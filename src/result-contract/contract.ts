/**
 * 结果页领域契约参考实现（P1 阻塞期的可准备工作）。
 * 对应 plan.md「四、结果输出」：规则版本取值、校验、尝试保留、批次汇总与样本筛选。
 * 仅使用 Node 内置能力，不依赖 Docker、网络、模型或第三方包。
 */

export type TriState = 'Pass' | 'Fail' | 'NA';
export type MetricValue = TriState | boolean | number;
export type MetricType = 'tri-state' | 'boolean' | 'numeric';
export type TotalDerivation = 'tri-state-pass-rate' | 'declared';

export interface MetricDef {
  id: string;
  name: string;
  type: MetricType;
  /** 支持嵌套对象与数组按键选择，例如 secondary_dimensions[name=参数填充正确].result */
  path: string;
  unit?: string;
  min?: number;
  max?: number;
}

export interface RuleDef {
  /** 旧版已保存的评分快照可能省略名称。 */
  name?: string;
  id: string;
  version: string;
  totalScorePath: string;
  reasonPath?: string;
  scoreRange: { min: number; max: number };
  metrics: MetricDef[];
  totalScoreDerivation: TotalDerivation;
  /** 全 NA 时允许总分为 JSON null；其他情况 null 视为非法 */
  nullTotalWhenAllNA: boolean;
}

export interface JudgeAttempt {
  id: string;
  /** 脱敏后的裁判响应原文；解析失败时仍完整保留供详情查看 */
  rawResponse: string | null;
  /** 已由上游结构化的业务 JSON，可代替原文解析 */
  businessJson?: unknown;
}

export interface EvidenceRef {
  status: 'ok' | 'failed';
  stage?: string;
  traceId?: string;
}

export interface SampleInput {
  id: string;
  query: string;
  /** 保留全部尝试，失败尝试不删除 */
  attempts: JudgeAttempt[];
  /** 批次聚合只采用该最终尝试；缺省取最后一条 */
  effectiveAttemptId?: string;
  evidence?: EvidenceRef;
}

export type FailureCode =
  | 'INVALID_RULE'
  | 'INVALID_JSON'
  | 'MISSING_FIELD'
  | 'AMBIGUOUS_KEY'
  | 'INVALID_ENUM'
  | 'INVALID_TYPE'
  | 'OUT_OF_RANGE'
  | 'SCORE_MISMATCH'
  | 'INVALID_NULL_TOTAL'
  | 'NO_ATTEMPT';

export interface FieldError {
  code: FailureCode;
  path: string;
  detail: string;
}

export interface ScoredResult {
  sampleId: string;
  status: 'scored';
  attemptId: string;
  totalScore: number | null;
  allNA: boolean;
  metrics: Record<string, MetricValue | null>;
  reason?: string;
  businessJson: unknown;
  rawResponse: string | null;
  attempts: JudgeAttempt[];
}

export interface EvidenceMissingResult {
  sampleId: string;
  status: 'evidence_missing';
  stage: string;
  traceId?: string;
  attempts: JudgeAttempt[];
}

export interface ScoringFailedResult {
  sampleId: string;
  status: 'scoring_failed';
  errors: FieldError[];
  businessJson?: unknown;
  rawResponse: string | null;
  attempts: JudgeAttempt[];
}

export interface UnscoredResult {
  sampleId: string;
  status: 'waiting' | 'canceled';
  attempts: JudgeAttempt[];
}

export type SampleResult = ScoredResult | EvidenceMissingResult | ScoringFailedResult | UnscoredResult;

export interface MetricSummary {
  id: string;
  name: string;
  type: MetricType;
  unit?: string;
  label: string;
  pass?: number;
  fail?: number;
  na?: number;
  effective?: number;
  rate?: number | null;
  trueCount?: number;
  validCount?: number;
  mean?: number | null;
  count?: number;
}

export interface BatchRollup {
  total: number;
  counts: {
    numericTotal: number;
    allNA: number;
    evidenceMissing: number;
    scoringFailed: number;
    waiting: number;
    canceled: number;
    scoringFailureSubtotal: number;
  };
  /** 有数值总分的样本等权均分；有效的 0 计入分母 */
  mean: number | null;
  meanPercent: string | null;
  metrics: MetricSummary[];
}

