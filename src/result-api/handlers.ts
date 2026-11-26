/**
 * 结果读取接口骨架（HTTP 无关）。三个 handler 对应 plan.md 拟定的三条 GET：
 *   GET /api/runs/:runId/results
 *   GET /api/runs/:runId/samples
 *   GET /api/runs/:runId/samples/:sampleId
 * 取值与统计复用 src/result-contract/contract.ts，避免结果页与契约口径分叉。
 * 本轮只交付可直接单测的纯函数与路由描述，不启动服务、不访问上游。
 */
import {
  aggregateBatch,
  filterResults,
  scoreSample,
  type BatchRollup,
  type FieldError,
  type MetricSummary,
  type MetricValue,
  type SampleFilter,
  type SampleResult,
} from '../result-contract/contract.ts';
import type {
  ReadStore,
  RunRecord,
  RunStatus,
  SampleRecord,
  TraceRef,
} from './store.ts';

export interface AuthContext {
  /** 由服务端从已验证会话取得，客户端不可传入 */
  accountId?: string;
  runId: string;
}

export type ReadErrorCode = 'UNAUTHORIZED' | 'NOT_FOUND';

export interface ReadError {
  ok: false;
  code: ReadErrorCode;
  httpStatus: 401 | 404;
  message: string;
}

export interface ReadSuccess<T> {
  ok: true;
  httpStatus: 200;
  data: T;
}

export type ReadResponse<T> = ReadSuccess<T> | ReadError;

function unauthorized(): ReadError {
  return { ok: false, code: 'UNAUTHORIZED', httpStatus: 401, message: '需要登录' };
}

/** 访问他人资源与访问不存在的资源统一为 404，不泄露资源是否存在。 */
function notFound(kind: string): ReadError {
  return { ok: false, code: 'NOT_FOUND', httpStatus: 404, message: `${kind}不可用` };
}

function isError(value: RunRecord | ReadError): value is ReadError {
  return 'ok' in value && value.ok === false;
}

function loadRun(store: ReadStore, ctx: AuthContext): RunRecord | ReadError {
  if (!ctx.accountId) return unauthorized();
  return store.findRunForAccount(ctx.runId, ctx.accountId) ?? notFound('运行');
}

/** 批次概览：整批口径，不受样本筛选影响。 */
export interface ResultsData {
  runId: string;
  taskId: string;
  datasetVersionId: string;
  ruleVersionId: string;
  ruleVersion: string;
  scoreRange?: RunRecord['rule']['scoreRange'];
  triggeredBy: RunRecord['triggeredBy'];
  triggeredAt: string;
  status: RunStatus;
  progress?: { completed: number; total: number };
  counts: BatchRollup['counts'];
  mean: number | null;
  meanPercent: string | null;
  metrics: MetricSummary[];
}

/** 样本明细的一行。 */
export interface SampleListItem {
  sampleId: string;
  query: string;
  answerSummary?: string;
  scoringStatus: SampleResult['status'];
  totalScore: number | null;
  metrics: Record<string, MetricValue | null>;
  /** 证据采集失败时的阶段，其他状态为空 */
  stage?: string;
  durationMs?: number;
  trace: TraceRef | null;
}

export interface SamplesData {
  total: number;
  items: SampleListItem[];
}

export interface ScoringView {
  status: SampleResult['status'];
  totalScore: number | null;
  metrics: Record<string, MetricValue | null>;
  reason?: string;
  allNA: boolean;
  errors: FieldError[];
  stage?: string;
}

export interface AttemptView {
  attemptId: string;
  scoring: ScoringView;
  /** 已脱敏的裁判响应原文；解析失败时仍完整保留 */
  rawResponse: string | null;
  businessJson: unknown;
}

export interface SampleDetailData {
  runId: string;
  sampleId: string;
  query: string;
  answer?: string;
  durationMs?: number;
  scoring: ScoringView;
  attempts: AttemptView[];
  businessJson: unknown;
  rawResponse: string | null;
  /** 评分失败时列出具体出错字段，成功时为空数组 */
  parseError: FieldError[];
  evidence?: SampleRecord['evidence'];
  trace: TraceRef | null;
  /** Trace 到期后详情仍来自本地保存的评分 */
  scoringFromLocalHistory: boolean;
}

function scoringView(result: SampleResult): ScoringView {
  if (result.status === 'scored') {
    return {
      status: result.status,
      totalScore: result.totalScore,
      metrics: result.metrics,
      reason: result.reason,
      allNA: result.allNA,
      errors: [],
    };
  }
  if (result.status === 'evidence_missing') {
    return {
      status: result.status,
      totalScore: null,
      metrics: {},
      allNA: false,
      errors: [],
      stage: result.stage,
    };
  }
  return {
    status: result.status,
    totalScore: null,
    metrics: {},
    allNA: false,
    errors: result.status === 'scoring_failed' ? result.errors : [],
  };
}

function scoreInRun(sample: SampleRecord, run: RunRecord): SampleResult {
  if (!sample.attempts.length && !sample.effectiveAttemptId && sample.evidence?.status !== 'failed') {
    if (run.status === 'queued' || run.status === 'running' || run.status === 'canceled') {
      return { sampleId: sample.id, status: run.status === 'canceled' ? 'canceled' : 'waiting', attempts: [] };
    }
  }
  return scoreSample(sample, run.rule);
}

