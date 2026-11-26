/**
 * 结果读取接口骨架单元测试：node --test src/result-api/handlers.test.ts
 * 全部为本地构造数据，不访问网络、模型、Docker 或上游服务。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { SampleInput } from '../result-contract/contract.ts';
import {
  processQualityRule,
  processQualitySamples,
  sampleA,
} from '../result-contract/fixtures.ts';
import { InMemoryReadStore, type RunRecord, type SampleRecord } from './store.ts';
import {
  createResultReadApi,
  resultReadRoutes,
  type ReadResponse,
} from './handlers.ts';

function makeSamples(): SampleRecord[] {
  return processQualitySamples.map((sample, index) => ({
    ...sample,
    answerSummary: `回答摘要-${sample.id}`,
    answer: `完整回答-${sample.id}`,
    durationMs: 100 + index * 10,
    trace: { traceId: sample.evidence?.traceId ?? `trace-${sample.id}`, expired: false },
  }));
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'RUN-A',
    ownerAccountId: 'acct-A',
    taskId: 'TASK-1',
    datasetVersionId: 'DS-v1',
    ruleVersionId: 'RULE-v1',
    rule: processQualityRule,
    triggeredBy: 'manual',
    triggeredAt: '2026-11-21T20:00:00+08:00',
    status: 'succeeded',
    samples: makeSamples(),
    ...overrides,
  };
}

function unwrap<T>(response: ReadResponse<T>): T {
  assert.equal(response.ok, true, JSON.stringify(response));
  if (!response.ok) throw new Error('unreachable');
  return response.data;
}

test('GET results：批次元数据、版本、状态计数、均分与指标汇总与整批契约一致', () => {
  const api = createResultReadApi(new InMemoryReadStore([makeRun()]));
  const data = unwrap(api.getResults({ accountId: 'acct-A', runId: 'RUN-A' }));
  assert.equal(data.runId, 'RUN-A');
  assert.equal(data.datasetVersionId, 'DS-v1');
  assert.equal(data.ruleVersionId, 'RULE-v1');
  assert.equal(data.ruleVersion, 'v1');
  assert.equal(data.status, 'succeeded');
  assert.equal(data.counts.numericTotal, 2);
  assert.equal(data.counts.allNA, 1);
  assert.equal(data.counts.evidenceMissing, 1);
  assert.equal(data.counts.scoringFailed, 1);
  assert.equal(data.counts.scoringFailureSubtotal, 2);
  assert.equal(data.mean, 0.375);
  assert.equal(data.meanPercent, '37.5%');
  const paramFill = data.metrics.find((metric) => metric.id === 'param_fill');
  assert.equal(paramFill?.label, '0 / 1');
  assert.equal(paramFill?.rate, 0);
});

test('GET samples：指标筛选命中 A，状态筛选与总分区间命中预期样本', () => {
  const api = createResultReadApi(new InMemoryReadStore([makeRun()]));
  const ctx = { accountId: 'acct-A', runId: 'RUN-A' };
  const byMetric = unwrap(api.listSamples(ctx, { metricId: 'param_fill', metricValue: 'Fail' }));
  assert.equal(byMetric.total, 1);
  assert.equal(byMetric.items[0]?.sampleId, 'A');
  assert.equal(byMetric.items[0]?.totalScore, 0.75);
  assert.deepEqual(byMetric.items[0]?.metrics.param_fill, 'Fail');
  assert.equal(byMetric.items[0]?.trace?.expired, false);

  assert.equal(unwrap(api.listSamples(ctx, { status: 'scoring_failed' })).items[0]?.sampleId, 'E');
  assert.equal(unwrap(api.listSamples(ctx, { status: 'evidence_missing' })).items[0]?.sampleId, 'D');
  assert.equal(unwrap(api.listSamples(ctx, { scoreMin: 0, scoreMax: 0 })).items[0]?.sampleId, 'B');
  assert.equal(unwrap(api.listSamples(ctx, { metricId: 'not_a_metric', metricValue: 'Pass' })).total, 0);
});

test('GET samples：分页只影响明细，total 保持命中总数；批次结果不随筛选变化', () => {
  const api = createResultReadApi(new InMemoryReadStore([makeRun()]));
  const ctx = { accountId: 'acct-A', runId: 'RUN-A' };
  const page = unwrap(api.listSamples(ctx, { limit: 2, offset: 1 }));
  assert.equal(page.total, 5);
  assert.deepEqual(page.items.map((item) => item.sampleId), ['B', 'C']);
  assert.equal(unwrap(api.getResults(ctx)).counts.numericTotal, 2);
});

test('GET sample：A 返回完整回答、业务 JSON、评分指标与 Trace 引用', () => {
  const api = createResultReadApi(new InMemoryReadStore([makeRun()]));
  const data = unwrap(api.getSample({ accountId: 'acct-A', runId: 'RUN-A' }, 'A'));
  assert.equal(data.sampleId, 'A');
  assert.equal(data.answer, '完整回答-A');
  assert.equal(data.scoring.status, 'scored');
  assert.equal(data.scoring.totalScore, 0.75);
  assert.equal(data.scoring.metrics.param_fill, 'Fail');
  assert.deepEqual(data.parseError, []);
  assert.equal(data.attempts.length, 1);
  assert.equal(data.trace?.traceId, 'trace-A');
  assert.equal(data.scoringFromLocalHistory, false);
  const json = data.businessJson as Record<string, unknown>;
  assert.deepEqual(json.redline_fail_hits, []);
});

test('GET sample：E 解析失败保留原文与具体字段，业务 JSON 为空', () => {
  const api = createResultReadApi(new InMemoryReadStore([makeRun()]));
  const data = unwrap(api.getSample({ accountId: 'acct-A', runId: 'RUN-A' }, 'E'));
  assert.equal(data.scoring.status, 'scoring_failed');
  assert.equal(data.parseError[0]?.code, 'INVALID_JSON');
  assert.equal(data.rawResponse?.startsWith('{"primary_dimension"'), true);
  assert.equal(data.businessJson, null);
});

test('GET sample：D 证据缺失保留阶段与 Trace，不伪造评分', () => {
  const api = createResultReadApi(new InMemoryReadStore([makeRun()]));
  const data = unwrap(api.getSample({ accountId: 'acct-A', runId: 'RUN-A' }, 'D'));
  assert.equal(data.scoring.status, 'evidence_missing');
  assert.equal(data.scoring.stage, 'tool_execution_collect');
  assert.equal(data.evidence?.traceId, 'trace-d-001');
  assert.equal(data.trace?.traceId, 'trace-d-001');
  assert.equal(data.attempts.length, 1);
});

test('GET sample：Trace 到期后仍返回本地保存的评分详情', () => {
  const run = makeRun();
  const first = run.samples.find((sample) => sample.id === 'A');
  assert.ok(first);
  first.trace = { traceId: 'trace-A', expired: true };
  const api = createResultReadApi(new InMemoryReadStore([run]));
  const data = unwrap(api.getSample({ accountId: 'acct-A', runId: 'RUN-A' }, 'A'));
  assert.equal(data.scoring.status, 'scored');
  assert.equal(data.scoring.totalScore, 0.75);
  assert.equal(data.scoringFromLocalHistory, true);
  assert.equal(data.trace?.expired, true);
});

test('归属隔离：他人批次与不存在批次统一 404，未登录 401，三条接口一致', () => {
  const other = makeRun({ id: 'RUN-B', ownerAccountId: 'acct-B', samples: [] });
  const api = createResultReadApi(new InMemoryReadStore([makeRun(), other]));

  const forbidden = api.getResults({ accountId: 'acct-B', runId: 'RUN-A' });
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) {
    assert.equal(forbidden.httpStatus, 404);
    assert.equal(forbidden.code, 'NOT_FOUND');
  }
  assert.equal(api.getResults({ accountId: 'acct-X', runId: 'RUN-A' }).ok, false);
  assert.equal(api.getResults({ accountId: undefined, runId: 'RUN-A' }).ok, false);
  const anonymous = api.getResults({ accountId: undefined, runId: 'RUN-A' });
  if (!anonymous.ok) assert.equal(anonymous.httpStatus, 401);

  const listForbidden = api.listSamples({ accountId: 'acct-B', runId: 'RUN-A' });
  assert.equal(listForbidden.ok, false);
  const detailForbidden = api.getSample({ accountId: 'acct-B', runId: 'RUN-A' }, 'A');
  assert.equal(detailForbidden.ok, false);
  if (!detailForbidden.ok) assert.equal(detailForbidden.httpStatus, 404);

  // 账号 B 只能读到自己的批次，且 B 的批次不含 A 的样本。
  const own = unwrap(api.getResults({ accountId: 'acct-B', runId: 'RUN-B' }));
  assert.equal(own.runId, 'RUN-B');
  assert.equal(api.getSample({ accountId: 'acct-B', runId: 'RUN-B' }, 'A').ok, false);
});

test('重试：详情列出全部尝试，失败尝试不被丢弃，最终尝试用于评分', () => {
  const valid = sampleA.attempts[0]!.rawResponse!;
  const sample: SampleInput = {
    ...sampleA,
    attempts: [
      { id: 'bad', rawResponse: '{"broken"' },
      { id: 'good', rawResponse: valid },
    ],
  };
  const run = makeRun({ samples: [{ ...sample, trace: { traceId: 'trace-A', expired: false } }] });
  const api = createResultReadApi(new InMemoryReadStore([run]));
  const data = unwrap(api.getSample({ accountId: 'acct-A', runId: 'RUN-A' }, 'A'));
  assert.deepEqual(data.attempts.map((attempt) => attempt.attemptId), ['bad', 'good']);
  assert.equal(data.attempts[0]?.scoring.status, 'scoring_failed');
  assert.equal(data.attempts[1]?.scoring.status, 'scored');
  assert.equal(data.scoring.totalScore, 0.75);
  assert.equal(data.attempts[0]?.rawResponse, '{"broken"');
});

test('路由描述与 plan.md 拟定的三条接口一致', () => {
  assert.deepEqual(resultReadRoutes.map((route) => `${route.method} ${route.path}`), [
    'GET /api/runs/:runId/results',
    'GET /api/runs/:runId/samples',
    'GET /api/runs/:runId/samples/:sampleId',
  ]);
});

test('等待和取消的样本使用同一状态返回概览、列表和详情', () => {
  for (const status of ['running', 'queued', 'canceled', 'failed'] as const) {
    const sample = { id: 'new', query: '尚未评分', attempts: [] };
    const run = makeRun({ status, samples: [sample] });
    const api = createResultReadApi(new InMemoryReadStore([run]));
    const ctx = { accountId: run.ownerAccountId, runId: run.id };
    const expected = status === 'failed' ? 'scoring_failed' : status === 'canceled' ? 'canceled' : 'waiting';
    assert.equal(unwrap(api.listSamples(ctx, { status: expected })).total, 1);
    assert.equal(unwrap(api.getSample(ctx, sample.id)).scoring.status, expected);
    const counts = unwrap(api.getResults(ctx)).counts;
    assert.equal(counts[expected === 'scoring_failed' ? 'scoringFailed' : expected], 1);
    assert.equal(counts.numericTotal, 0);
  }
});

test('裁判 JSON 可解析但字段不合规时，最终结果和尝试都能查到原始业务字段', () => {
  const json = { unrelated: '保留该字段' };
  const sample = { id: 'bad', query: '样本', attempts: [{ id: 'a', rawResponse: JSON.stringify(json) }] };
  const run = makeRun({ samples: [sample] });
  const api = createResultReadApi(new InMemoryReadStore([run]));
  const view = unwrap(api.getSample({ accountId: run.ownerAccountId, runId: run.id }, sample.id));
  assert.equal(view.scoring.status, 'scoring_failed');
  assert.deepEqual(view.businessJson, json);
  assert.deepEqual(view.attempts[0].businessJson, json);
});
