/**
 * SQLite 持久化单元测试：
 *   node --test src/storage/sqlite-store.test.ts
 * 仅使用临时目录中的本机 SQLite 文件，不访问网络、Docker、模型或上游服务。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SampleInput } from '../result-contract/contract.ts';
import {
  heterogeneousRule,
  processQualityRule,
  processQualitySamples,
  sampleA,
} from '../result-contract/fixtures.ts';
import { InMemoryReadStore, type RunRecord, type SampleRecord } from '../result-api/store.ts';
import { createResultReadApi, type ReadResponse } from '../result-api/handlers.ts';
import { applyMigrations, migrationVersion, openDatabase } from './migrations.ts';
import { openSqliteStore } from './sqlite-store.ts';

function tempDbPath(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'eval-sqlite-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'eval.sqlite');
}

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
    progress: { completed: 5, total: 5 },
    samples: makeSamples(),
    ...overrides,
  };
}

function unwrap<T>(response: ReadResponse<T>): T {
  assert.equal(response.ok, true, JSON.stringify(response));
  if (!response.ok) throw new Error('unreachable');
  return response.data;
}

test('迁移：账本从 0 到 6，重复执行不重复建表，降级版本被拒绝', (t) => {
  const dbPath = tempDbPath(t);
  const db = openDatabase(dbPath);
  assert.equal(migrationVersion(db), 0);
  assert.deepEqual(applyMigrations(db), [1, 2, 3, 4, 5, 6]);
  assert.equal(migrationVersion(db), 6);
  assert.deepEqual(applyMigrations(db), []);
  assert.equal(migrationVersion(db), 6);

  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[];
  assert.deepEqual(tables.map((row) => row.name), [
    'archived_resources', 'dataset_row_sets', 'dataset_rows', 'judge_attempts',
    'resource_versions', 'runs', 'samples', 'schema_migrations', 'sessions',
  ]);

  db.prepare(
    'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
  ).run(99, 'future', new Date().toISOString());
  assert.throws(() => applyMigrations(db), /高于代码版本/);
  db.close();
});

test('落盘与重启：关闭后重新打开，运行记录逐字段一致且三条接口仍返回 37.5%', (t) => {
  const dbPath = tempDbPath(t);
  const record = makeRun();
  const first = openSqliteStore(dbPath);
  first.insertRun(record);
  first.close();

  const reopened = openSqliteStore(dbPath);
  const loaded = reopened.findRunForAccount('RUN-A', 'acct-A');
  assert.deepEqual(loaded, record);

  const api = createResultReadApi(reopened);
  const ctx = { accountId: 'acct-A', runId: 'RUN-A' };
  const results = unwrap(api.getResults(ctx));
  assert.equal(results.meanPercent, '37.5%');
  assert.equal(results.counts.numericTotal, 2);
  assert.equal(results.progress?.completed, 5);
  const byMetric = unwrap(api.listSamples(ctx, { metricId: 'param_fill', metricValue: 'Fail' }));
  assert.deepEqual(byMetric.items.map((item) => item.sampleId), ['A']);
  const detail = unwrap(api.getSample(ctx, 'A'));
  assert.equal(detail.scoring.totalScore, 0.75);
  assert.deepEqual((detail.businessJson as Record<string, unknown>).redline_fail_hits, []);
  reopened.close();
});

test('归属隔离：SQL 的 WHERE 同时限定批次与账号，越权在存储层即查不到', (t) => {
  const dbPath = tempDbPath(t);
  const store = openSqliteStore(dbPath);
  store.insertRun(makeRun());
  store.insertRun(makeRun({ id: 'RUN-B', ownerAccountId: 'acct-B', samples: [] }));

  assert.equal(store.findRunForAccount('RUN-A', 'acct-B'), undefined);
  assert.equal(store.findRunForAccount('RUN-A', undefined), undefined);
  assert.equal(store.findRunForAccount('RUN-MISSING', 'acct-A'), undefined);
  assert.ok(store.findRunForAccount('RUN-A', 'acct-A'));

  const rows = store.db.prepare(
    'SELECT id FROM runs WHERE id = ? AND owner_account_id = ?',
  ).all('RUN-A', 'acct-B') as { id: string }[];
  assert.equal(rows.length, 0);
  const leakedAttempts = store.db.prepare(`
    SELECT COUNT(*) AS n FROM judge_attempts a
    JOIN runs r ON r.id = a.run_id WHERE r.owner_account_id = ?
  `).get('acct-B') as { n: number };
  assert.equal(leakedAttempts.n, 0);

  const api = createResultReadApi(store);
  const forbidden = api.getResults({ accountId: 'acct-B', runId: 'RUN-A' });
  const missing = api.getResults({ accountId: 'acct-B', runId: 'RUN-MISSING' });
  assert.equal(forbidden.ok, false);
  assert.equal(missing.ok, false);
  if (!forbidden.ok && !missing.ok) {
    assert.equal(forbidden.httpStatus, 404);
    assert.deepEqual(forbidden, missing);
  }
  store.close();
});

test('尝试保真：全部尝试与最终尝试选择、可空 total、证据引用、Trace 到期都可读', (t) => {
  const dbPath = tempDbPath(t);
  const store = openSqliteStore(dbPath);
  const valid = sampleA.attempts[0]!.rawResponse!;
  const sample: SampleInput = {
    ...sampleA,
    attempts: [
      { id: 'bad', rawResponse: '{"broken"' },
      { id: 'good', rawResponse: valid, businessJson: null },
    ],
    effectiveAttemptId: 'good',
    evidence: { status: 'failed', stage: 'tool_execution_collect', traceId: 'trace-d-001' },
  };
  const retrySample: SampleRecord = {
    ...sampleA,
    id: 'F',
    attempts: [
      { id: 'bad', rawResponse: '{"broken"' },
      { id: 'good', rawResponse: valid },
    ],
    effectiveAttemptId: 'good',
    trace: { traceId: 'trace-F', expired: false },
  };
  const record = makeRun({
    samples: [
      { ...sample, answer: '完整回答', trace: { traceId: 'trace-A', expired: true } },
      retrySample,
    ],
  });
  store.insertRun(record);

  const loaded = store.findRunForAccount('RUN-A', 'acct-A');
  assert.deepEqual(loaded, record);
  assert.equal('businessJson' in loaded!.samples[0]!.attempts[0]!, false);
  assert.equal(loaded!.samples[0]!.attempts[1]!.businessJson, null);

  const api = createResultReadApi(store);
  const ctx = { accountId: 'acct-A', runId: 'RUN-A' };
  const detail = unwrap(api.getSample(ctx, 'A'));
  assert.deepEqual(detail.attempts.map((attempt) => attempt.attemptId), ['bad', 'good']);
  assert.equal(detail.attempts[0]?.rawResponse, '{"broken"');
  assert.equal(detail.attempts[1]?.rawResponse, valid);
  assert.equal(detail.scoring.status, 'evidence_missing');
  assert.equal(detail.scoringFromLocalHistory, true);
  assert.equal(detail.trace?.traceId, 'trace-A');

  const retried = unwrap(api.getSample(ctx, 'F'));
  assert.deepEqual(retried.attempts.map((attempt) => attempt.attemptId), ['bad', 'good']);
  assert.equal(retried.attempts[0]?.scoring.status, 'scoring_failed');
  assert.equal(retried.attempts[1]?.scoring.status, 'scored');
  assert.equal(retried.scoring.totalScore, 0.75);
  store.close();
});

test('异构规则：不同键名和嵌套层级的评分经 SQLite 读出后仍按映射取值', (t) => {
  const dbPath = tempDbPath(t);
  const store = openSqliteStore(dbPath);
  const sample: SampleRecord = {
    id: 'H-1',
    query: '异构规则样本',
    attempts: [{ id: 'h-1', rawResponse: JSON.stringify({
      grade: { overall: 88, comment: '回答完整' },
      timing: { first_token_ms: 320 },
      flags: { answered: true },
      checks: [{ name: 'formality', verdict: 'NA' }, { name: 'tone', verdict: 'Pass' }],
    }) }],
    answer: '异构规则回答',
    durationMs: 12.5,
    trace: { traceId: 'trace-h-1', expired: false },
  };
  store.insertRun(makeRun({
    id: 'RUN-H',
    rule: heterogeneousRule,
    ruleVersionId: 'rule_heterogeneous',
    status: 'partial_failed',
    samples: [sample],
  }));

  const results = unwrap(createResultReadApi(store).getResults({ accountId: 'acct-A', runId: 'RUN-H' }));
  assert.equal(results.ruleVersion, 'v2');
  assert.equal(results.mean, 88);
  assert.equal(results.meanPercent, null);
  assert.deepEqual(results.scoreRange, { min: 0, max: 100 });
  const detail = unwrap(createResultReadApi(store).getSample(
    { accountId: 'acct-A', runId: 'RUN-H' }, 'H-1',
  ));
  assert.equal(detail.scoring.totalScore, 88);
  assert.equal(detail.scoring.metrics.tone, 'Pass');
  assert.equal(detail.durationMs, sample.durationMs);
  store.close();
});

test('写入校验：空归属、重复 ID 与悬空最终尝试被拒绝且不留下半条记录', (t) => {
  const dbPath = tempDbPath(t);
  const store = openSqliteStore(dbPath);
  assert.throws(() => store.insertRun(makeRun({ ownerAccountId: '' })), /ownerAccountId/);
  assert.throws(() => store.insertRun(makeRun({
    samples: [makeSamples()[0]!, makeSamples()[0]!],
  })), /样本 ID 重复/);
  assert.throws(() => store.insertRun(makeRun({
    samples: [{ ...sampleA, effectiveAttemptId: 'missing' }],
  })), /最终尝试/);

  const count = store.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number };
  assert.equal(count.n, 0);
  store.close();
});

test('与内存实现等价：同一运行记录的三条接口响应逐字节一致', (t) => {
  const dbPath = tempDbPath(t);
  const record = makeRun();
  const memory = new InMemoryReadStore([record]);
  const sqlite = openSqliteStore(dbPath);
  sqlite.insertRun(record);

  const memoryApi = createResultReadApi(memory);
  const sqliteApi = createResultReadApi(sqlite);
  const ctx = { accountId: 'acct-A', runId: 'RUN-A' };
  assert.deepEqual(sqliteApi.getResults(ctx), memoryApi.getResults(ctx));
  for (const filter of [
    {},
    { limit: 2, offset: 1 },
    { status: 'scoring_failed' as const },
    { metricId: 'param_fill', metricValue: 'Fail' as const },
  ]) {
    assert.deepEqual(sqliteApi.listSamples(ctx, filter), memoryApi.listSamples(ctx, filter));
  }
  for (const sampleId of ['A', 'B', 'C', 'D', 'E']) {
    assert.deepEqual(sqliteApi.getSample(ctx, sampleId), memoryApi.getSample(ctx, sampleId));
  }
  sqlite.close();
});
