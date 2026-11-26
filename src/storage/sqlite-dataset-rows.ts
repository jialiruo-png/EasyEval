/**
 * P2 数据集导入行内容的 SQLite 持久化实现（P1 阻塞期可准备工作）。
 *
 * 行集合头落到 dataset_row_sets（归属、与快照对齐的校验值、行数），逐行单元格落到
 * dataset_rows（序号、行 ID、cells_json），以 VersionRef 定位。写入复用
 * src/domain/dataset-rows.ts 的校验、内容哈希与归属语义：同键同内容幂等、改内容或
 * 换归属拒绝；读取在 SQL 的 WHERE 条件中带 owner_account_id，越权与不存在都查不到。
 * 行按 ordinal 读出，顺序与冻结的行 ID 一致；关库重开后单元格逐字段一致。
 *
 * 只使用 Node 22 内置 node:sqlite / structuredClone；不安装依赖、不访问上游、不调用模型。
 */
import { DatabaseSync } from 'node:sqlite';
import type { ImportRow } from '../domain/imports.ts';
import {
  datasetRowsHash,
  type DatasetRowSet,
  type DatasetRowStore,
} from '../domain/dataset-rows.ts';
import { ImmutableVersionConflict, type ResourceCatalog, type VersionRef } from '../domain/resources.ts';
import { applyMigrations, openDatabase } from './migrations.ts';

type RowSetHeaderRow = {
  dataset_id: string;
  dataset_version: string;
  owner_account_id: string;
  content_checksum: string;
  row_count: number;
  created_at: string;
}

type CellRow = {
  ordinal: number;
  row_id: string;
  cells_json: string;
}

function checkRef(ref: VersionRef): void {
  if (!ref?.id?.trim() || !ref?.version?.trim()) throw new Error('版本引用不完整');
}

/** SQLite 行存储：与内存实现共用领域语义，归属边界在 SQL 中限定。 */
export class SqliteDatasetRowStore implements DatasetRowStore {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  withImport<T>(catalog: ResourceCatalog, _ref: VersionRef, write: (rows: DatasetRowStore) => T): T {
    const db = 'db' in catalog && catalog.db instanceof DatabaseSync ? catalog.db : this.db;
    if (db !== this.db) {
      const filename = (conn: DatabaseSync) => conn.prepare("SELECT file FROM pragma_database_list WHERE name='main'").get()?.file;
      const target = filename(db);
      if (!target || target !== filename(this.db)) throw new Error('导入的版本与样本行必须位于同一个 SQLite 数据库');
    }
    const rows = db === this.db ? this : new SqliteDatasetRowStore(db);
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = write(rows);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  put(
    ownerAccountId: string,
    ref: VersionRef,
    contentChecksum: string,
    rows: readonly ImportRow[],
    now: () => string,
  ): DatasetRowSet {
    if (!ownerAccountId?.trim()) throw new Error('ownerAccountId 不能为空');
    checkRef(ref);
    if (!contentChecksum?.trim()) throw new Error('contentChecksum 不能为空');
    if (!Array.isArray(rows)) throw new Error('行集合必须是数组');
    const seen = new Set<string>();
    const cleanRows = rows.map((row, index) => {
      if (!row?.rowId?.trim()) throw new Error(`row[${index}].rowId 不能为空`);
      if (seen.has(row.rowId)) throw new Error(`行 ID 重复：${row.rowId}`);
      seen.add(row.rowId);
      if (!row.cells || typeof row.cells !== 'object' || Array.isArray(row.cells)) {
        throw new Error(`row[${index}].cells 必须是对象`);
      }
      for (const [column, value] of Object.entries(row.cells)) {
        if (typeof value !== 'string') throw new Error(`row[${index}].cells.${column} 必须是文本`);
      }
      return { rowId: row.rowId, cells: { ...row.cells } };
    });
    const frozen = Object.freeze(cleanRows.map((row) => Object.freeze({
      rowId: row.rowId, cells: Object.freeze(row.cells),
    }))) as readonly ImportRow[];
    const hash = datasetRowsHash(contentChecksum, frozen);
    const createdAt = now();

    this.db.exec('SAVEPOINT dataset_rows_write');
    try {
      const inserted = this.db.prepare(`
        INSERT INTO dataset_row_sets
          (dataset_id, dataset_version, owner_account_id, content_checksum, row_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(dataset_id, dataset_version) DO NOTHING
      `).run(ref.id, ref.version, ownerAccountId, contentChecksum, cleanRows.length, createdAt);
      if (inserted.changes === 0) {
        const existing = this.peek(ref)!;
        const existingHash = datasetRowsHash(existing.contentChecksum, existing.rows);
        if (
          existing.contentChecksum !== contentChecksum
          || existingHash !== hash
          || existing.ownerAccountId !== ownerAccountId
        ) {
          throw new ImmutableVersionConflict(`数据集版本 ${ref.id}@${ref.version} 的行内容已存在且不可变`);
        }
        this.db.exec('RELEASE dataset_rows_write');
        return existing;
      }
      const insertRow = this.db.prepare(`
        INSERT INTO dataset_rows (dataset_id, dataset_version, ordinal, row_id, cells_json)
        VALUES (?, ?, ?, ?, ?)
      `);
      cleanRows.forEach((row, ordinal) => {
        insertRow.run(ref.id, ref.version, ordinal, row.rowId, JSON.stringify(row.cells));
      });
      this.db.exec('RELEASE dataset_rows_write');
    } catch (error) {
      this.db.exec('ROLLBACK TO dataset_rows_write; RELEASE dataset_rows_write');
      throw error;
    }

    return Object.freeze({
      ref: Object.freeze({ ...ref }),
      ownerAccountId,
      contentChecksum,
      rows: frozen,
      createdAt,
    });
  }

