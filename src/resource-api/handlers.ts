/**
 * P2 版本化资源管理接口骨架（HTTP 无关，P1 阻塞期可准备工作）。
 *
 * 对应 readme.md「创建人取登录账号，读取和修改时同时限定账号和资源 ID」与
 * plan.md P2「管理页三 Tab 的搜索、详情、复制都限定为当前账号」：
 *  - 场景配置、数据集、规则、任务配置的 list/get/create 三类操作；
 *  - 账号只来自服务端 AuthContext，请求体自称的 ownerAccountId 一律忽略；
 *  - 归属校验复用 ResourceCatalog：越权与不存在统一为 404，不泄露资源是否存在；
 *  - 写入复用同一份领域校验、内容哈希与任务绑定复核，错误映射为稳定状态码；
 *  - 同键同内容重复提交返回既有版本（200 + replayed），改内容或换归属为 409；
 *  - 复制生成带新 ID 的配置副本，只写配置、不产生运行，沿用源快照与版本引用。
 *
 * 仅用 Node 22 内置能力；不挂 HTTP、不访问上游、不调用模型、不启动 Docker。
 */
import { importDataset } from '../domain/dataset-rows.ts';
import { randomUUID } from 'node:crypto';
import {
  ResourceCatalog,
  ImmutableVersionConflict,
  resourceContentHash,
  type ArchivableResourceKind,
  type ArchivedResource,
  type BindingIssue,
  type DatasetSnapshot,
  type ResourceVersion,
  type ScenarioConfigSnapshot,
  type TaskBinding,
  type TaskReference,
  type VersionRef,
} from '../domain/resources.ts';
import type { RuleDef } from '../result-contract/contract.ts';

export type ManagedKind = 'scenario' | 'dataset' | 'rule' | 'task';

export const MANAGED_KINDS: readonly ManagedKind[] = ['scenario', 'dataset', 'rule', 'task'];

/** 账号由服务端从已验证会话注入，调用方不能通过请求体切换身份。 */
export interface AuthContext {
  accountId?: string;
}

/** 请求体形状：归属字段只用来演示「收到也不采信」，代码从不读取它。 */
export interface ResourceWriteInput {
  id?: unknown;
  version?: unknown;
  snapshot?: unknown;
  /** 任务配置使用 binding，其余三类使用 snapshot */
  binding?: unknown;
  ownerAccountId?: unknown;
}

export interface ResourceItem<T = unknown> {
  kind: ManagedKind;
  id: string;
  name: string;
  version: string;
  ownerAccountId: string;
  contentHash: string;
  createdAt: string;
  snapshot: T;
}

export interface ResourceListData {
  kind: ManagedKind;
  /** 账号限定并应用筛选后的命中总数，不受分页影响 */
  total: number;
  items: ResourceItem[];
  /** 回显实际生效的排序与分页，供管理页恢复视图 */
  query: ResourceListQueryApplied;
}

/** 历史快照可能没有名称，列表和详情统一回退到 ID。 */
export function resourceDisplayName(_kind: ManagedKind, snapshot: unknown, id: string): string {
  if (isRecord(snapshot) && typeof snapshot.name === 'string' && snapshot.name.trim()) return snapshot.name;
  return id;
}

export type ResourceSortBy = 'id' | 'name' | 'createdAt';
export type ResourceSortOrder = 'asc' | 'desc';

/** 三个管理 Tab 默认按创建时间倒序，场景选择列表默认按 ID 升序。 */
export interface ResourceListQuery {
  /** 名称或 ID 的模糊匹配（不区分大小写） */
  q?: string;
  /** 名称精确匹配（区分大小写） */
  name?: string;
  /** ID 精确匹配 */
  id?: string;
  /** 创建人精确匹配；与会话账号不符时结果为空，不泄露他人数据 */
  ownerAccountId?: string;
  /** 上海本地日期 YYYY-MM-DD，包含起止日，可只传一端。 */
  from?: string;
  to?: string;
  sortBy?: ResourceSortBy;
  order?: ResourceSortOrder;
  /** 1 起始页码 */
  page?: number;
  /** 每页条数，上限见 MAX_PAGE_SIZE */
  pageSize?: number;
}

