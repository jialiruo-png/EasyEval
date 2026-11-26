/**
 * P2 数据集导入接口骨架（HTTP 无关，P1 阻塞期可准备工作）。
 *
 * 把 src/domain/imports.ts 的 parseDatasetCsv 与 src/domain/dataset-rows.ts 的
 * importDataset 串成一次可复现的写入：CSV 文本先解析为冻结快照与逐行单元格，
 * 再同时写入版本目录与行存储，任一步失败都不产生半成品。
 *  - 账号只来自服务端 AuthContext，请求体自称的 ownerAccountId 一律忽略；
 *  - 解析错误 422 并回带逐字段 issues，供管理页定位到列与数据行号；
 *  - 同键同内容幂等 200 + replayed，改内容或换归属 409；
 *  - 行集合读取按账号限定，越权与不存在统一 404，不泄露数据集是否存在；
 *  - inspectDatasetXlsxSheets 只列工作表名供界面显式选表，不写任何资源。
 *
 * 仅用 Node 22 内置能力；不读文件、不挂 HTTP、不访问上游、不调用模型。
 */
import {
  parseDatasetCsv,
  parseDatasetXlsx,
  xlsxIssuesToImport,
  DEFAULT_IMPORT_LIMITS,
  type DatasetSource,
  type DatasetImport,
  type ImportIssue,
  type ImportLimits,
} from '../domain/imports.ts';
import { inspectXlsx } from '../domain/xlsx.ts';
import {
  importDataset,
  type DatasetRowStore,
} from '../domain/dataset-rows.ts';
import {
  ImmutableVersionConflict,
  type DatasetSnapshot,
  type ResourceCatalog,
  type VersionRef,
} from '../domain/resources.ts';
import type { AuthContext } from '../resource-api/handlers.ts';

export type { AuthContext } from '../resource-api/handlers.ts';

export type ImportErrorCode =
  | 'UNAUTHORIZED'
  | 'INVALID_INPUT'
  | 'IMPORT_INVALID'
  | 'VERSION_CONFLICT'
  | 'NOT_FOUND';

export interface ImportError {
  ok: false;
  httpStatus: 400 | 401 | 404 | 409 | 422;
  code: ImportErrorCode;
  message: string;
  /** 解析阶段的可定位错误：列、数据行号与原因。 */
  issues?: ImportIssue[];
}

export interface ImportSuccess<T> {
  ok: true;
  httpStatus: 200 | 201;
  data: T;
  replayed?: boolean;
}

export type ImportResponse<T> = ImportSuccess<T> | ImportError;

/** 请求体形状；归属字段只用于演示「收到也不采信」，代码从不读取它。 */
export interface DatasetImportInput {
  id?: unknown;
  version?: unknown;
  name?: unknown;
  source?: unknown;
  queryColumn?: unknown;
  csv?: unknown;
  limits?: unknown;
  ownerAccountId?: unknown;
}

/**
 * Excel 导入请求体。xlsx 为 base64 编码的 .xlsx 字节（JSON 无法直接承载二进制），
 * sheet 为显式选定的工作表名或 1 起始序号，省略时由领域层读第一张。
 * 服务端不读取本机文件；sheet 的候选由后续 inspectXlsx 接口提供供界面显式确认。
 */
export interface DatasetXlsxImportInput {
  id?: unknown;
  version?: unknown;
  name?: unknown;
  source?: unknown;
  queryColumn?: unknown;
  xlsxBase64?: unknown;
  sheet?: unknown;
  limits?: unknown;
  ownerAccountId?: unknown;
}

/**
 * 工作表候选请求体：上传后先列出表名供用户显式选择，再提交导入。
 * 工作表名不来自请求体自称归属，账号仍只取服务端会话。
 */
export interface XlsxInspectionInput {
  xlsxBase64?: unknown;
  limits?: unknown;
  ownerAccountId?: unknown;
}

export interface XlsxInspectionData {
  /** 按工作簿中的顺序给出全部表名，界面据此显式选择，不用默认第一张代替确认。 */
  sheets: readonly string[];
}

export interface ImportedDatasetData {
  kind: 'dataset';
  id: string;
  version: string;
  name: string;
  ownerAccountId: string;
  source: DatasetSource;
  queryColumn: string;
  rowCount: number;
  contentChecksum: string;
  contentHash: string;
  createdAt: string;
  snapshot: DatasetSnapshot;
}

export interface DatasetRowsData {
  ref: Readonly<VersionRef>;
  ownerAccountId: string;
  contentChecksum: string;
  rowCount: number;
  rows: readonly { rowId: string; cells: Readonly<Record<string, string>> }[];
}