  get(ref: VersionRef, accountId: string | undefined): DatasetRowSet | undefined {
    if (!accountId) return undefined;
    checkRef(ref);
    const header = this.db.prepare(`
      SELECT dataset_id, dataset_version, owner_account_id, content_checksum, row_count, created_at
      FROM dataset_row_sets
      WHERE dataset_id = ? AND dataset_version = ? AND owner_account_id = ?
    `).get(ref.id, ref.version, accountId) as RowSetHeaderRow | undefined;
    return header ? this.materialize(header) : undefined;
  }

  list(accountId: string | undefined): DatasetRowSet[] {
    if (!accountId) return [];
    const headers = this.db.prepare(`
      SELECT dataset_id, dataset_version, owner_account_id, content_checksum, row_count, created_at
      FROM dataset_row_sets
      WHERE owner_account_id = ?
      ORDER BY dataset_id, dataset_version
    `).all(accountId) as RowSetHeaderRow[];
    return headers.map((header) => this.materialize(header));
  }

  peek(ref: VersionRef): DatasetRowSet | undefined {
    checkRef(ref);
    const header = this.db.prepare(`
      SELECT dataset_id, dataset_version, owner_account_id, content_checksum, row_count, created_at
      FROM dataset_row_sets
      WHERE dataset_id = ? AND dataset_version = ?
    `).get(ref.id, ref.version) as RowSetHeaderRow | undefined;
    return header ? this.materialize(header) : undefined;
  }

  private materialize(header: RowSetHeaderRow): DatasetRowSet {
    const cells = this.db.prepare(`
      SELECT ordinal, row_id, cells_json FROM dataset_rows
      WHERE dataset_id = ? AND dataset_version = ? ORDER BY ordinal
    `).all(header.dataset_id, header.dataset_version) as CellRow[];
    const rows = Object.freeze(cells.map((cell) => Object.freeze({
      rowId: cell.row_id,
      cells: Object.freeze(JSON.parse(cell.cells_json) as Record<string, string>),
    }))) as readonly ImportRow[];
    return Object.freeze({
      ref: Object.freeze({ id: header.dataset_id, version: header.dataset_version }),
      ownerAccountId: header.owner_account_id,
      contentChecksum: header.content_checksum,
      rows,
      createdAt: header.created_at,
    });
  }
}

/** 打开（必要时建库并迁移）SQLite 文件，返回可复用的导入行存储。 */
export function openSqliteDatasetRowStore(filePath: string): SqliteDatasetRowStore {
  const db = openDatabase(filePath);
  try {
    applyMigrations(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return new SqliteDatasetRowStore(db);
}
