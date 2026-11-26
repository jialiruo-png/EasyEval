/**
 * P2 资源管理接口骨架单元测试：
 *   node --test src/resource-api/handlers.test.ts
 * 纯逻辑测试，仅用 Node 22 内置能力；不启动 HTTP、Docker、上游或模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ResourceCatalog,
  resourceContentHash,
  type DatasetSnapshot,
  type ScenarioConfigSnapshot,
  type TaskBinding,
} from '../domain/resources.ts';
import { processQualityRule } from '../result-contract/fixtures.ts';
import { openSqliteResourceCatalog } from '../storage/sqlite-resource-store.ts';
import {
  archiveManagedResource,
  copyManagedResource,
  createManagedResource,
  getManagedArchiveStatus,
  getManagedResource,
  listManagedResources,
  listResourceReferences,
  MAX_PAGE_SIZE,
  resourceDisplayName,
  type AuthContext,
  type ManagedKind,
  type ResourceResponse,
} from './handlers.ts';

const A = { accountId: 'acct-A' } satisfies AuthContext;
const B = { accountId: 'acct-B' } satisfies AuthContext;
const SCENARIO = { id: 'sc-harness', version: 'v1' };
const DATASET = { id: 'ds-support', version: 'v3' };
const RULE = { id: processQualityRule.id, version: processQualityRule.version };

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

function catalogWithA(): ResourceCatalog {
  const catalog = new ResourceCatalog(() => '2026-11-24T10:00:00+08:00');
  catalog.putScenario('acct-A', SCENARIO, scenarioSnapshot());
  catalog.putDataset('acct-A', DATASET, datasetSnapshot());
  catalog.putRule('acct-A', RULE, processQualityRule);
  return catalog;
}

function expectError(response: ResourceResponse<unknown>, code: string, httpStatus: number): void {
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.code, code);
  assert.equal(response.httpStatus, httpStatus);
}

test('未登录时列表、详情与写入一律 401，且不触碰目录', () => {
  const catalog = new ResourceCatalog();
  expectError(listManagedResources(catalog, {}, 'scenario'), 'UNAUTHORIZED', 401);
  expectError(getManagedResource(catalog, {}, 'scenario', SCENARIO), 'UNAUTHORIZED', 401);
  expectError(
    createManagedResource(catalog, {}, 'scenario', {
      id: SCENARIO.id, version: SCENARIO.version, snapshot: scenarioSnapshot(),
    }),
    'UNAUTHORIZED',
    401,
  );
  assert.deepEqual(catalog.listScenarios('acct-A'), []);
});

test('列表只返回本人版本，按 id/version 稳定排序，新账号为空', () => {
  const catalog = catalogWithA();
  catalog.putScenario('acct-A', { id: 'sc-harness', version: 'v2' }, scenarioSnapshot());
  catalog.putScenario('acct-B', { id: 'sc-other', version: 'v1' }, scenarioSnapshot());

  const own = listManagedResources(catalog, A, 'scenario');
  assert.equal(own.ok, true);
  if (!own.ok) return;
  assert.equal(own.data.kind, 'scenario');
  assert.equal(own.data.total, 2);
  assert.deepEqual(own.data.items.map((item) => [item.id, item.version]), [
    ['sc-harness', 'v1'], ['sc-harness', 'v2'],
  ]);

  const other = listManagedResources(catalog, B, 'scenario');
  assert.equal(other.ok, true);
  if (!other.ok) return;
  assert.deepEqual(other.data.items.map((item) => item.id), ['sc-other']);

  const empty = listManagedResources(catalog, { accountId: 'acct-C' }, 'dataset');
  assert.equal(empty.ok, true);
  if (!empty.ok) return;
  assert.deepEqual(empty.data.items, []);
  assert.equal(empty.data.total, 0);
});

test('详情：本人可读且快照深冻结，越权与不存在统一 404', () => {
  const catalog = catalogWithA();
  catalog.putScenario('acct-B', { id: 'sc-b', version: 'v1' }, scenarioSnapshot());

  const own = getManagedResource(catalog, A, 'scenario', SCENARIO);
  assert.equal(own.ok, true);
  if (!own.ok) return;
  assert.equal(own.data.ownerAccountId, 'acct-A');
  assert.deepEqual(own.data.snapshot, scenarioSnapshot());
  assert.equal(Object.isFrozen(own.data.snapshot), true);
  assert.throws(() => { (own.data.snapshot as { name: string }).name = 'changed'; }, TypeError);

  const other = getManagedResource(catalog, A, 'scenario', { id: 'sc-b', version: 'v1' });
  const missing = getManagedResource(catalog, A, 'scenario', { id: 'sc-none', version: 'v1' });
  expectError(other, 'NOT_FOUND', 404);
  expectError(missing, 'NOT_FOUND', 404);
  if (!other.ok && !missing.ok) assert.equal(other.message, missing.message);
  expectError(getManagedResource(catalog, A, 'scenario', { id: SCENARIO.id, version: '' }), 'INVALID_INPUT', 400);
});

test('创建场景配置：201 落盘，归属只来自会话，请求体自称归属被忽略', () => {
  const catalog = new ResourceCatalog();
  const ref = { id: 'sc-new', version: 'v1' };
  const response = createManagedResource(catalog, A, 'scenario', {
    id: ref.id,
    version: ref.version,
    snapshot: scenarioSnapshot(),
    ownerAccountId: 'acct-B',
  });
  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.equal(response.httpStatus, 201);
  assert.equal(response.data.ownerAccountId, 'acct-A');
  assert.match(response.data.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(catalog.getScenario(ref, 'acct-A')?.ref.version, 'v1');
  assert.equal(catalog.getScenario(ref, 'acct-B'), undefined);
});

test('同一写接口可创建数据集与规则版本', () => {
  const catalog = new ResourceCatalog();
  const dataset = createManagedResource(catalog, A, 'dataset', {
    id: DATASET.id, version: DATASET.version, snapshot: datasetSnapshot(),
  });
  const rule = createManagedResource(catalog, A, 'rule', {
    id: RULE.id, version: RULE.version, snapshot: processQualityRule,
  });
  assert.equal(dataset.ok, true);
  assert.equal(rule.ok, true);
  if (!dataset.ok || !rule.ok) return;
  assert.equal(dataset.httpStatus, 201);
  assert.equal(rule.httpStatus, 201);
  assert.equal((rule.data.snapshot as typeof processQualityRule).metrics.length, 4);
  assert.equal(catalog.listDatasets('acct-A').length, 1);
  assert.equal(catalog.listRules('acct-A').length, 1);
});

test('同键同内容幂等返回 200.replayed；改内容或换归属返回 409', () => {
  const catalog = new ResourceCatalog();
  const input = { id: SCENARIO.id, version: SCENARIO.version, snapshot: scenarioSnapshot() };
  const first = createManagedResource(catalog, A, 'scenario', input);
  const reordered = createManagedResource(catalog, A, 'scenario', {
    id: SCENARIO.id,
    version: SCENARIO.version,
    // 键顺序不同但业务内容相同
    snapshot: {
      toolWhitelist: ['read_file', 'calculator'],
      modelConfigRef: 'model-profile-A',
      profile: 'deepseek-harness',
      name: 'DeepSeek Harness',
    },
  });
  assert.equal(first.ok, true);
  assert.equal(reordered.ok, true);
  if (!first.ok || !reordered.ok) return;
  assert.equal(reordered.httpStatus, 200);
  assert.equal(reordered.replayed, true);
  assert.equal(reordered.data.contentHash, first.data.contentHash);
  assert.equal(reordered.data.createdAt, first.data.createdAt);
  assert.equal(catalog.listScenarios('acct-A').length, 1);

  expectError(
    createManagedResource(catalog, A, 'scenario', {
      id: SCENARIO.id, version: SCENARIO.version,
      snapshot: { ...scenarioSnapshot(), profile: 'other-profile' },
    }),
    'VERSION_CONFLICT',
    409,
  );
  expectError(createManagedResource(catalog, B, 'scenario', input), 'VERSION_CONFLICT', 409);
});

test('非法数据集快照返回 422 且不落库', () => {
  const catalog = new ResourceCatalog();
  const response = createManagedResource(catalog, A, 'dataset', {
    id: 'ds-bad', version: 'v1', snapshot: { ...datasetSnapshot(), queryColumn: 'missing' },
  });
  expectError(response, 'INVALID_INPUT', 422);
  if (!response.ok) assert.match(response.message, /查询列不在数据集列中/);
  assert.deepEqual(catalog.listDatasets('acct-A'), []);
});

test('任务创建：三引用齐全时冻结绑定，详情按账号限定', () => {
  const catalog = catalogWithA();
  const ref = { id: 'task-regression', version: 'v1' };
  const created = createManagedResource(catalog, A, 'task', {
    id: ref.id, version: ref.version, binding: binding(),
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.httpStatus, 201);
  assert.equal(Object.isFrozen(created.data.snapshot), true);
  assert.deepEqual((created.data.snapshot as TaskBinding).dataset, DATASET);

  const own = getManagedResource(catalog, A, 'task', ref);
  assert.equal(own.ok, true);
  if (own.ok) assert.deepEqual((own.data.snapshot as TaskBinding).rule, RULE);
  expectError(getManagedResource(catalog, B, 'task', ref), 'NOT_FOUND', 404);
});

test('任务引用缺失、越界归属与定时缺 cron 返回逐字段错误且不落任务', () => {
  const catalog = catalogWithA();
  catalog.putDataset('acct-B', { id: 'ds-b', version: 'v1' }, datasetSnapshot());

  const foreign = createManagedResource(catalog, A, 'task', {
    id: 'task-x', version: 'v1', binding: binding({ dataset: { id: 'ds-b', version: 'v1' } }),
  });
  expectError(foreign, 'BINDING_INVALID', 422);
  if (!foreign.ok) {
    assert.deepEqual(foreign.issues?.map((item) => [item.code, item.field]), [['DATASET_NOT_FOUND', 'binding.dataset']]);
  }

  const noCron = createManagedResource(catalog, A, 'task', {
    id: 'task-y', version: 'v1',
    binding: binding({ schedule: { enabled: true, timezone: 'Asia/Shanghai' } }),
  });
  expectError(noCron, 'INVALID_INPUT', 422);
  if (!noCron.ok) assert.deepEqual(noCron.issues?.map((item) => item.field), ['binding.schedule.cron']);

  const missingRule = createManagedResource(catalog, A, 'task', {
    id: 'task-z', version: 'v1', binding: binding({ rule: { id: 'rule-none', version: 'v1' } }),
  });
  expectError(missingRule, 'BINDING_INVALID', 422);
  if (!missingRule.ok) assert.equal(missingRule.issues?.[0]?.code, 'RULE_NOT_FOUND');
  assert.deepEqual(catalog.listTasks('acct-A'), []);
});

test('任务同键同内容幂等，改绑定内容返回 409', () => {
  const catalog = catalogWithA();
  const ref = { id: 'task-regression', version: 'v1' };
  const first = createManagedResource(catalog, A, 'task', { ...ref, binding: binding() });
  const again = createManagedResource(catalog, A, 'task', { ...ref, binding: binding() });
  expectError(
    createManagedResource(catalog, A, 'task', { ...ref, binding: binding({ variableMappings: [] }) }),
    'VERSION_CONFLICT',
    409,
  );
  assert.equal(first.ok, true);
  assert.equal(again.ok, true);
  if (!first.ok || !again.ok) return;
  assert.equal(again.replayed, true);
  assert.equal(catalog.listTasks('acct-A').length, 1);
});

test('写接口直接作用于 SQLite 目录：关库重开后列表与详情逐字段一致', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-resource-api-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'eval.sqlite');
  const now = () => '2026-11-24T10:00:00+08:00';
  const taskRef = { id: 'task-regression', version: 'v1' };
  const taskInput = { ...taskRef, binding: binding() };

  const store = openSqliteResourceCatalog(dbPath, { now });
  for (const written of [
    createManagedResource(store, A, 'scenario', { ...SCENARIO, snapshot: scenarioSnapshot() }),
    createManagedResource(store, A, 'dataset', { ...DATASET, snapshot: datasetSnapshot() }),
    createManagedResource(store, A, 'rule', { ...RULE, snapshot: processQualityRule }),
    createManagedResource(store, A, 'task', taskInput),
  ]) {
    assert.equal(written.ok, true);
  }
  const before = listManagedResources(store, A, 'task');
  store.close();

  const reopened = openSqliteResourceCatalog(dbPath, { now });
  const after = listManagedResources(reopened, A, 'task');
  assert.deepEqual(after, before);
  const detail = getManagedResource(reopened, A, 'task', taskRef);
  assert.equal(detail.ok, true);
  if (!detail.ok) return;
  assert.deepEqual(detail.data.snapshot, binding());
  const otherList = listManagedResources(reopened, B, 'task');
  assert.equal(otherList.ok, true);
  if (otherList.ok) assert.equal(otherList.data.total, 0);
  const replay = createManagedResource(reopened, A, 'task', taskInput);
  assert.equal(replay.ok, true);
  if (replay.ok) assert.equal(replay.replayed, true);
  reopened.close();
});

test('复制生成新 ID 的独立副本：快照与绑定沿用源，归属来自会话且不触发运行', () => {
  const catalog = catalogWithA();
  const scenarioCopy = copyManagedResource(catalog, A, 'scenario', SCENARIO, {
    id: 'sc-copy', version: 'v1', ownerAccountId: B,
  });
  assert.equal(scenarioCopy.ok, true);
  if (!scenarioCopy.ok) return;
  assert.equal(scenarioCopy.httpStatus, 201);
  assert.equal(scenarioCopy.data.id, 'sc-copy');
  assert.equal(scenarioCopy.data.ownerAccountId, A.accountId);
  assert.deepEqual(scenarioCopy.data.snapshot, scenarioSnapshot());
  // 内容哈希包含 ref.id，副本快照相同但 ID 不同，因此哈希也不同。
  assert.match(scenarioCopy.data.contentHash, /^[0-9a-f]{64}$/);
  assert.notEqual(scenarioCopy.data.contentHash, catalog.getScenario(SCENARIO, A.accountId)?.contentHash);

  const sourceTask = catalog.createTaskConfig(A.accountId, { id: 'task-src', version: 'v1' }, binding());
  assert.equal(sourceTask.ok, true);
  const taskCopy = copyManagedResource(catalog, A, 'task', { id: 'task-src', version: 'v1' }, {
    id: 'task-copy', version: 'v1',
  });
  assert.equal(taskCopy.ok, true);
  if (!taskCopy.ok) return;
  assert.deepEqual(taskCopy.data.snapshot, binding());
  assert.equal(catalog.listTasks(A.accountId).length, 2);
  // 复制只写配置，不产生运行记录；运行索引由后续阶段单独写入。
  assert.deepEqual(catalog.listScenarios(B.accountId), []);
});

test('复制省略 ID 时由服务端生成，重复提交同副本幂等，改内容或同 ref 冲突', () => {
  const catalog = catalogWithA();
  const first = copyManagedResource(catalog, A, 'dataset', DATASET);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.match(first.data.id, /^ds-support-copy-[0-9a-f]{8}$/);
  assert.equal(first.data.version, 'v1');

  const sameRef = copyManagedResource(catalog, A, 'scenario', SCENARIO, { id: SCENARIO.id, version: SCENARIO.version });
  expectError(sameRef, 'INVALID_INPUT', 400);

  const replay = copyManagedResource(catalog, A, 'scenario', SCENARIO, { id: 'sc-replay', version: 'v1' });
  assert.equal(replay.ok, true);
  const again = copyManagedResource(catalog, A, 'scenario', SCENARIO, { id: 'sc-replay', version: 'v1' });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.httpStatus, 200);
  assert.equal(again.replayed, true);
  assert.equal(catalog.listScenarios(A.accountId).length, 2);
});

test('复制源越权或不存在统一 404，非法 ID 与请求体返回 400', () => {
  const catalog = catalogWithA();
  catalog.putScenario(B.accountId, { id: 'sc-b', version: 'v1' }, scenarioSnapshot());
  const foreign = copyManagedResource(catalog, A, 'scenario', { id: 'sc-b', version: 'v1' }, { id: 'sc-x' });
  const missing = copyManagedResource(catalog, A, 'scenario', { id: 'sc-none', version: 'v1' }, { id: 'sc-x' });
  expectError(foreign, 'NOT_FOUND', 404);
  expectError(missing, 'NOT_FOUND', 404);
  if (!foreign.ok && !missing.ok) assert.equal(foreign.message, missing.message);
  expectError(copyManagedResource(catalog, {}, 'scenario', SCENARIO), 'UNAUTHORIZED', 401);
  expectError(copyManagedResource(catalog, A, 'scenario', SCENARIO, { id: '' }), 'INVALID_INPUT', 400);
  expectError(copyManagedResource(catalog, A, 'scenario', SCENARIO, [] as never), 'INVALID_INPUT', 400);
  assert.equal(catalog.listScenarios(A.accountId).length, 1);
});

test('请求形状错误返回 400：缺 id/version、非对象、未知种类', () => {
  const catalog = catalogWithA();
  expectError(createManagedResource(catalog, A, 'scenario', { version: 'v1', snapshot: scenarioSnapshot() }), 'INVALID_INPUT', 400);
  expectError(createManagedResource(catalog, A, 'scenario', { id: 'sc', snapshot: scenarioSnapshot() }), 'INVALID_INPUT', 400);
  expectError(createManagedResource(catalog, A, 'scenario', null as never), 'INVALID_INPUT', 400);
  expectError(
    createManagedResource(catalog, A, 'scenario', { id: 'sc', version: 'v1', snapshot: [] }),
    'INVALID_INPUT',
    400,
  );
  expectError(listManagedResources(catalog, A, 'unknown' as ManagedKind), 'INVALID_INPUT', 400);
  expectError(
    createManagedResource(catalog, A, 'task', { id: 'task-bad', version: 'v1', binding: [] }),
    'INVALID_INPUT',
    400,
  );
});

/** 四条本人场景（含两个版本）与一条他人场景，createdAt 依次递增。 */
function searchableCatalog(): ResourceCatalog {
  let tick = 0;
  const clock = () => `2026-11-24T10:${String(tick++).padStart(2, '0')}:00+08:00`;
  const catalog = new ResourceCatalog(clock);
  catalog.putScenario(A.accountId!, { id: 'sc-alpha', version: 'v1' }, { ...scenarioSnapshot(), name: 'Alpha Harness' });
  catalog.putScenario(A.accountId!, { id: 'sc-alpha', version: 'v2' }, { ...scenarioSnapshot(), name: 'Alpha Harness 2' });
  catalog.putScenario(A.accountId!, { id: 'sc-beta', version: 'v1' }, { ...scenarioSnapshot(), name: 'Beta Tools' });
  catalog.putScenario(A.accountId!, { id: 'sc-gamma', version: 'v1' }, { ...scenarioSnapshot(), name: 'Gamma RW' });
  catalog.putScenario(B.accountId!, { id: 'sc-secret', version: 'v1' }, { ...scenarioSnapshot(), name: 'Secret Beta' });
  return catalog;
}

