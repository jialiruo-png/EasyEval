/**
 * P2 资源管理接口的 HTTP 挂载（P1 阻塞期可准备工作）。
 * 把 src/resource-api/handlers.ts 的 list/get/create 挂到 node:http：
 *   GET  /api/resources/:kind                  列表
 *   GET  /api/resources/:kind/:id/:version     详情
 *   POST /api/resources/:kind                  写入一份不可变版本
 *   POST /api/resources/:kind/:id/:version/copy  复制为带新 ID 的副本
 *   GET  /api/resources/:kind/:id/:version/archive    归档状态回显
 *   POST /api/resources/:kind/:id/:version/archive    按冻结版本归档（可重放）
 *   GET  /api/resources/:kind/:id/:version/references 列出引用该版本的本人任务
 *
 * 身份只从服务端签发的会话取得，复用 src/result-api/http.ts 的 SessionStore
 * 与会话解析逻辑；请求体里的 ownerAccountId 与查询参数 accountId 均不参与鉴权。
 * 写入请求体限制大小且必须是 JSON，错误统一映射为稳定状态码，不回显堆栈。
 * 仅用 Node 内置能力，不访问上游、不调用模型、不启动 Docker。
 */
import { decodeSegment, HttpInputError, readJsonBody, sendError, sendJson } from '../http/json.ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ResourceAccess, CatalogRequest } from '../http/catalog-access.ts';
import type { ResourceCatalog } from '../domain/resources.ts';
import { InMemorySessionStore, sessionAccountFromRequest, type SessionReader, type SessionStore } from '../result-api/http.ts';
import {
  archiveManagedResource,
  copyManagedResource,
  createManagedResource,
  getManagedArchiveStatus,
  getManagedResource,
  listManagedResources,
  listResourceReferences,
  type ManagedKind,
  type ResourceCopyInput,
  type ResourceListData,
  type ResourceListQuery,
  type ResourceResponse,
  type ResourceWriteInput,
} from './handlers.ts';

export { InMemorySessionStore, SESSION_COOKIE } from '../result-api/http.ts';
export type { SessionStore } from '../result-api/http.ts';

/** 写入请求体默认上限；避免本机服务被超大 JSON 拖垮。 */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface ResourceHttpOptions {
  sessions?: SessionStore;
  maxBodyBytes?: number;
}

type ParsedRoute =
  | { kind: 'collection'; resourceKind: string }
  | { kind: 'detail'; resourceKind: string; id: string; version: string }
  | { kind: 'copy'; resourceKind: string; id: string; version: string }
  | { kind: 'archive'; resourceKind: string; id: string; version: string }
  | { kind: 'references'; resourceKind: string; id: string; version: string };

type VersionRoute = Extract<ParsedRoute, { id: string }>;

function parseVersionRoute(kind: VersionRoute['kind'], match: RegExpExecArray): VersionRoute {
  return {
    kind,
    resourceKind: decodeSegment(match[1]!, 'kind'),
    id: decodeSegment(match[2]!, 'id'),
    version: decodeSegment(match[3]!, 'version'),
  };
}

function parseRoute(pathname: string): ParsedRoute | undefined {
  const collection = /^\/api\/resources\/([^/]+)$/.exec(pathname);
  if (collection) return { kind: 'collection', resourceKind: decodeSegment(collection[1]!, 'kind') };
  const copy = /^\/api\/resources\/([^/]+)\/([^/]+)\/([^/]+)\/copy$/.exec(pathname);
  if (copy) return parseVersionRoute('copy', copy);
  const archive = /^\/api\/resources\/([^/]+)\/([^/]+)\/([^/]+)\/archive$/.exec(pathname);
  if (archive) return parseVersionRoute('archive', archive);
  const references = /^\/api\/resources\/([^/]+)\/([^/]+)\/([^/]+)\/references$/.exec(pathname);
  if (references) return parseVersionRoute('references', references);
  const detail = /^\/api\/resources\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!detail) return undefined;
  return parseVersionRoute('detail', detail);
}

function allowedMethodsFor(kind: ParsedRoute['kind']): string[] {
  if (kind === 'detail' || kind === 'references') return ['GET'];
  if (kind === 'copy') return ['POST'];
  return ['GET', 'POST'];
}

/**
 * 把 URL 查询串解析为列表查询参数。未知参数一律忽略；数值参数无法解析时保留为
 * 非法值交给 handler 统一返回 400，避免 HTTP 层与 handler 出现两套校验口径。
 * 身份相关参数（accountId／ownerAccountId 自报值）不在这里信任，交由 handler 按会话限定。
 */
function parseListQuery(url: URL): ResourceListQuery {
  const result: ResourceListQuery = {};
  const pick = (key: string): string | undefined => {
    const value = url.searchParams.get(key);
    return value === null ? undefined : value;
  };
  const q = pick('q');
  const name = pick('name');
  const id = pick('id');
  const owner = pick('ownerAccountId');
  const from = pick('from');
  const to = pick('to');
  const sortBy = pick('sortBy');
  const order = pick('order');
  const page = pick('page');
  const pageSize = pick('pageSize');
  if (q !== undefined) result.q = q;
  if (name !== undefined) result.name = name;
  if (id !== undefined) result.id = id;
  if (owner !== undefined) result.ownerAccountId = owner;
  if (from !== undefined) result.from = from;
  if (to !== undefined) result.to = to;
  if (sortBy !== undefined) result.sortBy = sortBy as ResourceListQuery['sortBy'];
  if (order !== undefined) result.order = order as ResourceListQuery['order'];
  if (page !== undefined) result.page = Number(page);
  if (pageSize !== undefined) result.pageSize = Number(pageSize);
  return result;
}

