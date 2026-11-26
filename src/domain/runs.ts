/**
 * P2 阻塞期的运行索引领域契约（P5 准备）。
 *
 * 按 plan.md P5 与 readme.md 已确认的边界固化不依赖上游输入的部分：
 *  - 手动触发以「账号 + 请求 ID」幂等，定时触发以「账号 + 任务 ID + 上海时区计划时间」幂等；
 *  - 同一任务已有 queued/running 批次时跳过定时触发，不创建重复批次；
 *  - 运行记录持有任务与三个冻结版本引用、逐样本状态和尝试次数，归属取已持久化的任务所有者；
 *  - 取消只把本批未结束样本改为 canceled，保留已完成样本，不影响其他批次；
 *  - 所有读取与状态变更按账号限定，越权与不存在统一表现为查不到。
 *
 * 本层只做纯逻辑与内存实现；PostgreSQL 落盘、HTTP、真实 Runner 与调度回收留待后续增量。
 * 仅用 Node 22 内置 node:crypto / structuredClone；不访问 Docker、网络、上游或模型。
 */
import { randomUUID } from 'node:crypto';
import {
  deepFreeze,
  type BindingErrorCode,
  type ResourceCatalog,
  type VersionRef,
} from './resources.ts';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'partial_failed' | 'failed' | 'canceled';

export type SampleStatus =
  | 'waiting_agent'
  | 'agent_running'
  | 'waiting_trace'
  | 'waiting_scoring'
  | 'succeeded'
  | 'na'
  | 'agent_failed'
  | 'evidence_missing'
  | 'scoring_failed'
  | 'canceled';

export interface SampleRecord {
  readonly id: string;
  readonly status: SampleStatus;
  readonly attempts: number;
  readonly reason?: string;
}

/** 一次批次的冻结索引；samples 顺序与数据集冻结行顺序一致。 */
export interface RunRecord {
  readonly id: string;
  readonly ownerAccountId: string;
  readonly task: Readonly<VersionRef>;
  readonly trigger: 'manual' | 'scheduled';
  readonly idempotencyKey: string;
  readonly requestId?: string;
  readonly scheduledAt?: string;
  readonly scheduledTimezone?: 'Asia/Shanghai';
  readonly binding: Readonly<{
    scenario: Readonly<VersionRef>;
    dataset: Readonly<VersionRef>;
    rule: Readonly<VersionRef>;
  }>;
  readonly samples: readonly SampleRecord[];
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type RunIssueCode =
  | BindingErrorCode
  | 'RUN_ID_CONFLICT'
  | 'RUN_NOT_FOUND'
  | 'SAMPLE_MISMATCH'
  | 'SAMPLE_NOT_FOUND'
  | 'EMPTY_DATASET'
  | 'INVALID_TRANSITION';

export interface RunIssue {
  code: RunIssueCode;
  field: string;
  message: string;
}

export type RunResult =
  | { ok: true; value: RunRecord; replayed?: boolean }
  | { ok: false; issues: RunIssue[] };

export type RequestRunResult =
  | { ok: true; run: RunRecord; replayed: boolean; skipped: false }
  | { ok: true; run: undefined; replayed: false; skipped: true; reason: 'ACTIVE_RUN' }
  | { ok: false; issues: RunIssue[] };

export interface RunBindingRefs {
  scenario: VersionRef;
  dataset: VersionRef;
  rule: VersionRef;
}

export interface RequestRunInput {
  ownerAccountId: string;
  task: VersionRef;
  binding: RunBindingRefs;
  trigger: 'manual' | 'scheduled';
  /** 手动触发必填，仅在账号内去重。 */
  requestId?: string;
  /** 定时触发必填，格式为 Asia/Shanghai 墙上时间 +08:00。 */
  scheduledAt?: string;
  /** 省略时取数据集冻结行 ID；显式传入必须与冻结行完全一致。 */
  sampleIds?: string[];
  /** 可指定批次 ID；被任何账号占用时拒绝。 */
  runId?: string;
}

/**
 * 运行存储边界：save 是覆写式保存（状态流转写入新版本记录），其余读取均带归属。
 * findByIdempotency 与 activeForTask 只在账号内匹配，避免跨账号去重或跳过。
 */
export interface RunStore {
  save(record: RunRecord): RunRecord;
  peek(runId: string): RunRecord | undefined;
  get(runId: string, accountId: string | undefined): RunRecord | undefined;
  list(accountId: string | undefined): RunRecord[];
  findByIdempotency(ownerAccountId: string, key: string): RunRecord | undefined;
  activeForTask(ownerAccountId: string, taskId: string): RunRecord | undefined;
}

/** 内存实现：写入与读出都深冻结，避免调用方绕过领域规则修改历史记录。 */
export class InMemoryRunStore implements RunStore {
  private readonly byId = new Map<string, RunRecord>();