export interface SampleFilter {
  status?: SampleResult['status'];
  scoreMin?: number;
  scoreMax?: number;
  metricId?: string;
  metricValue?: MetricValue;
  limit?: number;
  offset?: number;
}

interface PathSegment {
  key: string;
  selectorField?: string;
  selectorValue?: string;
}

function parsePath(path: string): PathSegment[] {
  return path.split('.').map((raw) => {
    const part = raw.trim();
    const match = /^([A-Za-z_$][\w$]*)(?:\[([A-Za-z_$][\w$]*)=([^\]]+)\])?$/.exec(part);
    if (!match) throw new Error(`非法字段路径：${path}（片段 ${part}）`);
    return { key: match[1], selectorField: match[2], selectorValue: match[3] };
  });
}

/** 写入时和读取历史规则时使用同一份评分契约校验。 */
export function validateRuleDefinition(rule: RuleDef): void {
  if (!rule || !Array.isArray(rule.metrics) || !rule.metrics.length) throw new Error('规则指标不能为空');
  if (!Number.isFinite(rule.scoreRange?.min) || !Number.isFinite(rule.scoreRange?.max)
    || rule.scoreRange.min >= rule.scoreRange.max) throw new Error('总分上下限无效');
  if (!['declared', 'tri-state-pass-rate'].includes(rule.totalScoreDerivation)
    || typeof rule.nullTotalWhenAllNA !== 'boolean') throw new Error('总分计算方式或空值策略无效');
  const ids = new Set<string>();
  const paths = [rule.totalScorePath];
  if (rule.reasonPath !== undefined) paths.push(rule.reasonPath);
  for (const metric of rule.metrics) {
    if (typeof metric?.id !== 'string' || !metric.id.trim() || ids.has(metric.id)) {
      throw new Error('指标 ID 必须非空且唯一');
    }
    ids.add(metric.id);
    if (typeof metric.name !== 'string' || !metric.name.trim()
      || !['tri-state', 'numeric', 'boolean'].includes(metric.type)) throw new Error('指标名称或类型无效');
    if ((metric.min !== undefined && !Number.isFinite(metric.min))
      || (metric.max !== undefined && !Number.isFinite(metric.max))
      || (metric.min !== undefined && metric.max !== undefined && metric.min > metric.max)) throw new Error('指标上下限无效');
    paths.push(metric.path);
  }
  for (const path of paths) {
    if (typeof path !== 'string' || !path.trim()) throw new Error('评分字段路径不能为空');
    parsePath(path);
  }
  if (rule.totalScoreDerivation === 'tri-state-pass-rate'
    && !rule.metrics.some((metric) => metric.type === 'tri-state')) throw new Error('通过率计算需要三态指标');
}

