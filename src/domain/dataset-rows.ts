/**
 * P2 数据集导入行内容持久化领域契约（P1 阻塞期可准备工作）。
 *
 * src/domain/imports.ts 的 parseDatasetCsv 产出 DatasetImport，其中的 rows 含每一行
 * 真实的查询/回答文本单元格；但 DatasetSnapshot 只冻结元信息（列名、行 ID、行数、
 * 校验值与来源），不含单元格。若只写 ResourceCatalog，导入的原始数据会丢失，Runner
 * 无从按行读取查询值。本模块把「行内容」作为与版本引用绑定的不可变集合固化：
 *  - 行集合以 dataset 的 VersionRef 定位，携带与 DatasetSnapshot.contentChecksum 一致的
 *    校验值；内容哈希覆盖校验值与全部行，防止同键不同内容；
 *  - 写入按账号限定归属，同键同内容幂等、改内容或换归属拒绝，与资源版本语义一致；
 *  - 读取按账号限定，越权与不存在统一返回 undefined；行顺序、行 ID 与单元格原样冻结；
 *  - importDataset 把 parseDatasetCsv 的结果同时写入版本目录与行存储，写入前复核
 *    快照校验值与行集合一致，避免元数据与单元格脱钩。
 *
 * 仅用 Node 22 内置 node:crypto / structuredClone；不读文件、不访问网络、不调用模型。
 */
import { createHash } from 'node:crypto';
import { contentChecksumOf, type DatasetImport, type ImportRow } from './imports.ts';
import {
  type ResourceCatalog,
  ImmutableVersionConflict,
  deepFreeze,
  resourceContentHash,
  stableStringify,
  type DatasetSnapshot,
  type ResourceVersion,
  type VersionRef,
} from './resources.ts';

/** 一份与数据集版本绑定的不可变行集合。 */
export interface DatasetRowSet {
  readonly ref: Readonly<VersionRef>;
  readonly ownerAccountId: string;
  /** 与 DatasetSnapshot.contentChecksum 对齐，证明行集合来自该冻结版本。 */
  readonly contentChecksum: string;
  readonly rows: readonly ImportRow[];
  readonly createdAt: string;
}

/** 行内容哈希：覆盖校验值与全部行（含列顺序与单元格），用于幂等与不可变判定。 */
export function datasetRowsHash(contentChecksum: string, rows: readonly ImportRow[]): string {
  return createHash('sha256').update(stableStringify({ contentChecksum, rows }), 'utf8').digest('hex');
}

function versionKey(ref: VersionRef): string {
  return `${encodeURIComponent(ref.id)}@${encodeURIComponent(ref.version)}`;
}

function requireText(value: string, label: string): void {
  if (!value || !value.trim()) throw new Error(`${label} 不能为空`);
}

function checkRef(ref: VersionRef): void {
  requireText(ref?.id, '数据集 id');
  requireText(ref?.version, '数据集 version');
}

function validateRows(rows: readonly ImportRow[]): void {
  if (!Array.isArray(rows)) throw new Error('行集合必须是数组');
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    requireText(row?.rowId, `row[${index}].rowId`);
    if (seen.has(row.rowId)) throw new Error(`行 ID 重复：${row.rowId}`);
    seen.add(row.rowId);
    if (!row.cells || typeof row.cells !== 'object' || Array.isArray(row.cells)) {
      throw new Error(`row[${index}].cells 必须是对象`);
    }
    for (const [column, value] of Object.entries(row.cells)) {
      if (typeof value !== 'string') throw new Error(`row[${index}].cells.${column} 必须是文本`);
    }
  });
}

/**
 * 行存储接口：内存与 SQLite 两种实现共用同一份归属、幂等与不可变语义。
 * withImport 将样本行与元信息写入同一事务。
 */
export interface DatasetRowStore {
  withImport<T>(catalog: ResourceCatalog, ref: VersionRef, write: (rows: DatasetRowStore) => T): T;
  put(
    ownerAccountId: string,
    ref: VersionRef,
    contentChecksum: string,
    rows: readonly ImportRow[],
    now: () => string,
  ): DatasetRowSet;
  get(ref: VersionRef, accountId: string | undefined): DatasetRowSet | undefined;
  list(accountId: string | undefined): DatasetRowSet[];
  peek(ref: VersionRef): DatasetRowSet | undefined;
}

/** 内存行存储：与 SQLite 实现语义一致，供纯逻辑测试与未落库路径使用。 */
export class InMemoryDatasetRowStore implements DatasetRowStore {
  private readonly byKey = new Map<string, { record: DatasetRowSet; hash: string }>();

