/**
 * P3/P4 向导草稿与预览的 HTTP 无关 handler（阻塞期可准备工作）。
 *
 * 把 src/domain/drafts.ts 契约与 PG 适配层暴露为统一操作：
 *  - POST   /api/drafts                         创建草稿
 *  - GET    /api/drafts                         本人草稿列表
 *  - GET    /api/drafts/:draftId                草稿详情
 *  - PATCH  /api/drafts/:draftId                按 revision 更新草稿
 *  - POST   /api/drafts/:draftId/cancel         取消草稿（可重放）
 *  - POST   /api/drafts/:draftId/confirm        确认并返回冻结任务配置载荷
 *  - GET    /api/drafts/:draftId/previews       该草稿预览列表
 *  - POST   /api/drafts/:draftId/previews       按样本获取预览（同签名复用）
 *  - POST   /api/drafts/:draftId/previews/:sampleId/transition  预览状态流转
 *  - POST   /api/drafts/:draftId/previews/:sampleId/retry       按条重试
 *
 * 账号只来自服务端 AuthContext；越权与不存在统一 404，不泄露资源是否存在。
 * 形状错误 400，revision／ID 冲突 409，领域校验与非法状态流转 422。
 * 本层不访问 HTTP、不访问上游、不调用模型、不启动 Docker。
 */
import { DRAFT_ID_PREFIX } from '../domain/drafts.ts';
import type {
  ConfirmDraftInput, CreateDraftInput, DraftConfirmation, DraftIssue, DraftIssueCode,
  DraftRecord, DraftResult, PreviewEntry, PreviewStatus, UpdateDraftInput,
} from '../domain/drafts.ts';
import type { VariableMapping, VersionRef } from '../domain/resources.ts';
import type { AuthContext } from '../run-api/handlers.ts';

export type { AuthContext } from '../run-api/handlers.ts';

/**
 * 草稿访问边界：同步 DraftManager 与异步 postgresDrafts 都可实现，
 * handler 统一 await，因此单元测试无需连接 PostgreSQL。
 */
export interface DraftAccessor {
  create(owner: string | undefined, input: Omit<CreateDraftInput, 'ownerAccountId'>): Promise<DraftResult<DraftRecord>>;
  get(owner: string | undefined, draftId: string): Promise<DraftRecord | undefined>;
  list(owner: string | undefined): Promise<DraftRecord[]>;
  update(owner: string | undefined, draftId: string, input: UpdateDraftInput): Promise<DraftResult<DraftRecord>>;
  cancel(owner: string | undefined, draftId: string): Promise<DraftResult<DraftRecord>>;
  confirm(owner: string | undefined, draftId: string, input: ConfirmDraftInput): Promise<DraftResult<DraftConfirmation>>;
  acquirePreview(
    owner: string | undefined, draftId: string, sampleId: string,
  ): Promise<DraftResult<{ entry: PreviewEntry; created: boolean }>>;
  markPreview(
    owner: string | undefined, draftId: string, sampleId: string, status: PreviewStatus,
    detail?: { reason?: string; traceRef?: string },
  ): Promise<DraftResult<PreviewEntry>>;
  retryPreview(owner: string | undefined, draftId: string, sampleId: string): Promise<DraftResult<PreviewEntry>>;
  listPreviews(owner: string | undefined, draftId: string): Promise<PreviewEntry[]>;
}

export type DraftErrorCode = DraftIssueCode | 'INVALID_INPUT' | 'UNAUTHORIZED' | 'NOT_FOUND';

export interface DraftError {
  ok: false;
  httpStatus: 400 | 401 | 404 | 409 | 422;
  code: DraftErrorCode;
  message: string;
  issues?: DraftIssue[];
}

export interface DraftSuccess<T> {
  ok: true;
  httpStatus: 200 | 201;
  data: T;
  replayed?: boolean;
}

export type DraftResponse<T> = DraftSuccess<T> | DraftError;

export interface DraftListData {
  items: DraftRecord[];
  total: number;
}

export interface PreviewListData {
  draftId: string;
  items: PreviewEntry[];
  total: number;
}

const PREVIEW_STATUSES: PreviewStatus[] = ['pending', 'running', 'succeeded', 'failed', 'canceled'];

function failure(
  code: DraftErrorCode, httpStatus: DraftError['httpStatus'], message: string, issues?: DraftIssue[],
): DraftError {
  return { ok: false, code, httpStatus, message, ...(issues ? { issues } : {}) };
}

function unauthorized(): DraftError {
  return failure('UNAUTHORIZED', 401, '需要登录');
}

