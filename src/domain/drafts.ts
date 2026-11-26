/**
 * P3/P4 前置的向导草稿与预览领域契约。
 *
 * 只固化 PRD 已确认的边界，不依赖 Docker、凭据、模型与上游实验：
 *  - 草稿按账号隔离，草稿 ID 带 draft: 前缀，与正式运行批次分属不同存储；
 *  - 默认 24 小时到期（时钟可注入），revision 乐观并发，取消与确认可重放；
 *  - 确认只产出冻结任务配置载荷，不写任务版本，也不产生运行；
 *  - 预览最多三条，签名由草稿 ID、Agent 场景版本、数据集版本、样本 ID
 *    与查询映射构成；签名相同复用原条目，配置变化即丢弃旧结果；
 *  - 预览只保存状态与可选 trace 引用，不保存 Agent 输出与评分。
 *
 * 本层只提供纯逻辑与内存实现。PostgreSQL 落盘、HTTP、Runner 与真实登录留给后续增量。
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  deepFreeze,
  stableStringify,
  type ResourceCatalog,
  type VariableMapping,
  type VersionRef,
} from './resources.ts';

/** 草稿 ID 固定前缀，使草稿与正式运行／任务 ID 在日志和链接中可区分。 */
export const DRAFT_ID_PREFIX = 'draft:';
export const MAX_PREVIEW_SAMPLES = 3;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export type DraftStep = 1 | 2 | 3 | 4;
export type DraftStatus = 'active' | 'canceled' | 'confirmed';
export type PreviewStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface DraftRecord {
  readonly id: string;
  readonly ownerAccountId: string;
  readonly step: DraftStep;
  readonly name?: string;
  readonly scenario: Readonly<VersionRef>;
  readonly dataset: Readonly<VersionRef>;
  readonly rule?: Readonly<VersionRef>;
  readonly queryColumn: string;
  readonly sampleIds: readonly string[];
  readonly mappings: readonly VariableMapping[];
  readonly status: DraftStatus;
  readonly revision: number;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 确认时冻结：同一幂等键重放返回同一份载荷。 */
  readonly confirmation?: Readonly<{
    key: string;
    name: string;
    taskRef: Readonly<VersionRef>;
  }>;
}

export interface DraftConfirmation {
  readonly sourceDraftId: string;
  readonly taskRef: Readonly<VersionRef>;
  readonly binding: Readonly<{
    name: string;
    scenario: Readonly<VersionRef>;
    dataset: Readonly<VersionRef>;
    rule: Readonly<VersionRef>;
    schedule: Readonly<{ enabled: false; timezone: 'Asia/Shanghai' }>;
    variableMappings: readonly VariableMapping[];
  }>;
  readonly queryColumn: string;
  readonly sampleIds: readonly string[];
}

export interface PreviewEntry {
  readonly key: string;
  readonly ownerAccountId: string;
  readonly draftId: string;
  readonly sampleId: string;
  /** 配置签名；与当前草稿签名不符的条目不得被展示。 */
  readonly signature: string;
  readonly status: PreviewStatus;
  readonly attempts: number;
  readonly reason?: string;
  readonly traceRef?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type DraftIssueCode =
  | 'INVALID_INPUT'
  | 'DRAFT_NOT_FOUND'
  | 'DRAFT_EXPIRED'
  | 'DRAFT_CANCELED'
  | 'DRAFT_CONFIRMED'
  | 'REVISION_CONFLICT'
  | 'ID_CONFLICT'
  | 'SAMPLE_LIMIT'
  | 'SAMPLE_NOT_IN_DATASET'
  | 'PREVIEW_NOT_FOUND'
  | 'PREVIEW_TRANSITION';

export interface DraftIssue {
  code: DraftIssueCode;
  field: string;
  message: string;
}

export type DraftResult<T> =
  | { ok: true; value: T; replayed: boolean }
  | { ok: false; issues: DraftIssue[] };

export interface DraftStore {
  save(record: DraftRecord): DraftRecord;
  peek(id: string): DraftRecord | undefined;
  get(id: string, accountId: string | undefined): DraftRecord | undefined;
  list(accountId: string | undefined): DraftRecord[];
}

export interface PreviewStore {
  save(entry: PreviewEntry): PreviewEntry;
  get(key: string, accountId: string | undefined): PreviewEntry | undefined;
  listForDraft(draftId: string, accountId: string | undefined): PreviewEntry[];
  remove(key: string): void;
}

/** 写入与读取都深冻结，避免调用方绕过 revision 直接修改历史草稿。 */
export class InMemoryDraftStore implements DraftStore {
  private readonly byId = new Map<string, DraftRecord>();

