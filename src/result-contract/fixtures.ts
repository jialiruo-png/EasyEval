/**
 * plan.md 第四板块的固定验收样本与两份规则定义。
 * 数据为脱敏构造文本，不含真实会话、Token 或凭据。
 */
import type { RuleDef, SampleInput, TriState } from './contract.ts';

export const processQualityRule: RuleDef = {
  name: '过程质量',
  id: 'rule_process_quality',
  version: 'v1',
  totalScorePath: 'primary_dimension.total_score',
  reasonPath: 'primary_dimension.reason',
  scoreRange: { min: 0, max: 1 },
  totalScoreDerivation: 'tri-state-pass-rate',
  nullTotalWhenAllNA: true,
  metrics: [
    { id: 'step_decompose', name: '步骤拆解合理', type: 'tri-state', path: 'secondary_dimensions[name=步骤拆解合理].result' },
    { id: 'tool_choice', name: '工具选择正确', type: 'tri-state', path: 'secondary_dimensions[name=工具选择正确].result' },
    { id: 'param_fill', name: '参数填充正确', type: 'tri-state', path: 'secondary_dimensions[name=参数填充正确].result' },
    { id: 'tool_success', name: '工具调用成功', type: 'tri-state', path: 'secondary_dimensions[name=工具调用成功].result' },
  ],
};

/** 异构规则：不同键名、不同嵌套层级，含数值、布尔与三态三类指标。 */
export const heterogeneousRule: RuleDef = {
  name: '回答表现',
  id: 'rule_heterogeneous',
  version: 'v2',
  totalScorePath: 'grade.overall',
  reasonPath: 'grade.comment',
  scoreRange: { min: 0, max: 100 },
  totalScoreDerivation: 'declared',
  nullTotalWhenAllNA: false,
  metrics: [
    { id: 'first_token_ms', name: '首字延迟', type: 'numeric', unit: 'ms', min: 0, max: 5000, path: 'timing.first_token_ms' },
    { id: 'answered', name: '已回答', type: 'boolean', path: 'flags.answered' },
    { id: 'tone', name: '语气', type: 'tri-state', path: 'checks[name=tone].verdict' },
  ],
};

export type Dimension = [name: string, result: TriState];

export function processQualityResponse(input: {
  total: number | null;
  reason: string;
  dimensions: Dimension[];
}): string {
  return JSON.stringify({
    primary_dimension: { total_score: input.total, reason: input.reason },
    secondary_dimensions: input.dimensions.map(([name, result]) => ({ name, result })),
    redline_fail_hits: [],
  });
}

function singleAttempt(id: string, rawResponse: string | null): SampleInput {
  return { id: '', query: '', attempts: [{ id, rawResponse }] };
}

/** A：3 Pass、1 Fail（参数填充 Fail），数组顺序打乱。 */
export const sampleA: SampleInput = {
  ...singleAttempt('a-1', processQualityResponse({
    total: 0.75,
    reason: '三步判定通过，参数填充失败',
    dimensions: [
      ['工具调用成功', 'Pass'],
      ['参数填充正确', 'Fail'],
      ['步骤拆解合理', 'Pass'],
      ['工具选择正确', 'Pass'],
    ],
  })),
  id: 'A',
  query: '查询昨天订单的物流状态',
};

/** B：唯一适用项为工具调用成功且 Fail，其余 NA；实际执行列表为空。 */
export const sampleB: SampleInput = {
  ...singleAttempt('b-1', processQualityResponse({
    total: 0,
    reason: '要求实际调用工具，但执行列表为空',
    dimensions: [
      ['工具调用成功', 'Fail'],
      ['步骤拆解合理', 'NA'],
      ['工具选择正确', 'NA'],
      ['参数填充正确', 'NA'],
    ],
  })),
  id: 'B',
  query: '列出可用的售后工具',
};

/** C：4 NA，总分为合法 JSON null。 */
export const sampleC: SampleInput = {
  ...singleAttempt('c-1', processQualityResponse({
    total: null,
    reason: '四项均不适用',
    dimensions: [
      ['步骤拆解合理', 'NA'],
      ['工具选择正确', 'NA'],
      ['参数填充正确', 'NA'],
      ['工具调用成功', 'NA'],
    ],
  })),
  id: 'C',
  query: '你好',
};

/** D：必需的工具执行记录采集失败，保留阶段和 Trace 引用。 */
export const sampleD: SampleInput = {
  ...singleAttempt('d-1', null),
  id: 'D',
  query: '查询订单号 88231 的退款进度',
  evidence: { status: 'failed', stage: 'tool_execution_collect', traceId: 'trace-d-001' },
};

/** E：裁判响应 JSON 在结尾缺少闭合括号。 */
export const sampleE: SampleInput = {
  ...singleAttempt('e-1', '{"primary_dimension":{"total_score":0.5'),
  id: 'E',
  query: '把地址改成北京市朝阳区',
};

export const processQualitySamples: SampleInput[] = [sampleA, sampleB, sampleC, sampleD, sampleE];

export function heterogeneousSample(overrides: {
  total?: number;
  firstTokenMs?: number;
  answered?: boolean;
  tone?: TriState;
} = {}): SampleInput {
  const raw = JSON.stringify({
    grade: {
      overall: overrides.total ?? 88,
      comment: '回答完整',
    },
    timing: { first_token_ms: overrides.firstTokenMs ?? 320 },
    flags: { answered: overrides.answered ?? true },
    checks: [
      { name: 'formality', verdict: 'NA' },
      { name: 'tone', verdict: overrides.tone ?? 'Pass' },
    ],
  });
  return {
    id: 'H-1',
    query: '异构规则样本',
    attempts: [{ id: 'h-1', rawResponse: raw }],
  };
}