function badRequest(message: string, field = 'body'): DraftError {
  return failure('INVALID_INPUT', 400, message, [{ code: 'INVALID_INPUT', field, message }]);
}

function notFound(): DraftError {
  return failure('NOT_FOUND', 404, '草稿不存在或不属于当前账号');
}

/** 领域 issues 到状态码：不存在 404、并发与 ID 冲突 409，其余按业务校验 422。 */
function issuesToError(issues: DraftIssue[]): DraftError {
  if (issues.some((item) => item.code === 'DRAFT_NOT_FOUND' || item.code === 'PREVIEW_NOT_FOUND')) {
    return failure('NOT_FOUND', 404, issues[0]?.message ?? '资源不存在或不属于当前账号', issues);
  }
  if (issues.some((item) => item.code === 'REVISION_CONFLICT' || item.code === 'ID_CONFLICT')) {
    return failure(issues[0]!.code, 409, issues[0]!.message, issues);
  }
  return failure(issues[0]?.code ?? 'INVALID_INPUT', 422, issues[0]?.message ?? '草稿请求未通过校验', issues);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseRef(value: unknown, field: string): VersionRef | DraftError {
  if (!isRecord(value) || !text(value.id) || !text(value.version)) {
    return badRequest(`${field} 必须是含非空 id 与 version 的对象`, field);
  }
  return { id: value.id.trim(), version: value.version.trim() };
}

function parseOptionalRef(body: Record<string, unknown>, field: string): VersionRef | undefined | DraftError {
  if (body[field] === undefined) return undefined;
  return parseRef(body[field], field);
}

function parseMappings(value: unknown): VariableMapping[] | DraftError {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) return badRequest('mappings 必须是数组且不超过 32 项', 'mappings');
  const mappings: VariableMapping[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || !text(item.placeholder) || !text(item.source) || !text(item.path)) {
      return badRequest(`mappings[${index}] 必须含非空 placeholder、source 与 path`, `mappings[${index}]`);
    }
    mappings.push({ placeholder: item.placeholder.trim(), source: item.source.trim(), path: item.path.trim() });
  }
  return mappings;
}

function parseSampleIds(value: unknown): string[] | DraftError {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(text)) return badRequest('sampleIds 必须是非空字符串数组', 'sampleIds');
  return value.map((id) => (id as string).trim());
}

function parseStep(value: unknown): 1 | 2 | 3 | 4 | undefined | DraftError {
  if (value === undefined) return undefined;
  if (![1, 2, 3, 4].includes(value as number)) return badRequest('step 必须是 1 至 4', 'step');
  return value as 1 | 2 | 3 | 4;
}

function parseRevision(value: unknown, required: boolean): number | undefined | DraftError {
  if (value === undefined) {
    return required ? badRequest('expectedRevision 不能为空', 'expectedRevision') : undefined;
  }
  if (!Number.isInteger(value) || (value as number) < 1) {
    return badRequest('expectedRevision 必须是正整数', 'expectedRevision');
  }
  return value as number;
}

function parseName(value: unknown, field: string, required = false): string | undefined | DraftError {
  if (value === undefined || value === null) {
    return required ? badRequest(`${field} 不能为空`, field) : undefined;
  }
  if (!text(value)) return badRequest(`${field} 必须是非空字符串`, field);
  return value.trim();
}

function inError<T>(value: T | DraftError): value is DraftError {
  return isRecord(value) && 'httpStatus' in value && 'code' in value;
}