  save(record: DraftRecord): DraftRecord {
    const frozen = deepFreeze(structuredClone(record));
    this.byId.set(record.id, frozen);
    return frozen;
  }

  peek(id: string): DraftRecord | undefined {
    return this.byId.get(id);
  }

  get(id: string, accountId: string | undefined): DraftRecord | undefined {
    if (!accountId) return undefined;
    const record = this.byId.get(id);
    return record?.ownerAccountId === accountId ? record : undefined;
  }

  list(accountId: string | undefined): DraftRecord[] {
    if (!accountId) return [];
    return [...this.byId.values()]
      .filter((record) => record.ownerAccountId === accountId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
}

/** 键含账号、草稿与样本；读取仍按账号过滤，越权不会泄露他人预览状态。 */
export class InMemoryPreviewStore implements PreviewStore {
  private readonly byKey = new Map<string, PreviewEntry>();

  save(entry: PreviewEntry): PreviewEntry {
    const frozen = deepFreeze(structuredClone(entry));
    this.byKey.set(entry.key, frozen);
    return frozen;
  }

  get(key: string, accountId: string | undefined): PreviewEntry | undefined {
    if (!accountId) return undefined;
    const entry = this.byKey.get(key);
    return entry?.ownerAccountId === accountId ? entry : undefined;
  }

  listForDraft(draftId: string, accountId: string | undefined): PreviewEntry[] {
    if (!accountId) return [];
    return [...this.byKey.values()]
      .filter((entry) => entry.draftId === draftId && entry.ownerAccountId === accountId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sampleId.localeCompare(b.sampleId));
  }

  remove(key: string): void {
    this.byKey.delete(key);
  }
}

export interface CreateDraftInput {
  ownerAccountId: string;
  id?: string;
  step?: DraftStep;
  name?: string;
  scenario: VersionRef;
  dataset: VersionRef;
  rule?: VersionRef;
  queryColumn?: string;
  sampleIds?: string[];
  mappings?: VariableMapping[];
}

export interface UpdateDraftInput {
  expectedRevision: number;
  step?: DraftStep;
  name?: string;
  scenario?: VersionRef;
  dataset?: VersionRef;
  rule?: VersionRef;
  queryColumn?: string;
  sampleIds?: string[];
  mappings?: VariableMapping[];
}

export interface ConfirmDraftInput {
  taskRef: VersionRef;
  name: string;
  idempotencyKey: string;
  expectedRevision?: number;
}

export interface DraftOptions {
  store?: DraftStore;
  previewStore?: PreviewStore;
  now?: () => string;
  /** 默认 24 小时；可注入以验证过期路径。 */
  ttlMs?: number;
}

function issue(code: DraftIssueCode, field: string, message: string): DraftIssue {
  return { code, field, message };
}

function failed(...issues: DraftIssue[]): DraftResult<never> {
  return { ok: false, issues };
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validRef(value: unknown): value is VersionRef {
  return Boolean(value && typeof value === 'object'
    && text((value as VersionRef).id) && text((value as VersionRef).version));
}

function cloneRef(ref: VersionRef): VersionRef {
  return { id: ref.id, version: ref.version };
}

export function previewKey(owner: string, draftId: string, sampleId: string): string {
  return `${owner}\u0000${draftId}\u0000${sampleId}`;
}

function validateMappings(value: unknown, field: string): DraftIssue[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    return [issue('INVALID_INPUT', field, '变量映射必须是数组且不超过 32 项')];
  }
  const problems: DraftIssue[] = [];
  const seen = new Set<string>();
  value.forEach((mapping, index) => {
    const at = `${field}[${index}]`;
    if (!mapping || typeof mapping !== 'object') {
      problems.push(issue('INVALID_INPUT', at, '变量映射必须是对象'));
      return;
    }
    const candidate = mapping as VariableMapping;
    if (!text(candidate.placeholder)) problems.push(issue('INVALID_INPUT', `${at}.placeholder`, '占位符不能为空'));
    if (!['dataset', 'agent', 'trace'].includes(candidate.source)) {
      problems.push(issue('INVALID_INPUT', `${at}.source`, '来源必须是 dataset、agent 或 trace'));
    }
    if (!text(candidate.path)) problems.push(issue('INVALID_INPUT', `${at}.path`, '字段路径不能为空'));
    if (text(candidate.placeholder)) {
      if (seen.has(candidate.placeholder)) problems.push(issue('INVALID_INPUT', `${at}.placeholder`, '占位符不能重复'));
      seen.add(candidate.placeholder);
    }
  });
  return problems;
}

/** 草稿签名：覆盖会改变 Agent 预览的一切输入，键顺序与数组内映射顺序无关。 */
export function draftPreviewSignature(
  draft: DraftRecord,
  sampleId: string,
  mappings: readonly VariableMapping[] = draft.mappings,
): string {
  const payload = {
    draftId: draft.id,
    scenario: cloneRef(draft.scenario),
    dataset: cloneRef(draft.dataset),
    queryColumn: draft.queryColumn,
    sampleId,
    mappings: [...mappings].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
  };
  return createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex');
}

export function isDraftExpired(draft: DraftRecord, now: () => string): boolean {
  return Date.parse(now()) >= Date.parse(draft.expiresAt);
}

/**
 * 草稿与预览索引：所有写入前先按账号读取草稿并校验 revision、到期与冻结绑定。
 * 预览只在内存保存状态与引用，错误状态可按条重试，不触碰正式运行索引。
 */
export class DraftManager {
  private readonly catalog: ResourceCatalog;
  private readonly store: DraftStore;
  private readonly previews: PreviewStore;
  private readonly now: () => string;
  private readonly ttlMs: number;

  constructor(catalog: ResourceCatalog, options: DraftOptions = {}) {
    this.catalog = catalog;
    this.store = options.store ?? new InMemoryDraftStore();
    this.previews = options.previewStore ?? new InMemoryPreviewStore();
    this.now = options.now ?? (() => new Date().toISOString());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  get(ownerAccountId: string | undefined, draftId: string): DraftRecord | undefined {
    return this.store.get(draftId, ownerAccountId);
  }

  list(ownerAccountId: string | undefined): DraftRecord[] {
    return this.store.list(ownerAccountId);
  }

  create(input: CreateDraftInput): DraftResult<DraftRecord> {
    const problems: DraftIssue[] = [];
    if (!text(input?.ownerAccountId)) problems.push(issue('INVALID_INPUT', 'ownerAccountId', '账号不能为空'));
    const draftId = input.id ?? `${DRAFT_ID_PREFIX}${randomUUID()}`;
    if (!text(draftId) || !draftId.startsWith(DRAFT_ID_PREFIX) || draftId.length > 160) {
      problems.push(issue('INVALID_INPUT', 'id', `草稿 ID 必须以 ${DRAFT_ID_PREFIX} 开头`));
    }
    if (!validRef(input?.scenario)) problems.push(issue('INVALID_INPUT', 'scenario', '场景版本引用无效'));
    if (!validRef(input?.dataset)) problems.push(issue('INVALID_INPUT', 'dataset', '数据集版本引用无效'));
    if (input.rule !== undefined && !validRef(input.rule)) problems.push(issue('INVALID_INPUT', 'rule', '规则版本引用无效'));
    if (input.step !== undefined && ![1, 2, 3, 4].includes(input.step)) {
      problems.push(issue('INVALID_INPUT', 'step', '步骤必须是 1 至 4'));
    }
    problems.push(...validateMappings(input.mappings, 'mappings'));
    if (problems.length > 0) return failed(...problems);
    if (this.store.peek(draftId)) return failed(issue('ID_CONFLICT', 'id', '草稿 ID 已被占用'));
    if (!validRef(input.scenario) || !validRef(input.dataset)) return failed(issue('INVALID_INPUT', 'ref', '版本引用无效'));

    const binding = this.validateBinding(input.ownerAccountId, input.scenario, input.dataset,
      input.rule, input.queryColumn, input.sampleIds);
    if (!binding.ok) return binding;
    const createdAt = this.now();
    const expiresAt = new Date(Date.parse(createdAt) + this.ttlMs).toISOString();
    if (!Number.isFinite(Date.parse(expiresAt))) return failed(issue('INVALID_INPUT', 'now', '时钟返回的时间无效'));
    const record: DraftRecord = {
      id: draftId,
      ownerAccountId: input.ownerAccountId,
      step: input.step ?? 1,
      ...(text(input.name) ? { name: input.name.trim() } : {}),
      scenario: cloneRef(input.scenario),
      dataset: cloneRef(input.dataset),
      ...(input.rule ? { rule: cloneRef(input.rule) } : {}),
      queryColumn: binding.value.queryColumn,
      sampleIds: binding.value.sampleIds,
      mappings: (input.mappings ?? []).map((mapping) => ({ ...mapping })),
      status: 'active',
      revision: 1,
      expiresAt,
      createdAt,
      updatedAt: createdAt,
    };
    return { ok: true, value: this.store.save(record), replayed: false };
  }

  /** 加载草稿：到期草稿仍返回给界面展示，但任何写入都被拒绝。 */
  load(ownerAccountId: string | undefined, draftId: string): DraftResult<DraftRecord> {
    const draft = this.store.get(draftId, ownerAccountId);
    if (!draft) return failed(issue('DRAFT_NOT_FOUND', 'id', '草稿不存在或不属于当前账号'));
    if (isDraftExpired(draft, this.now)) return failed(issue('DRAFT_EXPIRED', 'id', '草稿已到期'));
    return { ok: true, value: draft, replayed: false };
  }

  update(ownerAccountId: string | undefined, draftId: string, input: UpdateDraftInput): DraftResult<DraftRecord> {
    const current = this.store.get(draftId, ownerAccountId);
    if (!current) return failed(issue('DRAFT_NOT_FOUND', 'id', '草稿不存在或不属于当前账号'));
    if (isDraftExpired(current, this.now)) return failed(issue('DRAFT_EXPIRED', 'id', '草稿已到期'));
    if (current.status === 'canceled') return failed(issue('DRAFT_CANCELED', 'id', '草稿已取消'));
    if (current.status === 'confirmed') return failed(issue('DRAFT_CONFIRMED', 'id', '草稿已确认'));
    if (!Number.isInteger(input?.expectedRevision) || input.expectedRevision !== current.revision) {
      return failed(issue('REVISION_CONFLICT', 'expectedRevision',
        `草稿已被更新，当前版本为 ${current.revision}`));
    }
    const problems: DraftIssue[] = [];
    if (input.step !== undefined && ![1, 2, 3, 4].includes(input.step)) {
      problems.push(issue('INVALID_INPUT', 'step', '步骤必须是 1 至 4'));
    }
    problems.push(...validateMappings(input.mappings, 'mappings'));
    if (problems.length > 0) return failed(...problems);

    const nextRefs = {
      scenario: input.scenario ?? current.scenario,
      dataset: input.dataset ?? current.dataset,
      rule: input.rule === undefined ? current.rule : input.rule,
    };
    if (!validRef(nextRefs.scenario) || !validRef(nextRefs.dataset)
      || (nextRefs.rule !== undefined && !validRef(nextRefs.rule))) {
      return failed(issue('INVALID_INPUT', 'ref', '版本引用无效'));
    }
    const binding = this.validateBinding(current.ownerAccountId, nextRefs.scenario, nextRefs.dataset,
      nextRefs.rule, input.queryColumn ?? current.queryColumn,
      input.sampleIds === undefined ? [...current.sampleIds] : input.sampleIds,
      nextRefs.dataset);
    if (!binding.ok) return binding;

    const updated: DraftRecord = {
      ...current,
      step: input.step ?? current.step,
      ...(input.name !== undefined ? { name: input.name } : {}),
      scenario: cloneRef(nextRefs.scenario),
      dataset: cloneRef(nextRefs.dataset),
      ...(nextRefs.rule ? { rule: cloneRef(nextRefs.rule) } : {}),
      queryColumn: binding.value.queryColumn,
      sampleIds: binding.value.sampleIds,
      mappings: (input.mappings ?? current.mappings).map((mapping) => ({ ...mapping })),
      revision: current.revision + 1,
      updatedAt: this.now(),
    };
    const saved = this.store.save(updated);
    // 数据集版本或样本变化时丢弃旧预览，避免界面把过期结果当成当前结果。
    for (const entry of this.previews.listForDraft(saved.id, current.ownerAccountId)) {
      if (!saved.sampleIds.includes(entry.sampleId)
        || draftPreviewSignature(saved, entry.sampleId) !== entry.signature) {
        this.previews.remove(entry.key);
      }
    }
    return { ok: true, value: saved, replayed: false };
  }

  cancel(ownerAccountId: string | undefined, draftId: string): DraftResult<DraftRecord> {
    const current = this.store.get(draftId, ownerAccountId);
    if (!current) return failed(issue('DRAFT_NOT_FOUND', 'id', '草稿不存在或不属于当前账号'));
    if (current.status === 'confirmed') return failed(issue('DRAFT_CONFIRMED', 'id', '已确认的草稿不能取消'));
    if (current.status === 'canceled') return { ok: true, value: current, replayed: true };
    const saved = this.store.save({
      ...current,
      status: 'canceled',
      revision: current.revision + 1,
      updatedAt: this.now(),
    });
    for (const entry of this.previews.listForDraft(draftId, current.ownerAccountId)) {
      if (entry.status === 'pending' || entry.status === 'running') {
        this.previews.save({ ...entry, status: 'canceled', updatedAt: saved.updatedAt });
      }
    }
    return { ok: true, value: saved, replayed: false };
  }

  /** 确认只产出任务配置载荷；同一幂等键重放返回同一份冻结结果，不创建任务或运行。 */
  confirm(ownerAccountId: string | undefined, draftId: string, input: ConfirmDraftInput): DraftResult<DraftConfirmation> {
    const current = this.store.get(draftId, ownerAccountId);
    if (!current) return failed(issue('DRAFT_NOT_FOUND', 'id', '草稿不存在或不属于当前账号'));
    if (!validRef(input?.taskRef)) return failed(issue('INVALID_INPUT', 'taskRef', '任务版本引用无效'));
    if (!text(input.idempotencyKey)) return failed(issue('INVALID_INPUT', 'idempotencyKey', '幂等键不能为空'));
    if (!text(input.name)) return failed(issue('INVALID_INPUT', 'name', '任务名称不能为空'));
    if (current.status === 'canceled') return failed(issue('DRAFT_CANCELED', 'id', '草稿已取消'));
    if (!current.rule) return failed(issue('INVALID_INPUT', 'rule', '确认前必须选定规则版本'));
    if (current.confirmation) {
      if (current.confirmation.key !== input.idempotencyKey) {
        return failed(issue('DRAFT_CONFIRMED', 'id', '草稿已用其他幂等键确认'));
      }
      return { ok: true, value: confirmationPayload(current), replayed: true };
    }
    if (isDraftExpired(current, this.now)) return failed(issue('DRAFT_EXPIRED', 'id', '草稿已到期'));
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
      return failed(issue('REVISION_CONFLICT', 'expectedRevision',
        `草稿已被更新，当前版本为 ${current.revision}`));
    }
    const saved = this.store.save({
      ...current,
      status: 'confirmed',
      revision: current.revision + 1,
      updatedAt: this.now(),
      confirmation: {
        key: input.idempotencyKey,
        name: input.name.trim(),
        taskRef: cloneRef(input.taskRef),
      },
    });
    return { ok: true, value: confirmationPayload(saved), replayed: false };
  }

  /** 相同签名返回既有预览；配置变化则丢弃旧条目并新建待执行预览。 */
  acquirePreview(ownerAccountId: string | undefined, draftId: string, sampleId: string)
    : DraftResult<{ entry: PreviewEntry; created: boolean }> {
    const loaded = this.load(ownerAccountId, draftId);
    if (!loaded.ok) return loaded;
    const draft = loaded.value;
    if (draft.status !== 'active') return failed(issue('DRAFT_CANCELED', 'id', '草稿不在编辑中'));
    if (!draft.sampleIds.includes(sampleId)) {
      return failed(issue('SAMPLE_NOT_IN_DATASET', 'sampleId', '样本不在草稿冻结的预览集合中'));
    }
    const signature = draftPreviewSignature(draft, sampleId);
    const key = previewKey(draft.ownerAccountId, draft.id, sampleId);
    const existing = this.previews.get(key, ownerAccountId);
    if (existing) {
      if (existing.signature === signature) return { ok: true, value: { entry: existing, created: false }, replayed: true };
      this.previews.remove(key);
    } else if (this.previews.listForDraft(draft.id, ownerAccountId).length >= MAX_PREVIEW_SAMPLES) {
      return failed(issue('SAMPLE_LIMIT', 'sampleId', `每个草稿最多保留 ${MAX_PREVIEW_SAMPLES} 条预览`));
    }
    const at = this.now();
    const entry: PreviewEntry = {
      key,
      ownerAccountId: draft.ownerAccountId,
      draftId: draft.id,
      sampleId,
      signature,
      status: 'pending',
      attempts: 1,
      createdAt: at,
      updatedAt: at,
    };
    return { ok: true, value: { entry: this.previews.save(entry), created: true }, replayed: false };
  }

  /** 预览状态流转；未结束与终态之间不能直接互换，失败重试走 retryPreview。 */
  markPreview(
    ownerAccountId: string | undefined,
    draftId: string,
    sampleId: string,
    status: PreviewStatus,
    detail: { reason?: string; traceRef?: string } = {},
  ): DraftResult<PreviewEntry> {
    const entry = this.requirePreview(ownerAccountId, draftId, sampleId);
    if (!entry.ok) return entry;
    const allowed: Record<PreviewStatus, readonly PreviewStatus[]> = {
      pending: ['running', 'succeeded', 'failed', 'canceled'],
      running: ['succeeded', 'failed', 'canceled'],
      succeeded: [],
      failed: [],
      canceled: [],
    };
    if (!allowed[entry.value.status].includes(status)) {
      return failed(issue('PREVIEW_TRANSITION', 'status',
        `预览状态 ${entry.value.status} 不能转为 ${status}`));
    }
    const updated = this.previews.save({
      ...entry.value,
      status,
      ...(text(detail.reason) ? { reason: detail.reason.trim() } : {}),
      ...(text(detail.traceRef) ? { traceRef: detail.traceRef.trim() } : {}),
      updatedAt: this.now(),
    });
    return { ok: true, value: updated, replayed: false };
  }

  /** 失败或取消的预览按条重试并递增尝试次数；仍在执行中的请求直接复用。 */
  retryPreview(ownerAccountId: string | undefined, draftId: string, sampleId: string)
    : DraftResult<PreviewEntry> {
    const entry = this.requirePreview(ownerAccountId, draftId, sampleId);
    if (!entry.ok) return entry;
    if (entry.value.status === 'pending' || entry.value.status === 'running') {
      return { ok: true, value: entry.value, replayed: true };
    }
    if (entry.value.status !== 'failed' && entry.value.status !== 'canceled') {
      return failed(issue('PREVIEW_TRANSITION', 'status', '已成功的预览不能重试'));
    }
    const updated = this.previews.save({
      ...entry.value,
      status: 'pending',
      attempts: entry.value.attempts + 1,
      reason: undefined,
      traceRef: undefined,
      updatedAt: this.now(),
    });
    return { ok: true, value: updated, replayed: false };
  }

  listPreviews(ownerAccountId: string | undefined, draftId: string): PreviewEntry[] {
    return this.previews.listForDraft(draftId, ownerAccountId);
  }

  private requirePreview(ownerAccountId: string | undefined, draftId: string, sampleId: string)
    : DraftResult<PreviewEntry> {
    const entry = this.previews.get(previewKey(ownerAccountId ?? '', draftId, sampleId), ownerAccountId);
    if (!entry) return failed(issue('PREVIEW_NOT_FOUND', 'sampleId', '预览不存在或不属于当前账号'));
    return { ok: true, value: entry, replayed: false };
  }

  private validateBinding(
    owner: string,
    scenario: VersionRef,
    dataset: VersionRef,
    rule: VersionRef | undefined,
    queryColumn: string | undefined,
    sampleIds: string[] | undefined,
    datasetRef: VersionRef = dataset,
  ): DraftResult<{ queryColumn: string; sampleIds: string[] }> {
    const problems: DraftIssue[] = [];
    if (!this.catalog.getScenario(scenario, owner)) {
      problems.push(issue('INVALID_INPUT', 'scenario', '场景版本不存在或不属于当前账号'));
    }
    const datasetVersion = this.catalog.getDataset(datasetRef, owner);
    if (!datasetVersion) {
      problems.push(issue('INVALID_INPUT', 'dataset', '数据集版本不存在或不属于当前账号'));
    }
    if (rule && !this.catalog.getRule(rule, owner)) {
      problems.push(issue('INVALID_INPUT', 'rule', '规则版本不存在或不属于当前账号'));
    }
    if (this.catalog.getArchive('dataset', datasetRef, owner)) {
      problems.push(issue('INVALID_INPUT', 'dataset', '数据集版本已归档'));
    }
    if (rule && this.catalog.getArchive('rule', rule, owner)) {
      problems.push(issue('INVALID_INPUT', 'rule', '规则版本已归档'));
    }
    let resolvedQuery = queryColumn?.trim() ?? datasetVersion?.snapshot.queryColumn;
    if (!text(resolvedQuery) || (datasetVersion && !datasetVersion.snapshot.columns.includes(resolvedQuery))) {
      problems.push(issue('INVALID_INPUT', 'queryColumn', '查询列必须是数据集冻结列中的非空文本列'));
      resolvedQuery = undefined;
    }
    const resolvedSamples = sampleIds === undefined
      ? (datasetVersion?.snapshot.rowIds.slice(0, MAX_PREVIEW_SAMPLES) ?? [])
      : [...sampleIds];
    if (resolvedSamples.length === 0 || resolvedSamples.length > MAX_PREVIEW_SAMPLES
      || resolvedSamples.some((id) => !text(id)) || new Set(resolvedSamples).size !== resolvedSamples.length
      || (datasetVersion && resolvedSamples.some((id) => !datasetVersion.snapshot.rowIds.includes(id)))) {
      problems.push(issue('SAMPLE_NOT_IN_DATASET', 'sampleIds',
        `预览样本必须是数据集冻结行中的唯一 ID，且不超过 ${MAX_PREVIEW_SAMPLES} 条`));
    }
    if (problems.length > 0 || !resolvedQuery) return failed(...problems);
    return { ok: true, value: { queryColumn: resolvedQuery, sampleIds: resolvedSamples }, replayed: false };
  }
}

function confirmationPayload(draft: DraftRecord): DraftConfirmation {
  const confirmation = draft.confirmation;
  if (!confirmation || !draft.rule) throw new Error('草稿尚未确认');
  return deepFreeze({
    sourceDraftId: draft.id,
    taskRef: cloneRef(confirmation.taskRef),
    binding: {
      name: confirmation.name,
      scenario: cloneRef(draft.scenario),
      dataset: cloneRef(draft.dataset),
      rule: cloneRef(draft.rule),
      schedule: { enabled: false as const, timezone: 'Asia/Shanghai' as const },
      variableMappings: draft.mappings.map((mapping) => ({ ...mapping })),
    },
    queryColumn: draft.queryColumn,
    sampleIds: [...draft.sampleIds],
  });
}
