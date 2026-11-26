/**
 * 结果契约单元测试：node --test src/result-contract/contract.test.ts
 * 全部为本地构造数据，不访问网络、模型或上游服务。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateBatch,
  filterResults,
  scoreSample,
  type SampleInput,
  type SampleResult,
  type ScoredResult,
} from './contract.ts';
import {
  heterogeneousRule,
  heterogeneousSample,
  processQualityResponse,
  processQualityRule,
  processQualitySamples,
  sampleA,
  sampleB,
  sampleC,
  sampleD,
  sampleE,
} from './fixtures.ts';

function scored(results: SampleResult[], id: string): ScoredResult {
  const result = results.find((item) => item.sampleId === id);
  assert.equal(result?.status, 'scored', `${id} 应为已评分`);
  return result as ScoredResult;
}

test('A：乱序数组按业务键取值，3 Pass / 1 Fail 得 0.75，参数填充为 Fail', () => {
  const result = scoreSample(sampleA, processQualityRule);
  assert.equal(result.status, 'scored');
  if (result.status !== 'scored') return;
  assert.equal(result.totalScore, 0.75);
  assert.equal(result.allNA, false);
  assert.equal(result.metrics.param_fill, 'Fail');
  assert.equal(result.metrics.tool_success, 'Pass');
  assert.deepEqual(result.businessJson && (result.businessJson as Record<string, unknown>).redline_fail_hits, []);
});

test('A：数组换序后结果与指标不变', () => {
  const reversed: SampleInput = {
    ...sampleA,
    attempts: [{
      id: 'a-2',
      rawResponse: processQualityResponse({
        total: 0.75,
        reason: '三步判定通过，参数填充失败',
        dimensions: [
          ['工具选择正确', 'Pass'],
          ['参数填充正确', 'Fail'],
          ['步骤拆解合理', 'Pass'],
          ['工具调用成功', 'Pass'],
        ],
      }),
    }],
  };
  const reordered = scoreSample(reversed, processQualityRule);
  const original = scoreSample(sampleA, processQualityRule);
  assert.equal(reordered.status, 'scored');
  assert.equal(original.status, 'scored');
  if (reordered.status !== 'scored' || original.status !== 'scored') return;
  assert.equal(reordered.totalScore, original.totalScore);
  assert.deepEqual(reordered.metrics, original.metrics);
});

test('B：唯一适用项 Fail 得 0，0 分计入均分分母', () => {
  const result = scoreSample(sampleB, processQualityRule);
  assert.equal(result.status, 'scored');
  if (result.status !== 'scored') return;
  assert.equal(result.totalScore, 0);
  assert.equal(result.allNA, false);
  assert.equal(result.metrics.tool_success, 'Fail');
  assert.equal(result.metrics.param_fill, 'NA');
});

test('C：全 NA 保留四项 NA，合法总分为 JSON null', () => {
  const result = scoreSample(sampleC, processQualityRule);
  assert.equal(result.status, 'scored');
  if (result.status !== 'scored') return;
  assert.equal(result.totalScore, null);
  assert.equal(result.allNA, true);
  assert.deepEqual(Object.values(result.metrics), ['NA', 'NA', 'NA', 'NA']);
});

test('D：证据采集失败单独标记阶段，不伪造评分', () => {
  const result = scoreSample(sampleD, processQualityRule);
  assert.equal(result.status, 'evidence_missing');
  if (result.status !== 'evidence_missing') return;
  assert.equal(result.stage, 'tool_execution_collect');
  assert.equal(result.traceId, 'trace-d-001');
  assert.equal(result.attempts.length, 1);
});

test('E：损坏 JSON 标为评分失败并保留原文', () => {
  const result = scoreSample(sampleE, processQualityRule);
  assert.equal(result.status, 'scoring_failed');
  if (result.status !== 'scoring_failed') return;
  assert.equal(result.errors[0]?.code, 'INVALID_JSON');
  assert.equal(result.rawResponse, sampleE.attempts[0]?.rawResponse);
});

test('整批：5 条样本、2 条数值总分、1 条全 NA、2 条评分失败，均分 37.5%', () => {
  const results = processQualitySamples.map((sample) => scoreSample(sample, processQualityRule));
  const rollup = aggregateBatch(results, processQualityRule);
  assert.equal(rollup.total, 5);
  assert.equal(rollup.counts.numericTotal, 2);
  assert.equal(rollup.counts.allNA, 1);
  assert.equal(rollup.counts.evidenceMissing, 1);
  assert.equal(rollup.counts.scoringFailed, 1);
  assert.equal(rollup.counts.scoringFailureSubtotal, 2);
  assert.equal(rollup.mean, 0.375);
  assert.equal(rollup.meanPercent, '37.5%');
});

test('指标汇总：各指标分母独立，NA 单列', () => {
  const results = processQualitySamples.map((sample) => scoreSample(sample, processQualityRule));
  const summaries = Object.fromEntries(aggregateBatch(results, processQualityRule).metrics.map((m) => [m.id, m]));
  assert.deepEqual(
    [summaries.step_decompose.pass, summaries.step_decompose.fail, summaries.step_decompose.na, summaries.step_decompose.effective],
    [1, 0, 2, 1],
  );
  assert.equal(summaries.step_decompose.rate, 1);
  assert.deepEqual(
    [summaries.param_fill.pass, summaries.param_fill.fail, summaries.param_fill.na],
    [0, 1, 2],
  );
  assert.equal(summaries.param_fill.rate, 0);
  assert.deepEqual(
    [summaries.tool_success.pass, summaries.tool_success.fail, summaries.tool_success.na, summaries.tool_success.effective],
    [1, 1, 1, 2],
  );
  assert.equal(summaries.tool_success.rate, 0.5);
});

test('样本筛选：指标取值、状态、总分区间与分页互不影响整批统计', () => {
  const results = processQualitySamples.map((sample) => scoreSample(sample, processQualityRule));
  const byMetric = filterResults(results, { metricId: 'param_fill', metricValue: 'Fail' });
  assert.equal(byMetric.total, 1);
  assert.equal(byMetric.items[0]?.sampleId, 'A');
  assert.equal(filterResults(results, { status: 'scoring_failed' }).total, 1);
  assert.equal(filterResults(results, { scoreMin: 0, scoreMax: 0 }).total, 1);
  const page = filterResults(results, { limit: 1, offset: 1 });
  assert.equal(page.total, 5);
  assert.equal(page.items[0]?.sampleId, 'B');
  assert.equal(filterResults(results, { metricId: 'tone', metricValue: 'Pass' }).total, 0);
  assert.equal(aggregateBatch(results, processQualityRule).total, 5);
});

test('失败分支：非法枚举、重复业务键、缺字段、总分不匹配与非法空分都保留具体字段', () => {
  const raw = (value: unknown) => ({ ...sampleA, attempts: [{ id: 'a-x', rawResponse: JSON.stringify(value) }] });
  const baseJson = JSON.parse(sampleA.attempts[0]!.rawResponse!);
  const dimensions = baseJson.secondary_dimensions as Array<{ name: string; result: string }>;

  const illegal = scoreSample(raw({
    ...baseJson,
    secondary_dimensions: dimensions.map((d) => d.name === '参数填充正确' ? { ...d, result: 'Maybe' } : d),
  }), processQualityRule);
  assert.equal(illegal.status, 'scoring_failed');
  if (illegal.status !== 'scoring_failed') return;
  assert.ok(illegal.errors.some((e) => e.code === 'INVALID_ENUM' && e.path.includes('参数填充正确')));

  const duplicated = scoreSample(raw({
    ...baseJson,
    secondary_dimensions: [...dimensions, { name: '参数填充正确', result: 'Pass' }],
  }), processQualityRule);
  assert.equal(duplicated.status, 'scoring_failed');
  if (duplicated.status !== 'scoring_failed') return;
  assert.ok(duplicated.errors.some((e) => e.code === 'AMBIGUOUS_KEY'));

  const missing = scoreSample(raw({
    ...baseJson,
    secondary_dimensions: dimensions.filter((d) => d.name !== '参数填充正确'),
  }), processQualityRule);
  assert.equal(missing.status, 'scoring_failed');
  if (missing.status !== 'scoring_failed') return;
  assert.ok(missing.errors.some((e) => e.code === 'MISSING_FIELD' && e.path.includes('参数填充正确')));

  const mismatched = scoreSample(raw({ ...baseJson, primary_dimension: { ...baseJson.primary_dimension, total_score: 0.8 } }), processQualityRule);
  assert.equal(mismatched.status, 'scoring_failed');
  if (mismatched.status !== 'scoring_failed') return;
  assert.ok(mismatched.errors.some((e) => e.code === 'SCORE_MISMATCH'));
});

test('重试：保留全部尝试，聚合只使用有效最终尝试', () => {
  const valid = sampleA.attempts[0]!.rawResponse!;
  const sample: SampleInput = {
    ...sampleA,
    attempts: [
      { id: 'bad', rawResponse: '{"broken"' },
      { id: 'good', rawResponse: valid },
    ],
  };
  assert.equal(scoreSample({ ...sample, effectiveAttemptId: 'good' }, processQualityRule).status, 'scored');
  const pinnedBad = scoreSample({ ...sample, effectiveAttemptId: 'bad' }, processQualityRule);
  assert.equal(pinnedBad.status, 'scoring_failed');
  assert.equal(pinnedBad.attempts.length, 2);
  const latest = scoreSample(sample, processQualityRule);
  assert.equal(latest.status, 'scored');
  if (latest.status !== 'scored') return;
  assert.equal(latest.attemptId, 'good');
});

test('异构规则：不同键名与嵌套层级仍能取值，数值越界与非法空分被拒绝', () => {
  const ok = scoreSample(heterogeneousSample(), heterogeneousRule);
  assert.equal(ok.status, 'scored');
  if (ok.status !== 'scored') return;
  assert.equal(ok.totalScore, 88);
  assert.equal(ok.metrics.first_token_ms, 320);
  assert.equal(ok.metrics.answered, true);
  assert.equal(ok.metrics.tone, 'Pass');

  const outOfRange = scoreSample(heterogeneousSample({ firstTokenMs: 6000 }), heterogeneousRule);
  assert.equal(outOfRange.status, 'scoring_failed');
  if (outOfRange.status !== 'scoring_failed') return;
  assert.ok(outOfRange.errors.some((e) => e.code === 'OUT_OF_RANGE' && e.path === 'timing.first_token_ms'));

  const base = JSON.parse(heterogeneousSample().attempts[0]!.rawResponse!);
  const nullTotal: SampleInput = {
    id: 'H-2',
    query: '',
    attempts: [{ id: 'h-2', rawResponse: JSON.stringify({ ...base, grade: { ...base.grade, overall: null } }) }],
  };
  const invalidNull = scoreSample(nullTotal, heterogeneousRule);
  assert.equal(invalidNull.status, 'scoring_failed');
  if (invalidNull.status !== 'scoring_failed') return;
  assert.ok(invalidNull.errors.some((e) => e.code === 'INVALID_NULL_TOTAL'));

  const summaries = aggregateBatch([ok], heterogeneousRule).metrics;
  assert.equal(summaries.find((m) => m.id === 'first_token_ms')?.label, '320ms');
  assert.equal(summaries.find((m) => m.id === 'answered')?.label, '1 / 1');
});

test('空分母显示无适用样本，空批次均分为空', () => {
  const empty = aggregateBatch([], processQualityRule);
  assert.equal(empty.mean, null);
  assert.equal(empty.meanPercent, null);
  assert.equal(empty.metrics[0]?.label, '无适用样本');
  assert.equal(scored([scoreSample(sampleC, processQualityRule)], 'C').totalScore, null);
});

test('百分制保留原始均分，纯数值指标不会被标为全 NA', () => {
  const rule = { ...heterogeneousRule, metrics: heterogeneousRule.metrics.filter((m) => m.type === 'numeric'), nullTotalWhenAllNA: true };
  const sample = heterogeneousSample();
  const result = scoreSample(sample, rule);
  assert.ok(result.status === 'scored');
  assert.equal(result.allNA, false);
  const rollup = aggregateBatch([result], rule);
  assert.equal(rollup.mean, result.totalScore);
  assert.equal(rollup.meanPercent, null);
  const attempt = { id: 'empty', rawResponse: null, businessJson: { grade: { overall: null }, timing: { first_token_ms: 10 } } };
  assert.equal(scoreSample({ ...sample, attempts: [attempt] }, rule).status, 'scoring_failed');
});

test('历史坏规则保留原文并报告字段错误，百分制通过率按规则量程复算', () => {
  const invalid = scoreSample(sampleA, { ...processQualityRule, totalScorePath: 'score[' });
  assert.ok(invalid.status === 'scoring_failed');
  assert.equal(invalid.errors[0].code, 'INVALID_RULE');
  assert.equal(invalid.rawResponse, sampleA.attempts[0].rawResponse);
  const json = JSON.parse(sampleA.attempts[0].rawResponse!);
  json.primary_dimension.total_score = 75;
  const scaled = scoreSample({ ...sampleA, attempts: [{ id: sampleA.attempts[0].id, rawResponse: JSON.stringify(json) }] },
    { ...processQualityRule, scoreRange: { min: 0, max: 100 } });
  assert.ok(scaled.status === 'scored');
  assert.equal(scaled.totalScore, 75);
});