const SOURCES: readonly DatasetSource[] = ['excel', 'csv', 'feishu', 'sql'];
const LIMIT_KEYS: readonly (keyof ImportLimits)[] = ['maxFileBytes', 'maxRows', 'maxCellChars'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(
  code: ImportErrorCode,
  httpStatus: ImportError['httpStatus'],
  message: string,
  issues?: ImportIssue[],
): ImportError {
  return issues ? { ok: false, code, httpStatus, message, issues } : { ok: false, code, httpStatus, message };
}

function badRequest(message: string): ImportError {
  return failure('INVALID_INPUT', 400, message);
}

function notFound(): ImportError {
  return failure('NOT_FOUND', 404, '数据集行不可用');
}

function requireText(value: unknown, label: string): string | ImportError {
  if (typeof value !== 'string' || !value.trim()) return badRequest(`${label} 必须是非空字符串`);
  return value;
}

/** 严格 base64 解码：只接受规范填充、字符集合法且长度为 4 倍数的文本。 */
function decodeBase64(value: unknown, label: string): Uint8Array | ImportError {
  if (typeof value !== 'string' || !value) return badRequest(`${label} 必须是非空 base64 文本`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    return badRequest(`${label} 不是合法的 base64 文本`);
  }
  return new Uint8Array(Buffer.from(value, 'base64'));
}

/** 工作表选择：省略读第一张；否则须为非空名称或 1 起始整数序号。 */
function parseSheet(value: unknown): string | number | undefined | ImportError {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    if (!value.trim()) return badRequest('sheet 必须是非空工作表名');
    return value;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  return badRequest('sheet 必须是工作表名或 1 起始的正整数序号');
}

/** 覆盖上限只接受三个已知的正整数键，其余忽略；非法值交 400，不用默认值兜底掩盖错误。 */
function parseLimits(value: unknown): Partial<ImportLimits> | ImportError {
  if (value === undefined) return {};
  if (!isRecord(value)) return badRequest('limits 必须是对象');
  const result: Partial<ImportLimits> = {};
  for (const key of LIMIT_KEYS) {
    const entry = value[key];
    if (entry === undefined) continue;
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1 || entry > DEFAULT_IMPORT_LIMITS[key]) {
      return badRequest(`limits.${key} 必须是 1 到 ${DEFAULT_IMPORT_LIMITS[key]} 的整数`);
    }
    result[key] = entry;
  }
  return result;
}

function toData(
  result: ReturnType<typeof importDataset>,
): ImportedDatasetData {
  const { record } = result;
  return {
    kind: 'dataset',
    id: record.ref.id,
    version: record.ref.version,
    name: record.snapshot.name,
    ownerAccountId: record.ownerAccountId,
    source: record.snapshot.source,
    queryColumn: record.snapshot.queryColumn,
    rowCount: record.snapshot.rowCount,
    contentChecksum: record.snapshot.contentChecksum,
    contentHash: record.contentHash,
    createdAt: record.createdAt,
    snapshot: record.snapshot,
  };
}

function persistImport(
  catalog: ResourceCatalog, rowStore: DatasetRowStore, accountId: string, ref: VersionRef,
  data: DatasetImport, now: () => string,
): ImportResponse<ImportedDatasetData> {
  try {
    const result = importDataset(catalog, rowStore, accountId, ref, data, now);
    return result.replayed
      ? { ok: true, httpStatus: 200, data: toData(result), replayed: true }
      : { ok: true, httpStatus: 201, data: toData(result) };
  } catch (error) {
    if (error instanceof ImmutableVersionConflict) return failure('VERSION_CONFLICT', 409, error.message);
    throw error;
  }
}

/**
 * 导入一份 CSV：解析失败返回 422 且不落库；写入冲突返回 409；
 * 同键同内容重放返回 200 + replayed，内容与首次写入逐字段一致。
 */
export function importDatasetFromCsv(
  catalog: ResourceCatalog,
  rowStore: DatasetRowStore,
  ctx: AuthContext,
  input: DatasetImportInput,
  now: () => string = () => new Date().toISOString(),
): ImportResponse<ImportedDatasetData> {
  if (!ctx.accountId) return failure('UNAUTHORIZED', 401, '需要登录');
  if (!isRecord(input)) return badRequest('请求体必须是对象');
  const id = requireText(input.id, 'id');
  if (typeof id === 'object') return id;
  const version = requireText(input.version, 'version');
  if (typeof version === 'object') return version;
  const name = requireText(input.name, 'name');
  if (typeof name === 'object') return name;
  const queryColumn = requireText(input.queryColumn, 'queryColumn');
  if (typeof queryColumn === 'object') return queryColumn;
  if (typeof input.csv !== 'string') return badRequest('csv 必须是文本');
  if (input.source !== undefined && !SOURCES.includes(input.source as DatasetSource)) {
    return badRequest('source 必须是 excel/csv/feishu/sql 之一');
  }
  const limits = parseLimits(input.limits);
  if (typeof limits === 'object' && 'ok' in limits) return limits;

  const parsed = parseDatasetCsv(input.csv, {
    name,
    ...(input.source === undefined ? {} : { source: input.source as DatasetSource }),
    queryColumn,
    limits,
  });
  if (!parsed.ok) {
    return failure('IMPORT_INVALID', 422, '数据集内容校验失败', parsed.issues);
  }

  return persistImport(catalog, rowStore, ctx.accountId, { id, version }, parsed.value, now);
}

