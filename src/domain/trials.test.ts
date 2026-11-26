/**
 * 试评分缓存领域契约单元测试：
 *   node --test src/domain/trials.test.ts
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
  type CreateDraftInput,
  type DraftIssue,
} from './drafts.ts';
import {
  MAX_TRIAL_SAMPLES,
  InMemoryTrialStore,
  TrialScoreManager,
  trialScoreSignature,
  type TrialIssue,
  type TrialScoreResult,
} from './trials.ts';

const SCENARIO = { id: 'sc-harness', version: 'v1' };
const DATASET = { id: 'ds-support', version: 'v3' };
const OTHER_DATASET = { id: 'ds-other', version: 'v1' };
const RULE_V1 = { id: 'rule-process_quality', version: 'v1' };
const RULE_V2 = { id: 'rule-process_quality', version: 'v2' };
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
    columns: ['query', 'answer'],
    rowIds: ['S1', 'S2'],
    rowCount: 2,
    queryColumn: 'query',
    contentChecksum: 'sha256:def456',
  });
  catalog.putRule('acct-A', RULE_V1, processQualityRule);
  catalog.putRule('acct-A', RULE_V2, { ...processQualityRule, name: '过程质量 v2' });
  const draftStore = new InMemoryDraftStore();
  const previewStore = new InMemoryPreviewStore();
  const trialStore = new InMemoryTrialStore();
  const drafts = new DraftManager(catalog, { store: draftStore, previewStore, now, ...options });
  const trials = new TrialScoreManager(catalog, drafts, { store: trialStore, now });
  const created = drafts.create(createInput());
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error('夹具草稿创建失败');
  const draftId = created.value.id;
  return {
    catalog, drafts, trials, trialStore, draftId, now,
    advance: (minutes: number) => {
      at = new Date(Date.parse(at) + minutes * 60_000).toISOString();
    },
    acquire: (sampleId: string, owner = 'acct-A') => trials.acquire(owner, draftId, sampleId),
    makePreview: (sampleId: string, status: 'succeeded' | 'failed' = 'succeeded') => {
      const acquired = drafts.acquirePreview('acct-A', draftId, sampleId);
      assert.equal(acquired.ok, true);
      const running = drafts.markPreview('acct-A', draftId, sampleId, 'running', { executionId: acquired.value.entry.executionId });
      assert.equal(running.ok, true);
      const finished = drafts.markPreview('acct-A', draftId, sampleId, status,
        { executionId: acquired.value.entry.executionId, reason: status === 'failed' ? 'Agent 超时' : undefined, traceRef: `trace-${sampleId}` });
      assert.equal(finished.ok, true);
    },
  };
}

function createInput(overrides: Partial<CreateDraftInput> = {}): CreateDraftInput {
  return {
    ownerAccountId: 'acct-A',
    id: `${DRAFT_ID_PREFIX}trial-1`,
    scenario: { ...SCENARIO },
    dataset: { ...DATASET },
    rule: { ...RULE_V1 },
    name: '过程质量试评分草稿',
    mappings: MAPPINGS.map((mapping) => ({ ...mapping })),
    ...overrides,
  };
}

function codes(result: { ok: false; issues: ReadonlyArray<{ code: string }> }): string[] {
  return result.issues.map((item) => item.code);
}

test('获取试评分：冻结前两条样本、按条待执行、上限两条且不写任务或运行', () => {
  const { drafts, trials, catalog, acquire } = setup();
  const first = acquire('R1');
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.value.created, true);
  assert.equal(first.replayed, false);
  assert.equal(first.value.entry.status, 'pending');
  assert.equal(first.value.entry.attempts, 1);
  assert.equal(first.value.agentReusable, false);
  assert.equal(first.value.agentRunRequired, true);
  assert.equal(Object.isFrozen(first.value.entry), true);

  const second = acquire('R2');
  assert.equal(second.ok, true);
  const third = acquire('R3');
  assert.equal(third.ok, false);
  if (!third.ok) assert.deepEqual(codes(third), ['SAMPLE_NOT_IN_DRAFT']);

  const listed = trials.list('acct-A', 'draft:trial-1');
  assert.deepEqual(listed.map((entry) => entry.sampleId), ['R1', 'R2']);
  assert.equal(listed.length, MAX_TRIAL_SAMPLES);
  assert.deepEqual(catalog.listTasks('acct-A'), []);
  assert.equal(drafts.get('acct-A', 'draft:trial-1')?.status, 'active');
});

test('同签名重放复用原条目，不重复执行评分', () => {
  const { trials, acquire } = setup();
  const first = acquire('R1');
  assert.equal(first.ok, true);
  const again = acquire('R1');
  assert.equal(again.ok, true);
  if (!again.ok || !first.ok) return;
  assert.equal(again.replayed, true);
  assert.equal(again.value.created, false);
  assert.equal(again.value.entry.key, first.value.entry.key);
  assert.equal(again.value.entry.signature, first.value.entry.signature);
  assert.equal(again.value.entry.attempts, first.value.entry.attempts);
  assert.equal(trials.list('acct-A', 'draft:trial-1').length, 1);
});

test('Agent 预览成功时可复用；规则变化只失效评分并保留 Agent 复用', () => {
  const { drafts, trials, acquire, makePreview } = setup();
  makePreview('R1');
  const withPreview = acquire('R1');
  assert.equal(withPreview.ok, true);
  if (!withPreview.ok) return;
  assert.equal(withPreview.value.agentReusable, true);
  assert.equal(withPreview.value.agentRunRequired, false);
  const agentSignature = withPreview.value.entry.agentSignature;

  const draft = drafts.get('acct-A', 'draft:trial-1');
  assert.ok(draft);
  const updated = drafts.update('acct-A', draft.id, {
    expectedRevision: draft.revision,
    rule: { ...RULE_V2 },
  });
  assert.equal(updated.ok, true);
  const afterRuleChange = acquire('R1');
  assert.equal(afterRuleChange.ok, true);
  if (!afterRuleChange.ok) return;
  assert.equal(afterRuleChange.value.created, true);
  assert.equal(afterRuleChange.replayed, false);
  assert.equal(afterRuleChange.value.entry.agentSignature, agentSignature);
  assert.notEqual(afterRuleChange.value.entry.signature, withPreview.value.entry.signature);
  assert.equal(afterRuleChange.value.agentReusable, true);
  assert.deepEqual(trials.list('acct-A', draft.id).map((entry) => entry.signature),
    [afterRuleChange.value.entry.signature]);
});

test('场景／映射变化使评分与 Agent 结果同时失效，旧条目不再展示', () => {
  const { drafts, trials, acquire, makePreview } = setup();
  makePreview('R1');
  const before = acquire('R1');
  assert.equal(before.ok, true);
  if (!before.ok) return;
  const draft = drafts.get('acct-A', 'draft:trial-1');
  assert.ok(draft);
  assert.equal(Object.isFrozen(draft), true);
  const changedMappings = MAPPINGS.map((mapping) =>
    mapping.placeholder === '{{answer}}' ? { ...mapping, path: 'final_answer_v2' } : { ...mapping });
  const updated = drafts.update('acct-A', draft.id, {
    expectedRevision: draft.revision,
    mappings: changedMappings,
  });
  assert.equal(updated.ok, true);
  const after = acquire('R1');
  assert.equal(after.ok, true);
  if (!after.ok) return;
  assert.equal(after.value.created, true);
  assert.equal(after.value.agentReusable, false);
  assert.equal(after.value.agentRunRequired, true);
  assert.notEqual(after.value.entry.agentSignature, before.value.entry.agentSignature);
  assert.notEqual(after.value.entry.signature, before.value.entry.signature);
  assert.deepEqual(drafts.listPreviews('acct-A', draft.id), []);
  assert.deepEqual(trials.list('acct-A', draft.id).map((entry) => entry.signature),
    [after.value.entry.signature]);
});

test('签名覆盖规则版本、映射与 Agent 预览签名，映射顺序无关', () => {
  const { drafts, acquire } = setup();
  const draft = drafts.get('acct-A', 'draft:trial-1');
  assert.ok(draft);
  const agentSignature = draftPreviewSignature(draft, 'R1');
  const first = trialScoreSignature(draft, 'R1', agentSignature);
  const reversed = { ...draft, mappings: [...draft.mappings].reverse() };
  assert.equal(trialScoreSignature(reversed, 'R1', agentSignature), first);
  assert.notEqual(trialScoreSignature(draft, 'R1', 'other-agent-signature'), first);
  const otherRule = { ...draft, rule: { ...RULE_V2 } };
  assert.notEqual(trialScoreSignature(otherRule, 'R1', agentSignature), first);
  const acquired = acquire('R1');
  assert.equal(acquired.ok, true);
  if (!acquired.ok) return;
  assert.equal(acquired.value.entry.signature, first);
});

test('评分状态流转、结果与 Trace 引用冻结，终态不能重复流转', () => {
  const { trials, acquire } = setup();
  const acquired = acquire('R1');
  assert.equal(acquired.ok, true);
  const running = trials.mark('acct-A', 'draft:trial-1', 'R1', 'running', { executionId: acquired.value.entry.executionId });
  assert.equal(running.ok, true);
  if (!running.ok) return;
  assert.equal(running.value.status, 'running');
  const result: TrialScoreResult = {
    score: 0.75,
    reason: '参数填充失败',
    businessJson: { primary_dimension: { total_score: 0.75 }, secondary_dimensions: [{ name: '参数填充正确' }] },
  };
  const succeeded = trials.mark('acct-A', 'draft:trial-1', 'R1', 'succeeded',
    { executionId: acquired.value.entry.executionId, result, traceRef: 'trace-judge-1' });
  assert.equal(succeeded.ok, true);
  if (!succeeded.ok) return;
  assert.equal(succeeded.value.status, 'succeeded');
  assert.deepEqual(succeeded.value.result?.businessJson, result.businessJson);
  assert.equal(Object.isFrozen(succeeded.value.result), true);
  assert.equal(Object.isFrozen(succeeded.value.result?.businessJson), true);
  assert.equal(succeeded.value.traceRef, 'trace-judge-1');
  const stored = trials.get('acct-A', 'draft:trial-1', 'R1');
  assert.equal(stored?.result?.score, 0.75);
  const again = trials.mark('acct-A', 'draft:trial-1', 'R1', 'failed', { executionId: acquired.value.entry.executionId });
  assert.equal(again.ok, false);
  if (!again.ok) assert.deepEqual(codes(again as { ok: false; issues: TrialIssue[] }), ['TRIAL_TRANSITION']);
});

test('全 NA 空分值与缺失结果按规则契约处理，非法结果不落库', () => {
  const { trials, acquire } = setup();
  const acquired = acquire('R1');
  assert.ok(acquired.ok);
  const missing = trials.mark('acct-A', 'draft:trial-1', 'R1', 'succeeded', { executionId: acquired.value.entry.executionId });
  assert.equal(missing.ok, false);
  const badScore = trials.mark('acct-A', 'draft:trial-1', 'R1', 'succeeded',
    { executionId: acquired.value.entry.executionId, result: { score: Number.NaN } });
  assert.equal(badScore.ok, false);
  const na = trials.mark('acct-A', 'draft:trial-1', 'R1', 'succeeded',
    { executionId: acquired.value.entry.executionId, result: { score: null, reason: '四项均为 NA', businessJson: { redline_fail_hits: [] } } });
  assert.equal(na.ok, true);
  if (!na.ok) return;
  assert.equal(na.value.result?.score, null);
  assert.deepEqual(na.value.result?.businessJson, { redline_fail_hits: [] });
  assert.equal(trials.get('acct-A', 'draft:trial-1', 'R1')?.status, 'succeeded');
});

test('失败按条重试递增尝试并清除旧结果，执行中的重试直接复用', () => {
  const { trials, acquire } = setup();
  const acquired = acquire('R1');
  assert.ok(acquired.ok);
  const failed = trials.mark('acct-A', 'draft:trial-1', 'R1', 'failed', { executionId: acquired.value.entry.executionId, reason: '评估器超时' });
  assert.equal(failed.ok, true);
  if (!failed.ok) return;
  assert.equal(failed.value.reason, '评估器超时');
  const retried = trials.retry('acct-A', 'draft:trial-1', 'R1');
  assert.equal(retried.ok, true);
  if (!retried.ok) return;
  assert.equal(retried.value.status, 'pending');
  assert.equal(retried.value.attempts, 2);
  assert.equal(retried.value.reason, undefined);
  const again = trials.retry('acct-A', 'draft:trial-1', 'R1');
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.replayed, true);
  assert.equal(again.value.attempts, 2);
  const late = trials.mark('acct-A', 'draft:trial-1', 'R1', 'succeeded', {
    executionId: acquired.value.entry.executionId, result: { score: 20 },
  });
  assert.equal(late.ok, false);
  const done = trials.mark('acct-A', 'draft:trial-1', 'R1', 'succeeded', {
    executionId: retried.value.executionId, result: { score: 100 },
  });
  assert.equal(done.ok, true);
  const retryDone = trials.retry('acct-A', 'draft:trial-1', 'R1');
  assert.equal(retryDone.ok, false);
  if (!retryDone.ok) assert.deepEqual(codes(retryDone as { ok: false; issues: TrialIssue[] }), ['TRIAL_TRANSITION']);
});

test('取消草稿停止未结束试评分并隐藏旧结果', () => {
  const { drafts, trials, acquire } = setup();
  const acquired = acquire('R1');
  assert.ok(acquired.ok);
  acquire('R2');
  const done = trials.mark('acct-A', 'draft:trial-1', 'R1', 'succeeded', { executionId: acquired.value.entry.executionId, result: { score: 50 } });
  assert.equal(done.ok, true);
  const canceled = trials.cancelForDraft('acct-A', 'draft:trial-1');
  assert.equal(canceled.ok, true);
  if (!canceled.ok) return;
  assert.equal(canceled.value, 1);
  assert.equal(trials.get('acct-A', 'draft:trial-1', 'R2')?.status, 'canceled');
  assert.equal(trials.get('acct-A', 'draft:trial-1', 'R1')?.status, 'succeeded');
  const draftCancel = drafts.cancel('acct-A', 'draft:trial-1');
  assert.equal(draftCancel.ok, true);
  assert.deepEqual(trials.list('acct-A', 'draft:trial-1'), []);
  assert.equal(trials.get('acct-A', 'draft:trial-1', 'R1'), undefined);
  const forbidden = trials.mark('acct-A', 'draft:trial-1', 'R1', 'failed', { executionId: acquired.value.entry.executionId });
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) assert.deepEqual(codes(forbidden as { ok: false; issues: TrialIssue[] }), ['DRAFT_CANCELED']);
});

test('到期草稿不展示旧评分且拒绝新的获取与重试', () => {
  const { trials, acquire, advance } = setup({ ttlMs: 60_000 });
  const first = acquire('R1');
  assert.equal(first.ok, true);
  advance(61);
  assert.deepEqual(trials.list('acct-A', 'draft:trial-1'), []);
  assert.equal(trials.get('acct-A', 'draft:trial-1', 'R1'), undefined);
  const expired = acquire('R1');
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.deepEqual(codes(expired), ['DRAFT_EXPIRED']);
  const retry = trials.retry('acct-A', 'draft:trial-1', 'R1');
  assert.equal(retry.ok, false);
  if (!retry.ok) assert.deepEqual(codes(retry as { ok: false; issues: TrialIssue[] }), ['DRAFT_EXPIRED']);
});

test('规则归档或未选定时不产生新试评分', () => {
  const { catalog, drafts, trials, acquire } = setup();
  catalog.archiveResource('rule', RULE_V1, 'acct-A');
  const archived = acquire('R1');
  assert.equal(archived.ok, false);
  if (!archived.ok) assert.deepEqual(codes(archived), ['RULE_ARCHIVED']);
  assert.deepEqual(trials.list('acct-A', 'draft:trial-1'), []);

  const noRule = drafts.create(createInput({ id: `${DRAFT_ID_PREFIX}no-rule`, rule: undefined }));
  assert.equal(noRule.ok, true);
  const missing = trials.acquire('acct-A', `${DRAFT_ID_PREFIX}no-rule`, 'R1');
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.deepEqual(codes(missing as { ok: false; issues: DraftIssue[] }), ['INVALID_INPUT']);
});

test('草稿确认后不再新增试评分，已完成条目按当前签名仍可展示', () => {
  const { drafts, trials, acquire } = setup();
  const acquired = acquire('R1');
  assert.equal(acquired.ok, true);
  const done = trials.mark('acct-A', 'draft:trial-1', 'R1', 'succeeded', { executionId: acquired.value.entry.executionId, result: { score: 80 } });
  assert.equal(done.ok, true);
  const confirmed = drafts.confirm('acct-A', 'draft:trial-1', {
    taskRef: { id: 'task-trial', version: 'v1' },
    name: '过程质量回归',
    idempotencyKey: 'confirm-trial-1',
  });
  assert.equal(confirmed.ok, true);
  const blocked = acquire('R2');
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.deepEqual(codes(blocked), ['DRAFT_CONFIRMED']);
  assert.equal(trials.get('acct-A', 'draft:trial-1', 'R1')?.result?.score, 80);
  assert.deepEqual(trials.list('acct-A', 'draft:trial-1').map((entry) => entry.sampleId), ['R1']);
});

test('归属隔离：跨账号读不到、不能获取，存储中的归属始终来自草稿', () => {
  const { trials, trialStore, acquire } = setup();
  const acquired = acquire('R1');
  assert.equal(acquired.ok, true);
  assert.equal(trials.get('acct-B', 'draft:trial-1', 'R1'), undefined);
  assert.deepEqual(trials.list('acct-B', 'draft:trial-1'), []);
  const denied = acquire('R1', 'acct-B');
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.deepEqual(codes(denied), ['DRAFT_NOT_FOUND']);
  const stored = trialStore.get('acct-A\u0000draft:trial-1\u0000R1', 'acct-A');
  assert.equal(stored?.ownerAccountId, 'acct-A');
  assert.equal(trialStore.get('acct-A\u0000draft:trial-1\u0000R1', 'acct-B'), undefined);
});

test('规则变更后，上一条试评分回调不能写入新规则的结果', () => {
  const { drafts, trials, draftId, acquire, advance } = setup({ ttlMs: 60_000 });
  const old = acquire('R1');
  assert.ok(old.ok);
  assert.ok(drafts.update('acct-A', draftId, { expectedRevision: 1, rule: RULE_V2 }).ok);
  const current = acquire('R1');
  assert.ok(current.ok);
  assert.equal(trials.mark('acct-A', draftId, 'R1', 'succeeded', {
    executionId: old.value.entry.executionId, result: { score: 0.7 },
  }).ok, false);
  assert.equal(trials.get('acct-A', draftId, 'R1')?.status, 'pending');
  advance(2);
  const late = trials.mark('acct-A', draftId, 'R1', 'succeeded', {
    executionId: current.value.entry.executionId, result: { score: 0.8 },
  });
  assert.ok(!late.ok);
  assert.equal(late.issues[0].code, 'DRAFT_EXPIRED');
});
