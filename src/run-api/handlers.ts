/**
 * P5 运行索引的 HTTP 无关 handler（P2 阻塞期可准备工作）。
 *
 * 把 src/domain/runs.ts 的领域规则与 PG 适配层暴露为四个操作：
 *  - POST /api/runs              手动触发（归属取服务端会话，body 不能自报账号）；
 *  - POST /api/runs/:runId/cancel 取消本批未结束样本；
 *  - GET  /api/runs/:runId       批次状态详情；
 *  - GET  /api/runs              本人批次列表（可按 taskId 过滤）。
 *
 * 账号只来自服务端 AuthContext；越权与不存在统一 404，不泄露资源是否存在。
 * 输入形状错误 400，绑定／状态流转等领域错误 422，批次 ID 冲突 409。
 * 本层不访问 HTTP、不访问上游、不调用模型、不启动 Docker。
 */
import type { VersionRef } from '../domain/resources.ts';
import type {
  RequestRunInput, RequestRunResult, RunIssue, RunIssueCode, RunRecord, RunResult,
} from '../domain/runs.ts';

/** 手动触发请求体去掉归属字段；归属由服务端会话注入。 */
export type RunRequest = Omit<RequestRunInput, 'ownerAccountId'>;

/**
 * 运行索引访问边界：领域 RunIndex（同步）与 PG 适配层（异步）都可实现，
 * handler 统一 await，因此单元测试无需连接 PostgreSQL。
 */
export interface RunIndexAccessor {
  requestRun(owner: string, input: RunRequest): RequestRunResult | Promise<RequestRunResult>;
  cancelRun(runId: string, owner: string | undefined): RunResult | Promise<RunResult>;
  getRun(runId: string, owner: string | undefined): RunRecord | undefined | Promise<RunRecord | undefined>;
  listRuns(owner: string | undefined): RunRecord[] | Promise<RunRecord[]>;
  listRunsForTask(owner: string | undefined, taskId: string): RunRecord[] | Promise<RunRecord[]>;
}

/** 账号由服务端从已验证会话注入，调用方不能通过请求体切换身份。 */
export interface AuthContext {
  accountId?: string;
}

export interface RunTriggerBody {
  task?: unknown;
  binding?: unknown;
  requestId?: unknown;
  runId?: unknown;
  sampleIds?: unknown;
  /** 收到也不采信，仅用于演示「自报账号无效」。 */
  ownerAccountId?: unknown;
}

export interface RunListQuery {
  taskId?: string;
}

export type RunErrorCode = RunIssueCode | 'INVALID_INPUT' | 'UNAUTHORIZED' | 'NOT_FOUND';

export interface RunError {
  ok: false;
  httpStatus: 400 | 401 | 404 | 409 | 422;
  code: RunErrorCode;
  message: string;
  issues?: RunIssue[];
}

export interface RunSuccess<T> {
  ok: true;
  httpStatus: 200 | 201;
  data: T;
  replayed?: boolean;
}

export type RunResponse<T> = RunSuccess<T> | RunError;

/** 定时触发被活跃批次跳过的响应体：不创建批次，因此不返回 run。 */
export interface RunSkipped {
  skipped: true;
  reason: 'ACTIVE_RUN';
}

export interface RunListData {
  items: RunRecord[];
  total: number;
  taskId?: string;
}

function failure(
  code: RunErrorCode, httpStatus: RunError['httpStatus'], message: string, issues?: RunIssue[],
): RunError {
  return { ok: false, code, httpStatus, message, ...(issues ? { issues } : {}) };
}

function unauthorized(): RunError {
  return failure('UNAUTHORIZED', 401, '需要登录');
}

function badRequest(message: string, field = 'body'): RunError {
  return failure('INVALID_INPUT', 400, message, [{ code: 'INVALID_INPUT', field, message }]);
}

