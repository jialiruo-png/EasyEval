/**
 * P3/P4 草稿与预览的 HTTP 挂载（阻塞期可准备工作）。
 *   POST   /api/drafts                          创建草稿
 *   GET    /api/drafts                          本人草稿列表
 *   GET    /api/drafts/:draftId                 草稿详情
 *   PATCH  /api/drafts/:draftId                 按 revision 更新
 *   POST   /api/drafts/:draftId/cancel          取消草稿
 *   POST   /api/drafts/:draftId/confirm         确认并返回冻结任务配置载荷
 *   GET    /api/drafts/:draftId/previews        预览列表
 *   POST   /api/drafts/:draftId/previews        按样本获取预览
 *   POST   /api/drafts/:draftId/previews/:sampleId/transition  状态流转
 *   POST   /api/drafts/:draftId/previews/:sampleId/retry       按条重试
 *
 * 身份只从服务端签发的会话取得；请求体自报 ownerAccountId 不参与鉴权。
 * 仅用 Node 内置能力，不访问上游、不调用模型、不启动 Docker。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { decodeSegment, HttpInputError, readJsonBody, sendError, sendJson } from '../http/json.ts';
import {
  InMemorySessionStore, sessionAccountFromRequest, type SessionReader, type SessionStore,
} from '../result-api/http.ts';
import {
  acquireManagedPreview, cancelManagedDraft, confirmManagedDraft, createManagedDraft,
  getManagedDraft, listManagedDrafts, listManagedPreviews, retryManagedPreview,
  transitionManagedPreview, updateManagedDraft,
  type DraftAccessor, type DraftResponse,
} from './handlers.ts';

export { InMemorySessionStore, SESSION_COOKIE } from '../result-api/http.ts';
export type { SessionStore } from '../result-api/http.ts';

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface DraftHttpOptions {
  sessions?: SessionStore;
  maxBodyBytes?: number;
}

type ParsedRoute =
  | { kind: 'collection' }
  | { kind: 'draft'; draftId: string }
  | { kind: 'cancel'; draftId: string }
  | { kind: 'confirm'; draftId: string }
  | { kind: 'previews'; draftId: string }
  | { kind: 'preview-action'; draftId: string; sampleId: string; action: 'transition' | 'retry' };

function parseRoute(pathname: string): ParsedRoute | undefined {
  if (pathname === '/api/drafts' || pathname === '/api/drafts/') return { kind: 'collection' };
  const action = /^\/api\/drafts\/([^/]+)\/previews\/([^/]+)\/(transition|retry)$/.exec(pathname);
  if (action) {
    return {
      kind: 'preview-action',
      draftId: decodeSegment(action[1]!, 'draftId'),
      sampleId: decodeSegment(action[2]!, 'sampleId'),
      action: action[3] as 'transition' | 'retry',
    };
  }
  const previews = /^\/api\/drafts\/([^/]+)\/previews$/.exec(pathname);
  if (previews) return { kind: 'previews', draftId: decodeSegment(previews[1]!, 'draftId') };
  const special = /^\/api\/drafts\/([^/]+)\/(cancel|confirm)$/.exec(pathname);
  if (special) {
    return { kind: special[2] as 'cancel' | 'confirm', draftId: decodeSegment(special[1]!, 'draftId') };
  }
  const draft = /^\/api\/drafts\/([^/]+)$/.exec(pathname);
  if (draft) return { kind: 'draft', draftId: decodeSegment(draft[1]!, 'draftId') };
  return undefined;
}

function methodsFor(kind: ParsedRoute['kind']): string[] {
  if (kind === 'collection') return ['GET', 'POST'];
  if (kind === 'draft') return ['GET', 'PATCH'];
  if (kind === 'previews') return ['GET', 'POST'];
  return ['POST'];
}

/** 判断路径是否属于草稿接口，供 server.ts 与其他 /api/drafts* 路由分流。 */
export function isDraftRoute(pathname: string): boolean {
  return pathname === '/api/drafts' || pathname === '/api/drafts/' || pathname.startsWith('/api/drafts/');
}

function sendDraftResponse<T>(res: ServerResponse, response: DraftResponse<T>): void {
  if (!response.ok) {
    sendJson(res, response.httpStatus, {
      code: response.code, message: response.message, ...(response.issues ? { issues: response.issues } : {}),
    });
    return;
  }
  sendJson(res, response.httpStatus, response.data, response.replayed ? { 'x-replayed': 'true' } : {});
}

export async function handleDraftHttp(
  req: IncomingMessage,
  res: ServerResponse,
  accessor: DraftAccessor,
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

  if (route.kind === 'collection') {
    if (method === 'GET') {
      sendDraftResponse(res, await listManagedDrafts(accessor, ctx));
      return;
    }
  } else if (route.kind === 'draft') {
    if (method === 'GET') {
      sendDraftResponse(res, await getManagedDraft(accessor, ctx, route.draftId));
      return;
    }
  } else if (route.kind === 'previews') {
    if (method === 'GET') {
      sendDraftResponse(res, await listManagedPreviews(accessor, ctx, route.draftId));
      return;
    }
  } else if (route.kind === 'cancel') {
    sendDraftResponse(res, await cancelManagedDraft(accessor, ctx, route.draftId));
    return;
  } else if (route.kind === 'preview-action') {
    if (route.action === 'retry') {
      sendDraftResponse(res, await retryManagedPreview(accessor, ctx, route.draftId, route.sampleId));
      return;
    }
  }

  // 其余分支均需读取 JSON 请求体；取消在上面已直接处理，因此可以省略请求体。
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

  if (route.kind === 'collection') sendDraftResponse(res, await createManagedDraft(accessor, ctx, body));
  else if (route.kind === 'draft') sendDraftResponse(res, await updateManagedDraft(accessor, ctx, route.draftId, body));
  else if (route.kind === 'confirm') sendDraftResponse(res, await confirmManagedDraft(accessor, ctx, route.draftId, body));
  else if (route.kind === 'previews') sendDraftResponse(res, await acquireManagedPreview(accessor, ctx, route.draftId, body));
  else if (route.kind === 'preview-action') {
    sendDraftResponse(res, await transitionManagedPreview(accessor, ctx, route.draftId, route.sampleId, body));
  }
}

/** 挂载草稿接口。会话由服务端签发；客户端自报账号一律不参与鉴权。 */
export function createDraftHttpServer(
  accessor: DraftAccessor, options: DraftHttpOptions | SessionStore = {},
): Server {
  const resolved: DraftHttpOptions = 'accountFor' in options ? { sessions: options as SessionStore } : options;
  const sessions = resolved.sessions ?? new InMemorySessionStore();
  const maxBytes = resolved.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return createServer((req, res) => {
    handleDraftHttp(req, res, accessor, sessions, maxBytes).catch((error) => {
      console.error('draft-api internal error', error);
      if (!res.headersSent) sendError(res, 500, 'INTERNAL', '服务器内部错误');
    });
  });
}
