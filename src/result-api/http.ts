/**
 * 结果读取接口的 HTTP 挂载（P1 阻塞期可准备工作）。
 * 把 src/result-api/handlers.ts 的三条 GET 挂到 node:http：
 *   GET /api/runs/:runId/results
 *   GET /api/runs/:runId/samples
 *   GET /api/runs/:runId/samples/:sampleId
 *
 * 身份只从服务端签发的会话取得：请求里的 accountId 查询参数或请求头一律不参与鉴权。
 * 会话创建/失效由服务端代码调用，不提供信任客户端输入的登录路由（登录方式待负责人选型）。
 * 仅用 Node 内置能力，不访问上游、不调用模型、不启动 Docker。
 */
import { sendJson } from '../http/json.ts';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { MetricValue, SampleFilter, SampleResult, TriState } from '../result-contract/contract.ts';
import { createResultReadApi, type ReadResponse } from './handlers.ts';
import type { ReadStore, RunRecord } from './store.ts';

export const SESSION_COOKIE = 'eval_session';

export interface SessionStore {
  /** 由服务端在已验证身份后签发，返回不可预测的会话令牌 */
  create(accountId: string): string;
  accountFor(token: string | undefined): string | undefined;
  invalidate(token: string): void;
}

/** 单机内存会话；重启即失效，持久化会话留待登录方案确定后实现。 */
export class InMemorySessionStore implements SessionStore {
  private readonly byToken = new Map<string, string>();

  create(accountId: string): string {
    if (!accountId?.trim()) throw new Error('账号 ID 不能为空');
    const token = randomBytes(24).toString('base64url');
    this.byToken.set(token, accountId);
    return token;
  }

  accountFor(token: string | undefined): string | undefined {
    return token ? this.byToken.get(token) : undefined;
  }

  invalidate(token: string): void {
    this.byToken.delete(token);
  }
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** 会话令牌支持 Cookie 与 Bearer 两种传输；二者都不允许调用方指定账号。 */
export interface SessionReader {
  accountFor(token: string | undefined): string | undefined | Promise<string | undefined>;
}

export function sessionAccountFromRequest(req: IncomingMessage, sessions: SessionStore): string | undefined;
export function sessionAccountFromRequest(req: IncomingMessage, sessions: SessionReader): ReturnType<SessionReader['accountFor']>;
export function sessionAccountFromRequest(req: IncomingMessage, sessions: SessionReader): ReturnType<SessionReader['accountFor']> {
  const fromCookie = cookieValue(req.headers.cookie, SESSION_COOKIE);
  if (fromCookie) return sessions.accountFor(fromCookie);
  const authorization = req.headers.authorization;
  if (authorization?.startsWith('Bearer ')) {
    return sessions.accountFor(authorization.slice('Bearer '.length).trim());
  }
  return undefined;
}

type ParsedRoute =
  | { kind: 'results'; runId: string }
  | { kind: 'samples'; runId: string }
  | { kind: 'sample'; runId: string; sampleId: string };

class BadRequest extends Error {}

function decode(part: string, label: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new BadRequest(`${label} 编码无效`);
  }
}

function parseRoute(pathname: string): ParsedRoute | undefined {
  const match = /^\/api\/runs\/([^/]+)\/(results|samples)(?:\/([^/]+))?$/.exec(pathname);
  if (!match) return undefined;
  const runId = decode(match[1]!, 'runId');
  if (match[2] === 'results') return match[3] ? undefined : { kind: 'results', runId };
  if (!match[3]) return { kind: 'samples', runId };
  return { kind: 'sample', runId, sampleId: decode(match[3], 'sampleId') };
}

const STATUSES: SampleResult['status'][] = ['scored', 'evidence_missing', 'scoring_failed', 'waiting', 'canceled'];

function numericParam(value: string | null, name: string): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (value.trim() === '' || !Number.isFinite(parsed)) {
    throw new BadRequest(`${name} 必须是有限数`);
  }
  return parsed;
}

function metricValueParam(value: string): MetricValue {
  if (value === 'Pass' || value === 'Fail' || value === 'NA') return value as TriState;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const parsed = Number(value);
  if (value.trim() !== '' && Number.isFinite(parsed)) return parsed;
  throw new BadRequest('metricValue 必须是 Pass / Fail / NA / true / false / 数值');
}