export interface ResourceListQueryApplied extends ResourceListQuery {
  sortBy: ResourceSortBy;
  order: ResourceSortOrder;
  page: number;
  pageSize: number;
}

/** 页大小上限；避免本机服务被一次全表拉取拖垮。 */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

const shanghaiDay = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

function isCalendarDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isResourceSortBy(value: unknown): value is ResourceSortBy {
  return value === 'id' || value === 'name' || value === 'createdAt';
}

export function isResourceSortOrder(value: unknown): value is ResourceSortOrder {
  return value === 'asc' || value === 'desc';
}

/** 正整数且不超过上限；page 最小 1，pageSize 最小 1。 */
function validPage(value: number | undefined, max: number): boolean {
  return value === undefined || (Number.isInteger(value) && value >= 1 && value <= max);
}

export type ResourceErrorCode =
  | 'UNAUTHORIZED'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'BINDING_INVALID'
  | 'ACTIVE_TASK_REFERENCE';

export interface ResourceError {
  ok: false;
  httpStatus: 400 | 401 | 404 | 409 | 422;
  code: ResourceErrorCode;
  message: string;
  /** 任务绑定复核与归档冲突的逐字段错误，供向导定位到具体引用 */
  issues?: BindingIssue[];
  /** 归档被活跃任务阻挡时返回的引用任务，供界面提示先处理哪些任务 */
  references?: TaskReference[];
}

export interface ResourceSuccess<T> {
  ok: true;
  httpStatus: 200 | 201;
  data: T;
  replayed?: boolean;
}

export type ResourceResponse<T> = ResourceSuccess<T> | ResourceError;

const LABELS: Record<ManagedKind, string> = {
  scenario: '场景配置',
  dataset: '数据集',
  rule: '规则',
  task: '任务配置',
};

function failure(
  code: ResourceErrorCode,
  httpStatus: ResourceError['httpStatus'],
  message: string,
  issues?: BindingIssue[],
  references?: TaskReference[],
): ResourceError {
  return {
    ok: false,
    code,
    httpStatus,
    message,
    ...(issues ? { issues } : {}),
    ...(references ? { references } : {}),
  };
}

function unauthorized(): ResourceError {
  return failure('UNAUTHORIZED', 401, '需要登录');
}

function badRequest(message: string): ResourceError {
  return failure('INVALID_INPUT', 400, message);
}

function notFound(kind: ManagedKind): ResourceError {
  return failure('NOT_FOUND', 404, `${LABELS[kind]}不可用`);
}

