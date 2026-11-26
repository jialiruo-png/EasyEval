/**
 * P2 版本化资源的 SQLite 持久化实现（P1 阻塞期可准备工作）。
 *
 * 场景配置、数据集版本、规则版本、任务配置四类不可变版本落到 resource_versions 表；
 * 写入时复用 src/domain/resources.ts 的领域校验与内容哈希，读取在 SQL 中按
 * resource_kind + id + version 定位，按账号限定只返回本人记录。
 *
 * 归属边界：
 *  - get/list 在 SQL 的 WHERE 条件中带 owner_account_id，越权与不存在都查不到。
 *  - 绑定校验使用 get，缺失与其他账号的资源返回相同错误。
 *  - 同键同内容幂等返回，同键改内容或换归属拒绝；冻结快照在读出后仍深冻结。
 *
 * 只使用 Node 22 内置 node:sqlite / structuredClone；不安装依赖、不访问上游、不调用模型。
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  ResourceCatalog,
  ImmutableVersionConflict,
  deepFreeze,
  resourceContentHash,
  type ArchivableResourceKind,
  type ArchiveStore,
  type ArchivedResource,
  type DatasetSnapshot,
  type ResourceCatalogOptions,
  type ResourceVersion,
  type ScenarioConfigSnapshot,
  type TaskBinding,
  type VersionRef,
  type VersionStore,
} from '../domain/resources.ts';
import { SqliteDatasetRowStore } from './sqlite-dataset-rows.ts';
import type { RuleDef } from '../result-contract/contract.ts';
import { applyMigrations, openDatabase } from './migrations.ts';

export type ResourceKind = 'scenario' | 'dataset' | 'rule' | 'task';

type ResourceRow = {
  id: string;
  version: string;
  owner_account_id: string;
  snapshot_json: string;
  content_hash: string;
  created_at: string;
}

function versionKey(kind: ResourceKind, ref: VersionRef): string {
  return `${kind} ${encodeURIComponent(ref.id)}@${encodeURIComponent(ref.version)}`;
}

function checkRef(ref: VersionRef): void {
  if (!ref?.id?.trim() || !ref?.version?.trim()) throw new Error('版本引用不完整');
}

function toRecord<T>(row: ResourceRow): ResourceVersion<T> {
  return Object.freeze({
    ownerAccountId: row.owner_account_id,
    ref: Object.freeze({ id: row.id, version: row.version }),
    snapshot: deepFreeze(JSON.parse(row.snapshot_json) as T),
    contentHash: row.content_hash,
    createdAt: row.created_at,
  });
}

/** 单类资源的 SQLite 版本表，实现与内存实现完全相同的 VersionStore 语义。 */
class SqliteVersionStore<T> implements VersionStore<T> {
  private readonly db: DatabaseSync;
  private readonly kind: ResourceKind;

  constructor(db: DatabaseSync, kind: ResourceKind) {
    this.db = db;
    this.kind = kind;
  }

  put(ownerAccountId: string, ref: VersionRef, snapshot: T, now: () => string): ResourceVersion<T> {
    if (!ownerAccountId?.trim()) throw new Error('ownerAccountId 不能为空');
    checkRef(ref);
    const frozen = deepFreeze(structuredClone(snapshot));
    const hash = resourceContentHash(ownerAccountId, ref, frozen);
    const createdAt = now();
    const result = this.db.prepare(`
      INSERT INTO resource_versions
        (resource_kind, id, version, owner_account_id, snapshot_json, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(resource_kind, id, version) DO NOTHING
    `).run(
      this.kind, ref.id, ref.version, ownerAccountId,
      JSON.stringify(frozen), hash, createdAt,
    );
    // 冲突时必须读回「不带账号过滤」的原行，才能区分幂等重写与改内容／换归属。
    const row = this.select(ref);
    if (!row) throw new Error(`版本 ${versionKey(this.kind, ref)} 写入后无法读取`);
    if (result.changes === 0) {
      if (row.content_hash !== hash || row.owner_account_id !== ownerAccountId) {
        throw new ImmutableVersionConflict(`版本 ${versionKey(this.kind, ref)} 已存在且内容不可变`);
      }
    }
    return toRecord<T>(row);
  }

  peek(ref: VersionRef): ResourceVersion<T> | undefined {
    checkRef(ref);
    const row = this.select(ref);
    return row ? toRecord<T>(row) : undefined;
  }

  get(ref: VersionRef, accountId: string | undefined): ResourceVersion<T> | undefined {
    if (!accountId) return undefined;
    checkRef(ref);
    const row = this.select(ref, accountId);
    return row ? toRecord<T>(row) : undefined;
  }

  list(accountId: string | undefined): ResourceVersion<T>[] {
    if (!accountId) return [];
    const rows = this.db.prepare(`
      SELECT id, version, owner_account_id, snapshot_json, content_hash, created_at
      FROM resource_versions
      WHERE resource_kind = ? AND owner_account_id = ?
      ORDER BY id, version
    `).all(this.kind, accountId) as ResourceRow[];
    return rows.map((row) => toRecord<T>(row));
  }

