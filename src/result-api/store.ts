/**
 * 结果读取接口的只读数据模型与存储（P1 阻塞期可准备工作）。
 * 对应 plan.md「结果读取接口（拟定）」和 P1 第 3 项的归属边界：
 * 账号只能读到自己拥有的批次；账号不匹配与批次不存在在接口层统一为 404。
 * 只使用 Node 内置能力，不依赖 Docker、网络、模型或第三方包。
 */
import { deepFreeze } from '../domain/resources.ts';
import type {
  EvidenceRef,
  RuleDef,
  SampleInput,
} from '../result-contract/contract.ts';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'partial_failed'
  | 'failed'
  | 'canceled';

export interface TraceRef {
  traceId?: string;
  /** Trace 已到期或采集失败，但本地保存的评分详情仍可查看 */
  expired: boolean;
}

export interface SampleRecord extends SampleInput {
  /** 列表用的回答摘要；详情使用完整 answer */
  answerSummary?: string;
  answer?: string;
  /** 数据可用时的执行耗时 */
  durationMs?: number;
  trace?: TraceRef;
  evidence?: EvidenceRef;
}

export interface RunRecord {
  id: string;
  ownerAccountId: string;
  taskId: string;
  datasetVersionId: string;
  ruleVersionId: string;
  /** 运行时冻结的规则版本快照，聚合与取值都以此为准 */
  rule: RuleDef;
  triggeredBy: 'manual' | 'schedule';
  /** ISO 8601，带 Asia/Shanghai 偏移 */
  triggeredAt: string;
  status: RunStatus;
  progress?: { completed: number; total: number };
  samples: SampleRecord[];
}

export interface ReadStore {
  /** 账号与批次归属同时限定；未登录、越权与不存在均返回 undefined。 */
  findRunForAccount(runId: string, accountId: string | undefined): RunRecord | undefined;
}

/** 只读内存实现：为接口骨架与单元测试提供可复现数据，不代表最终持久化方案。 */
export class InMemoryReadStore implements ReadStore {
  private readonly runs = new Map<string, RunRecord>();

  constructor(records: RunRecord[] = []) {
    for (const record of records) this.add(record);
  }

  add(record: RunRecord): void {
    if (this.runs.has(record.id)) throw new Error('运行 ID 已存在');
    this.runs.set(record.id, deepFreeze(structuredClone(record)));
  }

  findRunForAccount(runId: string, accountId: string | undefined): RunRecord | undefined {
    if (!accountId) return undefined;
    const run = this.runs.get(runId);
    if (!run || run.ownerAccountId !== accountId) return undefined;
    return run;
  }
}

function requireNonEmpty(value: string, label: string): void {
  if (!value || !value.trim()) throw new Error(`${label} 不能为空`);
}

export function validateRunRecord(record: RunRecord): void {
  requireNonEmpty(record.id, 'runId');
  requireNonEmpty(record.ownerAccountId, 'ownerAccountId');

  const sampleIds = new Set<string>();
  for (const sample of record.samples) {
    requireNonEmpty(sample.id, 'sampleId');
    if (sampleIds.has(sample.id)) throw new Error(`样本 ID 重复：${sample.id}`);
    sampleIds.add(sample.id);
    const attemptIds = new Set<string>();
    for (const attempt of sample.attempts) {
      requireNonEmpty(attempt.id, 'attemptId');
      if (attemptIds.has(attempt.id)) {
        throw new Error(`样本 ${sample.id} 的尝试 ID 重复：${attempt.id}`);
      }
      attemptIds.add(attempt.id);
    }
    if (sample.effectiveAttemptId && !attemptIds.has(sample.effectiveAttemptId)) {
      throw new Error(`样本 ${sample.id} 的最终尝试 ${sample.effectiveAttemptId} 不存在`);
    }
  }
  if (record.progress) {
    const { completed, total } = record.progress;
    if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || completed < 0 || completed > total) {
      throw new Error('progress 必须为整数且满足 0 ≤ completed ≤ total');
    }
  }
}