function itemKeys(response: ResourceResponse<unknown>): string[] {
  if (!response.ok) return [];
  const data = response.data as { items: { id: string; version: string }[] };
  return data.items.map((item) => `${item.id}@${item.version}`);
}

test('列表筛选：q 模糊匹配名称或 ID（大小写不敏感），name/id 精确匹配', () => {
  const catalog = searchableCatalog();
  const byName = listManagedResources(catalog, A, 'scenario', { q: 'ALPHA' });
  assert.deepEqual(itemKeys(byName), ['sc-alpha@v1', 'sc-alpha@v2']);
  const byId = listManagedResources(catalog, A, 'scenario', { q: 'gamma' });
  assert.deepEqual(itemKeys(byId), ['sc-gamma@v1']);
  const exactName = listManagedResources(catalog, A, 'scenario', { name: 'Beta Tools' });
  assert.deepEqual(itemKeys(exactName), ['sc-beta@v1']);
  const exactId = listManagedResources(catalog, A, 'scenario', { id: 'sc-alpha' });
  assert.deepEqual(itemKeys(exactId), ['sc-alpha@v1', 'sc-alpha@v2']);
  // 他人的 Secret Beta 虽匹配 beta，但必须先按账号限定，不出现在结果中。
  const beta = listManagedResources(catalog, A, 'scenario', { q: 'beta' });
  assert.deepEqual(itemKeys(beta), ['sc-beta@v1']);
});

