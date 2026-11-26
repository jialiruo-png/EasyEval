/**
 * P2 版本化资源领域契约单元测试：
 *   node --test src/domain/resources.test.ts
 * 纯逻辑测试，仅用 Node 22 内置能力；不启动 Docker、不访问上游、不调用模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ImmutableVersionConflict,
  InMemoryArchiveStore,
  ResourceCatalog,
  resourceContentHash,
  stableStringify,
  type ArchivableResourceKind,
  type DatasetSnapshot,
  type ScenarioConfigSnapshot,
  type TaskBinding,
} from './resources.ts';
import { processQualityRule } from '../result-contract/fixtures.ts';

const SCENARIO = { id: 'sc-harness', version: 'v1' } as const;
const DATASET = { id: 'ds-support', version: 'v3' } as const;
const RULE = { id: 'rule-process-quality', version: 'v1' } as const;
const TASK = { id: 'task-regression', version: 'v1' } as const;

function scenarioSnapshot(): ScenarioConfigSnapshot {
  return {
    name: 'DeepSeek Harness',
    profile: 'deepseek-harness',
    modelConfigRef: 'model-profile-A',
    toolWhitelist: ['read_file', 'calculator'],
  };
}

function datasetSnapshot(): DatasetSnapshot {
  return {
    name: '客服样本集',
    source: 'excel',
    columns: ['query', 'answer'],
    rowIds: ['R1', 'R2', 'R3'],
    rowCount: 3,
    queryColumn: 'query',
    contentChecksum: 'sha256:abc123',
  };
}

function binding(overrides: Partial<TaskBinding> = {}): TaskBinding {
  return {
    name: '过程质量回归评测',
    scenario: { ...SCENARIO },
    dataset: { ...DATASET },
    rule: { ...RULE },
    schedule: { enabled: false, timezone: 'Asia/Shanghai' },
    variableMappings: [{ placeholder: '{{query}}', source: 'dataset', path: 'query' }],
    ...overrides,
  };
}

/** 在账号 A 名下建立一份三引用齐全的目录。 */
function catalogWithOwnerA(now: () => string = () => '2026-11-23T10:00:00+08:00'): ResourceCatalog {
  const catalog = new ResourceCatalog(now);
  catalog.putScenario('acct-A', SCENARIO, scenarioSnapshot());
  catalog.putDataset('acct-A', DATASET, datasetSnapshot());
  catalog.putRule('acct-A', RULE, processQualityRule);
  return catalog;
}

test('稳定序列化与内容哈希：键顺序无关，内容或归属变化则哈希变化', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(
    stableStringify({ x: [{ b: 2, a: 1 }] }),
    stableStringify({ x: [{ a: 1, b: 2 }] }),
  );
  const hash = resourceContentHash('acct-A', SCENARIO, scenarioSnapshot());
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, resourceContentHash('acct-A', { ...SCENARIO }, scenarioSnapshot()));
  assert.notEqual(hash, resourceContentHash('acct-B', SCENARIO, scenarioSnapshot()));
  assert.notEqual(hash, resourceContentHash('acct-A', { ...SCENARIO, version: 'v2' }, scenarioSnapshot()));
});

test('版本不可变：同键同内容幂等返回，同键不同内容被拒绝，快照深冻结', () => {
  const catalog = new ResourceCatalog(() => '2026-11-23T10:00:00+08:00');
  const first = catalog.putScenario('acct-A', SCENARIO, scenarioSnapshot());
  const again = catalog.putScenario('acct-A', { ...SCENARIO }, scenarioSnapshot());
  assert.equal(again, first);
  assert.equal(catalog.listScenarios('acct-A').length, 1);

  assert.throws(
    () => catalog.putScenario('acct-A', SCENARIO, { ...scenarioSnapshot(), profile: 'other' }),
    /内容不可变/,
  );
  assert.throws(
    () => catalog.putScenario('acct-B', SCENARIO, scenarioSnapshot()),
    /内容不可变/,
  );

  // 深冻结：外部持有原始快照并改写，不影响已存版本。
  const mutable = datasetSnapshot();
  const stored = catalog.putDataset('acct-A', DATASET, mutable);
  mutable.rowIds.push('R4');
  assert.equal(Object.isFrozen(stored.snapshot), true);
  assert.deepEqual(stored.snapshot.rowIds, ['R1', 'R2', 'R3']);
  assert.throws(() => { (stored.snapshot as { name: string }).name = 'changed'; }, TypeError);
});