function allMetricsNA(rule: RuleDef, metrics: Record<string, MetricValue | null>): boolean {
  return rule.metrics.length > 0 && rule.metrics.every((metric) => metrics[metric.id] === 'NA');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function selectFromArray(
  value: unknown,
  segment: PathSegment,
  path: string,
  errors: FieldError[],
): unknown {
  if (!Array.isArray(value)) {
    errors.push({ code: 'MISSING_FIELD', path, detail: `${segment.key} 不是可按业务键选择的数组` });
    return undefined;
  }
  const field = segment.selectorField;
  const wanted = segment.selectorValue;
  if (!field || wanted === undefined) {
    errors.push({ code: 'MISSING_FIELD', path, detail: `${segment.key} 是数组，必须提供 [字段=值] 选择器` });
    return undefined;
  }
  const matches = value.filter(
    (item) => isObject(item) && Object.hasOwn(item, field) && String(item[field]) === wanted,
  );
  if (matches.length === 0) {
    errors.push({ code: 'MISSING_FIELD', path, detail: `数组 ${segment.key} 中没有 ${field}=${wanted}` });
    return undefined;
  }
  if (matches.length > 1) {
    errors.push({
      code: 'AMBIGUOUS_KEY',
      path,
      detail: `数组 ${segment.key} 中 ${field}=${wanted} 命中 ${matches.length} 项，需显式选择首/末项`,
    });
    return undefined;
  }
  return matches[0];
}

/** 解析嵌套路径；收集全部错误而不是遇到首个错误就返回，便于详情展示所有出错字段。 */
function resolvePath(root: unknown, path: string, errors: FieldError[]): unknown {
  let cursor: unknown = root;
  for (const segment of parsePath(path)) {
    if (Array.isArray(cursor)) {
      cursor = selectFromArray(cursor, segment, path, errors);
      if (cursor === undefined) return undefined;
      continue;
    }
    if (!isObject(cursor)) {
      errors.push({ code: 'MISSING_FIELD', path, detail: `${segment.key} 的上级不是对象或数组` });
      return undefined;
    }
    if (!Object.hasOwn(cursor, segment.key)) {
      errors.push({ code: 'MISSING_FIELD', path, detail: `缺少字段 ${segment.key}` });
      return undefined;
    }
    cursor = cursor[segment.key];
    if (segment.selectorField) {
      cursor = selectFromArray(cursor, segment, path, errors);
      if (cursor === undefined) return undefined;
    }
  }
  return cursor;
}

function readMetricValue(
  raw: unknown,
  metric: MetricDef,
  errors: FieldError[],
): MetricValue | undefined {
  if (raw === null || raw === undefined) {
    errors.push({ code: 'MISSING_FIELD', path: metric.path, detail: '指标取值为空' });
    return undefined;
  }
  if (metric.type === 'tri-state') {
    if (raw === 'Pass' || raw === 'Fail' || raw === 'NA') return raw;
    errors.push({
      code: 'INVALID_ENUM',
      path: metric.path,
      detail: `期望 Pass / Fail / NA，实际为 ${String(raw)}`,
    });
    return undefined;
  }
  if (metric.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    errors.push({ code: 'INVALID_TYPE', path: metric.path, detail: '期望布尔值' });
    return undefined;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    errors.push({ code: 'INVALID_TYPE', path: metric.path, detail: '期望有限数值' });
    return undefined;
  }
  if ((metric.min !== undefined && raw < metric.min) || (metric.max !== undefined && raw > metric.max)) {
    errors.push({
      code: 'OUT_OF_RANGE',
      path: metric.path,
      detail: `${raw} 超出 [${metric.min ?? '-∞'}, ${metric.max ?? '+∞'}]${metric.unit ?? ''}`,
    });
    return undefined;
  }
  return raw;
}

function parseAttempt(attempt: JudgeAttempt): { json?: unknown; errors: FieldError[] } {
  if (attempt.businessJson !== undefined) return { json: attempt.businessJson, errors: [] };
  if (attempt.rawResponse === null || attempt.rawResponse.trim() === '') {
    return { errors: [{ code: 'INVALID_JSON', path: '<response>', detail: '裁判响应为空' }] };
  }
  try {
    return { json: JSON.parse(attempt.rawResponse), errors: [] };
  } catch (error) {
    return {
      errors: [{
        code: 'INVALID_JSON',
        path: '<response>',
        detail: `裁判响应 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }
}

function checkTotal(
  raw: unknown,
  rule: RuleDef,
  metrics: Record<string, MetricValue | null>,
  errors: FieldError[],
): number | null | undefined {
  if (raw === null || raw === undefined) {
    const allNA = allMetricsNA(rule, metrics);
    if (rule.nullTotalWhenAllNA && allNA) return null;
    errors.push({
      code: 'INVALID_NULL_TOTAL',
      path: rule.totalScorePath,
      detail: '总分为空，但并非规则约定的全 NA 情形',
    });
    return undefined;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    errors.push({ code: 'INVALID_TYPE', path: rule.totalScorePath, detail: '总分期望有限数值' });
    return undefined;
  }
  if (raw < rule.scoreRange.min || raw > rule.scoreRange.max) {
    errors.push({
      code: 'OUT_OF_RANGE',
      path: rule.totalScorePath,
      detail: `总分 ${raw} 超出 [${rule.scoreRange.min}, ${rule.scoreRange.max}]`,
    });
  }
  if (rule.totalScoreDerivation === 'tri-state-pass-rate') {
    const pass = rule.metrics.filter(
      (metric) => metric.type === 'tri-state' && metrics[metric.id] === 'Pass',
    ).length;
    const fail = rule.metrics.filter(
      (metric) => metric.type === 'tri-state' && metrics[metric.id] === 'Fail',
    ).length;
    const expected = pass + fail === 0 ? null
      : rule.scoreRange.min + (rule.scoreRange.max - rule.scoreRange.min) * pass / (pass + fail);
    if (expected === null) {
      errors.push({
        code: 'SCORE_MISMATCH',
        path: rule.totalScorePath,
        detail: '全 NA 时合法总分为 null，实际返回了数值',
      });
    } else if (Math.abs(raw - expected) > 1e-9 * Math.max(1, Math.abs(expected))) {
      errors.push({
        code: 'SCORE_MISMATCH',
        path: rule.totalScorePath,
        detail: `声明总分 ${raw} 与指标判定复算 ${expected} 不一致`,
      });
    }
  }
  return raw;
}

/** 对单条样本评分。失败时保留原文与全部错误，不抛异常。 */
export function scoreSample(sample: SampleInput, rule: RuleDef): SampleResult {
  if (sample.evidence?.status === 'failed') {
    return {
      sampleId: sample.id,
      status: 'evidence_missing',
      stage: sample.evidence.stage ?? '未知阶段',
      traceId: sample.evidence.traceId,
      attempts: sample.attempts,
    };
  }

  const attempt = sample.effectiveAttemptId
    ? sample.attempts.find((item) => item.id === sample.effectiveAttemptId)
    : sample.attempts.at(-1);
  if (!attempt) {
    return {
      sampleId: sample.id,
      status: 'scoring_failed',
      errors: [{ code: 'NO_ATTEMPT', path: '<response>', detail: '没有可评分的裁判尝试' }],
      rawResponse: null,
      attempts: sample.attempts,
    };
  }

  const { json, errors } = parseAttempt(attempt);
  const metrics: Record<string, MetricValue | null> = Object.create(null);
  if (json === undefined) {
    return { sampleId: sample.id, status: 'scoring_failed', errors, rawResponse: attempt.rawResponse, attempts: sample.attempts };
  }
  if (!isObject(json)) {
    return {
      sampleId: sample.id,
      status: 'scoring_failed',
      errors: [{ code: 'INVALID_TYPE', path: '<response>', detail: '裁判响应根节点不是对象' }],
      businessJson: json,
      rawResponse: attempt.rawResponse,
      attempts: sample.attempts,
    };
  }

  try {
    validateRuleDefinition(rule);
  } catch (error) {
    return { sampleId: sample.id, status: 'scoring_failed', rawResponse: attempt.rawResponse,
      businessJson: json, attempts: sample.attempts,
      errors: [{ code: 'INVALID_RULE', path: '<rule>', detail: error instanceof Error ? error.message : '规则无效' }] };
  }
  for (const metric of rule.metrics) {
    const value = resolvePath(json, metric.path, errors);
    const checked = readMetricValue(value, metric, errors);
    if (checked !== undefined) metrics[metric.id] = checked;
  }
  const rawTotal = resolvePath(json, rule.totalScorePath, errors);
  let totalScore: number | null = null;
  if (errors.length === 0) {
    const checked = checkTotal(rawTotal, rule, metrics, errors);
    if (checked !== undefined) totalScore = checked;
  }
  if (errors.length > 0) {
    return {
      sampleId: sample.id,
      status: 'scoring_failed',
      errors,
      businessJson: json,
      rawResponse: attempt.rawResponse,
      attempts: sample.attempts,
    };
  }

  const reasonRaw = rule.reasonPath ? resolvePath(json, rule.reasonPath, []) : undefined;
  const allNA = allMetricsNA(rule, metrics);
  return {
    sampleId: sample.id,
    status: 'scored',
    attemptId: attempt.id,
    totalScore,
    allNA,
    metrics,
    reason: typeof reasonRaw === 'string' ? reasonRaw : undefined,
    businessJson: json,
    rawResponse: attempt.rawResponse,
    attempts: sample.attempts,
  };
}

/** 批次聚合始终使用全部样本；样本明细筛选不改变这里的分母。 */
export function aggregateBatch(results: SampleResult[], rule: RuleDef): BatchRollup {
  const numericTotals: number[] = [];
  let allNA = 0;
  let evidenceMissing = 0;
  let scoringFailed = 0;
  let waiting = 0;
  let canceled = 0;
  for (const result of results) {
    if (result.status === 'scored') {
      if (result.totalScore === null) allNA += 1;
      else numericTotals.push(result.totalScore);
    } else if (result.status === 'evidence_missing') evidenceMissing += 1;
    else if (result.status === 'waiting') waiting += 1;
    else if (result.status === 'canceled') canceled += 1;
    else scoringFailed += 1;
  }
  const mean = numericTotals.length
    ? numericTotals.reduce((sum, value) => sum + value, 0) / numericTotals.length
    : null;

  const metrics: MetricSummary[] = (Array.isArray(rule.metrics) ? rule.metrics.filter(Boolean) : []).map((metric) => {
    const base: MetricSummary = { id: metric.id, name: metric.name, type: metric.type, unit: metric.unit, label: '' };
    const values = results
      .filter((item): item is ScoredResult => item.status === 'scored')
      .map((item) => item.metrics[metric.id]);
    const valid = values.filter((value) => value !== null && value !== undefined);
    if (metric.type === 'tri-state') {
      const pass = valid.filter((value) => value === 'Pass').length;
      const fail = valid.filter((value) => value === 'Fail').length;
      const na = valid.filter((value) => value === 'NA').length;
      const effective = pass + fail;
      return {
        ...base, pass, fail, na, effective,
        rate: effective ? pass / effective : null,
        label: effective ? `${pass} / ${effective}` : '无适用样本',
      };
    }
    if (metric.type === 'boolean') {
      const trueCount = valid.filter((value) => value === true).length;
      return {
        ...base, trueCount, validCount: valid.length,
        label: valid.length ? `${trueCount} / ${valid.length}` : '无适用样本',
      };
    }
    const numbers = valid.filter((value): value is number => typeof value === 'number');
    const metricMean = numbers.length
      ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length
      : null;
    return {
      ...base, mean: metricMean, count: numbers.length,
      label: numbers.length ? `${metricMean}${metric.unit ?? ''}` : '无适用样本',
    };
  });

  return {
    total: results.length,
    counts: {
      numericTotal: numericTotals.length,
      allNA,
      evidenceMissing,
      scoringFailed,
      waiting,
      canceled,
      scoringFailureSubtotal: evidenceMissing + scoringFailed,
    },
    mean,
    meanPercent: mean === null || rule.scoreRange?.min !== 0 || rule.scoreRange.max !== 1 ? null : `${(mean * 100).toFixed(1)}%`,
    metrics,
  };
}

/** 样本明细筛选：先匹配条件，再分页；返回命中总数与当前页。 */
export function filterResults(results: SampleResult[], filter: SampleFilter): { total: number; items: SampleResult[] } {
  const matched = results.filter((result) => {
    if (filter.status && result.status !== filter.status) return false;
    if (filter.scoreMin !== undefined || filter.scoreMax !== undefined) {
      if (result.status !== 'scored' || result.totalScore === null) return false;
      if (filter.scoreMin !== undefined && result.totalScore < filter.scoreMin) return false;
      if (filter.scoreMax !== undefined && result.totalScore > filter.scoreMax) return false;
    }
    if (filter.metricId !== undefined) {
      if (result.status !== 'scored' || result.metrics[filter.metricId] !== filter.metricValue) return false;
    }
    return true;
  });
  const offset = filter.offset ?? 0;
  const limit = filter.limit ?? matched.length;
  return { total: matched.length, items: matched.slice(offset, offset + limit) };
}