/** 只读取计划约定的筛选参数；未知参数（含 accountId）被忽略，不能影响归属。 */
export function parseSampleFilter(search: URLSearchParams): SampleFilter {
  const status = search.get('status');
  if (status !== null && !STATUSES.includes(status as SampleResult['status'])) {
    throw new BadRequest('status 取值无效');
  }
  const metricId = search.get('metricId');
  const rawMetricValue = search.get('metricValue');
  if ((metricId === null) !== (rawMetricValue === null)) {
    throw new BadRequest('metricId 与 metricValue 必须同时提供');
  }
  const limit = numericParam(search.get('limit'), 'limit');
  const offset = numericParam(search.get('offset'), 'offset');
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new BadRequest('limit 必须是正整数');
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new BadRequest('offset 必须是非负整数');
  const scoreMin = numericParam(search.get('scoreMin'), 'scoreMin');
  const scoreMax = numericParam(search.get('scoreMax'), 'scoreMax');
  if (scoreMin !== undefined && scoreMax !== undefined && scoreMin > scoreMax) throw new BadRequest('总分下限不能大于上限');
  return {
    status: status === null ? undefined : (status as SampleResult['status']),
    scoreMin,
    scoreMax,
    metricId: metricId ?? undefined,
    metricValue: rawMetricValue === null ? undefined : metricValueParam(rawMetricValue),
    limit,
    offset,
  };
}

function sendReadResponse<T>(res: ServerResponse, response: ReadResponse<T>): void {
  if (response.ok) {
    sendJson(res, response.httpStatus, response.data);
    return;
  }
  sendJson(res, response.httpStatus, { code: response.code, message: response.message });
}

interface ResultReader {
  findRunForAccount(runId: string, accountId: string): RunRecord | undefined | Promise<RunRecord | undefined>;
}

export async function handleResultHttp(req: IncomingMessage, res: ServerResponse, store: ResultReader, sessions: SessionReader): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', message: '仅支持 GET' }, { allow: 'GET' });
    return;
  }

  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    sendJson(res, 400, { code: 'BAD_REQUEST', message: 'URL 无效' });
    return;
  }

  let route: ParsedRoute | undefined;
  let filter: SampleFilter = {};
  try {
    route = parseRoute(url.pathname);
    if (route?.kind === 'samples') filter = parseSampleFilter(url.searchParams);
  } catch (error) {
    const message = error instanceof BadRequest ? error.message : '请求参数无效';
    sendJson(res, 400, { code: 'BAD_REQUEST', message });
    return;
  }
  if (!route) {
    sendJson(res, 404, { code: 'NOT_FOUND', message: '接口不可用' });
    return;
  }

  const accountId = await sessionAccountFromRequest(req, sessions);
  if (!accountId) {
    sendJson(res, 401, { code: 'UNAUTHORIZED', message: '需要登录' });
    return;
  }

  const record = await store.findRunForAccount(route.runId, accountId);
  const api = createResultReadApi({ findRunForAccount: (id, owner) =>
    record?.id === id && record.ownerAccountId === owner ? record : undefined });
  const ctx = { accountId, runId: route.runId };
  if (route.kind === 'results') {
    sendReadResponse(res, api.getResults(ctx));
  } else if (route.kind === 'samples') {
    sendReadResponse(res, api.listSamples(ctx, filter));
  } else {
    sendReadResponse(res, api.getSample(ctx, route.sampleId));
  }
}

/** 挂载三条结果读取接口。会话由服务端创建，绝不接受客户端自报账号。 */
export function createResultHttpServer(store: ReadStore, sessions: SessionStore = new InMemorySessionStore()): Server {
  return createServer((req, res) => {
    handleResultHttp(req, res, store, sessions).catch((error) => {
      // 内部错误不回显堆栈或上游信息，避免泄露凭据与实现细节。
      console.error('result-api internal error', error);
      if (!res.headersSent) sendJson(res, 500, { code: 'INTERNAL', message: '服务器内部错误' });
    });
  });
}
