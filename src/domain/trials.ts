/**
 * P4 前置的试评分缓存领域契约（第 4 步，最多两条）。
 *
 * 只固化 PRD 已确认的边界，不依赖 Docker、凭据、模型与上游实验：
 *  - 试评分只取草稿冻结样本的前 2 条，按账号＋草稿＋样本建条目；
 *  - 规则版本变化只使评分结果失效，场景／数据集／查询列／映射／样本变化
 *    同时使已完成的 Agent 预览结果不可复用；
 *  - 同签名复用例行评分，缺少匹配的成功预览时由上层先执行 Agent；
 *  - 评分条目只保存状态、尝试、结果与 Trace 引用，不写任务版本或正式运行；
 *  - 草稿取消或到期后旧结果不展示，读取按账号限定。
 *
 * 本层只提供纯逻辑与内存实现。评估器调用、Runner、HTTP 与持久化留给后续增量。
 */
import { createHash } from 'node:crypto';
import {
  deepFreeze,
  stableStringify,
  type ResourceCatalog,
  type VersionRef,
} from './resources.ts';
import {
  draftPreviewSignature,
  isDraftExpired,
  type DraftManager,
  type DraftRecord,
  type PreviewEntry,
} from './drafts.ts';

export const MAX_TRIAL_SAMPLES = 2;
export type TrialStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';

/** 规则产出的最小可展示结果；分值量纲由规则版本决定，这里不强制 0–100。 */
export interface TrialScoreResult {
  readonly score?: number | null;
  readonly reason?: string;
  readonly businessJson?: Readonly<Record<string, unknown>>;
}

export interface TrialScoreEntry {
  readonly key: string;
  readonly ownerAccountId: string;
  readonly draftId: string;
  readonly sampleId: string;
  /** 评分签名：规则版本、变量映射与 Agent 预览签名共同决定。 */
  readonly signature: string;
  /** 本条评分所依据的 Agent 预览签名，用于判断能否复用已有 Agent 结果。 */
  readonly agentSignature: string;
  readonly status: TrialStatus;
  readonly attempts: number;
  readonly result?: Readonly<TrialScoreResult>;
  readonly reason?: string;
  readonly traceRef?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TrialIssueCode =
  | 'INVALID_INPUT'
  | 'DRAFT_NOT_FOUND'
  | 'DRAFT_EXPIRED'
  | 'DRAFT_CANCELED'
  | 'DRAFT_CONFIRMED'
  | 'RULE_NOT_FOUND'
  | 'RULE_ARCHIVED'
  | 'TRIAL_NOT_FOUND'
  | 'TRIAL_LIMIT'
  | 'TRIAL_TRANSITION'
  | 'SAMPLE_NOT_IN_DRAFT';

export interface TrialIssue {
  code: TrialIssueCode;
  field: string;
  message: string;
}

export type TrialResult<T> =
  | { ok: true; value: T; replayed: boolean }
  | { ok: false; issues: TrialIssue[] };

export interface TrialStore {
  save(entry: TrialScoreEntry): TrialScoreEntry;
  get(key: string, accountId: string | undefined): TrialScoreEntry | undefined;
  listForDraft(draftId: string, accountId: string | undefined): TrialScoreEntry[];
  remove(key: string): void;
}

/** 与预览存储同样的归属语义：写入深冻结，读取按账号过滤。 */
export class InMemoryTrialStore implements TrialStore {
  private readonly byKey = new Map<string, TrialScoreEntry>();

  save(entry: TrialScoreEntry): TrialScoreEntry {
    const frozen = deepFreeze(structuredClone(entry));
    this.byKey.set(entry.key, frozen);
    return frozen;
  }

  get(key: string, accountId: string | undefined): TrialScoreEntry | undefined {
    if (!accountId) return undefined;
    const entry = this.byKey.get(key);
    return entry?.ownerAccountId === accountId ? entry : undefined;
  }

  listForDraft(draftId: string, accountId: string | undefined): TrialScoreEntry[] {
    if (!accountId) return [];
    return [...this.byKey.values()]
      .filter((entry) => entry.draftId === draftId && entry.ownerAccountId === accountId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sampleId.localeCompare(b.sampleId));
  }