  save(record: RunRecord): RunRecord {
    const frozen = deepFreeze(structuredClone(record));
    this.byId.set(record.id, frozen);
    return frozen;
  }

  peek(runId: string): RunRecord | undefined {
    return this.byId.get(runId);
  }

  get(runId: string, accountId: string | undefined): RunRecord | undefined {
    if (!accountId) return undefined;
    const record = this.byId.get(runId);
    return record?.ownerAccountId === accountId ? record : undefined;
  }

  list(accountId: string | undefined): RunRecord[] {
    if (!accountId) return [];
    return [...this.byId.values()].filter((record) => record.ownerAccountId === accountId);
  }

  findByIdempotency(ownerAccountId: string, key: string): RunRecord | undefined {
    return [...this.byId.values()].find(
      (record) => record.ownerAccountId === ownerAccountId && record.idempotencyKey === key,
    );
  }

  activeForTask(ownerAccountId: string, taskId: string): RunRecord | undefined {
    return [...this.byId.values()].find(
      (record) => record.ownerAccountId === ownerAccountId
        && record.task.id === taskId
        && (record.status === 'queued' || record.status === 'running'),
    );
  }
}

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['running', 'canceled'],
  running: ['succeeded', 'partial_failed', 'failed', 'canceled'],
  succeeded: [],
  partial_failed: [],
  failed: [],
  canceled: [],
};

const SAMPLE_TRANSITIONS: Record<SampleStatus, readonly SampleStatus[]> = {
  waiting_agent: ['agent_running', 'canceled'],
  agent_running: ['waiting_trace', 'agent_failed', 'canceled'],
  waiting_trace: ['waiting_scoring', 'evidence_missing', 'canceled'],
  waiting_scoring: ['succeeded', 'na', 'scoring_failed', 'canceled'],
  succeeded: [],
  na: [],
  canceled: [],
  agent_failed: ['agent_running'],
  evidence_missing: [],
  scoring_failed: ['waiting_scoring'],
};

function issue(code: RunIssueCode, field: string, message: string): RunIssue {
  return { code, field, message };
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 已落定结果：失败状态仍可在运行期间重试，但也可以作为本批的最终结果。 */
function isSettledSample(status: SampleStatus): boolean {
  return status !== 'waiting_agent'
    && status !== 'agent_running'
    && status !== 'waiting_trace'
    && status !== 'waiting_scoring';
}

/** 校验上海时区墙上时间：格式严格、日期真实、偏移量固定 +08:00。 */
export function isShanghaiScheduleTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(value)) return false;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return false;
  return new Date(millis + 8 * 60 * 60 * 1000).toISOString().slice(0, 19) === value.slice(0, 19);
}

export interface RunIndexOptions {
  store?: RunStore;
  now?: () => string;
}

/**
 * 运行索引：所有写入前先按账号确认任务与冻结绑定，幂等与状态流转都落在同一存储边界。
 * 时钟由调用方注入，便于确定性测试与重启后接续。
 */
export class RunIndex {
  private readonly catalog: ResourceCatalog;
  private readonly store: RunStore;
  private readonly now: () => string;