function resultsOf(run: RunRecord): SampleResult[] {
  return run.samples.map((sample) => scoreInRun(sample, run));
}

export function getResults(
  store: ReadStore,
  ctx: AuthContext,
): ReadResponse<ResultsData> {
  const loaded = loadRun(store, ctx);
  if (isError(loaded)) return loaded;

  const rollup = aggregateBatch(resultsOf(loaded), loaded.rule);
  return {
    ok: true,
    httpStatus: 200,
    data: {
      runId: loaded.id,
      taskId: loaded.taskId,
      datasetVersionId: loaded.datasetVersionId,
      ruleVersionId: loaded.ruleVersionId,
      ruleVersion: loaded.rule.version,
      scoreRange: loaded.rule.scoreRange,
      triggeredBy: loaded.triggeredBy,
      triggeredAt: loaded.triggeredAt,
      status: loaded.status,
      progress: loaded.progress,
      counts: rollup.counts,
      mean: rollup.mean,
      meanPercent: rollup.meanPercent,
      metrics: rollup.metrics,
    },
  };
}

function listItem(sample: SampleRecord, result: SampleResult): SampleListItem {
  const view = scoringView(result);
  return {
    sampleId: sample.id,
    query: sample.query,
    answerSummary: sample.answerSummary,
    scoringStatus: view.status,
    totalScore: view.totalScore,
    metrics: view.metrics,
    stage: view.stage,
    durationMs: sample.durationMs,
    trace: sample.trace ?? null,
  };
}

export function listSamples(
  store: ReadStore,
  ctx: AuthContext,
  filter: SampleFilter = {},
): ReadResponse<SamplesData> {
  const loaded = loadRun(store, ctx);
  if (isError(loaded)) return loaded;

  const byId = new Map(loaded.samples.map((sample) => [sample.id, sample]));
  const matched = filterResults(resultsOf(loaded), filter);
  const items = matched.items.flatMap((result) => {
    const sample = byId.get(result.sampleId);
    return sample ? [listItem(sample, result)] : [];
  });
  return { ok: true, httpStatus: 200, data: { total: matched.total, items } };
}

export function getSample(
  store: ReadStore,
  ctx: AuthContext,
  sampleId: string,
): ReadResponse<SampleDetailData> {
  const loaded = loadRun(store, ctx);
  if (isError(loaded)) return loaded;

  const sample = loaded.samples.find((item) => item.id === sampleId);
  if (!sample) return notFound('样本');

  const effective = scoreInRun(sample, loaded);
  // 每次尝试单独评分，失败尝试不被删除，便于从详情核对同一次裁判的响应。
  const attempts: AttemptView[] = sample.attempts.map((attempt) => {
    const outcome = scoreSample(
      { ...sample, effectiveAttemptId: attempt.id },
      loaded.rule,
    );
    return {
      attemptId: attempt.id,
      scoring: scoringView(outcome),
      rawResponse: attempt.rawResponse,
      businessJson: 'businessJson' in outcome ? outcome.businessJson : attempt.businessJson ?? null,
    };
  });

  const view = scoringView(effective);
  const parseError = effective.status === 'scoring_failed' ? effective.errors : [];
  const businessJson = 'businessJson' in effective ? effective.businessJson : null;
  const rawResponse = effective.status === 'scoring_failed' || effective.status === 'scored'
    ? effective.rawResponse
    : sample.attempts.at(-1)?.rawResponse ?? null;

  return {
    ok: true,
    httpStatus: 200,
    data: {
      runId: loaded.id,
      sampleId: sample.id,
      query: sample.query,
      answer: sample.answer,
      durationMs: sample.durationMs,
      scoring: view,
      attempts,
      businessJson,
      rawResponse,
      parseError,
      evidence: sample.evidence,
      trace: sample.trace ?? null,
      scoringFromLocalHistory: sample.trace?.expired === true,
    },
  };
}

export interface ReadRoute {
  method: 'GET';
  path: string;
  description: string;
}

/** 供后续 HTTP 层挂载；路径与 plan.md 拟定接口一致。 */
export const resultReadRoutes: ReadRoute[] = [
  { method: 'GET', path: '/api/runs/:runId/results', description: '批次元数据、状态计数与指标汇总' },
  { method: 'GET', path: '/api/runs/:runId/samples', description: '样本明细筛选与分页' },
  { method: 'GET', path: '/api/runs/:runId/samples/:sampleId', description: '样本详情、尝试、业务 JSON 与证据引用' },
];

/** 把只读存储绑定到三个 handler，便于未来接入 node:http 或其他框架。 */
export function createResultReadApi(store: ReadStore) {
  return {
    routes: resultReadRoutes,
    getResults: (ctx: AuthContext) => getResults(store, ctx),
    listSamples: (ctx: AuthContext, filter?: SampleFilter) => listSamples(store, ctx, filter),
    getSample: (ctx: AuthContext, sampleId: string) => getSample(store, ctx, sampleId),
  };
}
