/**
 * 向导草稿与预览领域契约单元测试：
 *   node --test src/domain/drafts.test.ts
 * 纯逻辑测试，仅用 Node 内置能力；不启动 Docker、不访问上游、不调用模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ResourceCatalog, type VariableMapping } from './resources.ts';
import { processQualityRule } from '../result-contract/fixtures.ts';
import {
  DRAFT_ID_PREFIX,
  DraftManager,
  InMemoryDraftStore,
  InMemoryPreviewStore,
  draftPreviewSignature,
  isDraftExpired,
  type ConfirmDraftInput,
  type CreateDraftInput,
  type DraftIssue,
  type UpdateDraftInput,
} from './drafts.ts';

const SCENARIO = { id: 'sc-harness', version: 'v1' } as const;
const DATASET = { id: 'ds-support', version: 'v3' } as const;
const OTHER_DATASET = { id: 'ds-other', version: 'v1' } as const;
const RULE = { id: 'rule-process_quality', version: 'v1' } as const;
const MAPPINGS: VariableMapping[] = [
  { placeholder: '{{query}}', source: 'dataset', path: 'query' },
  { placeholder: '{{answer}}', source: 'agent', path: 'final_answer' },
];

function setup(options: { ttlMs?: number } = {}) {
  let at = '2026-11-26T10:00:00+08:00';
  const now = () => at;
  const catalog = new ResourceCatalog(() => at);
  catalog.putScenario('acct-A', SCENARIO, {
    name: 'DeepSeek Harness',
    profile: 'deepseek-harness',
    modelConfigRef: 'model-profile-A',
    toolWhitelist: ['read_file'],
  });
  catalog.putDataset('acct-A', DATASET, {
    name: '客服样本集',
    source: 'excel',
    columns: ['query', 'answer'],
    rowIds: ['R1', 'R2', 'R3', 'R4', 'R5'],
    rowCount: 5,
    queryColumn: 'query',
    contentChecksum: 'sha256:abc123',
  });
  catalog.putDataset('acct-A', OTHER_DATASET, {
    name: '另一批样本',
    source: 'csv',
    columns: ['query'],
    rowIds: ['S1', 'S2'],
    rowCount: 2,
    queryColumn: 'query',
    contentChecksum: 'sha256:def456',
  });
  catalog.putRule('acct-A', RULE, processQualityRule);
  const store = new InMemoryDraftStore();
  const previewStore = new InMemoryPreviewStore();
  const drafts = new DraftManager(catalog, { store, previewStore, now, ...options });
  return { catalog, store, previewStore, drafts, now, advance: (minutes: number) => {
    at = new Date(Date.parse(at) + minutes * 60_000).toISOString();
  } };
}

function createInput(overrides: Partial<CreateDraftInput> = {}): CreateDraftInput {
  return {
    ownerAccountId: 'acct-A',
    id: 'draft:regression-1',
    scenario: { ...SCENARIO },
    dataset: { ...DATASET },
    rule: { ...RULE },
    name: '过程质量回归评测草稿',
    mappings: MAPPINGS.map((mapping) => ({ ...mapping })),
    ...overrides,
  };
}

function codes(result: { ok: false; issues: DraftIssue[] }): string[] {
  return result.issues.map((item) => item.code);
}

function confirmInput(overrides: Partial<ConfirmDraftInput> = {}): ConfirmDraftInput {
  return {
    taskRef: { id: 'task-regression', version: 'v1' },
    name: '过程质量回归评测',
    idempotencyKey: 'confirm-1',
    expectedRevision: 1,
    ...overrides,
  };
}

function updateInput(overrides: Partial<UpdateDraftInput> = {}): UpdateDraftInput {
  return { expectedRevision: 1, ...overrides };
}

test('创建草稿：账号限定、draft 前缀、冻结快照、默认取前三行', () => {
  const { drafts, store } = setup();
  const created = drafts.create(createInput());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const draft = created.value;
  assert.equal(draft.id, 'draft:regression-1');
  assert.ok(draft.id.startsWith(DRAFT_ID_PREFIX));
  assert.deepEqual(draft.sampleIds, ['R1', 'R2', 'R3']);
  assert.equal(draft.queryColumn, 'query');
  assert.equal(draft.revision, 1);
  assert.equal(draft.status, 'active');
  assert.equal(Object.isFrozen(draft), true);
  assert.equal(Object.isFrozen(draft.mappings), true);
  assert.equal(drafts.get('acct-B', draft.id), undefined);
  assert.deepEqual(drafts.list('acct-B'), []);
  assert.deepEqual(drafts.list('acct-A').map((item) => item.id), [draft.id]);
  assert.equal(store.get(draft.id, 'acct-A')?.ownerAccountId, 'acct-A');
});

test('创建校验：版本归属、查询列、预览样本上限与重复占位符均有字段级错误且不落库', () => {
  const { drafts, store } = setup();
  const cases: Array<[CreateDraftInput, string]> = [
    [createInput({ ownerAccountId: 'acct-B' }), 'INVALID_INPUT'],
    [createInput({ dataset: { id: 'ds-b-only', version: 'v1' } }), 'INVALID_INPUT'],
    [createInput({ id: 'run-1' }), 'INVALID_INPUT'],
    [createInput({ queryColumn: 'answer_text' }), 'INVALID_INPUT'],
    [createInput({ sampleIds: ['R1', 'R2', 'R3', 'R4'] }), 'SAMPLE_NOT_IN_DATASET'],
    [createInput({ sampleIds: ['R1', 'missing'] }), 'SAMPLE_NOT_IN_DATASET'],
    [createInput({ mappings: [MAPPINGS[0], { ...MAPPINGS[0] }] }), 'INVALID_INPUT'],
  ];
  for (const [input, code] of cases) {
    const result = drafts.create(input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(codes(result).includes(code), `${code} not in ${codes(result).join(',')}`);
  }
  assert.equal(store.get('draft:regression-1', 'acct-A'), undefined);
  const duplicate = drafts.create(createInput());
  assert.equal(duplicate.ok, true);
  const replay = drafts.create(createInput());
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.deepEqual(codes(replay), ['ID_CONFLICT']);
});

test('更新草稿：revision 乐观并发、按账号限定、样本与冻结行一致', () => {
  const { drafts } = setup();
  assert.equal(drafts.create(createInput()).ok, true);
  const stale = drafts.update('acct-A', 'draft:regression-1', updateInput({ expectedRevision: 9 }));
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.deepEqual(codes(stale), ['REVISION_CONFLICT']);
  assert.equal(drafts.update('acct-B', 'draft:regression-1', updateInput()).ok, false);

  const changed = drafts.update('acct-A', 'draft:regression-1', updateInput({
    step: 3,
    name: '改名后的草稿',
    sampleIds: ['R2', 'R4'],
    mappings: [{ placeholder: '{{query}}', source: 'dataset', path: 'query' }],
  }));
  assert.equal(changed.ok, true);
  if (!changed.ok) return;
  assert.equal(changed.value.revision, 2);
  assert.equal(changed.value.step, 3);
  assert.deepEqual(changed.value.sampleIds, ['R2', 'R4']);
  assert.equal(changed.value.name, '改名后的草稿');
  assert.equal(changed.value.mappings.length, 1);

  const wrongDataset = drafts.update('acct-A', 'draft:regression-1', updateInput({
    expectedRevision: 2,
    dataset: { ...OTHER_DATASET }, sampleIds: ['R2'],
  }));
  assert.equal(wrongDataset.ok, false);
  if (!wrongDataset.ok) assert.deepEqual(codes(wrongDataset), ['SAMPLE_NOT_IN_DATASET']);
  const switched = drafts.update('acct-A', 'draft:regression-1', updateInput({
    expectedRevision: 2,
    dataset: { ...OTHER_DATASET },
    sampleIds: ['S1'],
  }));
  assert.equal(switched.ok, true);
});

test('到期草稿仍可读取展示，但更新、确认与预览获取均被拒绝', () => {
  const { drafts, advance } = setup({ ttlMs: 60_000 });
  assert.equal(drafts.create(createInput()).ok, true);
  advance(2);
  const draft = drafts.get('acct-A', 'draft:regression-1');
  assert.ok(draft);
  assert.equal(isDraftExpired(draft, () => '2026-11-26T10:02:00+08:00'), true);
  assert.equal(drafts.load('acct-A', draft.id).ok, false);
  assert.equal(drafts.update('acct-A', draft.id, updateInput()).ok, false);
  assert.equal(drafts.confirm('acct-A', draft.id, confirmInput()).ok, false);
  assert.equal(drafts.acquirePreview('acct-A', draft.id, 'R1').ok, false);
});

test('取消草稿：幂等重放、停止未结束预览、保留已完成结果，更新与确认被拒绝', () => {
  const { drafts } = setup();
  assert.equal(drafts.create(createInput()).ok, true);
  const pending = drafts.acquirePreview('acct-A', 'draft:regression-1', 'R1');
  assert.equal(pending.ok, true);
  assert.equal(drafts.markPreview('acct-A', 'draft:regression-1', 'R1', 'running', { executionId: pending.value.entry.executionId }).ok, true);
  const done = drafts.acquirePreview('acct-A', 'draft:regression-1', 'R2');
  assert.equal(done.ok, true);
  assert.equal(drafts.markPreview('acct-A', 'draft:regression-1', 'R2', 'succeeded', { executionId: done.value.entry.executionId }).ok, true);

  const canceled = drafts.cancel('acct-A', 'draft:regression-1');
  assert.equal(canceled.ok, true);
  const replay = drafts.cancel('acct-A', 'draft:regression-1');
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  if (canceled.ok) assert.equal(canceled.value.revision, 2);
  assert.deepEqual(drafts.listPreviews('acct-A', 'draft:regression-1').map((entry) => entry.status),
    ['canceled', 'succeeded']);
  assert.equal(drafts.update('acct-A', 'draft:regression-1', updateInput()).ok, false);
  assert.equal(drafts.confirm('acct-A', 'draft:regression-1', confirmInput()).ok, false);
});

test('确认草稿：产出冻结任务配置载荷，幂等重放一致，不写任务版本与运行', () => {
  const { drafts, catalog } = setup();
  assert.equal(drafts.create(createInput()).ok, true);
  const input = confirmInput();
  const confirmed = drafts.confirm('acct-A', 'draft:regression-1', input);
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;
  const payload = confirmed.value;
  assert.equal(payload.sourceDraftId, 'draft:regression-1');
  assert.deepEqual(payload.taskRef, { id: 'task-regression', version: 'v1' });
  assert.equal(payload.binding.name, '过程质量回归评测');
  assert.deepEqual(payload.binding.rule, RULE);
  assert.deepEqual(payload.binding.schedule, { enabled: false, timezone: 'Asia/Shanghai' });
  assert.deepEqual(payload.sampleIds, ['R1', 'R2', 'R3']);
  assert.equal(Object.isFrozen(payload.binding), true);
  assert.equal(Object.isFrozen(payload.binding.variableMappings), true);
  assert.deepEqual(catalog.listTasks('acct-A'), []);

  const replay = drafts.confirm('acct-A', 'draft:regression-1', input);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.ok && JSON.stringify(replay.value) === JSON.stringify(payload), true);
  const otherKey = drafts.confirm('acct-A', 'draft:regression-1', confirmInput({ idempotencyKey: 'confirm-2' }));
  assert.equal(otherKey.ok, false);
  assert.equal(drafts.confirm('acct-B', 'draft:regression-1', input).ok, false);
  assert.equal(drafts.cancel('acct-A', 'draft:regression-1').ok, false);
});

test('确认前必须有规则版本和名称；规则归档后不能再绑定到草稿', () => {
  const { drafts, catalog } = setup();
  assert.equal(drafts.create(createInput({ rule: undefined })).ok, true);
  const noRule = drafts.confirm('acct-A', 'draft:regression-1', confirmInput());
  assert.equal(noRule.ok, false);
  if (!noRule.ok) assert.deepEqual(codes(noRule), ['INVALID_INPUT']);

  assert.equal(drafts.create(createInput({ id: 'draft:archived' })).ok, true);
  catalog.archiveResource('rule', RULE, 'acct-A');
  const archived = drafts.update('acct-A', 'draft:archived', updateInput());
  assert.equal(archived.ok, false);
  if (!archived.ok) assert.ok(codes(archived).includes('INVALID_INPUT'));
});

test('预览签名覆盖草稿 ID、Agent 场景、数据集、查询映射与样本', () => {
  const { drafts } = setup();
  assert.equal(drafts.create(createInput()).ok, true);
  const draft = drafts.get('acct-A', 'draft:regression-1');
  assert.ok(draft);
  const baseline = draftPreviewSignature(draft, 'R1');
  assert.equal(baseline, draftPreviewSignature(draft, 'R1'));
  assert.notEqual(baseline, draftPreviewSignature(draft, 'R2'));
  assert.notEqual(baseline, draftPreviewSignature({ ...draft, scenario: { id: 'sc-harness', version: 'v2' } }, 'R1'));
  assert.notEqual(baseline, draftPreviewSignature({ ...draft, dataset: { ...OTHER_DATASET } }, 'R1'));
  assert.notEqual(baseline, draftPreviewSignature({ ...draft, queryColumn: 'answer' }, 'R1'));
  assert.equal(baseline, draftPreviewSignature(draft, 'R1', [...MAPPINGS].reverse()));
  assert.notEqual(baseline, draftPreviewSignature(draft, 'R1', [
    { placeholder: '{{query}}', source: 'dataset', path: 'answer' },
  ]));
  assert.notEqual(baseline, draftPreviewSignature({ ...draft, id: 'draft:other' }, 'R1'));
});

test('预览获取：相同签名复用原状态，配置变化丢弃旧结果并只留三条', () => {
  const { drafts } = setup();
  assert.equal(drafts.create(createInput()).ok, true);
  const first = drafts.acquirePreview('acct-A', 'draft:regression-1', 'R1');
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.value.created, true);
  assert.equal(first.value.entry.status, 'pending');
  assert.equal(drafts.markPreview('acct-A', 'draft:regression-1', 'R1', 'succeeded', { executionId: first.value.entry.executionId }).ok, true);

  const replay = drafts.acquirePreview('acct-A', 'draft:regression-1', 'R1');
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.ok && replay.value.created, false);
  assert.equal(replay.ok && replay.value.entry.status, 'succeeded');

  const changed = drafts.update('acct-A', 'draft:regression-1', updateInput({
    mappings: [{ placeholder: '{{query}}', source: 'dataset', path: 'answer' }],
  }));
  assert.equal(changed.ok, true);
  const refreshed = drafts.acquirePreview('acct-A', 'draft:regression-1', 'R1');
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.ok && refreshed.value.created, true);
  assert.equal(refreshed.ok && refreshed.value.entry.status, 'pending');
  assert.notEqual(refreshed.ok && refreshed.value.entry.signature, first.value.entry.signature);

  for (const id of ['R2', 'R3']) assert.equal(drafts.acquirePreview('acct-A', 'draft:regression-1', id).ok, true);
  assert.equal(drafts.listPreviews('acct-A', 'draft:regression-1').length, 3);
  assert.equal(drafts.acquirePreview('acct-A', 'draft:regression-1', 'R4').ok, false);
  assert.equal(drafts.acquirePreview('acct-A', 'draft:regression-1', 'missing').ok, false);
  assert.equal(drafts.acquirePreview('acct-B', 'draft:regression-1', 'R1').ok, false);
});

test('预览流转与按条重试：失败可重试并递增尝试，成功不可重试，状态不可跨越', () => {
  const { drafts } = setup();
  assert.equal(drafts.create(createInput()).ok, true);
  const initialR2 = drafts.acquirePreview('acct-A', 'draft:regression-1', 'R2');
  assert.ok(initialR2.ok);
  const invalid = drafts.markPreview('acct-A', 'draft:regression-1', 'R2', 'succeeded', { executionId: initialR2.value.entry.executionId });
  assert.equal(invalid.ok, true); // pending 可直接完成
  const retrySucceeded = drafts.retryPreview('acct-A', 'draft:regression-1', 'R2');
  assert.equal(retrySucceeded.ok, false);
  if (!retrySucceeded.ok) assert.deepEqual(codes(retrySucceeded), ['PREVIEW_TRANSITION']);

  const initialR1 = drafts.acquirePreview('acct-A', 'draft:regression-1', 'R1');
  assert.ok(initialR1.ok);
  assert.equal(drafts.markPreview('acct-A', 'draft:regression-1', 'R1', 'failed', { executionId: initialR1.value.entry.executionId, reason: 'trace 延迟' }).ok, true);
  const retried = drafts.retryPreview('acct-A', 'draft:regression-1', 'R1');
  assert.equal(retried.ok, true);
  assert.equal(retried.ok && retried.value.attempts, 2);
  assert.equal(retried.ok && retried.value.status, 'pending');
  assert.equal(retried.ok && retried.value.reason, undefined);
  const inFlight = drafts.retryPreview('acct-A', 'draft:regression-1', 'R1');
  assert.equal(inFlight.ok, true);
  assert.equal(inFlight.replayed, true);
  assert.equal(drafts.markPreview('acct-A', 'draft:regression-1', 'R1', 'running', { executionId: retried.value.executionId }).ok, true);
  const done = drafts.markPreview('acct-A', 'draft:regression-1', 'R1', 'succeeded', { executionId: retried.value.executionId, traceRef: 'trace-1' });
  assert.equal(done.ok, true);
  assert.equal(done.ok && done.value.traceRef, 'trace-1');
  assert.equal(drafts.markPreview('acct-A', 'draft:regression-1', 'R1', 'failed', { executionId: retried.value.executionId }).ok, false);
  assert.equal(drafts.markPreview('acct-B', 'draft:regression-1', 'R1', 'failed', { executionId: retried.value.executionId }).ok, false);
});

test('存储重启后草稿、revision、确认与预览签名仍可复核', () => {
  const first = setup();
  assert.equal(first.drafts.create(createInput()).ok, true);
  const preview = first.drafts.acquirePreview('acct-A', 'draft:regression-1', 'R1');
  assert.ok(preview.ok);
  assert.equal(first.drafts.markPreview('acct-A', 'draft:regression-1', 'R1', 'succeeded', { executionId: preview.value.entry.executionId }).ok, true);
  const confirmed = first.drafts.confirm('acct-A', 'draft:regression-1', confirmInput());
  assert.equal(confirmed.ok, true);

  const restarted = new DraftManager(first.catalog, {
    store: first.store,
    previewStore: first.previewStore,
    now: first.now,
  });
  assert.equal(restarted.get('acct-A', 'draft:regression-1')?.revision, 2);
  const replay = restarted.confirm('acct-A', 'draft:regression-1', confirmInput());
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.ok && JSON.stringify(replay.value) === (confirmed.ok && JSON.stringify(confirmed.value)), true);
  assert.equal(restarted.listPreviews('acct-A', 'draft:regression-1')[0]?.status, 'succeeded');
  const stale = restarted.update('acct-A', 'draft:regression-1', updateInput({ expectedRevision: 1 }));
  assert.equal(stale.ok, false);
});

test('第一步可单独保存，选择和更换数据集时取该版本的默认查询列和样本', () => {
  const { drafts } = setup();
  const schedule = { enabled: true, timezone: 'Asia/Shanghai' as const, cron: '0 9 * * *' };
  const d = drafts.create(createInput({ dataset: undefined, rule: undefined, step: 1, schedule }));
  assert.ok(d.ok);
  assert.deepEqual(d.value.sampleIds, []);
  const id = d.value.id;
  assert.equal(drafts.update('acct-A', id, { expectedRevision: 1, step: 3 }).ok, false);
  assert.equal(drafts.acquirePreview('acct-A', id, 'R1').ok, false);
  const picked = drafts.update('acct-A', id, { expectedRevision: 1, step: 2, dataset: DATASET, queryColumn: 'answer' });
  assert.ok(picked.ok);
  assert.deepEqual(picked.value.sampleIds, ['R1', 'R2', 'R3']);
  const changed = drafts.update('acct-A', id, { expectedRevision: 2, dataset: OTHER_DATASET, rule: RULE });
  assert.ok(changed.ok);
  assert.equal(changed.value.queryColumn, 'query');
  assert.deepEqual(changed.value.sampleIds, ['S1', 'S2']);
  const confirmed = drafts.confirm('acct-A', id, confirmInput({ expectedRevision: 3 }));
  assert.ok(confirmed.ok);
  assert.deepEqual(confirmed.value.binding.schedule, schedule);
});

test('配置切回原值也拒绝旧回调；草稿取消、过期后不能再回写或重试', () => {
  const { drafts, advance } = setup({ ttlMs: 60_000 });
  const draft = drafts.create(createInput());
  assert.ok(draft.ok);
  const id = draft.value.id;
  const first = drafts.acquirePreview('acct-A', id, 'R1');
  assert.ok(first.ok);
  assert.ok(drafts.update('acct-A', id, { expectedRevision: 1, queryColumn: 'answer' }).ok);
  assert.ok(drafts.update('acct-A', id, { expectedRevision: 2, queryColumn: 'query' }).ok);
  const current = drafts.acquirePreview('acct-A', id, 'R1');
  assert.ok(current.ok);
  assert.equal(current.value.entry.signature, first.value.entry.signature);
  assert.notEqual(current.value.entry.executionId, first.value.entry.executionId);
  assert.equal(drafts.markPreview('acct-A', id, 'R1', 'succeeded', first.value.entry).ok, false);
  assert.equal(drafts.listPreviews('acct-A', id)[0].status, 'pending');
  assert.ok(drafts.cancel('acct-A', id).ok);
  assert.equal(drafts.retryPreview('acct-A', id, 'R1').ok, false);
  const next = drafts.create(createInput({ id: 'draft:expires' }));
  assert.ok(next.ok);
  const expiring = drafts.acquirePreview('acct-A', next.value.id, 'R1');
  assert.ok(expiring.ok);
  advance(2);
  assert.equal(drafts.markPreview('acct-A', next.value.id, 'R1', 'succeeded', expiring.value.entry).ok, false);
  assert.equal(drafts.retryPreview('acct-A', next.value.id, 'R1').ok, false);
});

test('确认时复核已选规则与数据集归档状态，失败后仍可编辑', () => {
  for (const kind of ['dataset', 'rule'] as const) {
    const { drafts, catalog } = setup();
    const d = drafts.create(createInput());
    assert.ok(d.ok);
    assert.ok(catalog.archiveResource(kind, kind === 'dataset' ? DATASET : RULE, 'acct-A').ok);
    const confirmation = drafts.confirm('acct-A', d.value.id, confirmInput());
    assert.ok(!confirmation.ok);
    assert.equal(confirmation.issues[0].field, kind);
    assert.equal(drafts.get('acct-A', d.value.id)?.status, 'active');
  }
});

test('不同账号可以保存相同草稿 ID，读取和取消各自独立', () => {
  const { drafts, catalog } = setup();
  const other = { id: 'scene-B', version: 'v1' };
  const scenario = catalog.getScenario(SCENARIO, 'acct-A');
  assert.ok(scenario);
  catalog.putScenario('acct-B', other, scenario.snapshot);
  const id = 'draft:local-name';
  assert.ok(drafts.create({ id, name: 'A', scenario: SCENARIO, ownerAccountId: 'acct-A' }).ok);
  assert.ok(drafts.create({ id, name: 'B', scenario: other, ownerAccountId: 'acct-B' }).ok);
  assert.ok(drafts.cancel('acct-B', id).ok);
  assert.equal(drafts.get('acct-A', id)?.status, 'active');
  assert.equal(drafts.get('acct-B', id)?.status, 'canceled');
});