  constructor(catalog: ResourceCatalog, options: RunIndexOptions = {}) {
    this.catalog = catalog;
    this.store = options.store ?? new InMemoryRunStore();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  requestRun(input: RequestRunInput): RequestRunResult {
    const issues: RunIssue[] = [];
    const owner = input?.ownerAccountId;
    if (!text(owner)) issues.push(issue('INVALID_INPUT', 'ownerAccountId', '账号不能为空'));
    if (input?.trigger !== 'manual' && input?.trigger !== 'scheduled') {
      issues.push(issue('INVALID_INPUT', 'trigger', '触发方式必须是 manual 或 scheduled'));
    }
    if (input?.runId !== undefined && !text(input.runId)) {
      issues.push(issue('INVALID_INPUT', 'runId', '批次 ID 不能为空'));
    }

    let idempotencyKey = '';
    if (input?.trigger === 'manual') {
      if (!text(input.requestId)) {
        issues.push(issue('INVALID_INPUT', 'requestId', '手动触发必须提供请求 ID'));
      } else {
        idempotencyKey = `manual:${encodeURIComponent(owner)}:${encodeURIComponent(input.requestId)}`;
      }
    } else if (input?.trigger === 'scheduled') {
      if (!isShanghaiScheduleTime(input.scheduledAt)) {
        issues.push(issue('INVALID_INPUT', 'scheduledAt', '计划时间必须是有效的 Asia/Shanghai 时间（+08:00）'));
      } else if (!text(input.task?.id)) {
        issues.push(issue('INVALID_INPUT', 'task.id', '定时触发必须提供任务 ID'));
      } else {
        idempotencyKey = `scheduled:${encodeURIComponent(owner)}:${encodeURIComponent(input.task.id)}:${input.scheduledAt}`;
      }
    }
    if (issues.length > 0) return { ok: false, issues };

    const checked = this.catalog.validateRunBindings(owner, input.task, input.binding);
    if (!checked.ok) return { ok: false, issues: checked.issues.map((item) => ({ ...item })) };
    const dataset = this.catalog.getDataset(input.binding.dataset, owner);
    if (!dataset) {
      return { ok: false, issues: [issue('DATASET_NOT_FOUND', 'binding.dataset', '数据集不存在或不属于当前账号')] };
    }

    const frozenRowIds = dataset.snapshot.rowIds;
    let sampleIds: string[];
    if (input.sampleIds === undefined) {
      sampleIds = [...frozenRowIds];
    } else if (!Array.isArray(input.sampleIds)
      || input.sampleIds.length !== frozenRowIds.length
      || input.sampleIds.some((id, index) => id !== frozenRowIds[index])) {
      return { ok: false, issues: [issue('SAMPLE_MISMATCH', 'sampleIds', '样本 ID 必须与数据集冻结行完全一致')] };
    } else {
      sampleIds = [...input.sampleIds];
    }
    if (sampleIds.length === 0) {
      return { ok: false, issues: [issue('EMPTY_DATASET', 'sampleIds', '数据集没有冻结样本行')] };
    }

    const replayed = this.store.findByIdempotency(owner, idempotencyKey);
    if (replayed) return { ok: true, run: replayed, replayed: true, skipped: false };
    if (input.trigger === 'scheduled' && this.store.activeForTask(owner, input.task.id)) {
      return { ok: true, run: undefined, replayed: false, skipped: true, reason: 'ACTIVE_RUN' };
    }

    const runId = input.runId ?? `RUN-${randomUUID().slice(0, 8)}`;
    if (this.store.peek(runId)) {
      return { ok: false, issues: [issue('RUN_ID_CONFLICT', 'runId', '批次 ID 已被使用')] };
    }
    const timestamp = this.now();
    const record: RunRecord = {
      id: runId,
      ownerAccountId: owner,
      task: { ...input.task },
      trigger: input.trigger,
      idempotencyKey,
      ...(input.trigger === 'manual'
        ? { requestId: input.requestId }
        : { scheduledAt: input.scheduledAt, scheduledTimezone: 'Asia/Shanghai' as const }),
      binding: {
        scenario: { ...input.binding.scenario },
        dataset: { ...input.binding.dataset },
        rule: { ...input.binding.rule },
      },
      samples: sampleIds.map((id) => ({ id, status: 'waiting_agent' as const, attempts: 0 })),
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return { ok: true, run: this.store.save(deepFreeze(record)), replayed: false, skipped: false };
  }

  transitionRun(runId: string, accountId: string | undefined, next: RunStatus): RunResult {
    if (next === 'canceled') return this.cancelRun(runId, accountId);
    const current = this.store.get(runId, accountId);
    if (!current) return { ok: false, issues: [issue('RUN_NOT_FOUND', 'runId', '批次不存在或不属于当前账号')] };
    if (!RUN_TRANSITIONS[current.status].includes(next)) {
      return { ok: false, issues: [issue('INVALID_TRANSITION', 'status', `${current.status} 不能转为 ${next}`)] };
    }
    if ((next === 'succeeded' || next === 'partial_failed' || next === 'failed')
      && current.samples.some((sample) => !isSettledSample(sample.status))) {
      return { ok: false, issues: [issue('INVALID_TRANSITION', 'status', '仍有未结束的样本，不能结束批次')] };
    }
    return { ok: true, value: this.store.save({ ...current, status: next, updatedAt: this.now() }) };
  }

  /** 取消只影响本批未结束样本；同批次重放幂等，其他账号与其他批次不受影响。 */
  cancelRun(runId: string, accountId: string | undefined): RunResult {
    const current = this.store.get(runId, accountId);
    if (!current) return { ok: false, issues: [issue('RUN_NOT_FOUND', 'runId', '批次不存在或不属于当前账号')] };
    if (current.status === 'canceled') return { ok: true, value: current, replayed: true };
    if (current.status !== 'queued' && current.status !== 'running') {
      return { ok: false, issues: [issue('INVALID_TRANSITION', 'status', `${current.status} 不能取消`)] };
    }
    const samples = current.samples.map((sample) => isSettledSample(sample.status)
      ? sample
      : { ...sample, status: 'canceled' as const, reason: '批次取消' });
    return {
      ok: true,
      value: this.store.save({ ...current, status: 'canceled', samples, updatedAt: this.now() }),
      replayed: false,
    };
  }

  /** 样本状态流转；失败样本重试时递增 attempts 并清除上次原因。 */
  setSampleStatus(
    runId: string,
    accountId: string | undefined,
    sampleId: string,
    next: SampleStatus,
    reason?: string,
  ): RunResult {
    const current = this.store.get(runId, accountId);
    if (!current) return { ok: false, issues: [issue('RUN_NOT_FOUND', 'runId', '批次不存在或不属于当前账号')] };
    if (current.status !== 'running') {
      return { ok: false, issues: [issue('INVALID_TRANSITION', 'status', '只有运行中的批次可以更新样本')] };
    }
    const index = current.samples.findIndex((sample) => sample.id === sampleId);
    if (index < 0) return { ok: false, issues: [issue('SAMPLE_NOT_FOUND', 'sampleId', '样本不属于该批次')] };
    const previous = current.samples[index];
    if (!SAMPLE_TRANSITIONS[previous.status].includes(next)) {
      return { ok: false, issues: [issue('INVALID_TRANSITION', 'status', `${previous.status} 不能转为 ${next}`)] };
    }
    const retried = (previous.status === 'agent_failed' && next === 'agent_running')
      || (previous.status === 'scoring_failed' && next === 'waiting_scoring');
    const updatedSample: SampleRecord = {
      id: previous.id,
      status: next,
      attempts: previous.attempts + (retried ? 1 : 0),
      ...(text(reason) ? { reason } : {}),
    };
    const samples = [...current.samples];
    samples[index] = updatedSample;
    return { ok: true, value: this.store.save({ ...current, samples, updatedAt: this.now() }) };
  }

  getRun(runId: string, accountId: string | undefined): RunRecord | undefined {
    return this.store.get(runId, accountId);
  }

  listRuns(accountId: string | undefined): RunRecord[] {
    return this.store.list(accountId);
  }

  listRunsForTask(accountId: string | undefined, taskId: string): RunRecord[] {
    return this.store.list(accountId).filter((run) => run.task.id === taskId);
  }
}
