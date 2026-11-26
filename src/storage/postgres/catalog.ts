import type { Pool, PoolClient } from 'pg';
import { InMemoryDatasetRowStore } from '../../domain/dataset-rows.ts';
import type { ImportRow } from '../../domain/imports.ts';
import {
  InMemoryArchiveStore, ResourceCatalog, VersionTable,
  type DatasetSnapshot, type ResourceVersion, type ScenarioConfigSnapshot, type TaskBinding, type VersionRef,
} from '../../domain/resources.ts';
import type { RuleDef } from '../../result-contract/contract.ts';
import type { CatalogAccess, CatalogRequest } from '../../http/catalog-access.ts';
import {
  prepareResourceListQuery, resourceDisplayName, type ManagedKind, type ResourceListQuery,
  type ResourceListData, type ResourceResponse,
} from '../../resource-api/handlers.ts';
import { transaction } from './database.ts';

interface ResourceRow {
  kind: ManagedKind;
  id: string;
  version: string;
  snapshot: unknown;
  content_hash: string;
  created_at: Date;
  archived_at: Date | null;
}
interface RowSet {
  id: string;
  version: string;
  content_checksum: string;
  cells: ImportRow[];
  created_at: Date;
}

function ref(value: unknown): VersionRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Partial<VersionRef>;
  if (typeof item.id !== 'string' || typeof item.version !== 'string') return undefined;
  return { id: item.id, version: item.version };
}

interface ResourceKey extends VersionRef { kind: string }
function addBindings(keys: ResourceKey[], binding: unknown): void {
  if (!binding || typeof binding !== 'object') return;
  for (const kind of ['scenario', 'rule', 'dataset'] as const) {
    const linked = ref((binding as Partial<TaskBinding>)[kind]);
    if (linked) keys.push({ ...linked, kind });
  }
}

async function loadResources(client: PoolClient, request: CatalogRequest, refs: VersionRef[]): Promise<ResourceRow[]> {
  const { owner, kind, action, source } = request;
  const keys = refs.map((item) => ({ ...item, kind }));
  if (action === 'create' && kind === 'task') addBindings(keys, request.binding);
  const load = async (selected: ResourceKey[], references: boolean) => {
    const result = await client.query<ResourceRow>(
      `SELECT v.kind,v.id,v.version,v.snapshot,v.content_hash,v.created_at,v.archived_at FROM resource_versions v
       WHERE owner_id=$1 AND (
         (kind,id,version) IN (SELECT k.kind,k.id,k.version FROM jsonb_to_recordset($3::jsonb) AS k(kind text,id text,version text))
         OR ($4::boolean AND kind='task' AND (snapshot->$2::text)->>'id'=$5 AND (snapshot->$2::text)->>'version'=$6))`,
      [owner, kind, JSON.stringify(selected), references, source?.id ?? null, source?.version ?? null]);
    return result.rows;
  };
  const references = (action === 'references' || action === 'archive') && (kind === 'dataset' || kind === 'rule');
  const records = await load(keys, references);
  if (action === 'copy' && kind === 'task' && source) {
    const original = records.find((r) => r.id === source.id && r.version === source.version);
    const linked: ResourceKey[] = [];
    addBindings(linked, original?.snapshot);
    if (linked.length) records.push(...await load(linked, false));
  }
  return records;
}

function versions<T>(records: ResourceRow[], kind: ManagedKind, owner: string): VersionTable<T> {
  return new VersionTable(records.filter((r) => r.kind === kind).map((r) => ({
    ownerAccountId: owner, ref: { id: r.id, version: r.version }, snapshot: r.snapshot as T,
    createdAt: r.created_at.toISOString(), contentHash: r.content_hash,
  })));
}

function key(kind: string, item: VersionRef): string {
  return JSON.stringify([kind, item.id, item.version]);
}

/** 供运行索引写事务复用：只加载本次涉及的任务、数据集、规则与场景版本。 */
export async function catalogForRuns(
  client: PoolClient, owner: string, refs: VersionRef[], binding: unknown,
): Promise<ResourceCatalog> {
  const records = await loadResources(client, { owner, kind: 'task', action: 'create', binding }, refs);
  const archives = new InMemoryArchiveStore();
  for (const record of records) {
    if (record.archived_at && record.kind !== 'scenario') {
      archives.put(owner, record.kind, { id: record.id, version: record.version },
        () => record.archived_at!.toISOString());
    }
  }
  return new ResourceCatalog({
    stores: {
      scenario: versions<ScenarioConfigSnapshot>(records, 'scenario', owner),
      dataset: versions<DatasetSnapshot>(records, 'dataset', owner),
      rule: versions<RuleDef>(records, 'rule', owner),
      task: versions<TaskBinding>(records, 'task', owner),
    },
    archives,
  });
}

/** Run the synchronous domain rules over only the versions involved in this operation.
 * The database transaction owns all mutations; no account data stays in process between requests.
 */