  remove(key: string): void {
    this.byKey.delete(key);
  }
}

export interface TrialManagerOptions {
  store?: TrialStore;
  now?: () => string;
}

export interface TrialAcquisition {
  readonly entry: TrialScoreEntry;
  readonly created: boolean;
  /** 已有配置匹配且成功的 Agent 预览，评分可直接复用。 */
  readonly agentReusable: boolean;
  /** 缺少可复用的 Agent 结果，上层须先执行该样本再评分。 */
  readonly agentRunRequired: boolean;
}

export interface MarkTrialInput {
  readonly result?: TrialScoreResult;
  readonly reason?: string;
  readonly traceRef?: string;
}

export function trialKey(owner: string, draftId: string, sampleId: string): string {
  return `${owner}\u0000${draftId}\u0000${sampleId}`;
}

/** 评分签名排除场景／数据集／查询列本身，它们已通过 Agent 预览签名间接覆盖。 */
export function trialScoreSignature(
  draft: DraftRecord,
  sampleId: string,
  agentSignature: string,
): string {
  const mappings = [...draft.mappings].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
  const rule: VersionRef | null = draft.rule ? { id: draft.rule.id, version: draft.rule.version } : null;
  const payload = {
    ownerAccountId: draft.ownerAccountId,
    draftId: draft.id,
    sampleId,
    rule,
    mappings,
    agentSignature,
  };
  return createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex');
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function issue(code: TrialIssueCode, field: string, message: string): TrialIssue {
  return { code, field, message };
}

function failed(...issues: TrialIssue[]): TrialResult<never> {
  return { ok: false, issues };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeResult(value: TrialScoreResult | undefined): TrialScoreResult | undefined {
  if (!plainObject(value)) return undefined;
  const result: {
    score?: number | null;
    reason?: string;
    businessJson?: Record<string, unknown>;
  } = {};
  if (value.score !== undefined) {
    if (value.score !== null && (typeof value.score !== 'number' || !Number.isFinite(value.score))) {
      return undefined;
    }
    result.score = value.score;
  }
  if (value.reason !== undefined) {
    if (!text(value.reason)) return undefined;
    result.reason = value.reason.trim();
  }
  if (value.businessJson !== undefined) {
    if (!plainObject(value.businessJson)) return undefined;
    result.businessJson = structuredClone(value.businessJson);
  }
  if (Object.keys(result).length === 0) return undefined;
  return deepFreeze(result);
}

/**
 * 试评分索引：所有写操作先按账号加载草稿与当前条目，签名不符的旧条目不展示也不可变更。
 * 评分条目不保存 Agent 输出，只引用当前 Agent 预览的签名与可选 Trace。
 */
export class TrialScoreManager {
  private readonly catalog: ResourceCatalog;
  private readonly drafts: DraftManager;
  private readonly store: TrialStore;
  private readonly now: () => string;

  constructor(catalog: ResourceCatalog, drafts: DraftManager, options: TrialManagerOptions = {}) {
    this.catalog = catalog;
    this.drafts = drafts;
    this.store = options.store ?? new InMemoryTrialStore();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get(ownerAccountId: string | undefined, draftId: string, sampleId: string): TrialScoreEntry | undefined {
    const draft = this.drafts.get(ownerAccountId, draftId);
    if (!draft || !this.isVisibleDraft(draft)) return undefined;
    const entry = this.store.get(trialKey(ownerAccountId ?? '', draftId, sampleId), ownerAccountId);
    return entry && this.isCurrent(entry, draft, sampleId) ? entry : undefined;
  }

  list(ownerAccountId: string | undefined, draftId: string): TrialScoreEntry[] {
    const draft = this.drafts.get(ownerAccountId, draftId);
    if (!draft || !this.isVisibleDraft(draft)) return [];
    return this.currentEntries(ownerAccountId, draft);
  }

  /** 同签名复用例行；新条目先检查上限，并标记是否需要先跑 Agent。 */
  acquire(ownerAccountId: string | undefined, draftId: string, sampleId: string)
    : TrialResult<TrialAcquisition> {
    const active = this.requireActiveDraft(ownerAccountId, draftId);
    if (!active.ok) return active;
    const draft = active.value;
    if (!text(sampleId) || !draft.sampleIds.slice(0, MAX_TRIAL_SAMPLES).includes(sampleId)) {
      return failed(issue('SAMPLE_NOT_IN_DRAFT', 'sampleId',
        `试评分只取草稿冻结样本的前 ${MAX_TRIAL_SAMPLES} 条`));
    }
    const agentSignature = draftPreviewSignature(draft, sampleId);
    const signature = trialScoreSignature(draft, sampleId, agentSignature);
    const key = trialKey(draft.ownerAccountId, draftId, sampleId);
    const existing = this.store.get(key, ownerAccountId);
    if (existing) {
      if (existing.signature === signature && existing.agentSignature === agentSignature) {
        const reusable = this.hasReusablePreview(ownerAccountId, draftId, sampleId, agentSignature);
        return {
          ok: true,
          value: {
            entry: existing,
            created: false,
            agentReusable: Boolean(reusable),
            agentRunRequired: !reusable,
          },
          replayed: true,
        };
      }
      // 评分配置变化：旧结果不再展示，也不占用两条上限。
      this.store.remove(key);
    }
    if (this.currentEntries(ownerAccountId, draft).length >= MAX_TRIAL_SAMPLES) {
      return failed(issue('TRIAL_LIMIT', 'sampleId',
        `每个草稿最多保留 ${MAX_TRIAL_SAMPLES} 条试评分`));
    }
    const reusable = this.hasReusablePreview(ownerAccountId, draftId, sampleId, agentSignature);
    const at = this.now();
    const entry: TrialScoreEntry = {
      key,
      ownerAccountId: draft.ownerAccountId,
      draftId,
      sampleId,
      signature,
      agentSignature,
      status: 'pending',
      attempts: 1,
      createdAt: at,
      updatedAt: at,
    };
    return {
      ok: true,
      value: {
        entry: this.store.save(entry),
        created: true,
        agentReusable: Boolean(reusable),
        agentRunRequired: !reusable,
      },
      replayed: false,
    };
  }

  /** 评分状态流转；成功时必须提供可展示的结果，失败可带原因与 Trace 引用。 */
  mark(ownerAccountId: string | undefined, draftId: string, sampleId: string,
    status: TrialStatus, detail: MarkTrialInput = {}): TrialResult<TrialScoreEntry> {
    const draft = this.drafts.get(ownerAccountId, draftId);
    if (!draft) return failed(issue('DRAFT_NOT_FOUND', 'id', '草稿不存在或不属于当前账号'));
    if (draft.status === 'canceled' && status !== 'canceled') {
      return failed(issue('DRAFT_CANCELED', 'id', '草稿已取消，不能再流转试评分'));
    }
    const entry = this.requireCurrent(ownerAccountId, draft, sampleId);
    if (!entry.ok) return entry;
    const allowed: Record<TrialStatus, readonly TrialStatus[]> = {
      pending: ['running', 'succeeded', 'failed', 'canceled'],
      running: ['succeeded', 'failed', 'canceled'],
      succeeded: [],
      failed: [],
      canceled: [],
    };
    if (!allowed[entry.value.status].includes(status)) {
      return failed(issue('TRIAL_TRANSITION', 'status',
        `试评分状态 ${entry.value.status} 不能转为 ${status}`));
    }
    let result: TrialScoreResult | undefined;
    if (status === 'succeeded') {
      const normalized = normalizeResult(detail.result);
      if (!normalized) return failed(issue('INVALID_INPUT', 'result', '成功试评分必须提供有效结果'));
      result = normalized;
    }
    const updated = this.store.save({
      ...entry.value,
      status,
      ...(result ? { result } : {}),
      ...(text(detail.reason) ? { reason: detail.reason.trim() } : {}),
      ...(text(detail.traceRef) ? { traceRef: detail.traceRef.trim() } : {}),
      updatedAt: this.now(),
    });
    return { ok: true, value: updated, replayed: false };
  }

  /** 失败或取消的条目按条重试并递增尝试次数；仍在执行中的请求直接复用。 */
  retry(ownerAccountId: string | undefined, draftId: string, sampleId: string)
    : TrialResult<TrialScoreEntry> {
    const active = this.requireActiveDraft(ownerAccountId, draftId);
    if (!active.ok) return active;
    const entry = this.requireCurrent(ownerAccountId, active.value, sampleId);
    if (!entry.ok) return entry;
    if (entry.value.status === 'pending' || entry.value.status === 'running') {
      return { ok: true, value: entry.value, replayed: true };
    }
    if (entry.value.status !== 'failed' && entry.value.status !== 'canceled') {
      return failed(issue('TRIAL_TRANSITION', 'status', '已成功的试评分不能重试'));
    }
    const updated = this.store.save({
      ...entry.value,
      status: 'pending',
      attempts: entry.value.attempts + 1,
      result: undefined,
      reason: undefined,
      traceRef: undefined,
      updatedAt: this.now(),
    });
    return { ok: true, value: updated, replayed: false };
  }

  /** 取消草稿时由上层同事务调用：只停止本草稿未结束的试评分，不改已完成结果。 */
  cancelForDraft(ownerAccountId: string | undefined, draftId: string): TrialResult<number> {
    const draft = this.drafts.get(ownerAccountId, draftId);
    if (!draft) return failed(issue('DRAFT_NOT_FOUND', 'id', '草稿不存在或不属于当前账号'));
    let canceled = 0;
    for (const entry of this.currentEntries(ownerAccountId, draft)) {
      if (entry.status === 'pending' || entry.status === 'running') {
        this.store.save({ ...entry, status: 'canceled', updatedAt: this.now() });
        canceled += 1;
      }
    }
    return { ok: true, value: canceled, replayed: false };
  }

  private requireActiveDraft(ownerAccountId: string | undefined, draftId: string)
    : TrialResult<DraftRecord> {
    if (!text(ownerAccountId) || !text(draftId)) {
      return failed(issue('INVALID_INPUT', 'id', '账号与草稿 ID 不能为空'));
    }
    const draft = this.drafts.get(ownerAccountId, draftId);
    if (!draft) return failed(issue('DRAFT_NOT_FOUND', 'id', '草稿不存在或不属于当前账号'));
    if (isDraftExpired(draft, this.now)) return failed(issue('DRAFT_EXPIRED', 'id', '草稿已到期'));
    if (draft.status === 'canceled') return failed(issue('DRAFT_CANCELED', 'id', '草稿已取消'));
    if (draft.status === 'confirmed') return failed(issue('DRAFT_CONFIRMED', 'id', '草稿已确认'));
    if (!draft.rule) return failed(issue('INVALID_INPUT', 'rule', '试评分前必须选定规则版本'));
    if (!this.catalog.getRule(draft.rule, ownerAccountId)) {
      return failed(issue('RULE_NOT_FOUND', 'rule', '规则版本不存在或不属于当前账号'));
    }
    if (this.catalog.getArchive('rule', draft.rule, ownerAccountId)) {
      return failed(issue('RULE_ARCHIVED', 'rule', '规则版本已归档'));
    }
    return { ok: true, value: draft, replayed: false };
  }

  private requireCurrent(ownerAccountId: string | undefined, draft: DraftRecord, sampleId: string)
    : TrialResult<TrialScoreEntry> {
    const entry = this.store.get(trialKey(ownerAccountId ?? '', draft.id, sampleId), ownerAccountId);
    if (!entry || !this.isCurrent(entry, draft, sampleId)) {
      return failed(issue('TRIAL_NOT_FOUND', 'sampleId', '试评分不存在、已过期或不属于当前账号'));
    }
    return { ok: true, value: entry, replayed: false };
  }

  private currentEntries(ownerAccountId: string | undefined, draft: DraftRecord): TrialScoreEntry[] {
    return this.store.listForDraft(draft.id, ownerAccountId)
      .filter((entry) => this.isCurrent(entry, draft, entry.sampleId));
  }

  private isCurrent(entry: TrialScoreEntry, draft: DraftRecord, sampleId: string): boolean {
    if (!draft.sampleIds.slice(0, MAX_TRIAL_SAMPLES).includes(sampleId)) return false;
    const agentSignature = draftPreviewSignature(draft, sampleId);
    return entry.agentSignature === agentSignature
      && entry.signature === trialScoreSignature(draft, sampleId, agentSignature);
  }

  private isVisibleDraft(draft: DraftRecord): boolean {
    return draft.status !== 'canceled' && !isDraftExpired(draft, this.now);
  }

  private hasReusablePreview(ownerAccountId: string | undefined, draftId: string,
    sampleId: string, agentSignature: string): PreviewEntry | undefined {
    return this.drafts.listPreviews(ownerAccountId, draftId).find((entry) =>
      entry.sampleId === sampleId && entry.signature === agentSignature && entry.status === 'succeeded');
  }
}