/** 形状校验只把 unknown 收敛为领域输入；归属、绑定与状态规则仍由领域复核。 */
function parseCreateBody(body: Record<string, unknown>): Omit<CreateDraftInput, 'ownerAccountId'> | DraftError {
  const scenario = parseRef(body.scenario, 'scenario');
  if (inError(scenario)) return scenario;
  const dataset = parseRef(body.dataset, 'dataset');
  if (inError(dataset)) return dataset;
  const rule = parseOptionalRef(body, 'rule');
  if (inError(rule)) return rule;
  const id = parseName(body.id, 'id');
  if (inError(id)) return id;
  if (id !== undefined && !id.startsWith(DRAFT_ID_PREFIX)) {
    return badRequest(`草稿 ID 必须以 ${DRAFT_ID_PREFIX} 开头`, 'id');
  }
  const name = parseName(body.name, 'name');
  if (inError(name)) return name;
  const queryColumn = parseName(body.queryColumn, 'queryColumn');
  if (inError(queryColumn)) return queryColumn;
  const step = parseStep(body.step);
  if (inError(step)) return step;
  const sampleIds = parseSampleIds(body.sampleIds);
  if (inError(sampleIds)) return sampleIds;
  const mappings = parseMappings(body.mappings);
  if (inError(mappings)) return mappings;
  return {
    scenario, dataset,
    ...(rule ? { rule } : {}),
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(queryColumn ? { queryColumn } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(body.sampleIds !== undefined ? { sampleIds } : {}),
    ...(body.mappings !== undefined ? { mappings } : {}),
  };
}

function parseUpdateBody(body: Record<string, unknown>): UpdateDraftInput | DraftError {
  const expectedRevision = parseRevision(body.expectedRevision, true);
  if (inError(expectedRevision)) return expectedRevision;
  const scenario = parseOptionalRef(body, 'scenario');
  if (inError(scenario)) return scenario;
  const dataset = parseOptionalRef(body, 'dataset');
  if (inError(dataset)) return dataset;
  const rule = parseOptionalRef(body, 'rule');
  if (inError(rule)) return rule;
  const name = parseName(body.name, 'name');
  if (inError(name)) return name;
  const queryColumn = parseName(body.queryColumn, 'queryColumn');
  if (inError(queryColumn)) return queryColumn;
  const step = parseStep(body.step);
  if (inError(step)) return step;
  const sampleIds = parseSampleIds(body.sampleIds);
  if (inError(sampleIds)) return sampleIds;
  const mappings = parseMappings(body.mappings);
  if (inError(mappings)) return mappings;
  return {
    expectedRevision: expectedRevision!,
    ...(scenario ? { scenario } : {}),
    ...(dataset ? { dataset } : {}),
    ...(body.rule !== undefined ? { rule } : {}),
    ...(body.name !== undefined ? { name } : {}),
    ...(body.queryColumn !== undefined ? { queryColumn } : {}),
    ...(body.step !== undefined ? { step } : {}),
    ...(body.sampleIds !== undefined ? { sampleIds } : {}),
    ...(body.mappings !== undefined ? { mappings } : {}),
  };
}

function parseConfirmBody(body: Record<string, unknown>): ConfirmDraftInput | DraftError {
  const taskRef = parseRef(body.taskRef, 'taskRef');
  if (inError(taskRef)) return taskRef;
  const name = parseName(body.name, 'name', true);
  if (inError(name)) return name;
  const key = parseName(body.idempotencyKey, 'idempotencyKey', true);
  if (inError(key)) return key;
  const expectedRevision = parseRevision(body.expectedRevision, false);
  if (inError(expectedRevision)) return expectedRevision;
  return {
    taskRef, name: name!, idempotencyKey: key!,
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
  };
}

function requireAccount(ctx: AuthContext): string | DraftError {
  return ctx.accountId ? ctx.accountId : unauthorized();
}

function requireId(value: string, field: string): string | DraftError {
  return text(value) ? value.trim() : badRequest(`${field} 不能为空`, field);
}

async function requireOwnedDraft(
  accessor: DraftAccessor, owner: string, draftId: string,
): Promise<DraftRecord | DraftError> {
  const draft = await accessor.get(owner, draftId);
  return draft ?? notFound();
}

function sendResult<T>(result: DraftResult<T>, okStatus: 200 | 201): DraftResponse<T> {
  if (!result.ok) return issuesToError(result.issues);
  return { ok: true, httpStatus: result.replayed ? 200 : okStatus, data: result.value, replayed: result.replayed };
}

export async function createManagedDraft(
  accessor: DraftAccessor, ctx: AuthContext, body: Record<string, unknown> = {},
): Promise<DraftResponse<DraftRecord>> {
  const owner = requireAccount(ctx);
  if (inError(owner)) return owner;
  const parsed = parseCreateBody(body ?? {});
  if (inError(parsed)) return parsed;
  const result = await accessor.create(owner, parsed);
  return sendResult(result, 201);
}

export async function listManagedDrafts(
  accessor: DraftAccessor, ctx: AuthContext,
): Promise<DraftResponse<DraftListData>> {
  const owner = requireAccount(ctx);
  if (inError(owner)) return owner;
  const items = await accessor.list(owner);
  return { ok: true, httpStatus: 200, data: { items, total: items.length } };
}

export async function getManagedDraft(
  accessor: DraftAccessor, ctx: AuthContext, draftId: string,
): Promise<DraftResponse<DraftRecord>> {
  const owner = requireAccount(ctx);
  if (inError(owner)) return owner;
  const id = requireId(draftId, 'draftId');
  if (inError(id)) return id;
  const draft = await requireOwnedDraft(accessor, owner, id);
  if (inError(draft)) return draft;
  return { ok: true, httpStatus: 200, data: draft };
}

export async function updateManagedDraft(
  accessor: DraftAccessor, ctx: AuthContext, draftId: string, body: Record<string, unknown> = {},
): Promise<DraftResponse<DraftRecord>> {
  const owner = requireAccount(ctx);
  if (inError(owner)) return owner;
  const id = requireId(draftId, 'draftId');
  if (inError(id)) return id;
  const parsed = parseUpdateBody(body ?? {});
  if (inError(parsed)) return parsed;
  return sendResult(await accessor.update(owner, id, parsed), 200);
}

export async function cancelManagedDraft(
  accessor: DraftAccessor, ctx: AuthContext, draftId: string,
): Promise<DraftResponse<DraftRecord>> {
  const owner = requireAccount(ctx);
  if (inError(owner)) return owner;
  const id = requireId(draftId, 'draftId');
  if (inError(id)) return id;
  return sendResult(await accessor.cancel(owner, id), 200);
}

export async function confirmManagedDraft(
  accessor: DraftAccessor, ctx: AuthContext, draftId: string, body: Record<string, unknown> = {},
): Promise<DraftResponse<DraftConfirmation>> {
  const owner = requireAccount(ctx);
  if (inError(owner)) return owner;
  const id = requireId(draftId, 'draftId');
  if (inError(id)) return id;
  const parsed = parseConfirmBody(body ?? {});
  if (inError(parsed)) return parsed;
  return sendResult(await accessor.confirm(owner, id, parsed), 200);
}

export async function listManagedPreviews(
  accessor: DraftAccessor, ctx: AuthContext, draftId: string,
): Promise<DraftResponse<PreviewListData>> {
  const owner = requireAccount(ctx);
  if (inError(owner)) return owner;
  const id = requireId(draftId, 'draftId');
  if (inError(id)) return id;
  const draft = await requireOwnedDraft(accessor, owner, id);
  if (inError(draft)) return draft;
  const items = await accessor.listPreviews(owner, id);
  return { ok: true, httpStatus: 200, data: { draftId: id, items, total: items.length } };
}

export async function acquireManagedPreview(
  accessor: DraftAccessor, ctx: AuthContext, draftId: string, body: Record<string, unknown> = {},
): Promise<DraftResponse<PreviewEntry>> {
  const owner = requireAccount(ctx);
  if (inError(owner)) return owner;
  const id = requireId(draftId, 'draftId');
  if (inError(id)) return id;
  const sampleId = parseName(body.sampleId, 'sampleId', true);
  if (inError(sampleId)) return sampleId;
  const result = await accessor.acquirePreview(owner, id, sampleId!);
  if (!result.ok) return issuesToError(result.issues);
  return {
    ok: true, httpStatus: result.replayed ? 200 : 201,
    data: result.value.entry, replayed: result.replayed,
  };
}

export async function transitionManagedPreview(
  accessor: DraftAccessor, ctx: AuthContext, draftId: string, sampleId: string,
  body: Record<string, unknown> = {},
): Promise<DraftResponse<PreviewEntry>> {
  const owner = requireAccount(ctx);
  if (inError(owner)) return owner;
  const id = requireId(draftId, 'draftId');
  if (inError(id)) return id;
  const sample = requireId(sampleId, 'sampleId');
  if (inError(sample)) return sample;
  if (!PREVIEW_STATUSES.includes(body.status as PreviewStatus)) {
    return badRequest('status 必须是 pending、running、succeeded、failed 或 canceled', 'status');
  }
  const reason = parseName(body.reason, 'reason');
  if (inError(reason)) return reason;
  const traceRef = parseName(body.traceRef, 'traceRef');
  if (inError(traceRef)) return traceRef;
  return sendResult(await accessor.markPreview(owner, id, sample, body.status as PreviewStatus, {
    ...(reason ? { reason } : {}), ...(traceRef ? { traceRef } : {}),
  }), 200);
}

export async function retryManagedPreview(
  accessor: DraftAccessor, ctx: AuthContext, draftId: string, sampleId: string,
): Promise<DraftResponse<PreviewEntry>> {
  const owner = requireAccount(ctx);
  if (inError(owner)) return owner;
  const id = requireId(draftId, 'draftId');
  if (inError(id)) return id;
  const sample = requireId(sampleId, 'sampleId');
  if (inError(sample)) return sample;
  return sendResult(await accessor.retryPreview(owner, id, sample), 200);
}