test('读取按账号限定：越权与不存在统一为查不到，列表只返回本人', () => {
  const catalog = catalogWithOwnerA();
  catalog.putScenario('acct-B', { id: 'sc-harness', version: 'v2' }, scenarioSnapshot());

  assert.ok(catalog.getScenario(SCENARIO, 'acct-A'));
  assert.equal(catalog.getScenario(SCENARIO, 'acct-B'), undefined);
  assert.equal(catalog.getScenario(SCENARIO, undefined), undefined);
  assert.equal(catalog.getScenario({ id: 'missing', version: 'v1' }, 'acct-A'), undefined);
  assert.equal(catalog.getDataset(DATASET, 'acct-B'), undefined);
  assert.equal(catalog.getRule(RULE, 'acct-B'), undefined);

  assert.equal(catalog.listScenarios('acct-A').length, 1);
  assert.equal(catalog.listScenarios('acct-B').length, 1);
  assert.deepEqual(catalog.listScenarios('acct-B').map((r) => r.ref.version), ['v2']);
  assert.deepEqual(catalog.listDatasets('acct-B'), []);
  assert.deepEqual(catalog.listTasks(undefined), []);
});

test('数据集快照校验：缺列、重复列、查询列缺失、行 ID 重复、行数不符、缺校验值均拒绝', () => {
  const catalog = new ResourceCatalog();
  const ref = { id: 'ds-bad', version: 'v1' };
  assert.throws(() => catalog.putDataset('acct-A', ref, { ...datasetSnapshot(), columns: [] }), /列不能为空/);
  assert.throws(
    () => catalog.putDataset('acct-A', ref, { ...datasetSnapshot(), columns: ['query', 'query'] }),
    /列重复/,
  );
  assert.throws(
    () => catalog.putDataset('acct-A', ref, { ...datasetSnapshot(), queryColumn: 'missing' }),
    /查询列不在数据集列中/,
  );
  assert.throws(
    () => catalog.putDataset('acct-A', ref, { ...datasetSnapshot(), rowIds: ['R1', 'R1', 'R3'] }),
    /行 ID 重复/,
  );
  assert.throws(
    () => catalog.putDataset('acct-A', ref, { ...datasetSnapshot(), rowCount: 99 }),
    /行数与行 ID 数量不一致/,
  );
  assert.throws(
    () => catalog.putDataset('acct-A', ref, { ...datasetSnapshot(), contentChecksum: '' }),
    /内容校验值/,
  );
  assert.equal(catalog.listDatasets('acct-A').length, 0);
});

test('创建任务配置成功：三引用同账号，绑定冻结为快照并写入不可变版本', () => {
  const catalog = catalogWithOwnerA();
  const result = catalog.createTaskConfig('acct-A', TASK, binding());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.ref, TASK);
  assert.equal(result.value.ownerAccountId, 'acct-A');
  assert.equal(result.value.createdAt, '2026-11-23T10:00:00+08:00');
  assert.equal(Object.isFrozen(result.value.snapshot), true);
  assert.equal(Object.isFrozen(result.value.snapshot.variableMappings), true);
  assert.deepEqual(result.value.snapshot.dataset, DATASET);

  assert.equal(catalog.listTasks('acct-A').length, 1);
  assert.deepEqual(catalog.getTask(TASK, 'acct-B'), undefined);
  assert.equal(catalog.createTaskConfig('acct-A', TASK, binding()).ok, true);
  assert.equal(catalog.listTasks('acct-A').length, 1);
  assert.equal(
    catalog.createTaskConfig('acct-A', TASK, binding({ schedule: { enabled: true, timezone: 'Asia/Shanghai', cron: '0 9 * * 1' } })).ok,
    false,
  );
});

