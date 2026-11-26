/**
 * P2 版本化资源落盘单元测试：
 *   node --test src/storage/sqlite-resource-store.test.ts
 * 仅使用临时目录中的本机 SQLite 文件与 Node 22 内置能力，
 * 不启动 Docker、不安装依赖、不访问上游或模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ResourceCatalog } from '../domain/resources.ts';
import type { DatasetSnapshot, ScenarioConfigSnapshot, TaskBinding } from '../domain/resources.ts';
import { processQualityRule } from '../result-contract/fixtures.ts';
import { applyMigrations, migrationVersion, openDatabase } from './migrations.ts';
import { openSqliteResourceCatalog } from './sqlite-resource-store.ts';

const NOW = () => '2026-11-24T09:00:00+08:00';
const SCENARIO = { id: 'sc-harness', version: 'v1' } as const;
const DATASET = { id: 'ds-support', version: 'v3' } as const;
const RULE = { id: 'rule-process-quality', version: 'v1' } as const;
const TASK = { id: 'task-regression', version: 'v1' } as const;

function tempDbPath(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'eval-resources-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'eval.sqlite');
}

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

function seedCatalog(open: ReturnType<typeof openSqliteResourceCatalog>): void {
  open.putScenario('acct-A', SCENARIO, scenarioSnapshot());
  open.putDataset('acct-A', DATASET, datasetSnapshot());
  open.putRule('acct-A', RULE, processQualityRule);
}

test('迁移：账本到版本 6，resource_versions 与归档表结构可用且重复执行幂等', (t) => {
  const dbPath = tempDbPath(t);
  const store = openSqliteResourceCatalog(dbPath, { now: NOW });
  assert.equal(migrationVersion(store.db), 6);
  assert.deepEqual(applyMigrations(store.db), []);

  const columns = store.db.prepare('PRAGMA table_info(resource_versions)').all() as { name: string }[];
  assert.deepEqual(columns.map((row) => row.name), [
    'resource_kind', 'id', 'version', 'owner_account_id',
    'snapshot_json', 'content_hash', 'created_at',
  ]);
  assert.throws(
    () => store.db.prepare(`
      INSERT INTO resource_versions
        (resource_kind, id, version, owner_account_id, snapshot_json, content_hash, created_at)
      VALUES ('unknown', 'x', 'v1', 'acct-A', '{}', 'h', 'now')
    `).run(),
    /CHECK constraint failed/,
  );
  const archiveColumns = store.db.prepare('PRAGMA table_info(archived_resources)').all() as { name: string }[];
  assert.deepEqual(archiveColumns.map((row) => row.name), [
    'resource_kind', 'id', 'version', 'owner_account_id', 'archived_at',
  ]);
  assert.throws(
    () => store.db.prepare(`
      INSERT INTO archived_resources
        (resource_kind, id, version, owner_account_id, archived_at)
      VALUES ('scenario', 'x', 'v1', 'acct-A', 'now')
    `).run(),
    /CHECK constraint failed/,
  );
  store.close();
});

test('四类版本写入落盘：归属、哈希、冻结快照与按账号列表', (t) => {
  const dbPath = tempDbPath(t);
  const store = openSqliteResourceCatalog(dbPath, { now: NOW });
  seedCatalog(store);
  const task = store.createTaskConfig('acct-A', TASK, binding());
  assert.equal(task.ok, true);

  const rows = store.db.prepare(`
    SELECT resource_kind, id, version, owner_account_id, content_hash, created_at
    FROM resource_versions ORDER BY resource_kind, id
  `).all() as {
    resource_kind: string; id: string; version: string;
    owner_account_id: string; content_hash: string; created_at: string;
  }[];
  assert.deepEqual(rows.map((row) => row.resource_kind), ['dataset', 'rule', 'scenario', 'task']);
  assert.ok(rows.every((row) => row.owner_account_id === 'acct-A'));
  assert.ok(rows.every((row) => /^[0-9a-f]{64}$/.test(row.content_hash)));
  assert.ok(rows.every((row) => row.created_at === NOW()));

  const stored = store.getScenario(SCENARIO, 'acct-A');
  assert.ok(stored);
  assert.equal(Object.isFrozen(stored.snapshot), true);
  assert.throws(() => { (stored.snapshot as { name: string }).name = 'changed'; }, TypeError);
  const mutable = datasetSnapshot();
  const saved = store.putDataset('acct-A', { id: 'ds-new', version: 'v1' }, mutable);
  mutable.rowIds.push('R4');
  assert.deepEqual(saved.snapshot.rowIds, ['R1', 'R2', 'R3']);

  assert.equal(store.getScenario(SCENARIO, 'acct-B'), undefined);
  assert.equal(store.getScenario(SCENARIO, undefined), undefined);
  assert.equal(store.getDataset(DATASET, 'acct-B'), undefined);
  assert.equal(store.getRule(RULE, undefined), undefined);
  assert.equal(store.getTask(TASK, 'acct-B'), undefined);
  assert.equal(store.listScenarios('acct-B').length, 0);
  assert.deepEqual(store.listDatasets('acct-A').map((row) => row.ref), [
    { id: 'ds-new', version: 'v1' }, DATASET,
  ]);
  assert.deepEqual(store.listTasks('acct-A').map((row) => row.ref), [TASK]);
  store.close();
});

test('同键同内容幂等；同键改内容或换归属被拒绝', (t) => {
  const dbPath = tempDbPath(t);
  const store = openSqliteResourceCatalog(dbPath, { now: NOW });
  const first = store.putScenario('acct-A', SCENARIO, scenarioSnapshot());
  const reorder = scenarioSnapshot();
  const reordered = {
    toolWhitelist: reorder.toolWhitelist,
    modelConfigRef: reorder.modelConfigRef,
    profile: reorder.profile,
    name: reorder.name,
  } as ScenarioConfigSnapshot;
  const again = store.putScenario('acct-A', { ...SCENARIO }, reordered);
  assert.equal(again.contentHash, first.contentHash);
  assert.equal(again.createdAt, first.createdAt);
  assert.equal(store.listScenarios('acct-A').length, 1);

  assert.throws(
    () => store.putScenario('acct-A', SCENARIO, { ...scenarioSnapshot(), profile: 'other' }),
    /内容不可变/,
  );
  assert.throws(
    () => store.putScenario('acct-B', SCENARIO, scenarioSnapshot()),
    /内容不可变/,
  );
  assert.equal(store.listScenarios('acct-B').length, 0);
  store.close();
});

test('任务绑定写入落盘：跨账号引用与失败校验不落任务行', (t) => {
  const dbPath = tempDbPath(t);
  const store = openSqliteResourceCatalog(dbPath, { now: NOW });
  seedCatalog(store);
  store.putScenario('acct-B', { id: 'sc-other', version: 'v1' }, scenarioSnapshot());

  const crossOwner = store.createTaskConfig('acct-A', TASK, binding({
    scenario: { id: 'sc-other', version: 'v1' },
  }));
  assert.equal(crossOwner.ok, false);
  if (!crossOwner.ok) assert.deepEqual(crossOwner.issues.map((i) => i.code), ['SCENARIO_NOT_FOUND']);
  const missing = store.createTaskConfig('acct-A', TASK, binding({
    dataset: { id: 'ds-missing', version: 'v1' },
  }));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.deepEqual(missing.issues.map((i) => i.code), ['DATASET_NOT_FOUND']);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM resource_versions WHERE resource_kind = 'task'").get()?.['n'], 0);

  assert.equal(store.createTaskConfig('acct-A', TASK, binding()).ok, true);
  assert.equal(store.createTaskConfig('acct-A', TASK, binding()).ok, true);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM resource_versions WHERE resource_kind = 'task'").get()?.['n'], 1);
  store.close();
});

test('重启后四类版本可读且运行绑定校验一致；版本漂移被拒绝', (t) => {
  const dbPath = tempDbPath(t);
  const first = openSqliteResourceCatalog(dbPath, { now: NOW });
  seedCatalog(first);
  assert.equal(first.createTaskConfig('acct-A', TASK, binding()).ok, true);
  first.close();

  const reopened = openSqliteResourceCatalog(dbPath, { now: NOW });
  assert.deepEqual(reopened.getScenario(SCENARIO, 'acct-A')?.snapshot, scenarioSnapshot());
  assert.deepEqual(reopened.getDataset(DATASET, 'acct-A')?.snapshot, datasetSnapshot());
  assert.deepEqual(reopened.getRule(RULE, 'acct-A')?.snapshot, processQualityRule);
  assert.deepEqual(reopened.getTask(TASK, 'acct-A')?.snapshot, binding());

  const valid = reopened.validateRunBindings('acct-A', TASK, {
    scenario: { ...SCENARIO }, dataset: { ...DATASET }, rule: { ...RULE },
  });
  assert.equal(valid.ok, true);

  const drifted = reopened.validateRunBindings('acct-A', TASK, {
    scenario: { ...SCENARIO }, dataset: { ...DATASET, version: 'v4' }, rule: { ...RULE },
  });
  assert.equal(drifted.ok, false);
  if (!drifted.ok) {
    assert.deepEqual(drifted.issues.map((i) => i.code), ['BINDING_MISMATCH']);
    assert.equal(drifted.issues[0]?.field, 'dataset');
  }
  const notOwner = reopened.validateRunBindings('acct-B', TASK, {
    scenario: { ...SCENARIO }, dataset: { ...DATASET }, rule: { ...RULE },
  });
  assert.equal(notOwner.ok, false);
  if (!notOwner.ok) assert.deepEqual(notOwner.issues.map((i) => i.code), ['TASK_NOT_FOUND']);
  reopened.close();
});

test('归属在 SQL 条件中限定：他人行不进入结果集', (t) => {
  const dbPath = tempDbPath(t);
  const store = openSqliteResourceCatalog(dbPath, { now: NOW });
  seedCatalog(store);
  store.putScenario('acct-B', { id: 'sc-private', version: 'v1' }, scenarioSnapshot());

  const visible = store.db.prepare(`
    SELECT id FROM resource_versions
    WHERE resource_kind = 'scenario' AND owner_account_id = ?
  `).all('acct-A') as { id: string }[];
  assert.deepEqual(visible.map((row) => row.id), ['sc-harness']);
  assert.equal(store.getScenario({ id: 'sc-private', version: 'v1' }, 'acct-A'), undefined);
  assert.deepEqual(store.listScenarios('acct-A').map((row) => row.ref.id), ['sc-harness']);
  store.close();
});

test('内存与 SQLite 两种目录的读取结果逐字段一致', (t) => {
  const dbPath = tempDbPath(t);
  const memory = new ResourceCatalog({ now: NOW });
  const sqlite = openSqliteResourceCatalog(dbPath, { now: NOW });
  for (const catalog of [memory, sqlite]) {
    catalog.putScenario('acct-A', SCENARIO, scenarioSnapshot());
    catalog.putDataset('acct-A', DATASET, datasetSnapshot());
    catalog.putRule('acct-A', RULE, processQualityRule);
    assert.equal(catalog.createTaskConfig('acct-A', TASK, binding()).ok, true);
  }

  for (const accountId of ['acct-A', 'acct-B', undefined]) {
    assert.equal(
      JSON.stringify(memory.getScenario(SCENARIO, accountId)),
      JSON.stringify(sqlite.getScenario(SCENARIO, accountId)),
    );
    assert.equal(
      JSON.stringify(memory.getDataset(DATASET, accountId)),
      JSON.stringify(sqlite.getDataset(DATASET, accountId)),
    );
    assert.equal(
      JSON.stringify(memory.getRule(RULE, accountId)),
      JSON.stringify(sqlite.getRule(RULE, accountId)),
    );
    assert.equal(
      JSON.stringify(memory.getTask(TASK, accountId)),
      JSON.stringify(sqlite.getTask(TASK, accountId)),
    );
    assert.equal(
      JSON.stringify(memory.listScenarios(accountId)),
      JSON.stringify(sqlite.listScenarios(accountId)),
    );
    assert.equal(
      JSON.stringify(memory.listTasks(accountId)),
      JSON.stringify(sqlite.listTasks(accountId)),
    );
  }
  const refs = { scenario: SCENARIO, dataset: DATASET, rule: RULE };
  assert.equal(
    JSON.stringify(memory.validateRunBindings('acct-A', TASK, refs)),
    JSON.stringify(sqlite.validateRunBindings('acct-A', TASK, refs)),
  );
  sqlite.close();
});

test('迁移 CLI 入口建库后重复执行仍幂等', (t) => {
  const dbPath = tempDbPath(t);
  const first = openDatabase(dbPath);
  assert.deepEqual(applyMigrations(first), [1, 2, 3, 4, 5, 6]);
  first.close();
  const second = openDatabase(dbPath);
  assert.deepEqual(applyMigrations(second), []);
  assert.equal(migrationVersion(second), 6);
  second.close();
});

test('归档状态落盘：关库重开后仍生效、重放幂等且按账号隔离', (t) => {
  const dbPath = tempDbPath(t);
  const first = openSqliteResourceCatalog(dbPath, { now: NOW });
  seedCatalog(first);
  const archived = first.archiveResource('dataset', DATASET, 'acct-A');
  assert.equal(archived.ok, true);
  if (archived.ok) assert.equal(archived.replayed, false);
  first.close();

  const reopened = openSqliteResourceCatalog(dbPath, { now: NOW });
  const again = reopened.archiveResource('dataset', { ...DATASET }, 'acct-A');
  assert.equal(again.ok, true);
  if (again.ok && archived.ok) {
    assert.equal(again.replayed, true);
    assert.equal(again.value.archivedAt, archived.value.archivedAt);
  }
  assert.deepEqual(reopened.getArchive('dataset', DATASET, 'acct-A')?.ref, DATASET);
  assert.equal(reopened.getArchive('dataset', DATASET, 'acct-B'), undefined);
  assert.deepEqual(reopened.listArchived('dataset', 'acct-A').map((row) => row.ref), [DATASET]);
  assert.deepEqual(reopened.listArchived('dataset', 'acct-B'), []);
  assert.equal(reopened.getDataset(DATASET, 'acct-A')?.snapshot.name, '客服样本集');
  const rows = reopened.db.prepare(`
    SELECT resource_kind, id, version, owner_account_id, archived_at FROM archived_resources
  `).all() as { resource_kind: string; id: string; version: string; owner_account_id: string; archived_at: string }[];
  assert.deepEqual(rows.map((row) => ({ ...row })), [{
    resource_kind: 'dataset', id: DATASET.id, version: DATASET.version,
    owner_account_id: 'acct-A', archived_at: NOW(),
  }]);
  reopened.close();
});

test('SQLite 活跃引用拒绝归档；任务归档后释放引用并停止新运行', (t) => {
  const dbPath = tempDbPath(t);
  const first = openSqliteResourceCatalog(dbPath, { now: NOW });
  seedCatalog(first);
  assert.equal(first.createTaskConfig('acct-A', TASK, binding()).ok, true);
  const blocked = first.archiveResource('dataset', DATASET, 'acct-A');
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.deepEqual(blocked.issues.map((i) => i.code), ['ACTIVE_TASK_REFERENCE']);
    assert.deepEqual(blocked.references.map((row) => row.ref), [TASK]);
  }
  assert.equal(first.archiveResource('task', TASK, 'acct-A').ok, true);
  first.close();

  const reopened = openSqliteResourceCatalog(dbPath, { now: NOW });
  assert.equal(reopened.archiveResource('dataset', DATASET, 'acct-A').ok, true);
  assert.equal(reopened.archiveResource('rule', RULE, 'acct-A').ok, true);
  const newTask = reopened.createTaskConfig('acct-A', { id: 'task-new', version: 'v1' }, binding());
  assert.equal(newTask.ok, false);
  if (!newTask.ok) {
    assert.deepEqual(newTask.issues.map((i) => i.code), ['DATASET_ARCHIVED', 'RULE_ARCHIVED']);
  }
  const run = reopened.validateRunBindings('acct-A', TASK, {
    scenario: { ...SCENARIO }, dataset: { ...DATASET }, rule: { ...RULE },
  });
  assert.equal(run.ok, false);
  if (!run.ok) assert.deepEqual(run.issues.map((i) => i.code), ['TASK_ARCHIVED']);
  assert.deepEqual(reopened.getTask(TASK, 'acct-A')?.snapshot.dataset, DATASET);
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM resource_versions WHERE resource_kind = 'task'").get()?.['n'], 1);
  reopened.close();
});

test('内存与 SQLite 的归档结果逐字段一致', (t) => {
  const dbPath = tempDbPath(t);
  const memory = new ResourceCatalog({ now: NOW });
  const sqlite = openSqliteResourceCatalog(dbPath, { now: NOW });
  for (const catalog of [memory, sqlite]) {
    catalog.putScenario('acct-A', SCENARIO, scenarioSnapshot());
    catalog.putDataset('acct-A', DATASET, datasetSnapshot());
    catalog.putRule('acct-A', RULE, processQualityRule);
    assert.equal(catalog.createTaskConfig('acct-A', TASK, binding()).ok, true);
    assert.equal(catalog.archiveResource('task', TASK, 'acct-A').ok, true);
  }
  for (const catalog of [memory, sqlite]) {
    const archived = catalog.archiveResource('dataset', DATASET, 'acct-A');
    assert.equal(archived.ok, true);
    if (archived.ok) assert.equal(archived.replayed, false);
  }
  for (const accountId of ['acct-A', 'acct-B', undefined]) {
    assert.equal(
      JSON.stringify(memory.getArchive('dataset', DATASET, accountId)),
      JSON.stringify(sqlite.getArchive('dataset', DATASET, accountId)),
    );
    assert.equal(
      JSON.stringify(memory.listArchived('dataset', accountId)),
      JSON.stringify(sqlite.listArchived('dataset', accountId)),
    );
    assert.equal(
      JSON.stringify(memory.listReferencingTasks('dataset', DATASET, accountId)),
      JSON.stringify(sqlite.listReferencingTasks('dataset', DATASET, accountId)),
    );
  }
  sqlite.close();
});