function isManagedKind(kind: string): kind is ManagedKind {
  return MANAGED_KINDS.includes(kind as ManagedKind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRef(input: ResourceWriteInput | VersionRef): VersionRef | string {
  const ref = input as { id?: unknown; version?: unknown };
  if (typeof ref?.id !== 'string' || !ref.id.trim()) return 'id 必须是非空字符串';
  if (typeof ref?.version !== 'string' || !ref.version.trim()) return 'version 必须是非空字符串';
  return { id: ref.id, version: ref.version };
}

function toItem<T>(kind: ManagedKind, record: ResourceVersion<T>): ResourceItem<T> {
  return {
    kind,
    id: record.ref.id,
    name: resourceDisplayName(kind, record.snapshot, record.ref.id),
    version: record.ref.version,
    ownerAccountId: record.ownerAccountId,
    contentHash: record.contentHash,
    createdAt: record.createdAt,
    snapshot: record.snapshot,
  };
}

function listAll(
  catalog: ResourceCatalog,
  kind: ManagedKind,
  accountId: string,
): ResourceVersion<unknown>[] {
  if (kind === 'scenario') return catalog.listScenarios(accountId);
  if (kind === 'dataset') return catalog.listDatasets(accountId);
  if (kind === 'rule') return catalog.listRules(accountId);
  return catalog.listTasks(accountId);
}

function readOne(
  catalog: ResourceCatalog,
  kind: ManagedKind,
  ref: VersionRef,
  accountId: string,
): ResourceVersion<unknown> | undefined {
  if (kind === 'scenario') return catalog.getScenario(ref, accountId);
  if (kind === 'dataset') return catalog.getDataset(ref, accountId);
  if (kind === 'rule') return catalog.getRule(ref, accountId);
  return catalog.getTask(ref, accountId);
}

export function prepareResourceListQuery(
  ctx: AuthContext, kind: ManagedKind, query: ResourceListQuery,
): ResourceListQueryApplied | ResourceError {
  if (!ctx.accountId) return unauthorized();
  if (!isManagedKind(kind)) return badRequest('资源种类无效');
  if (typeof query !== 'object' || query === null || Array.isArray(query)) return badRequest('查询参数无效');
  if (query.q !== undefined && typeof query.q !== 'string') return badRequest('q 必须是字符串');
  if (query.name !== undefined && typeof query.name !== 'string') return badRequest('name 必须是字符串');
  if (query.id !== undefined && typeof query.id !== 'string') return badRequest('id 必须是字符串');
  if (query.ownerAccountId !== undefined && typeof query.ownerAccountId !== 'string') {
    return badRequest('ownerAccountId 必须是字符串');
  }
  if (query.sortBy !== undefined && !isResourceSortBy(query.sortBy)) return badRequest('sortBy 无效');
  if (query.order !== undefined && !isResourceSortOrder(query.order)) return badRequest('order 无效');
  if (!validPage(query.page, Number.MAX_SAFE_INTEGER)) return badRequest('page 必须是不小于 1 的整数');
  if (!validPage(query.pageSize, MAX_PAGE_SIZE)) {
    return badRequest(`pageSize 必须是 1 到 ${MAX_PAGE_SIZE} 的整数`);
  }

  const from = query.from === '' ? undefined : query.from;
  const to = query.to === '' ? undefined : query.to;
  if (from !== undefined && !isCalendarDate(from)) return badRequest('from 必须是有效日期 YYYY-MM-DD');
  if (to !== undefined && !isCalendarDate(to)) return badRequest('to 必须是有效日期 YYYY-MM-DD');
  if (from && to && from > to) return badRequest('创建止日不能早于创建起日');

  const sortBy = query.sortBy ?? (kind === 'scenario' ? 'id' : 'createdAt');
  const order = query.order ?? (query.sortBy === undefined && kind !== 'scenario' ? 'desc' : 'asc');
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  const applied: ResourceListQueryApplied = {
    sortBy,
    order,
    page,
    pageSize,
    ...(query.q !== undefined ? { q: query.q } : {}),
    ...(query.name !== undefined ? { name: query.name } : {}),
    ...(query.id !== undefined ? { id: query.id } : {}),
    ...(query.ownerAccountId !== undefined ? { ownerAccountId: query.ownerAccountId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };

  return applied;
}

/**
 * 列表只返回当前账号的版本；筛选在账号限定后的集合上进行，越权查询不泄露他人数据。
 * 排序主键相同时用 id+version 兜底，分页前计算命中总数。
 */
export function listManagedResources(
  catalog: ResourceCatalog,
  ctx: AuthContext,
  kind: ManagedKind,
  query: ResourceListQuery = {},
): ResourceResponse<ResourceListData> {
  if (!ctx.accountId) return unauthorized();
  const applied = prepareResourceListQuery(ctx, kind, query);
  if ('ok' in applied) return applied;
  const { from, to, sortBy, order, page, pageSize } = applied;
  // 创建人筛选只允许等于会话账号：他人账号直接得到空集合，不触碰其他账号数据。
  if (query.ownerAccountId !== undefined && query.ownerAccountId !== ctx.accountId) {
    return { ok: true, httpStatus: 200, data: { kind, total: 0, items: [], query: applied } };
  }
  const q = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
  const matched = listAll(catalog, kind, ctx.accountId)
    .map((record) => toItem(kind, record))
    .filter((item) => {
      if (query.id !== undefined && item.id !== query.id) return false;
      if (query.name !== undefined && item.name !== query.name) return false;
      if (q && !item.name.toLowerCase().includes(q) && !item.id.toLowerCase().includes(q)) return false;
      if (from || to) {
        const day = shanghaiDay.format(new Date(item.createdAt));
        if ((from && day < from) || (to && day > to)) return false;
      }
      return true;
    });

  const dir = order === 'desc' ? -1 : 1;
  const byKey = (a: ResourceItem, b: ResourceItem): number => {
    if (sortBy === 'createdAt') return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    return a.id.localeCompare(b.id);
  };
  matched.sort((a, b) => {
    const primary = byKey(a, b);
    if (primary !== 0) return dir * primary;
    // 主键相同时依次用 id、version 兜底，方向与 order 一致，保证排序确定。
    const byId = a.id.localeCompare(b.id);
    if (byId !== 0) return dir * byId;
    return dir * a.version.localeCompare(b.version);
  });

  const total = matched.length;
  const start = (page - 1) * pageSize;
  const items = matched.slice(start, start + pageSize);
  return { ok: true, httpStatus: 200, data: { kind, total, items, query: applied } };
}

/** 详情：越权与不存在统一为 404；快照由领域层深冻结，调用方无法改写已存版本。 */
export function getManagedResource(
  catalog: ResourceCatalog,
  ctx: AuthContext,
  kind: ManagedKind,
  ref: VersionRef,
): ResourceResponse<ResourceItem> {
  if (!ctx.accountId) return unauthorized();
  if (!isManagedKind(kind)) return badRequest('资源种类无效');
  const parsed = parseRef(ref);
  if (typeof parsed === 'string') return badRequest(parsed);
  const record = readOne(catalog, kind, parsed, ctx.accountId);
  if (!record) return notFound(kind);
  return { ok: true, httpStatus: 200, data: toItem(kind, record) };
}

/**
 * 写入一份版本。请求体不能指定归属；全部领域校验、绑定复核与不可变语义由
 * ResourceCatalog 执行，这里只做形状校验和稳定的错误码映射。
 */
export function createManagedResource(
  catalog: ResourceCatalog,
  ctx: AuthContext,
  kind: ManagedKind,
  input: ResourceWriteInput,
): ResourceResponse<ResourceItem> {
  if (!ctx.accountId) return unauthorized();
  if (!isManagedKind(kind)) return badRequest('资源种类无效');
  if (!isRecord(input)) return badRequest('请求体必须是对象');
  const parsed = parseRef(input);
  if (typeof parsed === 'string') return badRequest(parsed);
  const ref = parsed;
  const replayed = Boolean(readOne(catalog, kind, ref, ctx.accountId));

  try {
    let record: ResourceVersion<unknown>;
    if (kind === 'task') {
      if (!isRecord(input.binding)) return badRequest('binding 必须是对象');
      const result = catalog.createTaskConfig(ctx.accountId, ref, input.binding as unknown as TaskBinding);
      if (!result.ok) {
        const conflict = result.issues.find((entry) => entry.code === 'VERSION_CONFLICT');
        if (conflict) return failure('VERSION_CONFLICT', 409, conflict.message, result.issues);
        const code: ResourceErrorCode = result.issues.some((entry) => entry.code !== 'INVALID_INPUT')
          ? 'BINDING_INVALID'
          : 'INVALID_INPUT';
        return failure(code, 422, '任务绑定校验失败', result.issues);
      }
      record = result.value;
    } else {
      if (!isRecord(input.snapshot)) return badRequest('snapshot 必须是对象');
      if (kind === 'scenario') {
        record = catalog.putScenario(ctx.accountId, ref, input.snapshot as unknown as ScenarioConfigSnapshot);
      } else if (kind === 'dataset') {
        record = catalog.putDataset(ctx.accountId, ref, input.snapshot as unknown as DatasetSnapshot);
      } else {
        record = catalog.putRule(ctx.accountId, ref, input.snapshot as unknown as RuleDef);
      }
    }
    const data = toItem(kind, record);
    return replayed
      ? { ok: true, httpStatus: 200, data, replayed: true }
      : { ok: true, httpStatus: 201, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : '写入失败';
    if (error instanceof ImmutableVersionConflict) return failure('VERSION_CONFLICT', 409, message);
    if (error instanceof Error && 'code' in error) throw error;
    return failure('INVALID_INPUT', 422, message);
  }
}

/** 复制时可选指定新版本引用；省略时由服务端生成独立 ID。 */
export interface ResourceCopyInput {
  id?: unknown;
  version?: unknown;
  ownerAccountId?: unknown;
}

function copyRef(source: VersionRef, input: ResourceCopyInput): VersionRef | string {
  const id = input.id;
  const version = input.version;
  if (id !== undefined && (typeof id !== 'string' || !id.trim())) return 'id 必须是非空字符串';
  if (version !== undefined && (typeof version !== 'string' || !version.trim())) return 'version 必须是非空字符串';
  const nextId = typeof id === 'string' && id.trim() ? id.trim() : `${source.id}-copy-${randomUUID().slice(0, 8)}`;
  const nextVersion = typeof version === 'string' && version.trim() ? version.trim() : 'v1';
  if (nextId === source.id) return '副本必须使用新的 id';
  return { id: nextId, version: nextVersion };
}

/**
 * 复制一份带新 ID 的配置副本：源按账号限定，越权与不存在统一 404；
 * 副本沿用源快照（任务沿用整份冻结绑定）与引用，归属改写为当前会话账号。
 * 只调用写入接口，不触发运行；同键同内容幂等与冲突语义由写入接口复用。
 */
export function copyManagedResource(
  catalog: ResourceCatalog,
  ctx: AuthContext,
  kind: ManagedKind,
  source: VersionRef,
  input: ResourceCopyInput = {},
): ResourceResponse<ResourceItem> {
  if (!ctx.accountId) return unauthorized();
  if (!isManagedKind(kind)) return badRequest('资源种类无效');
  if (input !== undefined && !isRecord(input)) return badRequest('请求体必须是对象');
  const sourceRef = parseRef(source);
  if (typeof sourceRef === 'string') return badRequest(sourceRef);
  const record = readOne(catalog, kind, sourceRef, ctx.accountId);
  if (!record) return notFound(kind);
  const next = copyRef(sourceRef, input);
  if (typeof next === 'string') return badRequest(next);
  if (kind === 'dataset') {
    const store = catalog.datasetRowsFor(sourceRef);
    const sourceRows = store?.get(sourceRef, ctx.accountId);
    if (store && sourceRows) {
      try {
        const snapshot = record.snapshot as DatasetSnapshot;
        const copy = importDataset(catalog, store, ctx.accountId, next, {
          snapshot, rows: sourceRows.rows, contentChecksum: snapshot.contentChecksum,
        }, () => new Date().toISOString());
        return { ok: true, httpStatus: copy.replayed ? 200 : 201, data: toItem(kind, copy.record),
          ...(copy.replayed ? { replayed: true } : {}) };
      } catch (error) {
        const message = error instanceof Error ? error.message : '复制数据集失败';
        if (error instanceof ImmutableVersionConflict) return failure('VERSION_CONFLICT', 409, message);
        throw error;
      }
    }
  }
  let snapshot = record.snapshot;
  if ((kind === 'task' || kind === 'rule') && isRecord(snapshot)) {
    const existing = readOne(catalog, kind, next, ctx.accountId);
    const legacyReplay = existing?.contentHash === resourceContentHash(ctx.accountId, next, snapshot);
    if (!legacyReplay) {
      const name = resourceDisplayName(kind, snapshot, sourceRef.id);
      snapshot = kind === 'rule' ? { ...snapshot, ...next, name } : { ...snapshot, name };
    }
  }
  const inputSnapshot = kind === 'task' ? { binding: snapshot } : { snapshot };
  return createManagedResource(catalog, ctx, kind, { ...next, ...inputSnapshot });
}

/** 归档只标记冻结版本，返回可回显的状态与时间；场景配置不支持归档。 */
export interface ArchiveItem {
  kind: ArchivableResourceKind;
  ref: VersionRef;
  archived: true;
  archivedAt: string;
}

export interface ArchiveStatusData {
  kind: ArchivableResourceKind;
  ref: VersionRef;
  archived: boolean;
  archivedAt?: string;
}

export interface ResourceReferencesData {
  kind: 'dataset' | 'rule';
  ref: VersionRef;
  total: number;
  items: TaskReference[];
}

function isArchivableKind(kind: ManagedKind): kind is ArchivableResourceKind {
  return kind === 'dataset' || kind === 'rule' || kind === 'task';
}

function toArchiveItem(
  kind: ArchivableResourceKind,
  ref: VersionRef,
  record: ArchivedResource,
): ArchiveItem {
  return { kind, ref: { ...ref }, archived: true, archivedAt: record.archivedAt };
}

/**
 * 归档一份冻结版本：数据集／规则被未归档任务引用时返回 409 并列出引用任务，
 * 归档任务本身不需要检查引用；同键重放 200 + replayed，不改归档时间。
 * 越权与不存在统一 404，场景配置不支持归档返回 400。
 */
export function archiveManagedResource(
  catalog: ResourceCatalog,
  ctx: AuthContext,
  kind: ManagedKind,
  ref: VersionRef,
): ResourceResponse<ArchiveItem> {
  if (!ctx.accountId) return unauthorized();
  if (!isManagedKind(kind)) return badRequest('资源种类无效');
  if (!isArchivableKind(kind)) return badRequest('场景配置不支持归档');
  const parsed = parseRef(ref);
  if (typeof parsed === 'string') return badRequest(parsed);
  const result = catalog.archiveResource(kind, parsed, ctx.accountId);
  if (result.ok) {
    return {
      ok: true,
      httpStatus: 200,
      data: toArchiveItem(kind, parsed, result.value),
      ...(result.replayed ? { replayed: true } : {}),
    };
  }
  const first = result.issues[0];
  const message = first?.message ?? '归档失败';
  if (first?.code === 'ACTIVE_TASK_REFERENCE') {
    return failure('ACTIVE_TASK_REFERENCE', 409, message, result.issues, result.references);
  }
  if (first?.code === 'RESOURCE_NOT_FOUND') return notFound(kind);
  if (first?.code === 'ARCHIVE_CONFLICT') return failure('VERSION_CONFLICT', 409, message, result.issues);
  if (first?.code === 'INVALID_INPUT') return badRequest(message);
  return failure('BINDING_INVALID', 422, message, result.issues);
}

/** 归档状态回显：先按账号确认版本存在，再返回是否已归档及其时间。 */
export function getManagedArchiveStatus(
  catalog: ResourceCatalog,
  ctx: AuthContext,
  kind: ManagedKind,
  ref: VersionRef,
): ResourceResponse<ArchiveStatusData> {
  if (!ctx.accountId) return unauthorized();
  if (!isManagedKind(kind)) return badRequest('资源种类无效');
  if (!isArchivableKind(kind)) return badRequest('场景配置不支持归档');
  const parsed = parseRef(ref);
  if (typeof parsed === 'string') return badRequest(parsed);
  if (!readOne(catalog, kind, parsed, ctx.accountId)) return notFound(kind);
  const record = catalog.getArchive(kind, parsed, ctx.accountId);
  return {
    ok: true,
    httpStatus: 200,
    data: {
      kind,
      ref: { ...parsed },
      archived: Boolean(record),
      ...(record ? { archivedAt: record.archivedAt } : {}),
    },
  };
}

/**
 * 列出引用指定数据集／规则版本的本人任务，已归档任务也会返回并带 archived 标记，
 * 供管理页在归档前提示先处理哪些任务；越权与不存在统一 404。
 */
export function listResourceReferences(
  catalog: ResourceCatalog,
  ctx: AuthContext,
  kind: ManagedKind,
  ref: VersionRef,
): ResourceResponse<ResourceReferencesData> {
  if (!ctx.accountId) return unauthorized();
  if (!isManagedKind(kind)) return badRequest('资源种类无效');
  if (kind !== 'dataset' && kind !== 'rule') return badRequest('只有数据集与规则支持查看引用任务');
  const parsed = parseRef(ref);
  if (typeof parsed === 'string') return badRequest(parsed);
  if (!readOne(catalog, kind, parsed, ctx.accountId)) return notFound(kind);
  const items = [...catalog.listReferencingTasks(kind, parsed, ctx.accountId)].sort((a, b) =>
    a.ref.id.localeCompare(b.ref.id) || a.ref.version.localeCompare(b.ref.version));
  return { ok: true, httpStatus: 200, data: { kind, ref: { ...parsed }, total: items.length, items } };
}