test('创建任务配置失败：缺失引用、他人资源、定时缺 cron、重复占位符均不落库', () => {
  const catalog = catalogWithOwnerA();
  catalog.putScenario('acct-B', { id: 'sc-other', version: 'v1' }, scenarioSnapshot());

  const missing = catalog.createTaskConfig('acct-A', TASK, binding({ dataset: { id: 'ds-missing', version: 'v1' } }));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.deepEqual(missing.issues.map((i) => i.code), ['DATASET_NOT_FOUND']);

  const crossOwner = catalog.createTaskConfig('acct-A', TASK, binding({ scenario: { id: 'sc-other', version: 'v1' } }));
  assert.equal(crossOwner.ok, false);
  if (!crossOwner.ok) assert.deepEqual(crossOwner.issues.map((i) => i.code), ['SCENARIO_NOT_FOUND']);

  const noCron = catalog.createTaskConfig('acct-A', TASK, binding({
    schedule: { enabled: true, timezone: 'Asia/Shanghai' },
  }));
  assert.equal(noCron.ok, false);
  if (!noCron.ok) assert.ok(noCron.issues.some((i) => i.field === 'binding.schedule.cron'));

  const duplicated = catalog.createTaskConfig('acct-A', TASK, binding({
    variableMappings: [
      { placeholder: '{{x}}', source: 'dataset', path: 'query' },
      { placeholder: '{{x}}', source: 'trace', path: 'tool.status' },
    ],
  }));
  assert.equal(duplicated.ok, false);
  if (!duplicated.ok) assert.ok(duplicated.issues.some((i) => /占位符重复/.test(i.message)));

  const badTimezone = catalog.createTaskConfig('acct-A', TASK, binding({
    schedule: { enabled: false, timezone: 'UTC' as 'Asia/Shanghai' },
  }));
  assert.equal(badTimezone.ok, false);

  assert.deepEqual(catalog.listTasks('acct-A'), []);
  assert.deepEqual(catalog.listTasks('acct-B'), []);
});

test('运行引用校验：与任务已冻结绑定一致时通过', () => {
  const catalog = catalogWithOwnerA();
  assert.equal(catalog.createTaskConfig('acct-A', TASK, binding()).ok, true);
  const result = catalog.validateRunBindings('acct-A', TASK, {
    scenario: { ...SCENARIO },
    dataset: { ...DATASET },
    rule: { ...RULE },
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.snapshot.dataset, DATASET);
});

test('运行引用校验：任务越权、版本不一致或版本消失均被拒绝', () => {
  const catalog = catalogWithOwnerA();
  assert.equal(catalog.createTaskConfig('acct-A', TASK, binding()).ok, true);

  const notOwner = catalog.validateRunBindings('acct-B', TASK, {
    scenario: { ...SCENARIO }, dataset: { ...DATASET }, rule: { ...RULE },
  });
  assert.equal(notOwner.ok, false);
  if (!notOwner.ok) assert.deepEqual(notOwner.issues.map((i) => i.code), ['TASK_NOT_FOUND']);

  const drifted = catalog.validateRunBindings('acct-A', TASK, {
    scenario: { ...SCENARIO },
    dataset: { ...DATASET, version: 'v4' },
    rule: { ...RULE },
  });
  assert.equal(drifted.ok, false);
  if (!drifted.ok) {
    assert.deepEqual(drifted.issues.map((i) => i.code), ['BINDING_MISMATCH']);
    assert.equal(drifted.issues[0]?.field, 'dataset');
  }
});

test('归档未被引用的数据集版本：幂等、深冻结、只改状态不删版本', () => {
  const catalog = catalogWithOwnerA();
  const first = catalog.archiveResource('dataset', DATASET, 'acct-A');
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.value.ref, DATASET);
  assert.equal(first.value.kind, 'dataset');
  assert.equal(first.value.archivedAt, '2026-11-23T10:00:00+08:00');
  assert.equal(first.replayed, false);
  assert.equal(Object.isFrozen(first.value), true);
  assert.equal(Object.isFrozen(first.value.ref), true);

  const again = catalog.archiveResource('dataset', { ...DATASET }, 'acct-A');
  assert.equal(again.ok, true);
  if (again.ok) {
    assert.equal(again.replayed, true);
    assert.equal(again.value.archivedAt, first.value.archivedAt);
  }
  assert.deepEqual(catalog.listArchived('dataset', 'acct-A').map((row) => row.ref), [DATASET]);
  assert.deepEqual(catalog.listArchived('rule', 'acct-A'), []);
  assert.equal(catalog.getArchive('dataset', DATASET, 'acct-B'), undefined);
  assert.equal(catalog.getDataset(DATASET, 'acct-A')?.snapshot.name, '客服样本集');
  assert.equal(catalog.listDatasets('acct-A').length, 1);
});

