/**
 * 数据集导入行内容落盘单元测试：
 *   node --test src/storage/sqlite-dataset-rows.test.ts
 * 仅使用临时目录中的本机 SQLite 文件与 Node 22 内置能力，
 * 不启动 Docker、不安装依赖、不访问上游或模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDatasetCsv, type DatasetImport } from '../domain/imports.ts';
import { ResourceCatalog } from '../domain/resources.ts';
import {
  InMemoryDatasetRowStore,
  importDataset,
  type DatasetRowSet,
} from '../domain/dataset-rows.ts';
import { applyMigrations, migrationVersion, openDatabase } from './migrations.ts';
import { openSqliteResourceCatalog } from './sqlite-resource-store.ts';
import { openSqliteDatasetRowStore, SqliteDatasetRowStore } from './sqlite-dataset-rows.ts';

const REF = { id: 'ds-imported', version: 'v1' } as const;
const NOW = () => '2026-11-24T12:00:00+08:00';

function tempDbPath(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'eval-import-rows-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'eval.sqlite');
}

function imported(): DatasetImport {
  const result = parseDatasetCsv(
    'query,answer,source\n你好吗,我很好,faq\n"多行,查询","他说""你好""",policy\n',
    { name: '客服样本', queryColumn: 'query' },
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('fixture 解析失败');
  return result.value;
}

function unwrap(value: DatasetRowSet | undefined): DatasetRowSet {
  assert.ok(value);
  return value as DatasetRowSet;
}

test('迁移版本 6（含行集合表）：头表与单元格表的结构、约束和索引可用，重复执行幂等', (t) => {
  const dbPath = tempDbPath(t);
  const db = openDatabase(dbPath);
  assert.deepEqual(applyMigrations(db), [1, 2, 3, 4, 5, 6]);
  assert.equal(migrationVersion(db), 6);
  assert.deepEqual(applyMigrations(db), []);

  const headerCols = db.prepare('PRAGMA table_info(dataset_row_sets)').all() as { name: string }[];
  assert.deepEqual(headerCols.map((row) => row.name), [
    'dataset_id', 'dataset_version', 'owner_account_id',
    'content_checksum', 'row_count', 'created_at',
  ]);
  const cellCols = db.prepare('PRAGMA table_info(dataset_rows)').all() as { name: string }[];
  assert.deepEqual(cellCols.map((row) => row.name), [
    'dataset_id', 'dataset_version', 'ordinal', 'row_id', 'cells_json',
  ]);
  // 悬空行被外键拒绝：无行集合头时不能插入单元格。
  assert.throws(() => db.prepare(`
    INSERT INTO dataset_rows (dataset_id, dataset_version, ordinal, row_id, cells_json)
    VALUES ('orphan', 'v1', 0, 'R000001', '{}')
  `).run(), /FOREIGN KEY constraint failed/);
  db.close();
});

test('一次导入写入元信息与行：关库重开后单元格逐字段一致、行顺序稳定', (t) => {
  const dbPath = tempDbPath(t);
  const data = imported();
  const firstCatalog = openSqliteResourceCatalog(dbPath, { now: NOW });
  const firstStore = openSqliteDatasetRowStore(dbPath);
  const result = importDataset(firstCatalog, firstStore, 'acct-A', REF, data, NOW);
  assert.equal(result.replayed, false);
  firstCatalog.close();
  firstStore.db.close();

  const catalog = openSqliteResourceCatalog(dbPath, { now: NOW });
  const store = openSqliteDatasetRowStore(dbPath);
  const snapshot = catalog.getDataset(REF, 'acct-A');
  assert.equal(snapshot?.snapshot.contentChecksum, data.contentChecksum);

  const set = unwrap(store.get(REF, 'acct-A'));
  assert.equal(set.contentChecksum, data.contentChecksum);
  assert.equal(set.createdAt, NOW());
  assert.deepEqual(set.rows.map((row) => row.rowId), data.snapshot.rowIds);
  assert.deepEqual(set.rows.map((row) => row.cells.query), ['你好吗', '多行,查询']);
  assert.equal(set.rows[1]!.cells.answer, '他说"你好"');
  assert.equal(Object.isFrozen(set.rows), true);
  assert.equal(Object.isFrozen(set.rows[1]!.cells), true);
  assert.throws(() => { (set.rows[0]!.cells as Record<string, string>).query = '改写'; }, TypeError);

  catalog.close();
  store.db.close();
});

test('归属在 SQL 条件中限定：越权与不存在统一查不到，重复导入幂等且冲突拒绝', (t) => {
  const dbPath = tempDbPath(t);
  const store: SqliteDatasetRowStore = openSqliteDatasetRowStore(dbPath);
  const data = imported();
  const first = store.put('acct-A', REF, data.contentChecksum, data.rows, NOW);

  assert.equal(store.get(REF, 'acct-B'), undefined);
  assert.equal(store.get(REF, undefined), undefined);
  assert.equal(store.get({ ...REF, version: 'v9' }, 'acct-A'), undefined);
  assert.deepEqual(store.list('acct-B'), []);
  assert.deepEqual(store.list('acct-A').map((row) => row.ref), [REF]);

  const replay = store.put('acct-A', { ...REF }, data.contentChecksum, structuredClone(data.rows), NOW);
  assert.deepEqual(replay, first);
  assert.equal(replay.createdAt, first.createdAt);
  const rows = store.db.prepare('SELECT COUNT(*) AS n FROM dataset_rows').get() as { n: number };
  assert.equal(rows.n, data.rows.length);

  const edited = [
    { rowId: data.rows[0]!.rowId, cells: { ...data.rows[0]!.cells, answer: '改写' } },
    data.rows[1]!,
  ];
  assert.throws(() => store.put('acct-A', REF, data.contentChecksum, edited, NOW), /内容已存在且不可变/);
  assert.throws(() => store.put('acct-B', REF, data.contentChecksum, data.rows, NOW), /内容已存在且不可变/);
  const after = unwrap(store.get(REF, 'acct-A'));
  assert.deepEqual(after, first);

  // SQL 层直接核对归属条件确实过滤掉他人：库里只有 acct-A 的行集合。
  const leaked = store.db.prepare(
    'SELECT dataset_id FROM dataset_row_sets WHERE owner_account_id = ?',
  ).all('acct-B') as { dataset_id: string }[];
  assert.deepEqual(leaked, []);
  store.db.close();
});

test('内存与 SQLite 两种行存储读取结果逐字段一致', (t) => {
  const dbPath = tempDbPath(t);
  const data = imported();
  const memoryCatalog = new ResourceCatalog(NOW);
  const memoryRows = new InMemoryDatasetRowStore();
  const sqliteCatalog = openSqliteResourceCatalog(dbPath, { now: NOW });
  const sqliteRows = openSqliteDatasetRowStore(dbPath);
  importDataset(memoryCatalog, memoryRows, 'acct-A', REF, data, NOW);
  importDataset(sqliteCatalog, sqliteRows, 'acct-A', REF, data, NOW);

  for (const accountId of ['acct-A', 'acct-B', undefined]) {
    assert.equal(
      JSON.stringify(memoryRows.get(REF, accountId)),
      JSON.stringify(sqliteRows.get(REF, accountId)),
    );
    assert.equal(
      JSON.stringify(memoryRows.list(accountId)),
      JSON.stringify(sqliteRows.list(accountId)),
    );
  }
  const replay = imported();
  importDataset(memoryCatalog, memoryRows, 'acct-A', { id: 'ds-2', version: 'v1' }, replay, NOW);
  importDataset(sqliteCatalog, sqliteRows, 'acct-A', { id: 'ds-2', version: 'v1' }, replay, NOW);
  assert.equal(
    JSON.stringify(memoryRows.get({ id: 'ds-2', version: 'v1' }, 'acct-A')),
    JSON.stringify(sqliteRows.get({ id: 'ds-2', version: 'v1' }, 'acct-A')),
  );

  sqliteCatalog.close();
  sqliteRows.db.close();
});

test('importDataset 拒绝脱钩：任一侧漂移都不产生半成品', (t) => {
  const dbPath = tempDbPath(t);
  const data = imported();
  const catalog = openSqliteResourceCatalog(dbPath, { now: NOW });
  const store = openSqliteDatasetRowStore(dbPath);
  importDataset(catalog, store, 'acct-A', REF, data, NOW);

  const drifted = parseDatasetCsv(
    'query,answer,source\n你好吗,改写答案,faq\n"多行,查询","他说""你好""",policy\n',
    { name: '客服样本', queryColumn: 'query' },
  );
  assert.equal(drifted.ok, true);
  if (drifted.ok) {
    assert.throws(() => importDataset(catalog, store, 'acct-A', REF, drifted.value, NOW), /内容不可变/);
  }
  assert.equal(catalog.listDatasets('acct-A').length, 1);
  assert.equal(store.list('acct-A').length, 1);
  catalog.close();
  store.db.close();
});

test('导入事务在版本写入失败时撤销样本行，同文件的两个连接可以安全重试', (t) => {
  const path = tempDbPath(t);
  const catalog = openSqliteResourceCatalog(path, { now: NOW });
  const rows = openSqliteDatasetRowStore(path);
  t.after(() => { catalog.close(); rows.db.close(); });
  catalog.db.exec(`CREATE TEMP TRIGGER fail_version BEFORE INSERT ON resource_versions
    BEGIN SELECT RAISE(ABORT, '模拟元信息写入失败'); END`);
  assert.throws(() => importDataset(catalog, rows, 'acct-A', REF, imported(), NOW), /模拟元信息写入失败/);
  assert.equal(catalog.getDataset(REF, 'acct-A'), undefined);
  assert.equal(rows.get(REF, 'acct-A'), undefined);
  catalog.db.exec('DROP TRIGGER fail_version');
  assert.equal(importDataset(catalog, rows, 'acct-A', REF, imported(), NOW).replayed, false);
  assert.equal(importDataset(catalog, rows, 'acct-A', REF, imported(), NOW).replayed, true);
});