/**
 * 导入一份 Excel 工作簿的选定工作表：xlsx 字节经 base64 解码后交领域层
 * parseDatasetXlsx 校验并归一，再与 CSV 共用同一条写入与冲突映射路径。
 * 未显式选表时读第一张，来源默认 excel；sheet/xlsx 非法分别返回 400。
 */
export function importDatasetFromXlsx(
  catalog: ResourceCatalog,
  rowStore: DatasetRowStore,
  ctx: AuthContext,
  input: DatasetXlsxImportInput,
  now: () => string = () => new Date().toISOString(),
): ImportResponse<ImportedDatasetData> {
  if (!ctx.accountId) return failure('UNAUTHORIZED', 401, '需要登录');
  if (!isRecord(input)) return badRequest('请求体必须是对象');
  const id = requireText(input.id, 'id');
  if (typeof id === 'object') return id;
  const version = requireText(input.version, 'version');
  if (typeof version === 'object') return version;
  const name = requireText(input.name, 'name');
  if (typeof name === 'object') return name;
  const queryColumn = requireText(input.queryColumn, 'queryColumn');
  if (typeof queryColumn === 'object') return queryColumn;

  const bytes = decodeBase64(input.xlsxBase64, 'xlsxBase64');
  if (typeof bytes === 'object' && 'ok' in bytes) return bytes;
  const sheet = parseSheet(input.sheet);
  if (typeof sheet === 'object' && 'ok' in sheet) return sheet;
  if (input.source !== undefined && !SOURCES.includes(input.source as DatasetSource)) {
    return badRequest('source 必须是 excel/csv/feishu/sql 之一');
  }
  const limits = parseLimits(input.limits);
  if (typeof limits === 'object' && 'ok' in limits) return limits;

  const parsed = parseDatasetXlsx(bytes, {
    name,
    ...(input.source === undefined ? {} : { source: input.source as DatasetSource }),
    queryColumn,
    ...(sheet === undefined ? {} : { sheet }),
    limits,
  });
  if (!parsed.ok) {
    return failure('IMPORT_INVALID', 422, '数据集内容校验失败', parsed.issues);
  }

  return persistImport(catalog, rowStore, ctx.accountId, { id, version }, parsed.value, now);
}

/**
 * 列出工作簿的工作表候选：只解码上传的字节并读 xl/workbook.xml，
 * 不解析单元格、不写版本目录与行存储，也不接受请求体自称归属。
 * 坏容器返回 422 并与导入共用同一 issues 口径，非法 base64／limits 返回 400。
 */
export function inspectDatasetXlsxSheets(
  ctx: AuthContext,
  input: XlsxInspectionInput,
): ImportResponse<XlsxInspectionData> {
  if (!ctx.accountId) return failure('UNAUTHORIZED', 401, '需要登录');
  if (!isRecord(input)) return badRequest('请求体必须是对象');
  const bytes = decodeBase64(input.xlsxBase64, 'xlsxBase64');
  if (typeof bytes === 'object' && 'ok' in bytes) return bytes;
  const limits = parseLimits(input.limits);
  if (typeof limits === 'object' && 'ok' in limits) return limits;
  const result = inspectXlsx(bytes, limits);
  if (!result.ok) {
    return failure('IMPORT_INVALID', 422, '工作簿解析失败', xlsxIssuesToImport(result.issues));
  }
  return { ok: true, httpStatus: 200, data: { sheets: result.value } };
}

function refFrom(value: VersionRef): VersionRef | ImportError {
  const id = requireText(value?.id, 'id');
  if (typeof id === 'object') return id;
  const version = requireText(value?.version, 'version');
  if (typeof version === 'object') return version;
  return { id, version };
}

/** 行集合读取：越权与不存在统一 404；返回的行沿用领域层冻结快照。 */
export function getImportedDatasetRows(
  rowStore: DatasetRowStore,
  ctx: AuthContext,
  value: VersionRef,
): ImportResponse<DatasetRowsData> {
  if (!ctx.accountId) return failure('UNAUTHORIZED', 401, '需要登录');
  const ref = refFrom(value);
  if (typeof ref === 'object' && 'ok' in ref) return ref;
  const rowSet = rowStore.get(ref, ctx.accountId);
  if (!rowSet) return notFound();
  return {
    ok: true,
    httpStatus: 200,
    data: {
      ref: rowSet.ref,
      ownerAccountId: rowSet.ownerAccountId,
      contentChecksum: rowSet.contentChecksum,
      rowCount: rowSet.rows.length,
      rows: rowSet.rows,
    },
  };
}