test('被未归档任务引用的数据集／规则拒绝归档并返回引用任务', () => {
  const catalog = catalogWithOwnerA();
  assert.equal(catalog.createTaskConfig('acct-A', TASK, binding()).ok, true);
  const dataset = catalog.archiveResource('dataset', DATASET, 'acct-A');
  assert.equal(dataset.ok, false);
  if (!dataset.ok) {
    assert.deepEqual(dataset.issues.map((i) => i.code), ['ACTIVE_TASK_REFERENCE']);
    assert.deepEqual(dataset.references, [{ ref: TASK, name: '过程质量回归评测', archived: false }]);
  }
  const rule = catalog.archiveResource('rule', RULE, 'acct-A');
  assert.equal(rule.ok, false);
  if (!rule.ok) assert.deepEqual(rule.issues.map((i) => i.code), ['ACTIVE_TASK_REFERENCE']);
  assert.deepEqual(catalog.listArchived('dataset', 'acct-A'), []);
  assert.deepEqual(catalog.listArchived('rule', 'acct-A'), []);
});

test('任务归档后释放引用、停止新运行，但历史配置仍可读', () => {
  const catalog = catalogWithOwnerA();
  assert.equal(catalog.createTaskConfig('acct-A', TASK, binding()).ok, true);
  const archived = catalog.archiveResource('task', TASK, 'acct-A');
  assert.equal(archived.ok, true);
  assert.deepEqual(catalog.listReferencingTasks('dataset', DATASET, 'acct-A'), [
    { ref: TASK, name: '过程质量回归评测', archived: true },
  ]);
  assert.equal(catalog.archiveResource('dataset', DATASET, 'acct-A').ok, true);
  assert.equal(catalog.archiveResource('rule', RULE, 'acct-A').ok, true);

  const run = catalog.validateRunBindings('acct-A', TASK, {
    scenario: { ...SCENARIO }, dataset: { ...DATASET }, rule: { ...RULE },
  });
  assert.equal(run.ok, false);
  if (!run.ok) assert.deepEqual(run.issues.map((i) => i.code), ['TASK_ARCHIVED']);
  assert.deepEqual(catalog.getTask(TASK, 'acct-A')?.snapshot.dataset, DATASET);
});