  private select(ref: VersionRef, accountId?: string): ResourceRow | undefined {
    const sql = `
      SELECT id, version, owner_account_id, snapshot_json, content_hash, created_at
      FROM resource_versions
      WHERE resource_kind = ? AND id = ? AND version = ?${accountId === undefined ? '' : ' AND owner_account_id = ?'}
    `;
    const params = accountId === undefined
      ? [this.kind, ref.id, ref.version]
      : [this.kind, ref.id, ref.version, accountId];
    return this.db.prepare(sql).get(...params) as ResourceRow | undefined;
  }
}

type ArchivedRow = {
  resource_kind: ArchivableResourceKind;
  id: string;
  version: string;
  owner_account_id: string;
  archived_at: string;
};

function toArchiveRecord(row: ArchivedRow): ArchivedResource {
  return deepFreeze({
    ownerAccountId: row.owner_account_id,
    kind: row.resource_kind,
    ref: { id: row.id, version: row.version },
    archivedAt: row.archived_at,
  } as ArchivedResource);
}

/** 归档状态落盘：只写 archived_resources，不改版本表；归属在 SQL WHERE 中限定。 */
class SqliteArchiveStore implements ArchiveStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  put(ownerAccountId: string, kind: ArchivableResourceKind, ref: VersionRef, now: () => string): ArchivedResource {
    if (!ownerAccountId?.trim()) throw new Error('ownerAccountId 不能为空');
    if (!['dataset', 'rule', 'task'].includes(kind)) throw new Error('不支持归档的资源类型');
    checkRef(ref);
    const result = this.db.prepare(`
      INSERT INTO archived_resources
        (resource_kind, id, version, owner_account_id, archived_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(resource_kind, id, version) DO NOTHING
    `).run(kind, ref.id, ref.version, ownerAccountId, now());
    const row = this.select(kind, ref);
    if (!row) throw new Error(`归档记录 ${versionKey(kind, ref)} 写入后无法读取`);
    if (result.changes === 0 && row.owner_account_id !== ownerAccountId) {
      throw new ImmutableVersionConflict(`归档记录 ${versionKey(kind, ref)} 归属不可变`);
    }
    return toArchiveRecord(row);
  }

  get(kind: ArchivableResourceKind, ref: VersionRef, accountId: string | undefined): ArchivedResource | undefined {
    if (!accountId) return undefined;
    const row = this.select(kind, ref, accountId);
    return row ? toArchiveRecord(row) : undefined;
  }

  list(kind: ArchivableResourceKind, accountId: string | undefined): ArchivedResource[] {
    if (!accountId) return [];
    const rows = this.db.prepare(`
      SELECT resource_kind, id, version, owner_account_id, archived_at
      FROM archived_resources
      WHERE resource_kind = ? AND owner_account_id = ?
      ORDER BY id, version
    `).all(kind, accountId) as ArchivedRow[];
    return rows.map(toArchiveRecord);
  }

  private select(kind: ArchivableResourceKind, ref: VersionRef, accountId?: string): ArchivedRow | undefined {
    const sql = `
      SELECT resource_kind, id, version, owner_account_id, archived_at
      FROM archived_resources
      WHERE resource_kind = ? AND id = ? AND version = ?${accountId === undefined ? '' : ' AND owner_account_id = ?'}
    `;
    const params = accountId === undefined
      ? [kind, ref.id, ref.version]
      : [kind, ref.id, ref.version, accountId];
    return this.db.prepare(sql).get(...params) as ArchivedRow | undefined;
  }
}

/**
 * 落盘的资源目录。绑定校验仍由 ResourceCatalog 执行，因此内存与 SQLite 两种实现的
 * 错误码、归属边界和不可变语义完全一致。
 */
export class SqliteResourceCatalog extends ResourceCatalog {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync, options: Pick<ResourceCatalogOptions, 'now'> = {}) {
    super({
      now: options.now,
      datasetRows: new SqliteDatasetRowStore(db),
      archives: new SqliteArchiveStore(db),
      stores: {
        scenario: new SqliteVersionStore<ScenarioConfigSnapshot>(db, 'scenario'),
        dataset: new SqliteVersionStore<DatasetSnapshot>(db, 'dataset'),
        rule: new SqliteVersionStore<RuleDef>(db, 'rule'),
        task: new SqliteVersionStore<TaskBinding>(db, 'task'),
      },
    });
    this.db = db;
  }

  close(): void {
    this.db.close();
  }
}

/** 打开（必要时建库并迁移）SQLite 文件，返回可直接用于创建/读取/绑定校验的资源目录。 */
export function openSqliteResourceCatalog(
  filePath: string,
  options: Pick<ResourceCatalogOptions, 'now'> = {},
): SqliteResourceCatalog {
  const db = openDatabase(filePath);
  try {
    applyMigrations(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return new SqliteResourceCatalog(db, options);
}
