import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Pool } from 'pg';
import { processQualityRule, processQualitySamples } from '../src/result-contract/fixtures.ts';
import { sampleXlsxBase64 } from '../src/import-api/xlsx-test-fixture.ts';
import { createPlatformServer } from '../src/server.ts';
import { migrate, openPool, PostgresStore } from '../src/storage/postgres/database.ts';
import { postgresRunIndex } from '../src/storage/postgres/run-index.ts';

test('PostgreSQL 平台接口', async (t) => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, '请显式提供独立测试库 TEST_DATABASE_URL');
  const admin = openPool(url);
  const schema = 'eval_test_' + randomUUID().replaceAll('-', '');
  // Use an isolated namespace so repeat and parallel runs cannot touch pre-existing data.
  await admin.query('CREATE SCHEMA ' + schema);
  const pool = new Pool({ connectionString: url, options: '-c search_path=' + schema });
  const store = new PostgresStore(pool);
  const server = createPlatformServer(store);
  t.after(async () => {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    try { await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); } finally { await admin.end(); }
  });
  await Promise.all([migrate(pool), migrate(pool)]);
  await migrate(pool);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const a = await store.create('A');
  const b = await store.create('B');
  async function api(path: string, token?: string, body?: unknown) {
    const response = await fetch(base + '/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json(), replayed: response.headers.get('x-replayed') };
  }
  const dataset = { id: 'ds', version: 'v1' };
  const csv = { ...dataset, name: '客服样本', queryColumn: 'query', csv: 'query\n第一条\n第二条', ownerAccountId: 'B' };
  const sourceRows = 'imports/dataset/ds/v1/rows';
  await t.test('并发重复导入只写一份；跨账号读取、写入冲突都保留原始数据', async () => {
    assert.equal((await api('health')).json.database, 'postgresql');
    assert.equal((await api('resources/dataset?accountId=A')).status, 401);
    const replies = await Promise.all([api('imports/dataset', a, csv), api('imports/dataset', a, csv)]);
    assert.deepEqual(replies.map((r) => r.status).sort(), [200,201]);
    assert.equal(replies.find((r) => r.status === 200)?.replayed, 'true');
    assert.equal((await api('imports/dataset', a, { ...csv, csv: 'query\n冲突' })).status, 409);
    assert.equal((await api('imports/dataset', b, csv)).status, 409);
    assert.equal((await api('resources/dataset', b)).json.total, 0);
    assert.equal((await api(sourceRows, b)).status, 404);
    assert.equal((await api(sourceRows, a)).json.rows[0].cells.query, '第一条');
    assert.equal((await api('resources/dataset/ds/v1/copy', a, { id: 'copy' })).status, 201);
    assert.deepEqual((await api('imports/dataset/copy/v1/rows', a)).json.rows, (await api(sourceRows, a)).json.rows);
  });
  await t.test('行数据写入失败时，元信息在同一事务内回滚', async () => {
    await pool.query("ALTER TABLE dataset_row_sets ADD CONSTRAINT test_refuse_rows CHECK (id <> 'test-rollback')");
    try {
      const reply = await api('imports/dataset', a, { ...csv, id: 'test-rollback' });
      assert.equal(reply.status, 500);
      assert.equal((await api('resources/dataset/test-rollback/v1', a)).status, 404);
      assert.equal((await api('imports/dataset/test-rollback/v1/rows', a)).status, 404);
    } finally {
      await pool.query('ALTER TABLE dataset_row_sets DROP CONSTRAINT test_refuse_rows');
    }
  });
  await t.test('数据库筛选与分页返回本人命中总数，超出末页也保留总数', async () => {
    const first = await api('resources/dataset?name=客服样本&sortBy=id&pageSize=1', a);
    assert.equal(first.json.total, 2);
    assert.deepEqual(first.json.items.map((item: { id: string }) => item.id), ['copy']);
    const last = await api('resources/dataset?q=客服&page=3&pageSize=1', a);
    assert.equal(last.json.total, 2);
    assert.deepEqual(last.json.items, []);
    assert.equal((await api('resources/dataset?ownerAccountId=B', a)).json.total, 0);
    assert.equal((await api('resources/dataset?page=0', a)).status, 400);
  });
  await t.test('Excel 导入与重放仍能读取冻结样本', async () => {
    const input = { id: 'excel', version: 'v1', name: 'Excel', queryColumn: 'query', xlsxBase64: sampleXlsxBase64(), sheet: '样本' };
    assert.equal((await api('imports/dataset/xlsx', a, input)).status, 201);
    assert.equal((await api('imports/dataset/xlsx', a, input)).replayed, 'true');
    assert.ok((await api('imports/dataset/excel/v1/rows', a)).json.rows.length > 0);
  });
  await t.test('任务绑定、引用和归档按账号与版本校验', async () => {
    const scenario = { id: 'scenario', version: 'v1' };
    const rule = { id: processQualityRule.id, version: processQualityRule.version };
    assert.equal((await api('resources/scenario', a, { ...scenario, snapshot: {
      name: '测试场景', profile: 'harness', modelConfigRef: 'test', toolWhitelist: [],
    } })).status, 201);
    assert.equal((await api('resources/rule', a, { ...rule, snapshot: processQualityRule })).status, 201);
    const task = { id: 'task', version: 'v1', binding: { name: '试评', dataset, rule, scenario,
      schedule: { enabled: false, timezone: 'Asia/Shanghai' }, variableMappings: [] } };
    assert.equal((await api('resources/task', b, task)).status, 422);
    assert.equal((await api('resources/task', a, task)).status, 201);
    assert.equal((await api('resources/task/task/v1/copy', a, { id: 't2' })).status, 201);
    assert.equal((await api('resources/dataset/ds/v1/archive', a, {})).status, 409);
    for (const id of ['task','t2']) assert.ok((await api('resources/task/' + id + '/v1/archive', a, {})).status < 300);
    assert.ok((await api('resources/dataset/ds/v1/archive', a, {})).status < 300);
    assert.equal((await api('resources/task', a, { ...task, id: 't3' })).status, 422);
    assert.equal((await api(sourceRows, a)).status, 200);
  });
  await t.test('运行索引落 PG：幂等、活跃跳过、状态流转、取消、归属与重开可读', async () => {
    const runs = postgresRunIndex(pool);
    const scenario = { id: 'run-scenario', version: 'v1' };
    const dataset = { id: 'run-ds', version: 'v1' };
    const rule = { id: 'run-rule', version: 'v1' };
    const task = { id: 'run-task', version: 'v1' };
    assert.equal((await api('resources/scenario', a, { ...scenario, snapshot: {
      name: '运行索引场景', profile: 'harness', modelConfigRef: 'test', toolWhitelist: [],
    } })).status, 201);
    assert.equal((await api('imports/dataset', a, { ...dataset, name: '运行索引样本',
      queryColumn: 'query', csv: 'query\n第一条\n第二条' })).status, 201);
    assert.equal((await api('resources/rule', a, { ...rule, snapshot: { ...processQualityRule, id: rule.id } })).status, 201);
    assert.equal((await api('resources/task', a, { ...task, binding: {
      name: '运行索引任务', dataset, rule, scenario,
      schedule: { enabled: false, timezone: 'Asia/Shanghai' }, variableMappings: [],
    } })).status, 201);

    const manualInput = { task, binding: { scenario, dataset, rule }, trigger: 'manual' as const, requestId: 'pg-manual-1' };
    const first = await runs.requestRun('A', manualInput);
    assert.equal(first.ok, true);
    if (!first.ok || !first.run) throw new Error('手动触发未创建批次');
    const runId = first.run.id;
    assert.equal(first.run.status, 'queued');
    assert.equal(first.run.samples.length, 2);
    assert.equal(first.run.samples[0].status, 'waiting_agent');
    const replay = await runs.requestRun('A', manualInput);
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.run?.id, runId);
    const rowCount = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM run_index WHERE owner_id='A'");
    assert.equal(Number(rowCount.rows[0].n), 1);

    const running = await runs.transitionRun(runId, 'A', 'running');
    assert.equal(running.ok, true);
    assert.equal((await runs.transitionRun(runId, 'A', 'succeeded')).ok, false);
    if (!running.ok) throw new Error('批次未进入运行态');
    for (const sample of running.value.samples) {
      for (const next of ['agent_running', 'waiting_trace', 'waiting_scoring', 'succeeded'] as const) {
        const changed = await runs.setSampleStatus(runId, 'A', sample.id, next);
        assert.equal(changed.ok, true);
      }
    }
    const finished = await runs.transitionRun(runId, 'A', 'succeeded');
    assert.equal(finished.ok, true);
    assert.equal(finished.ok && finished.value.status, 'succeeded');

    const scheduledInput = { task, binding: { scenario, dataset, rule }, trigger: 'scheduled' as const,
      scheduledAt: '2026-11-26T10:00:00+08:00' };
    const scheduled = await runs.requestRun('A', scheduledInput);
    assert.equal(scheduled.ok, true);
    assert.ok(scheduled.run);
    const scheduledReplay = await runs.requestRun('A', scheduledInput);
    assert.equal(scheduledReplay.ok && scheduledReplay.replayed, true);
    const skipped = await runs.requestRun('A', { ...scheduledInput, scheduledAt: '2026-11-26T10:05:00+08:00' });
    assert.equal(skipped.ok, true);
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.run, undefined);

    const cancelInput = { ...manualInput, requestId: 'pg-cancel-1' };
    const cancelRun = await runs.requestRun('A', cancelInput);
    assert.equal(cancelRun.ok, true);
    if (!cancelRun.ok || !cancelRun.run) throw new Error('取消用批次未创建');
    const canceled = await runs.cancelRun(cancelRun.run.id, 'A');
    assert.equal(canceled.ok, true);
    assert.equal(canceled.ok && canceled.value.status, 'canceled');
    assert.ok(canceled.ok && canceled.value.samples.every((sample) => sample.status === 'canceled'));
    const cancelReplay = await runs.cancelRun(cancelRun.run.id, 'A');
    assert.equal(cancelReplay.ok && cancelReplay.replayed, true);

    const invalid = await runs.requestRun('A', { ...manualInput, requestId: 'pg-invalid',
      task: { id: 'missing-task', version: 'v1' } });
    assert.equal(invalid.ok, false);
    assert.equal((await runs.listRuns('A')).length, 3);
    assert.equal((await runs.getRun(runId, 'B')), undefined);
    assert.deepEqual(await runs.listRuns('B'), []);
    assert.equal((await runs.getRun(runId, undefined)), undefined);
    assert.equal((await runs.listRuns(undefined)).length, 0);
    assert.equal((await runs.listRunsForTask('A', task.id)).length, 3);
    assert.deepEqual(await runs.listRunsForTask('B', task.id), []);

    const reopened = new Pool({ connectionString: url, options: '-c search_path=' + schema });
    try {
      const reader = postgresRunIndex(reopened);
      assert.deepEqual(await reader.getRun(runId, 'A'), finished.ok ? finished.value : undefined);
      const reopenedReplay = await reader.requestRun('A', manualInput);
      assert.equal(reopenedReplay.ok && reopenedReplay.replayed, true);
    } finally { await reopened.end(); }
  });

  await t.test('运行索引 HTTP 入口：触发/重放/详情/列表/取消与跨账号隔离', async () => {
    const scenario = { id: 'http-run-scenario', version: 'v1' };
    const dataset = { id: 'http-run-ds', version: 'v1' };
    const rule = { id: 'http-run-rule', version: 'v1' };
    const task = { id: 'http-run-task', version: 'v1' };
    assert.equal((await api('resources/scenario', a, { ...scenario, snapshot: {
      name: 'HTTP 运行场景', profile: 'harness', modelConfigRef: 'test', toolWhitelist: [],
    } })).status, 201);
    assert.equal((await api('imports/dataset', a, { ...dataset, name: 'HTTP 运行样本',
      queryColumn: 'query', csv: 'query\n第一条\n第二条' })).status, 201);
    assert.equal((await api('resources/rule', a, { ...rule, snapshot: { ...processQualityRule, id: rule.id } })).status, 201);
    assert.equal((await api('resources/task', a, { ...task, binding: {
      name: 'HTTP 运行任务', dataset, rule, scenario,
      schedule: { enabled: false, timezone: 'Asia/Shanghai' }, variableMappings: [],
    } })).status, 201);

    const trigger = { task, binding: { scenario, dataset, rule }, requestId: 'http-manual-1', ownerAccountId: 'B' };
    assert.equal((await api('runs', undefined, trigger)).status, 401);
    const created = await api('runs', a, trigger);
    assert.equal(created.status, 201);
    assert.equal(created.json.ownerAccountId, 'A');
    assert.deepEqual(created.json.samples.map((s: any) => s.id), ['R000001', 'R000002']);
    const runId = created.json.id;
    const replay = await api('runs', a, trigger);
    assert.equal(replay.status, 200);
    assert.equal(replay.replayed, 'true');
    assert.equal(replay.json.id, runId);
    const rowCount = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM run_index WHERE owner_id='A' AND idempotency_key LIKE 'manual:A:http-manual-1%'");
    assert.equal(Number(rowCount.rows[0].n), 1);

    const detail = await api('runs/' + encodeURIComponent(runId), a);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.id, runId);
    const otherDetail = await api('runs/' + encodeURIComponent(runId), b);
    assert.equal(otherDetail.status, 404);
    const missing = await api('runs/NOT-EXIST', a);
    assert.equal(missing.status, 404);
    assert.deepEqual(otherDetail.json, missing.json);

    const list = await api('runs', a);
    assert.equal(list.status, 200);
    assert.ok(list.json.items.some((item: any) => item.id === runId));
    assert.equal(list.json.items.every((item: any) => item.ownerAccountId === 'A'), true);
    const filtered = await api('runs?taskId=' + encodeURIComponent(task.id), a);
    assert.equal(filtered.json.taskId, task.id);
    assert.ok(filtered.json.items.some((item: any) => item.id === runId));
    assert.equal((await api('runs', b)).json.items.some((item: any) => item.id === runId), false);

    const canceled = await api('runs/' + encodeURIComponent(runId) + '/cancel', a, {});
    assert.equal(canceled.status, 200);
    assert.equal(canceled.json.status, 'canceled');
    assert.ok(canceled.json.samples.every((s: any) => s.status === 'canceled'));
    const cancelReplay = await api('runs/' + encodeURIComponent(runId) + '/cancel', a, {});
    assert.equal(cancelReplay.replayed, 'true');
    assert.equal((await api('runs/' + encodeURIComponent(runId) + '/cancel', b, {})).status, 404);

    // 结果读取路由（/runs/:runId/results|samples）仍被分流到原 handler，未被运行索引遮蔽。
    assert.equal((await api('runs/' + encodeURIComponent(runId) + '/results', a)).status, 404);
  });

  await t.test('结果和会话跨连接可读；撤销或过期即失效', async () => {
    await store.insertRun({ id: 'r1', ownerAccountId: 'A', taskId: 'task', datasetVersionId: 'v1',
      ruleVersionId: processQualityRule.version, rule: processQualityRule, samples: processQualitySamples,
      status: 'succeeded', triggeredBy: 'manual', triggeredAt: new Date().toISOString() });
    const reopened = new Pool({ connectionString: url, options: '-c search_path=' + schema });
    try {
      const reader = new PostgresStore(reopened);
      assert.deepEqual((await reader.findRunForAccount('r1','A'))?.samples, processQualitySamples);
      assert.equal(await reader.accountFor(a), 'A');
    } finally { await reopened.end(); }
    assert.equal((await api('runs/r1/results', a)).status, 200);
    assert.equal((await api('runs/r1/samples/A', a)).status, 200);
    assert.equal((await api('runs/r1/results?accountId=A', b)).status, 404);
    await store.invalidate(a);
    assert.equal((await api('runs/r1/results', a)).status, 401);
    await pool.query("UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE account_id='B'");
    assert.equal((await api('resources/dataset', b)).status, 401);
    assert.equal(await store.purgeExpired(), 1);
  });
});