export function postgresCatalogAccess(pool: Pool): CatalogAccess {
  return async (request, work) => {
    const { owner, kind, action, source } = request;
    const write = ['create', 'copy', 'import', 'archive'].includes(action);
    return transaction(pool, !write, async (client) => {
      // Serialize dependent mutations (e.g. task binding vs. dataset archive) for one owner.
      if (write) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [owner]);
      const target = action === 'copy' && typeof request.target?.id === 'string'
        ? ref({ id: request.target.id.trim(), version: typeof request.target.version === 'string' ? request.target.version.trim() : 'v1' })
        : ref(request.target);
      const refs = [source, target].filter((item): item is VersionRef => Boolean(item));
      const records = action === 'rows' ? [] : await loadResources(client, request, refs);
      const stores = {
        scenario: versions<ScenarioConfigSnapshot>(records, 'scenario', owner),
        dataset: versions<DatasetSnapshot>(records, 'dataset', owner),
        rule: versions<RuleDef>(records, 'rule', owner),
        task: versions<TaskBinding>(records, 'task', owner),
      };
      const existing = new Set(records.map((r) => key(r.kind, r)));
      const archives = new InMemoryArchiveStore();
      const archived = new Set<string>();
      for (const r of records) {
        if (r.archived_at && r.kind !== 'scenario') {
          archives.put(owner, r.kind, { id: r.id, version: r.version }, () => r.archived_at!.toISOString());
          archived.add(key(r.kind, r));
        }
      }
      const rows = new InMemoryDatasetRowStore();
      const existingRows = new Set<string>();
      if (kind === 'dataset' && ['rows','copy','import'].includes(action) && refs.length) {
        const result = await client.query<RowSet>(
          `SELECT id,version,content_checksum,cells,created_at FROM dataset_row_sets
           WHERE owner_id=$1 AND (id,version) IN
             (SELECT id,version FROM jsonb_to_recordset($2::jsonb) AS k(id text,version text))`, [owner, JSON.stringify(refs)]);
        for (const r of result.rows) {
          const item = { id: r.id, version: r.version };
          rows.put(owner, item, r.content_checksum, r.cells, () => r.created_at.toISOString());
          existingRows.add(key(kind, item));
        }
      }
      const catalog = new ResourceCatalog({ stores, archives, datasetRows: rows });
      const response = work(catalog, rows);
      if (!write || !response.ok) return response;

      for (const [resourceKind, store] of Object.entries(stores)) {
        for (const item of store.list(owner) as ResourceVersion<unknown>[]) {
          if (existing.has(key(resourceKind, item.ref))) continue;
          await client.query(`INSERT INTO resource_versions(kind,id,version,owner_id,snapshot,content_hash,created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7)`, [resourceKind, item.ref.id, item.ref.version, owner,
            JSON.stringify(item.snapshot), item.contentHash, item.createdAt]);
        }
      }
      for (const item of rows.list(owner)) {
        if (!existingRows.has(key('dataset', item.ref))) {
          await client.query(`INSERT INTO dataset_row_sets(owner_id,id,version,content_checksum,cells,created_at)
            VALUES ($1,$2,$3,$4,$5,$6)`, [owner, item.ref.id, item.ref.version, item.contentChecksum,
            JSON.stringify(item.rows), item.createdAt]);
        }
      }
      if (action === 'archive' && source && (kind === 'task' || kind === 'dataset' || kind === 'rule')) {
        const archive = archives.get(kind, source, owner);
        if (archive && !archived.has(key(kind, source))) {
          await client.query('UPDATE resource_versions SET archived_at=$1 WHERE owner_id=$2 AND kind=$3 AND id=$4 AND version=$5',
            [archive.archivedAt, owner, kind, source.id, source.version]);
        }
      }
      return response;
    });
  };
}

export async function listPostgresResources(
  pool: Pool, owner: string, kind: ManagedKind, input: ResourceListQuery,
): Promise<ResourceResponse<ResourceListData>> {
  const query = prepareResourceListQuery({ accountId: owner }, kind, input);
  if ('ok' in query) return query;
  const data: ResourceListData = { kind, query, total: 0, items: [] };
  if (query.ownerAccountId !== undefined && query.ownerAccountId !== owner) return { ok: true, httpStatus: 200, data };
  // The name fallback also covers older versions with an absent or blank display name.
  const name = "CASE WHEN jsonb_typeof(snapshot->'name')='string' AND snapshot->>'name' ~ '[^[:space:]]' THEN snapshot->>'name' ELSE id END";
  const where = `FROM resource_versions WHERE owner_id=$1 AND kind=$2 AND ($3::text IS NULL OR id=$3)
    AND ($4::text IS NULL OR ${name}=$4)
    AND ($5='' OR strpos(lower(id),lower($5))>0 OR strpos(lower(${name}),lower($5))>0)
    AND ($6::text IS NULL OR to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') >= $6)
    AND ($7::text IS NULL OR to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') <= $7)`;
  const params = [owner, kind, query.id ?? null, query.name ?? null, query.q?.trim() ?? '', query.from ?? null, query.to ?? null];
  const primary = { createdAt: 'created_at', id: 'id', name }[query.sortBy];
  const dir = query.order === 'desc' ? 'DESC' : 'ASC';
  await transaction(pool, true, async (client) => {
    const count = await client.query<{ total: string }>('SELECT count(*) AS total ' + where, params);
    data.total = Number(count.rows[0].total);
    const offset = (query.page - 1) * query.pageSize;
    if (offset >= data.total) return;
    const page = await client.query<ResourceRow>(
      `SELECT id,version,created_at,content_hash,snapshot ${where}
       ORDER BY ${primary} ${dir}, id ${dir}, version ${dir} LIMIT $8 OFFSET $9`,
      [...params, query.pageSize, offset]);
    data.items = page.rows.map((r) => ({
      kind, id: r.id, version: r.version, ownerAccountId: owner, name: resourceDisplayName(kind, r.snapshot, r.id),
      createdAt: r.created_at.toISOString(), snapshot: r.snapshot, contentHash: r.content_hash,
    }));
  });
  return { ok: true, httpStatus: 200, data };
}
