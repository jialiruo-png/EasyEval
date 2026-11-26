/**
 * P2 运行索引领域契约单元测试：
 *   node --test src/domain/runs.test.ts
 * 纯逻辑测试，仅用 Node 22 内置能力；不启动 Docker、不访问上游、不调用模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ResourceCatalog } from './resources.ts';
import {
  InMemoryRunStore,
  RunIndex,
  isShanghaiScheduleTime,
  type RequestRunInput,
  type RequestRunResult,
  type RunIssue,
  type RunRecord,
  type RunResult,
  type SampleStatus,
} from './runs.ts';
import { processQualityRule } from '../result-contract/fixtures.ts';

const SCENARIO = { id: 'sc-harness', version: 'v1' } as const;
const DATASET = { id: 'ds-support', version: 'v3' } as const;
const RULE = { id: 'rule_process_quality', version: 'v1' } as const;
const TASK = { id: 'task-regression', version: 'v1' } as const;
const B_SCENARIO = { id: 'sc-harness-b', version: 'v1' } as const;
const B_DATASET = { id: 'ds-support-b', version: 'v3' } as const;
const B_RULE = { id: 'rule-process-quality-b', version: 'v1' } as const;
const B_TASK = { id: 'task-regression-b', version: 'v1' } as const;
const AT = '2026-11-26T10:30:00+08:00';

function scenarioSnapshot() {
  return {
    name: 'DeepSeek Harness',
    profile: 'deepseek-harness',
    modelConfigRef: 'model-profile-A',
    toolWhitelist: ['read_file'],
  };
}

function datasetSnapshot(rowIds: string[] = ['R1', 'R2', 'R3']) {
  return {
    name: '客服样本集',
    source: 'excel' as const,
    columns: ['query', 'answer'],
    rowIds,
    rowCount: rowIds.length,
    queryColumn: 'query',
    contentChecksum: 'sha256:abc123',
  };
}

function setup(rowIds: string[] = ['R1', 'R2', 'R3']) {
  let tick = 0;
  const now = () => `2026-11-26T10:${String(tick++).padStart(2, '0')}:00+08:00`;
  const catalog = new ResourceCatalog(() => '2026-11-26T09:00:00+08:00');
  catalog.putScenario('acct-A', SCENARIO, scenarioSnapshot());
  catalog.putDataset('acct-A', DATASET, datasetSnapshot(rowIds));
  catalog.putRule('acct-A', RULE, processQualityRule);
  const created = catalog.createTaskConfig('acct-A', TASK, {
    name: '过程质量回归评测',
    scenario: { ...SCENARIO },
    dataset: { ...DATASET },
    rule: { ...RULE },
    schedule: { enabled: false, timezone: 'Asia/Shanghai' },
    variableMappings: [{ placeholder: '{{query}}', source: 'dataset', path: 'query' }],
  });
  assert.equal(created.ok, true);
  const store = new InMemoryRunStore();
  return { catalog, store, runs: new RunIndex(catalog, { store, now }) };
}

function setupOwnerB(catalog: ResourceCatalog): void {
  catalog.putScenario('acct-B', B_SCENARIO, scenarioSnapshot());
  catalog.putDataset('acct-B', B_DATASET, datasetSnapshot());
  catalog.putRule('acct-B', B_RULE, { ...processQualityRule, id: B_RULE.id });
  const created = catalog.createTaskConfig('acct-B', B_TASK, {
    name: 'B 的回归评测',
    scenario: { ...B_SCENARIO },
    dataset: { ...B_DATASET },
    rule: { ...B_RULE },
    schedule: { enabled: false, timezone: 'Asia/Shanghai' },
    variableMappings: [],
  });
  assert.equal(created.ok, true);
}

function manual(overrides: Partial<RequestRunInput> = {}): RequestRunInput {
  return {
    ownerAccountId: 'acct-A',
    task: { ...TASK },
    binding: { scenario: { ...SCENARIO }, dataset: { ...DATASET }, rule: { ...RULE } },
    trigger: 'manual',
    requestId: 'manual-1',
    ...overrides,
  };
}

function scheduled(overrides: Partial<RequestRunInput> = {}): RequestRunInput {
  return {
    ownerAccountId: 'acct-A',
    task: { ...TASK },
    binding: { scenario: { ...SCENARIO }, dataset: { ...DATASET }, rule: { ...RULE } },
    trigger: 'scheduled',
    scheduledAt: AT,
    ...overrides,
  };
}

function issuesOf(result: RequestRunResult | RunResult): RunIssue[] {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  return result.issues;
}

function createRun(runs: RunIndex, overrides: Partial<RequestRunInput> = {}): RunRecord {
  const result = runs.requestRun(manual(overrides));
  assert.equal(result.ok, true);
  if (!result.ok || result.skipped || !result.run) throw new Error('batch not created');
  return result.run;
}

function finishSample(runs: RunIndex, runId: string, sampleId: string, final: SampleStatus = 'succeeded'): void {
  const chain: SampleStatus[] = final === 'scoring_failed'
    ? ['agent_running', 'waiting_trace', 'waiting_scoring', 'scoring_failed']
    : ['agent_running', 'waiting_trace', 'waiting_scoring', 'succeeded'];
  for (const status of chain) {
    const result = runs.setSampleStatus(runId, 'acct-A', sampleId, status,
      status === 'scoring_failed' ? '裁判输出无效' : undefined);
    assert.equal(result.ok, true, `${sampleId} ${status} 应可流转`);
  }
}

test('手动触发创建冻结批次：归属、版本快照、样本顺序与深冻结', () => {
  const { runs } = setup();
  const result = runs.requestRun(manual({ runId: 'RUN-FIXED' }));
  assert.equal(result.ok, true);
  if (!result.ok || result.skipped || !result.run) throw new Error('batch not created');
  assert.equal(result.replayed, false);
  const run = result.run;
  assert.equal(run.id, 'RUN-FIXED');
  assert.equal(run.ownerAccountId, 'acct-A');
  assert.equal(run.status, 'queued');
  assert.equal(run.trigger, 'manual');
  assert.equal(run.requestId, 'manual-1');
  assert.equal(run.idempotencyKey, 'manual:acct-A:manual-1');
  assert.deepEqual(run.task, TASK);
  assert.deepEqual(run.binding, { scenario: SCENARIO, dataset: DATASET, rule: RULE });
  assert.deepEqual(run.samples.map((sample) => sample.id), ['R1', 'R2', 'R3']);
  assert.deepEqual(run.samples.map((sample) => sample.status), ['waiting_agent', 'waiting_agent', 'waiting_agent']);
  assert.deepEqual(run.samples.map((sample) => sample.attempts), [0, 0, 0]);
  assert.equal(run.createdAt, '2026-11-26T10:00:00+08:00');
  assert.equal(run.updatedAt, '2026-11-26T10:00:00+08:00');
  assert.equal(Object.isFrozen(run), true);
  assert.equal(Object.isFrozen(run.samples), true);
  assert.throws(() => { (run.samples[0] as { status: string }).status = 'succeeded'; }, TypeError);
});

test('手动幂等按账号隔离：同请求 ID 重放不新增，其他账号独立创建', () => {
  const { catalog, runs } = setup();
  setupOwnerB(catalog);
  const first = createRun(runs);
  const replay = runs.requestRun(manual());
  assert.equal(replay.ok, true);
  if (!replay.ok || replay.skipped || !replay.run) throw new Error('replay failed');
  assert.equal(replay.replayed, true);
  assert.equal(replay.run.id, first.id);
  assert.equal(replay.run.updatedAt, first.updatedAt);
  assert.equal(runs.listRuns('acct-A').length, 1);

  const other = runs.requestRun(manual({
    ownerAccountId: 'acct-B',
    task: { ...B_TASK },
    binding: { scenario: { ...B_SCENARIO }, dataset: { ...B_DATASET }, rule: { ...B_RULE } },
  }));
  assert.equal(other.ok, true);
  if (!other.ok || other.skipped || !other.run) throw new Error('owner B run failed');
  assert.equal(other.replayed, false);
  assert.notEqual(other.run.id, first.id);
  assert.equal(runs.listRuns('acct-B').length, 1);
});

test('定时幂等与跳过：同任务已有活跃批次时不同计划时间也跳过，结束后可新建', () => {
  const { catalog, runs } = setup();
  setupOwnerB(catalog);
  const created = catalog.createTaskConfig('acct-A', { id: 'task-regression-2', version: 'v1' }, {
    name: '第二个任务',
    scenario: { ...SCENARIO },
    dataset: { ...DATASET },
    rule: { ...RULE },
    schedule: { enabled: true, cron: '0 9 * * *', timezone: 'Asia/Shanghai' },
    variableMappings: [],
  });
  assert.equal(created.ok, true);

  const first = runs.requestRun(scheduled({ runId: 'RUN-SCHED-1' }));
  assert.equal(first.ok, true);
  if (!first.ok || first.skipped || !first.run) throw new Error('scheduled run failed');
  assert.equal(first.run.scheduledAt, AT);
  assert.equal(first.run.scheduledTimezone, 'Asia/Shanghai');
  assert.equal(first.run.idempotencyKey, 'scheduled:acct-A:task-regression:2026-11-26T10:30:00+08:00');

  const replay = runs.requestRun(scheduled());
  assert.equal(replay.ok, true);
  if (!replay.ok || replay.skipped || !replay.run) throw new Error('scheduled replay failed');
  assert.equal(replay.replayed, true);
  assert.equal(replay.run.id, first.run.id);

  const skipped = runs.requestRun(scheduled({ scheduledAt: '2026-11-26T11:30:00+08:00' }));
  assert.deepEqual(skipped, { ok: true, run: undefined, replayed: false, skipped: true, reason: 'ACTIVE_RUN' });
  assert.equal(runs.listRuns('acct-A').length, 1);

  const otherTask = runs.requestRun(scheduled({
    task: { id: 'task-regression-2', version: 'v1' },
  }));
  assert.equal(otherTask.ok, true);
  if (!otherTask.ok || otherTask.skipped || !otherTask.run) throw new Error('other task run failed');
  assert.equal(otherTask.run.idempotencyKey, 'scheduled:acct-A:task-regression-2:2026-11-26T10:30:00+08:00');

  assert.equal(runs.cancelRun('RUN-SCHED-1', 'acct-A').ok, true);
  const afterEnd = runs.requestRun(scheduled({ scheduledAt: '2026-11-26T12:30:00+08:00' }));
  assert.equal(afterEnd.ok, true);
  if (!afterEnd.ok || afterEnd.skipped || !afterEnd.run) throw new Error('scheduled run after cancel failed');
  assert.equal(afterEnd.replayed, false);
});

test('计划时间与请求 ID 校验：无效输入返回字段级错误且不落库', () => {
  const { runs } = setup();
  const cases: [Partial<RequestRunInput>, string][] = [
    [{ scheduledAt: '2026-02-30T10:30:00+08:00' }, 'scheduledAt'],
    [{ scheduledAt: '2026-11-26T10:30:00Z' }, 'scheduledAt'],
    [{ scheduledAt: '2026-11-26 10:30:00+08:00' }, 'scheduledAt'],
    [{ scheduledAt: undefined }, 'scheduledAt'],
  ];
  for (const [overrides, field] of cases) {
    const result = runs.requestRun(scheduled(overrides));
    assert.deepEqual(issuesOf(result).map((item) => [item.code, item.field]), [['INVALID_INPUT', field]]);
  }
  assert.equal(isShanghaiScheduleTime('2026-11-26T10:30:00+08:00'), true);
  assert.equal(isShanghaiScheduleTime('2026-11-26T10:30:59+08:00'), true);
  assert.equal(isShanghaiScheduleTime('2026-11-26T24:00:00+08:00'), false);

  const noRequestId = runs.requestRun(manual({ requestId: '' }));
  assert.equal(issuesOf(noRequestId)[0].field, 'requestId');
  const badTrigger = runs.requestRun(manual({ trigger: 'unknown' as 'manual' }));
  assert.equal(issuesOf(badTrigger)[0].field, 'trigger');
  assert.equal(runs.listRuns('acct-A').length, 0);
});

test('绑定校验：他人任务、版本漂移与归档任务都拒绝且不写运行', () => {
  const { catalog, runs } = setup();
  setupOwnerB(catalog);

  const foreign = runs.requestRun(manual({
    ownerAccountId: 'acct-B',
    task: { ...TASK },
    binding: { scenario: { ...B_SCENARIO }, dataset: { ...B_DATASET }, rule: { ...B_RULE } },
  }));
  assert.equal(issuesOf(foreign)[0].code, 'TASK_NOT_FOUND');

  const drift = runs.requestRun(manual({
    binding: {
      scenario: { ...SCENARIO },
      dataset: { ...DATASET, version: 'v9' },
      rule: { ...RULE },
    },
  }));
  assert.ok(issuesOf(drift).some((item) => item.code === 'BINDING_MISMATCH' && item.field === 'dataset'));

  assert.equal(catalog.archiveResource('task', TASK, 'acct-A').ok, true);
  const archived = runs.requestRun(manual());
  assert.equal(issuesOf(archived)[0].code, 'TASK_ARCHIVED');
  assert.equal(runs.listRuns('acct-A').length, 0);
});

test('样本一致性：显式 ID 必须与冻结行一致，空数据集不能发起运行', () => {
  const { runs } = setup();
  const mismatch = runs.requestRun(manual({ sampleIds: ['R1', 'R2'] }));
  assert.equal(issuesOf(mismatch)[0].code, 'SAMPLE_MISMATCH');
  const reordered = runs.requestRun(manual({ sampleIds: ['R2', 'R1', 'R3'] }));
  assert.equal(issuesOf(reordered)[0].code, 'SAMPLE_MISMATCH');
  assert.equal(runs.listRuns('acct-A').length, 0);

  const empty = setup([]);
  const result = empty.runs.requestRun(manual());
  assert.equal(issuesOf(result)[0].code, 'EMPTY_DATASET');
});

test('批次 ID 冲突：本人与他人账号都不能复用同一 ID', () => {
  const { catalog, runs } = setup();
  setupOwnerB(catalog);
  createRun(runs, { runId: 'RUN-FIXED', requestId: 'manual-1' });
  const local = runs.requestRun(manual({ runId: 'RUN-FIXED', requestId: 'manual-2' }));
  assert.equal(issuesOf(local)[0].code, 'RUN_ID_CONFLICT');

  const other = runs.requestRun(manual({
    ownerAccountId: 'acct-B',
    task: { ...B_TASK },
    binding: { scenario: { ...B_SCENARIO }, dataset: { ...B_DATASET }, rule: { ...B_RULE } },
    runId: 'RUN-FIXED',
  }));
  assert.equal(issuesOf(other)[0].code, 'RUN_ID_CONFLICT');
  assert.equal(runs.listRuns('acct-A').length, 1);
});

test('状态流转：进入运行后必须全部样本结束才能结束批次，终态不可回转', () => {
  const { runs } = setup();
  const run = createRun(runs, { runId: 'RUN-LIFECYCLE' });
  assert.equal(runs.transitionRun(run.id, 'acct-A', 'succeeded').ok, false);
  assert.equal(runs.transitionRun(run.id, 'acct-A', 'running').ok, true);

  for (const sampleId of ['R1', 'R2', 'R3']) finishSample(runs, run.id, sampleId);
  const beforeEnd = runs.transitionRun(run.id, 'acct-A', 'succeeded');
  assert.equal(beforeEnd.ok, true, '全部样本结束后可结束批次');
  assert.equal(runs.transitionRun(run.id, 'acct-A', 'running').ok, false);
  assert.equal(runs.transitionRun(run.id, 'acct-A', 'canceled').ok, false);
  assert.equal(runs.listRuns('acct-A')[0].status, 'succeeded');
});

test('样本分阶段流转与部分失败：失败/NA 计入终态，非法跳步被拒', () => {
  const { runs } = setup();
  const run = createRun(runs, { runId: 'RUN-SAMPLES' });
  assert.equal(runs.transitionRun(run.id, 'acct-A', 'running').ok, true);

  assert.equal(runs.setSampleStatus(run.id, 'acct-A', 'R1', 'agent_running').ok, true);
  assert.equal(runs.setSampleStatus(run.id, 'acct-A', 'R1', 'waiting_trace').ok, true);
  const evidence = runs.setSampleStatus(run.id, 'acct-A', 'R1', 'evidence_missing', 'Trace 采集失败');
  assert.equal(evidence.ok, true);
  if (!evidence.ok) throw new Error('unreachable');
  assert.equal(evidence.value.samples[0].reason, 'Trace 采集失败');
  assert.equal(runs.setSampleStatus(run.id, 'acct-A', 'R1', 'waiting_scoring').ok, false);
  assert.equal(runs.setSampleStatus(run.id, 'acct-A', 'R2', 'waiting_scoring').ok, false);

  finishSample(runs, run.id, 'R2', 'scoring_failed');
  const na = runs.setSampleStatus(run.id, 'acct-A', 'R3', 'na');
  assert.equal(na.ok, false);
  assert.equal(runs.setSampleStatus(run.id, 'acct-A', 'R3', 'agent_running').ok, true);
  assert.equal(runs.setSampleStatus(run.id, 'acct-A', 'R3', 'waiting_trace').ok, true);
  assert.equal(runs.setSampleStatus(run.id, 'acct-A', 'R3', 'waiting_scoring').ok, true);
  assert.equal(runs.setSampleStatus(run.id, 'acct-A', 'R3', 'na').ok, true);

  const ended = runs.transitionRun(run.id, 'acct-A', 'partial_failed');
  assert.equal(ended.ok, true);
});

test('失败重试：Agent 与评分失败可重试并递增尝试次数，成功样本不可重试', () => {
  const { runs } = setup();
  const run = createRun(runs, { runId: 'RUN-RETRY' });
  assert.equal(runs.transitionRun(run.id, 'acct-A', 'running').ok, true);
  assert.equal(runs.setSampleStatus(run.id, 'acct-A', 'R1', 'agent_running').ok, true);
  const agentFail = runs.setSampleStatus(run.id, 'acct-A', 'R1', 'agent_failed', '瞬时超时');
  assert.equal(agentFail.ok, true);
  const retryAgent = runs.setSampleStatus(run.id, 'acct-A', 'R1', 'agent_running');
  assert.equal(retryAgent.ok, true);
  if (!retryAgent.ok) throw new Error('unreachable');
  assert.equal(retryAgent.value.samples[0].attempts, 1);
  assert.equal(retryAgent.value.samples[0].reason, undefined);

  finishSample(runs, run.id, 'R2', 'scoring_failed');
  const retryScoring = runs.setSampleStatus(run.id, 'acct-A', 'R2', 'waiting_scoring');
  assert.equal(retryScoring.ok, true);
  if (!retryScoring.ok) throw new Error('unreachable');
  assert.equal(retryScoring.value.samples[1].attempts, 1);
  assert.equal(retryScoring.value.samples[1].reason, undefined);
  assert.equal(runs.setSampleStatus(run.id, 'acct-A', 'R2', 'agent_running').ok, false);

  finishSample(runs, run.id, 'R3');
  assert.equal(runs.setSampleStatus(run.id, 'acct-A', 'R3', 'agent_running').ok, false);
});

test('取消只影响本批剩余样本，保留已完成样本与其他批次', () => {
  const { runs } = setup();
  const first = createRun(runs, { runId: 'RUN-CANCEL-1', requestId: 'manual-1' });
  const second = createRun(runs, { runId: 'RUN-CANCEL-2', requestId: 'manual-2' });
  assert.equal(runs.transitionRun(first.id, 'acct-A', 'running').ok, true);
  assert.equal(runs.transitionRun(second.id, 'acct-A', 'running').ok, true);
  finishSample(runs, first.id, 'R1');

  const canceled = runs.cancelRun(first.id, 'acct-A');
  assert.equal(canceled.ok, true);
  if (!canceled.ok) throw new Error('unreachable');
  assert.equal(canceled.value.status, 'canceled');
  assert.deepEqual(canceled.value.samples.map((sample) => sample.status),
    ['succeeded', 'canceled', 'canceled']);
  assert.equal(runs.getRun(second.id, 'acct-A')?.status, 'running');
  assert.deepEqual(runs.getRun(second.id, 'acct-A')?.samples.map((sample) => sample.status),
    ['waiting_agent', 'waiting_agent', 'waiting_agent']);

  const replay = runs.cancelRun(first.id, 'acct-A');
  assert.equal(replay.ok, true);
  if (!replay.ok) throw new Error('unreachable');
  assert.equal(replay.replayed, true);
  assert.equal(replay.value.updatedAt, canceled.value.updatedAt);
  assert.equal(runs.setSampleStatus(first.id, 'acct-A', 'R2', 'agent_running').ok, false);
  assert.equal(runs.transitionRun(first.id, 'acct-A', 'running').ok, false);
});

test('归属隔离：越权与不存在统一查不到，且无法变更他人批次', () => {
  const { catalog, runs } = setup();
  setupOwnerB(catalog);
  const run = createRun(runs, { runId: 'RUN-OWNER' });

  assert.equal(runs.getRun(run.id, 'acct-B'), undefined);
  assert.equal(runs.getRun(run.id, undefined), undefined);
  assert.equal(runs.getRun('RUN-MISSING', 'acct-A'), undefined);
  assert.deepEqual(runs.listRuns('acct-B'), []);
  assert.deepEqual(runs.listRuns(undefined), []);
  assert.deepEqual(runs.listRunsForTask('acct-B', TASK.id), []);
  assert.equal(issuesOf(runs.transitionRun(run.id, 'acct-B', 'running'))[0].code, 'RUN_NOT_FOUND');
  assert.equal(issuesOf(runs.cancelRun(run.id, undefined))[0].code, 'RUN_NOT_FOUND');
  assert.equal(issuesOf(runs.setSampleStatus(run.id, 'acct-B', 'R1', 'agent_running'))[0].code, 'RUN_NOT_FOUND');
  assert.equal(runs.transitionRun(run.id, 'acct-A', 'running').ok, true);
  assert.equal(issuesOf(runs.setSampleStatus(run.id, 'acct-A', 'R9', 'agent_running'))[0].code, 'SAMPLE_NOT_FOUND');
  assert.deepEqual(runs.listRunsForTask('acct-A', TASK.id).map((item) => item.id), [run.id]);
});

test('重启接续：共用存储的另一个 RunIndex 保留历史与幂等/跳过语义', () => {
  const { catalog, store, runs } = setup();
  const run = createRun(runs, { runId: 'RUN-RESTART' });
  const restarted = new RunIndex(catalog, { store, now: () => '2026-11-26T11:00:00+08:00' });

  assert.equal(restarted.getRun(run.id, 'acct-A')?.status, 'queued');
  const replay = restarted.requestRun(manual());
  assert.equal(replay.ok, true);
  if (!replay.ok || replay.skipped || !replay.run) throw new Error('unreachable');
  assert.equal(replay.replayed, true);
  assert.equal(replay.run.id, run.id);
  const skipped = restarted.requestRun(scheduled());
  assert.equal(skipped.ok, true);
  if (!skipped.ok || !skipped.skipped) throw new Error('unreachable');
  assert.equal(skipped.reason, 'ACTIVE_RUN');
  assert.equal(skipped.replayed, false);
  assert.equal(restarted.listRuns('acct-A').length, 1);
});

test('样本状态只在运行中更新：排队或已结束批次拒绝变更', () => {
  const { runs } = setup();
  const run = createRun(runs, { runId: 'RUN-GUARD' });
  assert.equal(issuesOf(runs.setSampleStatus(run.id, 'acct-A', 'R1', 'agent_running'))[0].code,
    'INVALID_TRANSITION');
  assert.equal(runs.transitionRun(run.id, 'acct-A', 'running').ok, true);
  assert.equal(runs.cancelRun(run.id, 'acct-A').ok, true);
  assert.equal(issuesOf(runs.setSampleStatus(run.id, 'acct-A', 'R1', 'agent_running'))[0].code,
    'INVALID_TRANSITION');
});
