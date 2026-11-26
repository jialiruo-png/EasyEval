/**
 * P2 数据集导入接口的 HTTP 挂载（P1 阻塞期可准备工作）。
 *   POST /api/imports/dataset                         导入 CSV（快照与行一次写入）
 *   POST /api/imports/dataset/xlsx/sheets             列出工作表名供显式选表
 *   POST /api/imports/dataset/xlsx                    导入 Excel 选定工作表
 *   GET  /api/imports/dataset/:id/:version/rows       读取该版本的冻结行
 *
 * 身份只从服务端签发的会话取得，复用结果读取接口的 SessionStore；
 * 请求体里的 ownerAccountId 与查询参数 accountId 都不参与鉴权。
 * CSV 以 JSON 文本字段提交，xlsx 以 base64 字段提交，均限制体积；
 * 错误码与逐字段 issues 原样映射，幂等重放以 x-replayed 暴露，
 * 所有响应 Cache-Control: no-store。
 * 仅用 Node 内置能力，不读取文件、不访问上游、不调用模型、不启动 Docker。
 */
import { decodeSegment, HttpInputError, readJsonBody, sendError, sendJson } from '../http/json.ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { CatalogAccess } from '../http/catalog-access.ts';
import type { ResourceCatalog } from '../domain/resources.ts';
import type { DatasetRowStore } from '../domain/dataset-rows.ts';
import {
  InMemorySessionStore,
  sessionAccountFromRequest,
  type SessionReader,
  type SessionStore,
} from '../result-api/http.ts';
import {
  getImportedDatasetRows,
  importDatasetFromCsv,
  importDatasetFromXlsx,
  inspectDatasetXlsxSheets,
  type DatasetImportInput,
  type DatasetXlsxImportInput,
  type ImportResponse,
  type XlsxInspectionInput,
} from './handlers.ts';

export { InMemorySessionStore, SESSION_COOKIE } from '../result-api/http.ts';
export type { SessionStore } from '../result-api/http.ts';

/** 覆盖 5 MiB Excel 的 base64 与 CSV 的 JSON 转义，文件自身仍受导入上限约束。 */
export const DEFAULT_MAX_IMPORT_BODY_BYTES = 12 * 1024 * 1024;

export interface ImportHttpOptions {
  sessions?: SessionStore;
  maxBodyBytes?: number;
  now?: () => string;
}

type ParsedRoute =
  | { kind: 'import' }
  | { kind: 'xlsx-inspect' }
  | { kind: 'xlsx-import' }
  | { kind: 'rows'; id: string; version: string };

function parseRoute(pathname: string): ParsedRoute | undefined {
  if (pathname === '/api/imports/dataset') return { kind: 'import' };
  if (pathname === '/api/imports/dataset/xlsx/sheets') return { kind: 'xlsx-inspect' };
  if (pathname === '/api/imports/dataset/xlsx') return { kind: 'xlsx-import' };
  const rows = /^\/api\/imports\/dataset\/([^/]+)\/([^/]+)\/rows$/.exec(pathname);
  if (!rows) return undefined;
  return {
    kind: 'rows',
    id: decodeSegment(rows[1]!, 'id'),
    version: decodeSegment(rows[2]!, 'version'),
  };
}

function sendImportResponse<T>(res: ServerResponse, response: ImportResponse<T>): void {
  if (!response.ok) {
    const body: Record<string, unknown> = { code: response.code, message: response.message };
    if (response.issues) body.issues = response.issues;
    sendJson(res, response.httpStatus, body);
    return;
  }
  sendJson(res, response.httpStatus, response.data, response.replayed ? { 'x-replayed': 'true' } : {});
}

export async function handleImportHttp(
  req: IncomingMessage,
  res: ServerResponse,
  access: CatalogAccess,
  sessions: SessionReader,
  maxBytes = DEFAULT_MAX_IMPORT_BODY_BYTES,
  now = () => new Date().toISOString(),
): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    sendError(res, 400, 'BAD_REQUEST', 'URL 无效');
    return;
  }

  let route: ParsedRoute | undefined;
  try {
    route = parseRoute(url.pathname);
  } catch (error) {
    const message = error instanceof HttpInputError ? error.message : '路径编码无效';
    sendError(res, 400, 'BAD_REQUEST', message);
    return;
  }
  if (!route) {
    sendError(res, 404, 'NOT_FOUND', '接口不可用');
    return;
  }

  const method = req.method ?? 'GET';
  const allowed = route.kind === 'rows' ? 'GET' : 'POST';
  if (method !== allowed) {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', `仅支持 ${allowed}`, allowed);
    return;
  }

  const accountId = await sessionAccountFromRequest(req, sessions);
  if (!accountId) {
    sendError(res, 401, 'UNAUTHORIZED', '需要登录');
    return;
  }
  const ctx = { accountId };

  if (route.kind === 'rows') {
    const source = { id: route.id, version: route.version };
    const result = await access({ owner: accountId, kind: 'dataset', action: 'rows', source },
      (_catalog, rows) => getImportedDatasetRows(rows, ctx, source));
    sendImportResponse(res, result);
    return;
  }

  let input: DatasetImportInput | DatasetXlsxImportInput | XlsxInspectionInput;
  try {
    input = await readJsonBody(req, maxBytes);
  } catch (error) {
    if (error instanceof HttpInputError) {
      sendError(res, error.status, 'BAD_REQUEST', error.message);
    } else {
      throw error;
    }
    return;
  }
  if (route.kind === 'xlsx-inspect') {
    sendImportResponse(res, inspectDatasetXlsxSheets(ctx, input as XlsxInspectionInput));
    return;
  }
  const target = input as DatasetImportInput;
  const response = await access({ owner: accountId, kind: 'dataset', action: 'import', target },
    (catalog, rowStore) => route.kind === 'xlsx-import'
    ? importDatasetFromXlsx(catalog, rowStore, ctx, input as DatasetXlsxImportInput, now)
    : importDatasetFromCsv(catalog, rowStore, ctx, input as DatasetImportInput, now));
  sendImportResponse(res, response);
}

/** 挂载数据集导入与行读取接口；身份只来自服务端会话。 */
export function createImportHttpServer(
  catalog: ResourceCatalog,
  rowStore: DatasetRowStore,
  options: ImportHttpOptions | SessionStore = {},
): Server {
  const resolved: ImportHttpOptions = 'accountFor' in options
    ? { sessions: options as SessionStore }
    : options;
  const sessions = resolved.sessions ?? new InMemorySessionStore();
  const maxBytes = resolved.maxBodyBytes ?? DEFAULT_MAX_IMPORT_BODY_BYTES;
  const now = resolved.now ?? (() => new Date().toISOString());
  return createServer((req, res) => {
    handleImportHttp(req, res, (_scope, work) => work(catalog, rowStore), sessions, maxBytes, now).catch((error) => {
      console.error('import-api internal error', error);
      if (!res.headersSent) sendError(res, 500, 'INTERNAL', '服务器内部错误');
    });
  });
}