/** 领域 issues 到状态码：批次 ID 冲突 409、批次不存在 404，其余按输入/业务校验 422。 */
function issuesToError(issues: RunIssue[]): RunError {
  if (issues.some((item) => item.code === 'RUN_ID_CONFLICT')) {
    return failure('RUN_ID_CONFLICT', 409, '批次 ID 已被使用', issues);
  }
  if (issues.some((item) => item.code === 'RUN_NOT_FOUND')) {
    return failure('RUN_NOT_FOUND', 404, '批次不存在或不属于当前账号', issues);
  }
  return failure(issues[0]?.code ?? 'INVALID_INPUT', 422, issues[0]?.message ?? '运行请求未通过校验', issues);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseRef(value: unknown, field: string): VersionRef | RunError {
  if (!isRecord(value) || !text(value.id) || !text(value.version)) {
    return badRequest(`${field} 必须是含非空 id 与 version 的对象`, field);
  }
  return { id: value.id.trim(), version: value.version.trim() };
}

function parseRefs(value: unknown, field: string): Record<'scenario' | 'dataset' | 'rule', VersionRef> | RunError {
  if (!isRecord(value)) return badRequest(`${field} 必须是对象`, field);
  const result = {} as Record<'scenario' | 'dataset' | 'rule', VersionRef>;
  for (const kind of ['scenario', 'dataset', 'rule'] as const) {
    const parsed = parseRef(value[kind], `${field}.${kind}`);
    if ('httpStatus' in parsed) return parsed;
    result[kind] = parsed;
  }
  return result;
}

/** 形状校验只负责把 unknown 收敛为领域输入；归属、绑定一致性等仍由 RunIndex 复核。 */
function parseTriggerBody(body: RunTriggerBody): RunRequest | RunError {
  const task = parseRef(body.task, 'task');
  if ('httpStatus' in task) return task;
  const binding = parseRefs(body.binding, 'binding');
  if ('httpStatus' in binding) return binding;
  if (!text(body.requestId)) return badRequest('requestId 不能为空', 'requestId');
  if (body.runId !== undefined && !text(body.runId)) return badRequest('runId 必须是非空字符串', 'runId');
  let sampleIds: string[] | undefined;
  if (body.sampleIds !== undefined) {
    if (!Array.isArray(body.sampleIds) || !body.sampleIds.every(text)) {
      return badRequest('sampleIds 必须是非空字符串数组', 'sampleIds');
    }
    sampleIds = body.sampleIds.map((id) => id.trim());
  }
  return {
    task,
    binding,
    trigger: 'manual',
    requestId: body.requestId.trim(),
    ...(body.runId !== undefined ? { runId: body.runId.trim() } : {}),
    ...(sampleIds !== undefined ? { sampleIds } : {}),
  };
}

export async function requestManagedRun(
  accessor: RunIndexAccessor, ctx: AuthContext, body: RunTriggerBody,
): Promise<RunResponse<RunRecord | RunSkipped>> {
  if (!ctx.accountId) return unauthorized();
  const parsed = parseTriggerBody(body ?? {});
  if ('httpStatus' in parsed) return parsed;
  const result = await accessor.requestRun(ctx.accountId, parsed);
  if (!result.ok) return issuesToError(result.issues);
  if (result.skipped) return { ok: true, httpStatus: 200, data: { skipped: true, reason: result.reason } };
  return { ok: true, httpStatus: result.replayed ? 200 : 201, data: result.run, replayed: result.replayed };
}

export async function cancelManagedRun(
  accessor: RunIndexAccessor, ctx: AuthContext, runId: string,
): Promise<RunResponse<RunRecord>> {
  if (!ctx.accountId) return unauthorized();
  if (!text(runId)) return badRequest('runId 不能为空', 'runId');
  const result = await accessor.cancelRun(runId.trim(), ctx.accountId);
  if (!result.ok) return issuesToError(result.issues);
  return { ok: true, httpStatus: 200, data: result.value, replayed: result.replayed ?? false };
}

export async function getManagedRunStatus(
  accessor: RunIndexAccessor, ctx: AuthContext, runId: string,
): Promise<RunResponse<RunRecord>> {
  if (!ctx.accountId) return unauthorized();
  if (!text(runId)) return badRequest('runId 不能为空', 'runId');
  const record = await accessor.getRun(runId.trim(), ctx.accountId);
  if (!record) return failure('NOT_FOUND', 404, '批次不存在或不属于当前账号');
  return { ok: true, httpStatus: 200, data: record };
}

export async function listManagedRuns(
  accessor: RunIndexAccessor, ctx: AuthContext, query: RunListQuery = {},
): Promise<RunResponse<RunListData>> {
  if (!ctx.accountId) return unauthorized();
  if (query.taskId !== undefined && !text(query.taskId)) return badRequest('taskId 必须是非空字符串', 'taskId');
  const taskId = query.taskId?.trim();
  const items = taskId === undefined
    ? await accessor.listRuns(ctx.accountId)
    : await accessor.listRunsForTask(ctx.accountId, taskId);
  return { ok: true, httpStatus: 200, data: { items, total: items.length, ...(taskId ? { taskId } : {}) } };
}
