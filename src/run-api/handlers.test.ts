/**
 * 运行索引 handler 单元测试：
 *   node --test src/run-api/handlers.test.ts
 * 用内存版运行索引，账号只来自 ctx；不连接数据库、不启动 Docker、不调用模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  A, B, TASK, createRun, completeSample, setup, triggerBody,
} from './run-test-fixture.ts';
import {
  cancelManagedRun, getManagedRunStatus, listManagedRuns, requestManagedRun,
} from './handlers.ts';

test('手动触发创建冻结批次，归属取 ctx，请求体自报账号无效', async () => {
  const f = setup();
  const response = await requestManagedRun(f.accessor, { accountId: A }, triggerBody({ ownerAccountId: B }));
  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.equal(response.httpStatus, 201);
  if ('skipped' in response.data) throw new Error('不应跳过');
  const run = response.data;
  assert.equal(run.ownerAccountId, A);
  assert.equal(run.status, 'queued');
  assert.equal(run.trigger, 'manual');
  assert.equal(run.requestId, 'manual-1');
  assert.deepEqual(run.samples.map((s) => s.id), ['R1', 'R2', 'R3']);
  assert.deepEqual(run.binding.dataset, { id: 'ds-support', version: 'v3' });
});

test('同一 requestId 幂等重放 200 且 replayed，仅一批；不同 requestId 另建', async () => {
  const f = setup();
  const first = await requestManagedRun(f.accessor, { accountId: A }, triggerBody());
  const replay = await requestManagedRun(f.accessor, { accountId: A }, triggerBody({ ownerAccountId: B }));
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (!first.ok || !replay.ok || 'skipped' in first.data || 'skipped' in replay.data) return;
  assert.equal(first.httpStatus, 201);
  assert.equal(replay.httpStatus, 200);
  assert.equal(replay.replayed, true);
  assert.equal(replay.data.id, first.data.id);
  assert.equal(f.store.list(A).length, 1);
  const other = await requestManagedRun(f.accessor, { accountId: A }, triggerBody({ requestId: 'manual-2' }));
  assert.equal(other.ok, true);
  assert.equal(f.store.list(A).length, 2);
});

test('未登录触发、取消、详情、列表均 401', async () => {
  const f = setup();
  const ctx = {};
  const trigger = await requestManagedRun(f.accessor, ctx, triggerBody());
  const cancel = await cancelManagedRun(f.accessor, ctx, 'RUN-x');
  const status = await getManagedRunStatus(f.accessor, ctx, 'RUN-x');
  const list = await listManagedRuns(f.accessor, ctx);
  for (const r of [trigger, cancel, status, list]) {
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.httpStatus, 401);
  }
});

test('形状错误返回 400 且不落库：缺 requestId、任务引用、绑定引用、样本不匹配', async () => {
  const f = setup();
  const cases = [
    triggerBody({ requestId: '' }),
    triggerBody({ task: undefined }),
    triggerBody({ task: { id: 'task-regression' } }),
    triggerBody({ binding: { scenario: { ...TASK } } }),
    triggerBody({ sampleIds: 'R1' }),
    triggerBody({ sampleIds: ['R1', ''] }),
  ];
  for (const body of cases) {
    const response = await requestManagedRun(f.accessor, { accountId: A }, body);
    assert.equal(response.ok, false);
    if (!response.ok) {
      assert.equal(response.httpStatus, 400);
      assert.equal(response.code, 'INVALID_INPUT');
      assert.ok(response.issues && response.issues.length > 0);
    }
  }
  assert.equal(f.store.list(A).length, 0);
});

test('绑定漂移、他人任务与空 requestId 之外的领域错误映射 422 且不落库', async () => {
  const f = setup();
  const drifted = await requestManagedRun(f.accessor, { accountId: A }, triggerBody({
    binding: {
      scenario: { id: 'sc-harness', version: 'v2' },
      dataset: { id: 'ds-support', version: 'v3' },
      rule: { id: 'rule_process_quality', version: 'v1' },
    },
  }));
  assert.equal(drifted.ok, false);
  if (!drifted.ok) assert.equal(drifted.httpStatus, 422);
  assert.equal(f.store.list(A).length, 0);
});

test('显式 runId 冲突返回 409 且不覆盖既有批次', async () => {
  const f = setup();
  const seed = createRun(f, { runId: 'RUN-FIXED' });
  const conflict = await requestManagedRun(f.accessor, { accountId: A }, triggerBody({
    requestId: 'manual-2', runId: 'RUN-FIXED',
  }));
  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal(conflict.httpStatus, 409);
    assert.equal(conflict.code, 'RUN_ID_CONFLICT');
  }
  assert.equal(f.store.get('RUN-FIXED', A)?.id, seed.id);
  assert.equal(f.store.list(A).length, 1);
});

test('取消本批未结束样本，保留已完成样本；重放 200 且时间不刷新', async () => {
  const f = setup();
  const run = createRun(f);
  completeSample(f, run, 'R1');
  const response = await cancelManagedRun(f.accessor, { accountId: A }, run.id);
  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.equal(response.httpStatus, 200);
  assert.equal(response.data.status, 'canceled');
  assert.deepEqual(response.data.samples.map((s) => s.status), ['succeeded', 'canceled', 'canceled']);
  const canceledAt = response.data.updatedAt;
  const replay = await cancelManagedRun(f.accessor, { accountId: A }, run.id);
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.replayed, true);
    assert.equal(replay.data.updatedAt, canceledAt);
  }
});

test('越权与不存在的取消、详情统一 404；他人批次不进入本人列表', async () => {
  const f = setup();
  const run = createRun(f);
  const cancel = await cancelManagedRun(f.accessor, { accountId: B }, run.id);
  const detail = await getManagedRunStatus(f.accessor, { accountId: B }, run.id);
  const missingDetail = await getManagedRunStatus(f.accessor, { accountId: A }, 'RUN-NOPE');
  for (const r of [cancel, detail, missingDetail]) {
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.httpStatus, 404);
  }
  const bList = await listManagedRuns(f.accessor, { accountId: B });
  const aList = await listManagedRuns(f.accessor, { accountId: A });
  assert.equal(bList.ok, true);
  if (bList.ok) assert.equal(bList.data.total, 0);
  assert.equal(aList.ok, true);
  if (aList.ok) assert.equal(aList.data.total, 1);
});

test('详情返回冻结批次，列表按 taskId 过滤且回显 taskId', async () => {
  const f = setup();
  const first = createRun(f);
  createRun(f, { requestId: 'manual-2' });
  const detail = await getManagedRunStatus(f.accessor, { accountId: A }, first.id);
  assert.equal(detail.ok, true);
  if (detail.ok) {
    assert.equal(detail.data.id, first.id);
    assert.throws(() => { (detail.data.samples as unknown as { status: string }[])[0]!.status = 'succeeded'; }, TypeError);
  }
  const all = await listManagedRuns(f.accessor, { accountId: A });
  const filtered = await listManagedRuns(f.accessor, { accountId: A }, { taskId: TASK.id });
  const none = await listManagedRuns(f.accessor, { accountId: A }, { taskId: 'task-other' });
  assert.equal(all.ok, true);
  assert.equal(filtered.ok, true);
  assert.equal(none.ok, true);
  if (all.ok && filtered.ok && none.ok) {
    assert.equal(all.data.total, 2);
    assert.equal(filtered.data.total, 2);
    assert.equal(filtered.data.taskId, TASK.id);
    assert.equal(none.data.total, 0);
  }
});

test('列表 taskId 非法形状返回 400', async () => {
  const f = setup();
  const response = await listManagedRuns(f.accessor, { accountId: A }, { taskId: '  ' });
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.httpStatus, 400);
});