function sendResourceResponse<T>(res: ServerResponse, response: ResourceResponse<T>): void {
  if (!response.ok) {
    const body: Record<string, unknown> = { code: response.code, message: response.message };
    if (response.issues) body.issues = response.issues;
    if (response.references) body.references = response.references;
    sendJson(res, response.httpStatus, body);
    return;
  }
  // 幂等重放只通过响应头暴露，不给资源详情的 JSON 形状增加字段。
  sendJson(res, response.httpStatus, response.data, response.replayed ? { 'x-replayed': 'true' } : {});
}

export async function handleResourceHttp(
  req: IncomingMessage,
  res: ServerResponse,
  access: ResourceAccess,
  list: (owner: string, kind: ManagedKind, query: ResourceListQuery) =>
    ResourceResponse<ResourceListData> | Promise<ResourceResponse<ResourceListData>>,
  sessions: SessionReader,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
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
  const allowedMethods = allowedMethodsFor(route.kind);
  if (!allowedMethods.includes(method)) {
    const allowed = allowedMethods.join(', ');
    sendError(res, 405, 'METHOD_NOT_ALLOWED', `仅支持 ${allowed}`, allowed);
    return;
  }

  const accountId = await sessionAccountFromRequest(req, sessions);
  if (!accountId) {
    sendError(res, 401, 'UNAUTHORIZED', '需要登录');
    return;
  }
  const ctx = { accountId };
  const resourceKind = route.resourceKind as ManagedKind;

  const source = 'id' in route ? { id: route.id, version: route.version } : undefined;
  const scope = { owner: accountId, kind: resourceKind, source };
  if (method === 'GET' && route.kind === 'collection') {
    sendResourceResponse(res, await list(accountId, resourceKind, parseListQuery(url)));
    return;
  }
  if (method === 'GET' && route.kind !== 'collection') {
    const action = route.kind === 'archive' ? 'status' : route.kind;
    const response = await access({ ...scope, action }, (catalog): ResourceResponse<unknown> => {
      if (action === 'references') return listResourceReferences(catalog, ctx, resourceKind, source!);
      if (action === 'status') return getManagedArchiveStatus(catalog, ctx, resourceKind, source!);
      return getManagedResource(catalog, ctx, resourceKind, source!);
    });
    sendResourceResponse(res, response);
    return;
  }

  // 复制与归档不需要请求体内容，但仍限制体积与媒体类型；写入必须提供对象体。
  const needsBody = route.kind === 'copy' || route.kind === 'collection' || route.kind === 'archive';
  let input: ResourceWriteInput = {};
  if (needsBody) {
    try {
      input = await readJsonBody(req, maxBytes, route.kind === 'copy' || route.kind === 'archive');
    } catch (error) {
      if (error instanceof HttpInputError) {
        sendError(res, error.status, 'BAD_REQUEST', error.message);
      } else {
        throw error;
      }
      return;
    }
  }
  const action: CatalogRequest['action'] = route.kind === 'copy' ? 'copy' : route.kind === 'archive' ? 'archive' : 'create';
  const response = await access({ ...scope, action, target: input, binding: input.binding }, (catalog): ResourceResponse<unknown> => {
    if (action === 'copy') return copyManagedResource(catalog, ctx, resourceKind, source!, input as ResourceCopyInput);
    if (action === 'archive') return archiveManagedResource(catalog, ctx, resourceKind, source!);
    return createManagedResource(catalog, ctx, resourceKind, input);
  });
  sendResourceResponse(res, response);
}

/**
 * 挂载四类资源的列表、详情与写入接口。
 * 会话由服务端签发；客户端自报账号、请求体归属字段一律不参与鉴权。
 */
export function createResourceHttpServer(
  catalog: ResourceCatalog,
  options: ResourceHttpOptions | SessionStore = {},
): Server {
  const resolved: ResourceHttpOptions = 'accountFor' in options
    ? { sessions: options as SessionStore }
    : options;
  const sessions = resolved.sessions ?? new InMemorySessionStore();
  const maxBytes = resolved.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const access: ResourceAccess = (_request, work) => work(catalog);
  const list = (owner: string, kind: ManagedKind, query: ResourceListQuery) => listManagedResources(catalog, { accountId: owner }, kind, query);
  return createServer((req, res) => {
    handleResourceHttp(req, res, access, list, sessions, maxBytes).catch((error) => {
      // 内部错误不回显堆栈或上游信息，避免泄露凭据与实现细节。
      console.error('resource-api internal error', error);
      if (!res.headersSent) sendError(res, 500, 'INTERNAL', '服务器内部错误');
    });
  });
}