  withImport<T>(_catalog: ResourceCatalog, ref: VersionRef, write: (rows: DatasetRowStore) => T): T {
    const key = versionKey(ref);
    const existed = this.byKey.has(key);
    try {
      return write(this);
    } catch (error) {
      if (!existed) this.byKey.delete(key);
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
    requireText(ownerAccountId, 'ownerAccountId');
    checkRef(ref);
    requireText(contentChecksum, 'contentChecksum');
    validateRows(rows);
    const frozen = deepFreeze(structuredClone(rows));
    const hash = datasetRowsHash(contentChecksum, frozen);
    const key = versionKey(ref);
    const existing = this.byKey.get(key);
    if (existing) {
      if (
        existing.record.contentChecksum !== contentChecksum
        || existing.hash !== hash
        || existing.record.ownerAccountId !== ownerAccountId
      ) {
        throw new ImmutableVersionConflict(`数据集版本 ${key} 的行内容已存在且不可变`);
      }
      return existing.record;
    }
    const record: DatasetRowSet = Object.freeze({
      ref: Object.freeze({ ...ref }),
      ownerAccountId,
      contentChecksum,
      rows: frozen,
      createdAt: now(),
    });
    this.byKey.set(key, { record, hash });
    return record;
  }

  get(ref: VersionRef, accountId: string | undefined): DatasetRowSet | undefined {
    if (!accountId) return undefined;
    checkRef(ref);
    const found = this.byKey.get(versionKey(ref));
    return found && found.record.ownerAccountId === accountId ? found.record : undefined;
  }

  list(accountId: string | undefined): DatasetRowSet[] {
    if (!accountId) return [];
    return [...this.byKey.values()]
      .map((entry) => entry.record)
      .filter((record) => record.ownerAccountId === accountId)
      .sort((a, b) => a.ref.id.localeCompare(b.ref.id) || a.ref.version.localeCompare(b.ref.version));
  }

  peek(ref: VersionRef): DatasetRowSet | undefined {
    checkRef(ref);
    return this.byKey.get(versionKey(ref))?.record;
  }
}

export interface ImportedDataset {
  /** 写入版本目录后的资源版本（含冻结元信息快照）。 */
  record: ResourceVersion<DatasetSnapshot>;
  /** 写入行存储后的行集合（含真实单元格）。 */
  rowSet: DatasetRowSet;
  /** 是否命中既有版本与行集合（同键同内容重放）。 */
  replayed: boolean;
}

/**
 * 把一次 parseDatasetCsv 的结果同时写入版本目录与行存储。写入前复核：
 *  - 快照校验值等于导入校验值，且行 ID／行数与快照一致；
 *  - 同键的行集合内容未漂移。
 * 任一侧漂移即拒绝，不产生「有元信息、无单元格」的半成品。
 */
export function importDataset(
  catalog: ResourceCatalog,
  rowStore: DatasetRowStore,
  ownerAccountId: string,
  ref: VersionRef,
  imported: DatasetImport,
  now: () => string,
): ImportedDataset {
  requireText(ownerAccountId, 'ownerAccountId');
  checkRef(ref);
  const { snapshot, rows, contentChecksum } = imported;
  if (snapshot?.contentChecksum !== contentChecksum) {
    throw new Error('数据集快照校验值与导入校验值不一致');
  }
  if (snapshot.rowCount !== rows.length) throw new Error('数据集快照行数与导入行数不一致');
  if (snapshot.rowIds.length !== rows.length || rows.some((row, i) => row.rowId !== snapshot.rowIds[i])) {
    throw new Error('数据集快照行 ID 与导入行 ID 不一致');
  }

  if (contentChecksumOf(snapshot.columns, snapshot.rowIds, rows, snapshot.queryColumn, snapshot.source) !== contentChecksum) {
    throw new Error('数据集单元格内容与导入校验值不一致');
  }

  const result = rowStore.withImport(catalog, ref, (store) => {
    const existingSnapshot = catalog.getDataset(ref, ownerAccountId);
    if (existingSnapshot && existingSnapshot.contentHash !== resourceContentHash(ownerAccountId, ref, snapshot)) {
      throw new ImmutableVersionConflict('数据集版本已存在且内容不可变');
    }
    const existingRows = store.get(ref, ownerAccountId);
    // 行存储和版本目录各自校验不可变内容；元信息写入失败时一起回滚。
    const rowSet = store.put(ownerAccountId, ref, contentChecksum, rows, now);
    const record = catalog.putDataset(ownerAccountId, ref, snapshot);
    return { record, rowSet, replayed: Boolean(existingSnapshot && existingRows) };
  });
  catalog.rememberDatasetRows(ref, rowStore);
  return result;
}