test('已归档数据集／规则不能用于新建任务，失败不落任务行', () => {
  const catalog = catalogWithOwnerA();
  catalog.putDataset('acct-A', { id: 'ds-support', version: 'v4' }, datasetSnapshot());
  assert.equal(catalog.archiveResource('dataset', DATASET, 'acct-A').ok, true);
  assert.equal(catalog.archiveResource('rule', RULE, 'acct-A').ok, true);

  const dataset = catalog.createTaskConfig('acct-A', TASK, binding());
  assert.equal(dataset.ok, false);
  if (!dataset.ok) assert.ok(dataset.issues.some((i) => i.code === 'DATASET_ARCHIVED' && i.field === 'binding.dataset'));
  const rule = catalog.createTaskConfig('acct-A', TASK, binding({
    dataset: { id: 'ds-support', version: 'v4' },
  }));
  assert.equal(rule.ok, false);
  if (!rule.ok) assert.deepEqual(rule.issues.map((i) => i.code), ['RULE_ARCHIVED']);
  assert.deepEqual(catalog.listTasks('acct-A'), []);
});

test('归档的越权、不存在与非法输入统一不写状态，也不泄露引用任务', () => {
  const catalog = catalogWithOwnerA();
  assert.equal(catalog.createTaskConfig('acct-A', TASK, binding()).ok, true);

  const crossOwner = catalog.archiveResource('dataset', DATASET, 'acct-B');
  assert.equal(crossOwner.ok, false);
  if (!crossOwner.ok) assert.deepEqual(crossOwner.issues.map((i) => i.code), ['RESOURCE_NOT_FOUND']);
  const missing = catalog.archiveResource('dataset', { id: 'ds-missing', version: 'v1' }, 'acct-A');
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.deepEqual(missing.issues.map((i) => i.code), ['RESOURCE_NOT_FOUND']);
  const scenario = catalog.archiveResource('scenario' as ArchivableResourceKind, SCENARIO, 'acct-A');
  assert.equal(scenario.ok, false);
  if (!scenario.ok) assert.deepEqual(scenario.issues.map((i) => i.code), ['INVALID_INPUT']);
  const emptyRef = catalog.archiveResource('dataset', { id: ' ', version: 'v1' }, 'acct-A');
  assert.equal(emptyRef.ok, false);
  if (!emptyRef.ok) assert.deepEqual(emptyRef.issues.map((i) => i.code), ['INVALID_INPUT']);

  assert.deepEqual(catalog.listReferencingTasks('dataset', DATASET, 'acct-B'), []);
  assert.deepEqual(catalog.listArchived('dataset', undefined), []);
});

test('同一数据集的多个任务版本：仅剩活跃引用时仍拒绝归档', () => {
  const catalog = catalogWithOwnerA();
  assert.equal(catalog.createTaskConfig('acct-A', TASK, binding()).ok, true);
  assert.equal(catalog.createTaskConfig('acct-A', { id: TASK.id, version: 'v2' }, binding()).ok, true);
  assert.equal(catalog.archiveResource('task', TASK, 'acct-A').ok, true);

  assert.deepEqual(catalog.listReferencingTasks('dataset', DATASET, 'acct-A'), [
    { ref: TASK, name: '过程质量回归评测', archived: true },
    { ref: { id: TASK.id, version: 'v2' }, name: '过程质量回归评测', archived: false },
  ]);
  const blocked = catalog.archiveResource('dataset', DATASET, 'acct-A');
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.deepEqual(blocked.references.map((row) => row.ref.version), ['v2']);
});

test('归档状态存储：同键同归属幂等，换归属拒绝且读不到', () => {
  const store = new InMemoryArchiveStore();
  const first = store.put('acct-A', 'dataset', DATASET, () => '2026-11-23T10:00:00+08:00');
  assert.equal(store.put('acct-A', 'dataset', { ...DATASET }, () => 'later').archivedAt, first.archivedAt);
  assert.throws(() => store.put('acct-B', 'dataset', DATASET, () => 'later'), ImmutableVersionConflict);
  assert.equal(store.get('dataset', DATASET, 'acct-B'), undefined);
  assert.equal(store.get('dataset', DATASET, undefined), undefined);
  assert.deepEqual(store.list('dataset', 'acct-A').map((row) => row.ref), [DATASET]);
  assert.deepEqual(store.list('dataset', 'acct-B'), []);
});