test('列表排序：createdAt/name 排序，主键相同用 version 兜底保持稳定', () => {
  const catalog = searchableCatalog();
  const newest = listManagedResources(catalog, A, 'scenario', { sortBy: 'createdAt', order: 'desc' });
  assert.deepEqual(itemKeys(newest), ['sc-gamma@v1', 'sc-beta@v1', 'sc-alpha@v2', 'sc-alpha@v1']);
  const oldest = listManagedResources(catalog, A, 'scenario', { sortBy: 'createdAt', order: 'asc' });
  assert.deepEqual(itemKeys(oldest), ['sc-alpha@v1', 'sc-alpha@v2', 'sc-beta@v1', 'sc-gamma@v1']);
  const byName = listManagedResources(catalog, A, 'scenario', { sortBy: 'name', order: 'desc' });
  assert.deepEqual(itemKeys(byName), ['sc-gamma@v1', 'sc-beta@v1', 'sc-alpha@v2', 'sc-alpha@v1']);
  // 不传查询参数时保持既有 id/version 升序。
  assert.deepEqual(itemKeys(listManagedResources(catalog, A, 'scenario')), [
    'sc-alpha@v1', 'sc-alpha@v2', 'sc-beta@v1', 'sc-gamma@v1',
  ]);
});

test('列表分页：total 不受分页影响，query 回显，页越界返回空', () => {
  const catalog = searchableCatalog();
  const first = listManagedResources(catalog, A, 'scenario', {
    sortBy: 'createdAt', order: 'desc', page: 1, pageSize: 2,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.data.total, 4);
  assert.deepEqual(first.data.query, { sortBy: 'createdAt', order: 'desc', page: 1, pageSize: 2 });
  assert.deepEqual(first.data.items.map((i) => i.id), ['sc-gamma', 'sc-beta']);

  const second = listManagedResources(catalog, A, 'scenario', {
    sortBy: 'createdAt', order: 'desc', page: 2, pageSize: 2,
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.data.total, 4);
  assert.deepEqual(second.data.items.map((i) => i.id), ['sc-alpha', 'sc-alpha']);

  const beyond = listManagedResources(catalog, A, 'scenario', { page: 9, pageSize: 2 });
  assert.equal(beyond.ok, true);
  if (beyond.ok) {
    assert.equal(beyond.data.total, 4);
    assert.deepEqual(beyond.data.items, []);
  }
});

test('列表创建人筛选：只接受会话账号，他人账号结果为空且不泄露', () => {
  const catalog = searchableCatalog();
  const own = listManagedResources(catalog, A, 'scenario', { ownerAccountId: A.accountId });
  assert.equal(own.ok, true);
  if (own.ok) assert.equal(own.data.total, 4);
  const foreign = listManagedResources(catalog, A, 'scenario', { ownerAccountId: B.accountId });
  assert.equal(foreign.ok, true);
  if (foreign.ok) {
    assert.equal(foreign.data.total, 0);
    assert.deepEqual(foreign.data.items, []);
  }
});

test('列表非法查询参数返回 400：sortBy/order/page/pageSize/q', () => {
  const catalog = searchableCatalog();
  expectError(listManagedResources(catalog, A, 'scenario', { sortBy: 'bogus' as never }), 'INVALID_INPUT', 400);
  expectError(listManagedResources(catalog, A, 'scenario', { order: 'sideways' as never }), 'INVALID_INPUT', 400);
  expectError(listManagedResources(catalog, A, 'scenario', { page: 0 }), 'INVALID_INPUT', 400);
  expectError(listManagedResources(catalog, A, 'scenario', { page: 1.5 }), 'INVALID_INPUT', 400);
  expectError(listManagedResources(catalog, A, 'scenario', { pageSize: 0 }), 'INVALID_INPUT', 400);
  expectError(listManagedResources(catalog, A, 'scenario', { pageSize: MAX_PAGE_SIZE + 1 }), 'INVALID_INPUT', 400);
  expectError(listManagedResources(catalog, A, 'scenario', { q: 42 as never }), 'INVALID_INPUT', 400);
  expectError(listManagedResources(catalog, A, 'scenario', null as never), 'INVALID_INPUT', 400);
});

test('展示名取版本快照中的名称，历史无名任务回退到 ID', () => {
  assert.equal(resourceDisplayName('task', {}, 'task-x'), 'task-x');
  assert.equal(resourceDisplayName('scenario', scenarioSnapshot(), 'sc-x'), 'DeepSeek Harness');
  assert.equal(resourceDisplayName('task', binding(), 'task-x'), binding().name);
});

test('三个管理列表默认最新在前，按真实时间排序，上海日期两端都包含', () => {
  let instant = '2026-11-23T15:59:59.999Z';
  const catalog = new ResourceCatalog(() => instant);
  catalog.putScenario(A.accountId!, SCENARIO, scenarioSnapshot());
  catalog.putDataset(A.accountId!, DATASET, datasetSnapshot());
  catalog.putRule(A.accountId!, RULE, processQualityRule);
  for (const [id, timestamp] of [
    ['b-before', '2026-11-23T23:59:59.999+08:00'],
    ['a-start', '2026-11-23T16:00:00Z'],
    ['z-end', '2026-11-24T23:59:59.999+08:00'],
    ['c-next', '2026-11-24T16:00:00Z'],
  ]) {
    instant = timestamp;
    const ref = { id, version: 'v1' };
    catalog.putDataset(A.accountId!, ref, datasetSnapshot());
    catalog.putRule(A.accountId!, ref, { ...processQualityRule, id });
    assert.ok(catalog.createTaskConfig(A.accountId!, ref, binding()).ok);
  }
  for (const kind of ['task', 'dataset', 'rule'] as const) {
    const all = listManagedResources(catalog, A, kind);
    assert.ok(all.ok);
    assert.deepEqual(itemKeys(all).slice(0, 3), ['c-next@v1', 'z-end@v1', 'a-start@v1']);
    const day = { from: '2026-11-24', to: '2026-11-24' };
    assert.deepEqual(itemKeys(listManagedResources(catalog, A, kind, day)), ['z-end@v1', 'a-start@v1']);
    const paged = listManagedResources(catalog, A, kind, { ...day, page: 2, pageSize: 1 });
    assert.ok(paged.ok);
    assert.equal(paged.data.total, 2);
    assert.deepEqual(itemKeys(paged), ['a-start@v1']);
    assert.deepEqual(itemKeys(listManagedResources(catalog, B, kind, day)), []);
  }
  assert.deepEqual(itemKeys(listManagedResources(catalog, A, 'task', { from: '2026-11-25' })), ['c-next@v1']);
  assert.deepEqual(itemKeys(listManagedResources(catalog, A, 'task', { to: '2026-11-23' })), ['b-before@v1']);
  assert.deepEqual(itemKeys(listManagedResources(catalog, A, 'task', { from: '', to: '' })), itemKeys(listManagedResources(catalog, A, 'task')));
  for (const bounds of [{ from: '2026-02-29' }, { to: '2026-11-2' }, { from: '2026-11-25', to: '2026-11-24' }]) {
    expectError(listManagedResources(catalog, A, 'task', bounds), 'INVALID_INPUT', 400);
  }
});

test('新任务必填名称；老 SQLite 快照保持可读、可重放、可复制', (t) => {
  const catalog = openSqliteResourceCatalog(':memory:');
  t.after(() => catalog.close());
  const owner = A.accountId!;
  catalog.putScenario(owner, SCENARIO, scenarioSnapshot());
  catalog.putDataset(owner, DATASET, datasetSnapshot());
  catalog.putRule(owner, RULE, processQualityRule);
  const ref = { id: 'legacy-task', version: 'v1' };
  const copyRef = { id: 'legacy-copy', version: 'v1' };
  const { name, ...legacy } = binding();
  const insert = catalog.db.prepare(`
    INSERT INTO resource_versions (resource_kind, id, version, owner_account_id, snapshot_json, content_hash, created_at)
    VALUES ('task', ?, ?, ?, ?, ?, ?)
  `);
  for (const old of [ref, copyRef]) {
    insert.run(old.id, old.version, owner, JSON.stringify(legacy), resourceContentHash(owner, old, legacy), '2026-11-20T08:00:00Z');
  }
  for (const invalid of [legacy, { ...legacy, name: '   ' }, { ...legacy, name: 123 }]) {
    expectError(createManagedResource(catalog, A, 'task', { id: 'new', version: 'v1', binding: invalid }), 'INVALID_INPUT', 422);
  }
  const replay = createManagedResource(catalog, A, 'task', { ...ref, binding: legacy });
  assert.ok(replay.ok && replay.replayed);
  assert.equal(replay.data.name, ref.id);
  assert.deepEqual(replay.data.snapshot, legacy);
  const oldCopy = copyManagedResource(catalog, A, 'task', ref, copyRef);
  assert.ok(oldCopy.ok && oldCopy.replayed);
  assert.deepEqual(oldCopy.data.snapshot, legacy);
  const copy = copyManagedResource(catalog, A, 'task', ref, { id: 'new-copy' });
  assert.ok(copy.ok);
  assert.equal(copy.data.name, ref.id);
  assert.deepEqual(copy.data.snapshot, { ...legacy, name: ref.id });
  const created = createManagedResource(catalog, A, 'task', { id: 'named', version: 'v1', binding: binding() });
  assert.ok(created.ok);
  assert.equal(created.data.name, name);
  assert.deepEqual(itemKeys(listManagedResources(catalog, A, 'task', { q: '质量' })), ['named@v1']);
  expectError(copyManagedResource(catalog, A, 'task', ref, { ...ref, version: 'v2' }), 'INVALID_INPUT', 400);
});

test('规则副本的外部版本和评分快照中的 ID、版本一致', () => {
  const catalog = catalogWithA();
  const ref = { id: 'independent-rule', version: 'v3' };
  const copy = copyManagedResource(catalog, A, 'rule', RULE, ref);
  assert.ok(copy.ok);
  assert.deepEqual(copy.data.snapshot, { ...processQualityRule, ...ref });
  assert.equal(copyManagedResource(catalog, A, 'rule', RULE, ref).httpStatus, 200);
  const invalid = createManagedResource(catalog, A, 'rule', { id: 'bad-rule', version: 'v1', snapshot: { ...processQualityRule, totalScorePath: 'broken[' } });
  expectError(invalid, 'INVALID_INPUT', 422);
});

test('资源接口的绑定错误对缺失资源和其他账号的资源给出相同响应', () => {
  const catalog = catalogWithA();
  const ref = { id: 'unavailable', version: 'v1' };
  const input = { id: 'private-ref-test', version: 'v1', binding: binding({ dataset: ref }) };
  const absent = createManagedResource(catalog, A, 'task', input);
  catalog.putDataset(B.accountId, ref, datasetSnapshot());
  assert.deepEqual(createManagedResource(catalog, A, 'task', input), absent);
});

test('新规则要求名称，历史无名规则重放与复制仍保留评分定义', (t) => {
  const catalog = openSqliteResourceCatalog(':memory:');
  t.after(() => catalog.close());
  const { name, ...legacy } = processQualityRule;
  const input = { ...RULE, snapshot: legacy };
  expectError(createManagedResource(catalog, A, 'rule', input), 'INVALID_INPUT', 422);
  catalog.db.prepare(`
    INSERT INTO resource_versions (resource_kind, id, version, owner_account_id, snapshot_json, content_hash, created_at)
    VALUES ('rule', ?, ?, ?, ?, ?, ?)
  `).run(RULE.id, RULE.version, A.accountId, JSON.stringify(legacy), resourceContentHash(A.accountId, RULE, legacy), '2026-11-20T00:00:00Z');
  assert.ok(createManagedResource(catalog, A, 'rule', input).ok);
  const copyRef = { id: 'new-rule', version: 'v2' };
  const copy = copyManagedResource(catalog, A, 'rule', RULE, copyRef);
  assert.ok(copy.ok);
  assert.deepEqual(copy.data.snapshot, { ...legacy, ...copyRef, name: RULE.id });
});

test('归档任务：只标状态、幂等重放、详情仍可读，越权与场景分别 404/400', () => {
  const catalog = catalogWithA();
  const ref = { id: 'task-archive', version: 'v1' };
  assert.equal(catalog.createTaskConfig(A.accountId, ref, binding()).ok, true);

  const before = getManagedArchiveStatus(catalog, A, 'task', ref);
  assert.ok(before.ok);
  if (before.ok) {
    assert.equal(before.data.archived, false);
    assert.equal('archivedAt' in before.data, false);
  }

  const first = archiveManagedResource(catalog, A, 'task', ref);
  assert.ok(first.ok);
  assert.equal(first.httpStatus, 200);
  assert.equal(first.replayed, undefined);
  assert.equal(first.data.archivedAt, '2026-11-24T10:00:00+08:00');
  const replay = archiveManagedResource(catalog, A, 'task', ref);
  assert.ok(replay.ok);
  assert.equal(replay.replayed, true);
  assert.equal(replay.data.archivedAt, first.data.archivedAt);

  const status = getManagedArchiveStatus(catalog, A, 'task', ref);
  assert.ok(status.ok);
  if (status.ok) {
    assert.equal(status.data.archived, true);
    assert.equal(status.data.archivedAt, first.data.archivedAt);
  }
  const detail = getManagedResource(catalog, A, 'task', ref);
  assert.ok(detail.ok);
  if (detail.ok) assert.deepEqual(detail.data.snapshot, binding());

  expectError(archiveManagedResource(catalog, B, 'task', ref), 'NOT_FOUND', 404);
  expectError(getManagedArchiveStatus(catalog, B, 'task', ref), 'NOT_FOUND', 404);
  expectError(archiveManagedResource(catalog, A, 'scenario', SCENARIO), 'INVALID_INPUT', 400);
  expectError(archiveManagedResource(catalog, {}, 'task', ref), 'UNAUTHORIZED', 401);
});

test('数据集被活跃任务引用时归档 409 并带引用任务，任务归档后释放', () => {
  const catalog = catalogWithA();
  const taskRef = { id: 'task-active', version: 'v1' };
  assert.equal(catalog.createTaskConfig(A.accountId, taskRef, binding({ name: '活跃任务' })).ok, true);

  const blocked = archiveManagedResource(catalog, A, 'dataset', DATASET);
  expectError(blocked, 'ACTIVE_TASK_REFERENCE', 409);
  if (!blocked.ok) {
    assert.deepEqual(blocked.issues?.map((entry) => entry.code), ['ACTIVE_TASK_REFERENCE']);
    assert.deepEqual(blocked.references?.map((entry) => [entry.ref.id, entry.name, entry.archived]), [
      ['task-active', '活跃任务', false],
    ]);
  }
  const stillActive = getManagedArchiveStatus(catalog, A, 'dataset', DATASET);
  assert.ok(stillActive.ok);
  if (stillActive.ok) assert.equal(stillActive.data.archived, false);

  const before = listResourceReferences(catalog, A, 'dataset', DATASET);
  assert.ok(before.ok);
  if (before.ok) assert.equal(before.data.total, 1);

  assert.ok(archiveManagedResource(catalog, A, 'task', taskRef).ok);
  const after = listResourceReferences(catalog, A, 'dataset', DATASET);
  assert.ok(after.ok);
  if (after.ok) {
    assert.equal(after.data.total, 1);
    assert.deepEqual(after.data.items.map((entry) => [entry.ref.id, entry.archived]), [['task-active', true]]);
  }

  assert.ok(archiveManagedResource(catalog, A, 'dataset', DATASET).ok);
  const newTask = createManagedResource(catalog, A, 'task', {
    id: 'task-after-archive', version: 'v1', binding: binding(),
  });
  expectError(newTask, 'BINDING_INVALID', 422);
  if (!newTask.ok) {
    assert.deepEqual(newTask.issues?.map((entry) => entry.code), ['DATASET_ARCHIVED']);
  }
  assert.equal(catalog.getTask(taskRef, A.accountId)?.snapshot.dataset.id, DATASET.id);
});

test('引用任务列表按账号限定，越权与不存在统一 404，种类非法 400', () => {
  const catalog = catalogWithA();
  assert.equal(catalog.createTaskConfig(A.accountId, { id: 'task-a', version: 'v1' }, binding({ name: 'A任务' })).ok, true);
  const bScenario = { id: 'sc-other', version: 'v1' };
  const bDataset = { id: 'ds-other', version: 'v1' };
  const bRule = { id: 'rule-other', version: 'v1' };
  catalog.putScenario(B.accountId, bScenario, scenarioSnapshot());
  catalog.putDataset(B.accountId, bDataset, datasetSnapshot());
  catalog.putRule(B.accountId, bRule, processQualityRule);
  assert.equal(catalog.createTaskConfig(B.accountId, { id: 'task-b', version: 'v1' },
    binding({ name: 'B任务', scenario: bScenario, dataset: bDataset, rule: bRule })).ok, true);

  const own = listResourceReferences(catalog, A, 'dataset', DATASET);
  assert.ok(own.ok);
  if (own.ok) assert.deepEqual(own.data.items.map((entry) => entry.name), ['A任务']);
  const other = listResourceReferences(catalog, B, 'dataset', bDataset);
  assert.ok(other.ok);
  if (other.ok) assert.deepEqual(other.data.items.map((entry) => entry.name), ['B任务']);
  // B 不能通过 A 的数据集引用看到 A 的任务。
  expectError(listResourceReferences(catalog, B, 'dataset', DATASET), 'NOT_FOUND', 404);

  expectError(listResourceReferences(catalog, A, 'task', { id: 'task-a', version: 'v1' }), 'INVALID_INPUT', 400);
  expectError(listResourceReferences(catalog, A, 'dataset', { id: 'ds-missing', version: 'v1' }), 'NOT_FOUND', 404);
  expectError(listResourceReferences(catalog, B, 'dataset', { id: 'ds-missing', version: 'v1' }), 'NOT_FOUND', 404);
  expectError(listResourceReferences(catalog, {}, 'dataset', DATASET), 'UNAUTHORIZED', 401);
});

test('SQLite 归档：关库重开后状态与引用逐字段一致，重放不刷新时间', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-archive-handler-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'eval.sqlite');
  let store = openSqliteResourceCatalog(dbPath, { now: () => '2026-11-25T09:00:00+08:00' });
  store.putScenario(A.accountId, SCENARIO, scenarioSnapshot());
  store.putDataset(A.accountId, DATASET, datasetSnapshot());
  store.putRule(A.accountId, RULE, processQualityRule);
  const taskRef = { id: 'task-sqlite', version: 'v1' };
  assert.equal(store.createTaskConfig(A.accountId, taskRef, binding()).ok, true);
  expectError(archiveManagedResource(store, A, 'dataset', DATASET), 'ACTIVE_TASK_REFERENCE', 409);
  assert.ok(archiveManagedResource(store, A, 'task', taskRef).ok);
  const archived = archiveManagedResource(store, A, 'dataset', DATASET);
  assert.ok(archived.ok);
  store.close();

  store = openSqliteResourceCatalog(dbPath, { now: () => '2026-11-26T09:00:00+08:00' });
  try {
    const status = getManagedArchiveStatus(store, A, 'dataset', DATASET);
    assert.ok(status.ok);
    if (status.ok) {
      assert.equal(status.data.archived, true);
      assert.equal(status.data.archivedAt, archived.data.archivedAt);
    }
    const replay = archiveManagedResource(store, A, 'dataset', DATASET);
    assert.ok(replay.ok);
    assert.equal(replay.replayed, true);
    assert.equal(replay.data.archivedAt, archived.data.archivedAt);
    const refs = listResourceReferences(store, A, 'dataset', DATASET);
    assert.ok(refs.ok);
    if (refs.ok) {
      assert.equal(refs.data.total, 1);
      assert.deepEqual(refs.data.items.map((entry) => [entry.ref.id, entry.archived]), [['task-sqlite', true]]);
    }
    expectError(archiveManagedResource(store, B, 'dataset', DATASET), 'NOT_FOUND', 404);
  } finally {
    store.close();
  }
});
