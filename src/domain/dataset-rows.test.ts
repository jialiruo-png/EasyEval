/**
 * 数据集导入行内容持久化领域契约单元测试：
 *   node --test src/domain/dataset-rows.test.ts
 * 纯逻辑测试，仅用 Node 22 内置能力；不启动 Docker、不访问上游、不调用模型、不安装依赖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDatasetCsv, type DatasetImport } from './imports.ts';
import { ResourceCatalog } from './resources.ts';
import {
  InMemoryDatasetRowStore,
  datasetRowsHash,
  importDataset,
  type DatasetRowSet,
} from './dataset-rows.ts';

const REF = { id: 'ds-imported', version: 'v1' } as const;
const NOW = () => '2026-11-24T12:00:00+08:00';

function imported(text = 'query,answer\n你好吗,我很好\n退货流程,见帮助中心\n'): DatasetImport {
  const result = parseDatasetCsv(text, { name: '客服样本', queryColumn: 'query' });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('fixture 解析失败');
  return result.value;
}

function unwrap(value: DatasetRowSet | undefined): DatasetRowSet {
  assert.ok(value);
  return value as DatasetRowSet;
}

test('行集合哈希覆盖校验值与单元格：改内容或改校验值都变化', () => {
  const data = imported();
  const hash = datasetRowsHash(data.contentChecksum, data.rows);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, datasetRowsHash(data.contentChecksum, data.rows));
  const changed = [
    { rowId: data.rows[0]!.rowId, cells: { ...data.rows[0]!.cells, answer: '变了' } },
    ...data.rows.slice(1),
  ];
  assert.notEqual(hash, datasetRowsHash(data.contentChecksum, changed));
  assert.notEqual(hash, datasetRowsHash('other-checksum', data.rows));
});

test('行集合写入与读取：按账号限定、深冻结、行顺序与单元格原样保留', () => {
  const store = new InMemoryDatasetRowStore();
  const data = imported();
  const set = store.put('acct-A', REF, data.contentChecksum, data.rows, NOW);
  assert.equal(set.ownerAccountId, 'acct-A');
  assert.equal(set.contentChecksum, data.contentChecksum);
  assert.equal(set.createdAt, NOW());
  assert.deepEqual(set.ref, REF);
  assert.deepEqual(set.rows.map((row) => row.cells.query), ['你好吗', '退货流程']);

  const loaded = unwrap(store.get(REF, 'acct-A'));
  assert.deepEqual(loaded, set);
  assert.equal(Object.isFrozen(loaded.rows), true);
  assert.equal(Object.isFrozen(loaded.rows[0]!.cells), true);
  assert.throws(() => { (loaded.rows[0]!.cells as Record<string, string>).query = '改写'; }, TypeError);

  assert.equal(store.get(REF, 'acct-B'), undefined);
  assert.equal(store.get(REF, undefined), undefined);
  assert.equal(store.get({ id: REF.id, version: 'v9' }, 'acct-A'), undefined);
  assert.deepEqual(store.list('acct-A').map((row) => row.ref), [REF]);
  assert.deepEqual(store.list('acct-B'), []);
});

test('行集合幂等与不可变：同键同内容重放返回原行，改内容或换归属被拒绝', () => {
  const store = new InMemoryDatasetRowStore();
  const data = imported();
  const first = store.put('acct-A', REF, data.contentChecksum, data.rows, NOW);
  const again = store.put(
    'acct-A', { ...REF }, data.contentChecksum, structuredClone(data.rows), NOW,
  );
  assert.deepEqual(again, first);
  assert.equal(again.createdAt, first.createdAt);
  assert.equal(store.list('acct-A').length, 1);

  const edited = [{ rowId: data.rows[0]!.rowId, cells: { query: '你好吗', answer: '改写' } }, data.rows[1]!];
  assert.throws(
    () => store.put('acct-A', REF, data.contentChecksum, edited, NOW),
    /行内容已存在且不可变/,
  );
  assert.throws(
    () => store.put('acct-B', REF, data.contentChecksum, data.rows, NOW),
    /行内容已存在且不可变/,
  );
  assert.deepEqual(store.get(REF, 'acct-A'), first);
  assert.equal(store.get(REF, 'acct-B'), undefined);
});

test('非法行集合被拒绝：空行 ID、重复行 ID、非对象单元格、非文本值', () => {
  const store = new InMemoryDatasetRowStore();
  const checksum = 'abc';
  assert.throws(
    () => store.put('acct-A', REF, checksum, null as unknown as [], NOW),
    /行集合必须是数组/,
  );
  assert.throws(() => store.put('acct-A', REF, checksum, [{ rowId: '', cells: {} }], NOW), /rowId/);
  assert.throws(() => store.put('acct-A', REF, checksum, [
    { rowId: 'R1', cells: {} }, { rowId: 'R1', cells: {} },
  ], NOW), /行 ID 重复/);
  assert.throws(() => store.put('acct-A', REF, checksum, [
    { rowId: 'R1', cells: null as unknown as Record<string, string> },
  ], NOW), /cells 必须是对象/);
  assert.throws(() => store.put('acct-A', REF, checksum, [
    { rowId: 'R1', cells: { query: 1 as unknown as string } },
  ], NOW), /必须是文本/);
  assert.deepEqual(store.list('acct-A'), []);
});

test('importDataset：一次导入同时写元信息与行，按账号隔离且重放幂等', () => {
  const catalog = new ResourceCatalog(NOW);
  const store = new InMemoryDatasetRowStore();
  const data = imported();
  const result = importDataset(catalog, store, 'acct-A', REF, data, NOW);

  assert.equal(result.replayed, false);
  assert.equal(result.record.snapshot.contentChecksum, data.contentChecksum);
  assert.deepEqual(result.rowSet.rows.map((row) => row.cells.query), ['你好吗', '退货流程']);
  assert.equal(catalog.getDataset(REF, 'acct-A')?.snapshot.rowCount, 2);
  assert.equal(catalog.getDataset(REF, 'acct-B'), undefined);
  assert.equal(store.get(REF, 'acct-A')?.contentChecksum, data.contentChecksum);
  assert.equal(store.get(REF, 'acct-B'), undefined);

  const replay = importDataset(catalog, store, 'acct-A', { ...REF }, imported(), NOW);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.rowSet, result.rowSet);
  assert.equal(store.list('acct-A').length, 1);
});

test('importDataset 拒绝元数据与行脱钩：校验值不符、行 ID／行数不符、任一侧内容漂移', () => {
  const data = imported();
  // 校验值不符
  assert.throws(() => importDataset(
    new ResourceCatalog(NOW), new InMemoryDatasetRowStore(), 'acct-A', REF,
    { ...data, contentChecksum: 'tampered' }, NOW,
  ), /校验值不一致/);
  // 行数不符
  assert.throws(() => importDataset(
    new ResourceCatalog(NOW), new InMemoryDatasetRowStore(), 'acct-A', REF,
    { ...data, snapshot: { ...data.snapshot, rowCount: 99 } }, NOW,
  ), /行数不一致/);
  // 行 ID 不符
  assert.throws(() => importDataset(
    new ResourceCatalog(NOW), new InMemoryDatasetRowStore(), 'acct-A', REF,
    { ...data, snapshot: { ...data.snapshot, rowIds: ['X000001', 'X000002'] } }, NOW,
  ), /行 ID 不一致/);

  // 快照已存在但内容漂移：版本目录拒绝前即报错
  const catalog = new ResourceCatalog(NOW);
  const store = new InMemoryDatasetRowStore();
  importDataset(catalog, store, 'acct-A', REF, data, NOW);
  const drifted = imported('query,answer\n你好吗,改写答案\n退货流程,见帮助中心\n');
  assert.throws(() => importDataset(catalog, store, 'acct-A', REF, drifted, NOW), /内容不可变/);

  // 行内容已漂移：行存储拒绝前即报错
  const poisoned = new InMemoryDatasetRowStore();
  poisoned.put('acct-A', REF, data.contentChecksum, [
    { rowId: data.rows[0]!.rowId, cells: { ...data.rows[0]!.cells, answer: '漂移' } },
    data.rows[1]!,
  ], NOW);
  assert.throws(() => importDataset(new ResourceCatalog(NOW), poisoned, 'acct-A', REF, data, NOW), /行内容已存在且不可变/);
  // 两种篡改都不产生额外版本
  assert.equal(catalog.listDatasets('acct-A').length, 1);
  assert.equal(store.list('acct-A').length, 1);
});
