/**
 * 草稿与预览 handler 测试：
 *   node --test src/draft-api/handlers.test.ts
 * 纯内存夹具，不连接数据库、不启动 Docker、不访问上游。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireManagedPreview, cancelManagedDraft, confirmManagedDraft, createManagedDraft,
  getManagedDraft, listManagedDrafts, listManagedPreviews, retryManagedPreview,
  transitionManagedPreview, updateManagedDraft,
  type DraftResponse,
} from './handlers.ts';
import { A, B, createBody, confirmBody, seedDraft, setup } from './draft-test-fixture.ts';

function ok<T>(response: DraftResponse<T>, status = 200): T {
  assert.equal(response.ok, true, JSON.stringify(response));
  if (!response.ok) throw new Error('unreachable');
  assert.equal(response.httpStatus, status);
  return response.data;
}

function err<T>(response: DraftResponse<T>): Extract<DraftResponse<T>, { ok: false }> {
  assert.equal(response.ok, false);
  if (response.ok) throw new Error('unreachable');
  return response;
}

test('创建草稿：归属只取服务端上下文，自报账号无效，201 并返回冻结记录', async () => {
  const { accessor } = setup();
  const created = createManagedDraft(accessor, { accountId: A }, createBody({ ownerAccountId: B, accountId: B }));
  const draft = ok(await created, 201);
  assert.equal(draft.ownerAccountId, A);
  assert.equal(draft.id, 'draft:regression-1');
  assert.deepEqual(draft.sampleIds, ['R1', 'R2', 'R3']);
  assert.equal(Object.isFrozen(draft), true);
  assert.equal(ok(await listManagedDrafts(accessor, { accountId: A })).total, 1);
  assert.equal(ok(await listManagedDrafts(accessor, { accountId: B })).total, 0);
  assert.equal(ok(await getManagedDraft(accessor, { accountId: A }, draft.id)).id, draft.id);
  assert.equal(err(await createManagedDraft(accessor, {}, createBody())).httpStatus, 401);
});

test('形状错误一律 400 且不落库：引用、ID 前缀、步骤、样本与映射', async () => {
  const { accessor } = setup();
  const cases: Record<string, unknown>[] = [
    createBody({ scenario: { id: 'sc-harness' } }),
    createBody({ id: 'run-1' }),
    createBody({ step: 5 }),
    createBody({ sampleIds: ['R1', 2] }),
    createBody({ mappings: [{ placeholder: '', source: 'dataset', path: 'query' }] }),
  ];
  for (const body of cases) {
    const failure = err(await createManagedDraft(accessor, { accountId: A }, body));
    assert.equal(failure.httpStatus, 400);
    assert.equal(failure.code, 'INVALID_INPUT');
    assert.ok(failure.issues?.length);
  }
  assert.equal(ok(await listManagedDrafts(accessor, { accountId: A })).total, 0);
});

test('领域冲突映射：重复 ID 409，越权绑定与非法查询列 422 带 issues', async () => {
  const { accessor } = setup();
  ok(await createManagedDraft(accessor, { accountId: A }, createBody()), 201);
  const duplicate = err(await createManagedDraft(accessor, { accountId: A }, createBody()));
  assert.equal(duplicate.httpStatus, 409);
  assert.equal(duplicate.code, 'ID_CONFLICT');
  const crossOwner = err(await createManagedDraft(accessor, { accountId: A },
    createBody({ id: 'draft:other', dataset: { id: 'ds-support-b', version: 'v1' } })));
  assert.equal(crossOwner.httpStatus, 422);
  assert.equal(crossOwner.issues?.[0]?.field, 'dataset');
  const badColumn = err(await createManagedDraft(accessor, { accountId: A },
    createBody({ id: 'draft:other', queryColumn: 'missing' })));
  assert.equal(badColumn.httpStatus, 422);
  assert.equal(badColumn.issues?.[0]?.field, 'queryColumn');
});

test('详情与列表按账号限定：越权和不存在统一 404', async () => {
  const { accessor } = setup();
  await seedDraft(accessor);
  const missing = err(await getManagedDraft(accessor, { accountId: A }, 'draft:nope'));
  const other = err(await getManagedDraft(accessor, { accountId: B }, 'draft:regression-1'));
  assert.equal(missing.httpStatus, 404);
  assert.deepEqual(other, missing);
  assert.equal(err(await updateManagedDraft(accessor, { accountId: B }, 'draft:regression-1', {
    expectedRevision: 1,
  })).httpStatus, 404);
});

test('更新以 revision 乐观并发：缺失或过期 400/409，合法更新递增 revision', async () => {
  const { accessor } = setup();
  await seedDraft(accessor);
  assert.equal(err(await updateManagedDraft(accessor, { accountId: A }, 'draft:regression-1', {})).httpStatus, 400);
  const stale = err(await updateManagedDraft(accessor, { accountId: A }, 'draft:regression-1', {
    expectedRevision: 9,
  }));
  assert.equal(stale.httpStatus, 409);
  assert.equal(stale.code, 'REVISION_CONFLICT');
  const updated = ok(await updateManagedDraft(accessor, { accountId: A }, 'draft:regression-1', {
    expectedRevision: 1, step: 3, name: '第 3 步',
  }));
  assert.equal(updated.revision, 2);
  assert.equal(updated.step, 3);
  assert.equal(updated.name, '第 3 步');
  assert.equal(err(await updateManagedDraft(accessor, { accountId: A }, 'draft:regression-1', {
    expectedRevision: 2, step: 9,
  })).httpStatus, 400);
});

test('取消可重放并停止预览；取消后更新与确认均被拒绝', async () => {
  const { accessor } = setup();
  await seedDraft(accessor);
  ok(await acquireManagedPreview(accessor, { accountId: A }, 'draft:regression-1', { sampleId: 'R1' }), 201);
  const canceled = await cancelManagedDraft(accessor, { accountId: A }, 'draft:regression-1');
  assert.equal(canceled.ok, true);
  if (!canceled.ok) throw new Error('unreachable');
  assert.equal(canceled.data.status, 'canceled');
  assert.equal(canceled.replayed, false);
  const second = await cancelManagedDraft(accessor, { accountId: A }, 'draft:regression-1');
  assert.equal((second as Extract<typeof second, { ok: true }>).replayed, true);
  assert.equal(ok(await listManagedPreviews(accessor, { accountId: A }, 'draft:regression-1')).items[0]?.status, 'canceled');
  assert.equal(err(await updateManagedDraft(accessor, { accountId: A }, 'draft:regression-1', {
    expectedRevision: 2,
  })).code, 'DRAFT_CANCELED');
  assert.equal(err(await confirmManagedDraft(accessor, { accountId: A }, 'draft:regression-1', confirmBody())).code,
    'DRAFT_CANCELED');
});

test('确认返回冻结任务配置载荷且不写任务版本；同幂等键重放一致', async () => {
  const { accessor, catalog } = setup();
  await seedDraft(accessor);
  const before = catalog.listTasks(A).length;
  const payload = ok(await confirmManagedDraft(accessor, { accountId: A }, 'draft:regression-1', confirmBody()));
  assert.equal(payload.sourceDraftId, 'draft:regression-1');
  assert.equal(payload.binding.name, '过程质量回归评测');
  assert.equal(payload.binding.schedule.enabled, false);
  assert.equal(Object.isFrozen(payload), true);
  const replay = await confirmManagedDraft(accessor, { accountId: A }, 'draft:regression-1', confirmBody());
  assert.equal((replay as Extract<typeof replay, { ok: true }>).replayed, true);
  assert.deepEqual((replay as Extract<typeof replay, { ok: true }>).data, payload);
  assert.equal(catalog.listTasks(A).length, before);
  assert.equal(err(await confirmManagedDraft(accessor, { accountId: A }, 'draft:regression-1',
    confirmBody({ idempotencyKey: 'other' }))).code, 'DRAFT_CONFIRMED');
  const withoutRule = setup();
  await seedDraft(withoutRule.accessor, A, { rule: undefined });
  assert.equal(err(await confirmManagedDraft(withoutRule.accessor, { accountId: A }, 'draft:regression-1',
    confirmBody())).issues?.[0]?.field, 'rule');
});

test('预览获取：同签名复用、越权样本拒绝、最多三条', async () => {
  const { accessor } = setup();
  await seedDraft(accessor);
  const first = await acquireManagedPreview(accessor, { accountId: A }, 'draft:regression-1', { sampleId: 'R1' });
  assert.equal((first as Extract<typeof first, { ok: true }>).httpStatus, 201);
  const reused = await acquireManagedPreview(accessor, { accountId: A }, 'draft:regression-1', { sampleId: 'R1' });
  assert.equal((reused as Extract<typeof reused, { ok: true }>).replayed, true);
  assert.equal((reused as Extract<typeof reused, { ok: true }>).data.key,
    (first as Extract<typeof first, { ok: true }>).data.key);
  for (const sampleId of ['R2', 'R3']) {
    ok(await acquireManagedPreview(accessor, { accountId: A }, 'draft:regression-1', { sampleId }), 201);
  }
  const extra = err(await acquireManagedPreview(accessor, { accountId: A }, 'draft:regression-1',
    { sampleId: 'R4' }));
  assert.equal(extra.code, 'SAMPLE_NOT_IN_DATASET');
  assert.equal(ok(await listManagedPreviews(accessor, { accountId: A }, 'draft:regression-1')).total, 3);
  assert.equal(err(await listManagedPreviews(accessor, { accountId: B }, 'draft:regression-1')).httpStatus, 404);
  assert.equal(err(await acquireManagedPreview(accessor, { accountId: A }, 'draft:regression-1', {})).httpStatus, 400);
});

test('预览流转与按条重试：非法状态 400/422，成功不可重试，失败重试递增次数', async () => {
  const { accessor } = setup();
  await seedDraft(accessor);
  ok(await acquireManagedPreview(accessor, { accountId: A }, 'draft:regression-1', { sampleId: 'R1' }), 201);
  assert.equal(err(await transitionManagedPreview(accessor, { accountId: A }, 'draft:regression-1', 'R1',
    { status: 'done' })).httpStatus, 400);
  ok(await transitionManagedPreview(accessor, { accountId: A }, 'draft:regression-1', 'R1', { status: 'running' }));
  ok(await transitionManagedPreview(accessor, { accountId: A }, 'draft:regression-1', 'R1', {
    status: 'failed', reason: 'trace 延迟',
  }));
  const retried = ok(await retryManagedPreview(accessor, { accountId: A }, 'draft:regression-1', 'R1'));
  assert.equal(retried.status, 'pending');
  assert.equal(retried.attempts, 2);
  assert.equal(retried.reason, undefined);
  const activeReplay = await retryManagedPreview(accessor, { accountId: A }, 'draft:regression-1', 'R1');
  assert.equal((activeReplay as Extract<typeof activeReplay, { ok: true }>).replayed, true);
  ok(await transitionManagedPreview(accessor, { accountId: A }, 'draft:regression-1', 'R1', {
    status: 'succeeded', traceRef: 'trace-http-1',
  }));
  const afterSuccess = err(await retryManagedPreview(accessor, { accountId: A }, 'draft:regression-1', 'R1'));
  assert.equal(afterSuccess.code, 'PREVIEW_TRANSITION');
  assert.equal(err(await transitionManagedPreview(accessor, { accountId: B }, 'draft:regression-1', 'R1',
    { status: 'failed' })).httpStatus, 404);
});

test('配置签名变化后旧预览被丢弃，按新配置重新获取', async () => {
  const { accessor } = setup();
  await seedDraft(accessor);
  const first = ok(await acquireManagedPreview(accessor, { accountId: A }, 'draft:regression-1', { sampleId: 'R1' }), 201);
  ok(await updateManagedDraft(accessor, { accountId: A }, 'draft:regression-1', {
    expectedRevision: 1,
    mappings: [{ placeholder: '{{query}}', source: 'dataset', path: 'answer' }],
  }));
  assert.equal(ok(await listManagedPreviews(accessor, { accountId: A }, 'draft:regression-1')).total, 0);
  const next = ok(await acquireManagedPreview(accessor, { accountId: A }, 'draft:regression-1', { sampleId: 'R1' }), 201);
  assert.notEqual(next.signature, first.signature);
  assert.equal(next.status, 'pending');
});
