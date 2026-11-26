/**
 * 草稿与预览索引的 PostgreSQL 落盘适配层（P3/P4 准备）。
 *
 * 与运行索引一致：写操作在按账号加事务锁的单个事务内加载该账号的草稿与预览，
 * 用同一份 DraftManager 同步领域规则完成校验、revision 并发、幂等与签名比对，
 * 成功后仅把新增或变更的文档写回；读取走只读事务并按账号限定。
 * 草稿 ID 带 draft: 前缀、与 run_index 分表；不接 Runner、调度、HTTP 与真实登录。
 */
import type { Pool, PoolClient } from 'pg';
import {
  DraftManager, InMemoryDraftStore, InMemoryPreviewStore, previewKey,
  type ConfirmDraftInput, type CreateDraftInput, type DraftConfirmation, type DraftRecord,
  type DraftResult, type DraftStore, type PreviewEntry, type PreviewStatus, type PreviewStore,
  type UpdateDraftInput,
} from '../../domain/drafts.ts';
import { ResourceCatalog, type VersionRef } from '../../domain/resources.ts';
import { catalogForDrafts } from './catalog.ts';
import { transaction } from './database.ts';

interface DraftRow { document: DraftRecord }
interface PreviewRow {
  owner_id: string;
  draft_id: string;
  sample_id: string;
  signature: string;
  status: PreviewStatus;
  attempts: number;
  reason: string | null;
  trace_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

type CatalogRef = { kind: 'scenario' | 'dataset' | 'rule'; ref: VersionRef };

interface State {
  drafts: DraftStore;
  previews: PreviewStore;
  draftBefore: Map<string, string>;
  previewBefore: Map<string, string>;
  draftIds: Set<string>;
}

function encodeKey(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url');
}

function toEntry(row: PreviewRow): PreviewEntry {
  return {
    key: previewKey(row.owner_id, row.draft_id, row.sample_id),
    ownerAccountId: row.owner_id,
    draftId: row.draft_id,
    sampleId: row.sample_id,
    signature: row.signature,
    status: row.status,
    attempts: row.attempts,
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.trace_ref === null ? {} : { traceRef: row.trace_ref }),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function loadState(client: PoolClient, owner: string): Promise<State> {
  const draftRows = await client.query<DraftRow>('SELECT document FROM drafts WHERE owner_id=$1', [owner]);
  const drafts = new InMemoryDraftStore();
  const draftBefore = new Map<string, string>();
  const draftIds = new Set<string>();
  for (const row of draftRows.rows) {
    drafts.save(row.document);
    draftBefore.set(row.document.id, JSON.stringify(row.document));
    draftIds.add(row.document.id);
  }
  const previewRows = await client.query<PreviewRow>(
    `SELECT owner_id,draft_id,sample_id,signature,status,attempts,reason,trace_ref,created_at,updated_at
     FROM draft_previews WHERE owner_id=$1`, [owner]);
  const previews = new InMemoryPreviewStore();
  const previewBefore = new Map<string, string>();
  for (const row of previewRows.rows) {
    const entry = toEntry(row);
    previews.save(entry);
    previewBefore.set(entry.key, JSON.stringify(entry));
    draftIds.add(entry.draftId);
  }
  return { drafts, previews, draftBefore, previewBefore, draftIds };
}

async function persistState(client: PoolClient, owner: string, state: State): Promise<void> {
  const afterDrafts = new Map(state.drafts.list(owner).map((draft) => [draft.id, JSON.stringify(draft)]));
  for (const id of state.draftBefore.keys()) {
    if (!afterDrafts.has(id)) await client.query('DELETE FROM drafts WHERE owner_id=$1 AND id=$2', [owner, id]);
  }
  for (const [id, document] of afterDrafts) {
    if (state.draftBefore.get(id) === document) continue;
    const draft = state.drafts.peek(id)!;
    await client.query(
      `INSERT INTO drafts(owner_id,id,step,status,revision,expires_at,created_at,updated_at,document)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (owner_id,id) DO UPDATE SET step=EXCLUDED.step,status=EXCLUDED.status,
         revision=EXCLUDED.revision,expires_at=EXCLUDED.expires_at,updated_at=EXCLUDED.updated_at,
         document=EXCLUDED.document`,
      [owner, draft.id, draft.step, draft.status, draft.revision, draft.expiresAt,
        draft.createdAt, draft.updatedAt, document]);
  }

  const afterPreviews = new Map<string, PreviewEntry>();
  for (const draftId of state.draftIds) {
    for (const entry of state.previews.listForDraft(draftId, owner)) afterPreviews.set(entry.key, entry);
  }
  for (const key of state.previewBefore.keys()) {
    if (!afterPreviews.has(key)) {
      await client.query('DELETE FROM draft_previews WHERE owner_id=$1 AND key_b64=$2', [owner, encodeKey(key)]);
    }
  }
  for (const [key, entry] of afterPreviews) {
    if (state.previewBefore.get(key) === JSON.stringify(entry)) continue;
    await client.query(
      `INSERT INTO draft_previews(key_b64,owner_id,draft_id,sample_id,signature,status,attempts,reason,trace_ref,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (key_b64) DO UPDATE SET signature=EXCLUDED.signature,status=EXCLUDED.status,
         attempts=EXCLUDED.attempts,reason=EXCLUDED.reason,trace_ref=EXCLUDED.trace_ref,
         updated_at=EXCLUDED.updated_at`,
      [encodeKey(key), owner, entry.draftId, entry.sampleId, entry.signature, entry.status,
        entry.attempts, entry.reason ?? null, entry.traceRef ?? null, entry.createdAt, entry.updatedAt]);
  }
}

function catalogRef(kind: CatalogRef['kind'], value: VersionRef | undefined): CatalogRef | undefined {
  if (!value?.id?.trim() || !value.version?.trim()) return undefined;
  return { kind, ref: { id: value.id, version: value.version } };
}

function refsFrom(value: {
  scenario?: VersionRef; dataset?: VersionRef; rule?: VersionRef;
}): CatalogRef[] {
  return [
    catalogRef('scenario', value.scenario),
    catalogRef('dataset', value.dataset),
    catalogRef('rule', value.rule),
  ].filter((item): item is CatalogRef => Boolean(item));
}

/** 同一账号的写操作按账号串行，与运行索引和资源目录使用同一把事务锁。 */
async function lockOwner(client: PoolClient, owner: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [owner]);
}

async function runWrite<T>(
  pool: Pool, owner: string | undefined,
  refsFor: (state: State) => CatalogRef[],
  work: (manager: DraftManager) => DraftResult<T>,
): Promise<DraftResult<T>> {
  // 请求体不能自报账号；会话缺失时直接在空领域实例上得到失败结果，不触碰数据库。
  if (!owner) return work(new DraftManager(new ResourceCatalog()));
  return transaction(pool, false, async (client) => {
    await lockOwner(client, owner);
    const state = await loadState(client, owner);
    const refs = refsFor(state);
    const manager = new DraftManager(
      refs.length ? await catalogForDrafts(client, owner, refs) : new ResourceCatalog(),
      { store: state.drafts, previewStore: state.previews },
    );
    const result = work(manager);
    if (result.ok) await persistState(client, owner, state);
    return result;
  });
}

async function runRead<T>(
  pool: Pool, owner: string | undefined, work: (manager: DraftManager) => T,
): Promise<T> {
  if (!owner) return work(new DraftManager(new ResourceCatalog()));
  return transaction(pool, true, async (client) => {
    const state = await loadState(client, owner);
    const manager = new DraftManager(new ResourceCatalog(),
      { store: state.drafts, previewStore: state.previews });
    return work(manager);
  });
}

export interface PostgresDrafts {
  create(owner: string | undefined, input: Omit<CreateDraftInput, 'ownerAccountId'>): Promise<DraftResult<DraftRecord>>;
  get(owner: string | undefined, draftId: string): Promise<DraftRecord | undefined>;
  list(owner: string | undefined): Promise<DraftRecord[]>;
  load(owner: string | undefined, draftId: string): Promise<DraftResult<DraftRecord>>;
  update(owner: string | undefined, draftId: string, input: UpdateDraftInput): Promise<DraftResult<DraftRecord>>;
  cancel(owner: string | undefined, draftId: string): Promise<DraftResult<DraftRecord>>;
  confirm(owner: string | undefined, draftId: string, input: ConfirmDraftInput): Promise<DraftResult<DraftConfirmation>>;
  acquirePreview(
    owner: string | undefined, draftId: string, sampleId: string,
  ): Promise<DraftResult<{ entry: PreviewEntry; created: boolean }>>;
  markPreview(
    owner: string | undefined, draftId: string, sampleId: string, status: PreviewStatus,
    detail?: { reason?: string; traceRef?: string },
  ): Promise<DraftResult<PreviewEntry>>;
  retryPreview(owner: string | undefined, draftId: string, sampleId: string): Promise<DraftResult<PreviewEntry>>;
  listPreviews(owner: string | undefined, draftId: string): Promise<PreviewEntry[]>;
}

export function postgresDrafts(pool: Pool): PostgresDrafts {
  return {
    create(owner, input) {
      return runWrite(pool, owner, () => refsFrom(input ?? {}),
        (manager) => manager.create({ ...input, ownerAccountId: owner! }));
    },
    get(owner, draftId) {
      return runRead(pool, owner, (manager) => manager.get(owner, draftId));
    },
    list(owner) {
      return runRead(pool, owner, (manager) => manager.list(owner));
    },
    load(owner, draftId) {
      return runRead(pool, owner, (manager) => manager.load(owner, draftId));
    },
    update(owner, draftId, input) {
      return runWrite(pool, owner, (state) => {
        const current = state.drafts.peek(draftId);
        return refsFrom({ ...(current ?? {}), ...(input ?? {}) });
      }, (manager) => manager.update(owner, draftId, input));
    },
    cancel(owner, draftId) {
      return runWrite(pool, owner, () => [], (manager) => manager.cancel(owner, draftId));
    },
    confirm(owner, draftId, input) {
      return runWrite(pool, owner, () => [], (manager) => manager.confirm(owner, draftId, input));
    },
    acquirePreview(owner, draftId, sampleId) {
      return runWrite(pool, owner, () => [], (manager) => manager.acquirePreview(owner, draftId, sampleId));
    },
    markPreview(owner, draftId, sampleId, status, detail) {
      return runWrite(pool, owner, () => [], (manager) => manager.markPreview(owner, draftId, sampleId, status, detail));
    },
    retryPreview(owner, draftId, sampleId) {
      return runWrite(pool, owner, () => [], (manager) => manager.retryPreview(owner, draftId, sampleId));
    },
    listPreviews(owner, draftId) {
      return runRead(pool, owner, (manager) => manager.listPreviews(owner, draftId));
    },
  };
}
