/**
 * P5 运行索引 HTTP 挂载（P2 阻塞期可准备工作）。
 *   POST /api/runs              手动触发
 *   POST /api/runs/:runId/cancel 取消本批
 *   GET  /api/runs/:runId       批次状态详情
 *   GET  /api/runs              本人批次列表（?taskId= 过滤）
 *
 * 身份只从服务端签发的会话取得，复用 src/result-api/http.ts 的会话解析；
 * 请求体 ownerAccountId 与查询 accountId 均不参与鉴权。
 * 路径形状与结果读取接口（/api/runs/:runId/results|samples）互斥，由 server.ts 分流。
 * 仅用 Node 内置能力，不访问上游、不调用模型、不启动 Docker。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { decodeSegment, HttpInputError, readJsonBody, sendError, sendJson } from '../http/json.ts';
import {
  InMemorySessionStore, sessionAccountFromRequest, type SessionReader, type SessionStore,
} from '../result-api/http.ts';
import {
  cancelManagedRun, getManagedRunStatus, listManagedRuns, requestManagedRun,
  type RunIndexAccessor, type RunResponse,
} from './handlers.ts';

export { InMemorySessionStore, SESSION_COOKIE } from '../result-api/http.ts';
export type { SessionStore } from '../result-api/http.ts';

/** 写入请求体默认上限。 */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface RunHttpOptions {
  sessions?: SessionStore;
  maxBodyBytes?: number;
}

type ParsedRoute =
  | { kind: 'collection' }
  | { kind: 'cancel'; runId: string }
  | { kind: 'status'; runId: string };

function parseRoute(pathname: string): ParsedRoute | undefined {
  if (pathname === '/api/runs' || pathname === '/api/runs/') return { kind: 'collection' };
  const cancel = /^\/api\/runs\/([^/]+)\/cancel$/.exec(pathname);
  if (cancel) return { kind: 'cancel', runId: decodeSegment(cancel[1]!, 'runId') };
  const status = /^\/api\/runs\/([^/]+)$/.exec(pathname);
  if (status) return { kind: 'status', runId: decodeSegment(status[1]!, 'runId') };
  return undefined;
}

function methodsFor(kind: ParsedRoute['kind']): string[] {
  return kind === 'collection' ? ['GET', 'POST'] : kind === 'cancel' ? ['POST'] : ['GET'];
}

/**
 * 判断路径是否属于运行索引而非结果读取。结果读取的路径一定带 /results 或 /samples
 * 后缀（含 /samples/:sampleId），这里显式排除，避免 `/api/runs/:runId` 与
 * `/api/runs/:runId/results` 互相遮蔽。
 */
export function isRunIndexRoute(pathname: string): boolean {
  if (/^\/api\/runs\/[^/]+\/(results|samples)(?:\/[^/]+)?\/?$/.test(pathname)) return false;
  return pathname === '/api/runs' || pathname === '/api/runs/' || /^\/api\/runs\/[^/]+(?:\/cancel)?\/?$/.test(pathname);
}

function sendRunResponse<T>(res: ServerResponse, response: RunResponse<T>): void {
  if (!response.ok) {
    sendJson(res, response.httpStatus, {
      code: response.code, message: response.message, ...(response.issues ? { issues: response.issues } : {}),
    });
    return;
  }
  sendJson(res, response.httpStatus, response.data, response.replayed ? { 'x-replayed': 'true' } : {});
}

export async function handleRunHttp(
  req: IncomingMessage,
  res: ServerResponse,
  accessor: RunIndexAccessor,
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
  const allowed = methodsFor(route.kind);
  if (!allowed.includes(method)) {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', `仅支持 ${allowed.join(', ')}`, allowed.join(', '));
    return;
  }

  const accountId = await sessionAccountFromRequest(req, sessions);
  if (!accountId) {
    sendError(res, 401, 'UNAUTHORIZED', '需要登录');
    return;
  }
  const ctx = { accountId };

  if (route.kind === 'status') {
    sendRunResponse(res, await getManagedRunStatus(accessor, ctx, route.runId));
    return;
  }
  if (route.kind === 'cancel') {
    sendRunResponse(res, await cancelManagedRun(accessor, ctx, route.runId));
    return;
  }

  if (method === 'GET') {
    const taskId = url.searchParams.get('taskId') ?? undefined;
    sendRunResponse(res, await listManagedRuns(accessor, ctx, { taskId }));
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req, maxBytes);
  } catch (error) {
    if (error instanceof HttpInputError) {
      sendError(res, error.status, 'BAD_REQUEST', error.message);
      return;
    }
    throw error;
  }
  sendRunResponse(res, await requestManagedRun(accessor, ctx, body));
}

/** 挂载运行索引接口。会话由服务端签发；客户端自报账号一律不参与鉴权。 */
export function createRunHttpServer(
  accessor: RunIndexAccessor, options: RunHttpOptions | SessionStore = {},
): Server {
  const resolved: RunHttpOptions = 'accountFor' in options ? { sessions: options as SessionStore } : options;
  const sessions = resolved.sessions ?? new InMemorySessionStore();
  const maxBytes = resolved.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return createServer((req, res) => {
    handleRunHttp(req, res, accessor, sessions, maxBytes).catch((error) => {
      console.error('run-api internal error', error);
      if (!res.headersSent) sendError(res, 500, 'INTERNAL', '服务器内部错误');
    });
  });
}
