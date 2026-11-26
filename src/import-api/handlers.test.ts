/**
 * 数据集导入 handler 单元测试：
 *   node --test src/import-api/handlers.test.ts
 * 覆盖账号来源、原子写入、幂等、冲突、解析 issues 与行读取归属。
 * 仅用 Node 22 内置能力，不读文件、不起 HTTP、不访问上游或模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ResourceCatalog } from '../domain/resources.ts';
import { InMemoryDatasetRowStore } from '../domain/dataset-rows.ts';
import {
  getImportedDatasetRows,
  importDatasetFromCsv,
  importDatasetFromXlsx,
  inspectDatasetXlsxSheets,
  type DatasetImportInput,
  type DatasetXlsxImportInput,
  type ImportError,
  type ImportResponse,
  type XlsxInspectionInput,
} from './handlers.ts';
import { buildXlsxBytes, sampleSheetXml, sampleXlsxBase64 } from './xlsx-test-fixture.ts';

const REF = { id: 'ds-import', version: 'v1' } as const;
const CSV = 'query,answer\n你好吗,我很好\n"多行,查询","他说""你好"""\n';
const NOW = () => '2026-11-24T18:00:00+08:00';

function input(overrides: Partial<DatasetImportInput> = {}): DatasetImportInput {
  return {
    id: REF.id,
    version: REF.version,
    name: '客服样本',
    queryColumn: 'query',
    csv: CSV,
    ...overrides,
  };
}

function setup(): { catalog: ResourceCatalog; rowStore: InMemoryDatasetRowStore } {
  return { catalog: new ResourceCatalog(NOW), rowStore: new InMemoryDatasetRowStore() };
}

function unwrap<T>(response: ImportResponse<T>): T {
  assert.equal(response.ok, true, response.ok ? '' : response.message);
  if (!response.ok) throw new Error('unreachable');
  return response.data;
}

function errorOf<T>(response: ImportResponse<T>): ImportError {
  assert.equal(response.ok, false);
  if (response.ok) throw new Error('unreachable');
  return response;
}

test('一次导入同时写入快照与行，归属取自会话且自称归属被忽略', () => {
  const { catalog, rowStore } = setup();
  const response = importDatasetFromCsv(catalog, rowStore, { accountId: 'acct-A' }, input({
    ownerAccountId: 'acct-B',
  }), NOW);
  assert.equal(response.ok, true);
  const data = unwrap(response);
  assert.equal(response.httpStatus, 201);
  assert.equal(data.id, REF.id);
  assert.equal(data.name, '客服样本');
  assert.equal(data.ownerAccountId, 'acct-A');
  assert.equal(data.rowCount, 2);
  assert.equal(data.source, 'csv');
  assert.equal(data.snapshot.queryColumn, 'query');
  assert.equal(data.contentChecksum.length, 64);
  assert.ok(catalog.getDataset(REF, 'acct-A'));
  assert.equal(catalog.getDataset(REF, 'acct-B'), undefined);
  assert.equal(rowStore.get(REF, 'acct-B'), undefined);
});

test('同一内容重放幂等 200 且逐字段一致，重复写入不改变行', () => {
  const { catalog, rowStore } = setup();
  const first = importDatasetFromCsv(catalog, rowStore, { accountId: 'acct-A' }, input(), NOW);
  const replay = importDatasetFromCsv(catalog, rowStore, { accountId: 'acct-A' }, input(), NOW);
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (!first.ok || !replay.ok) return;
  assert.equal(replay.httpStatus, 200);
  assert.equal(replay.replayed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(replay.data)), JSON.parse(JSON.stringify(first.data)));
  assert.equal(rowStore.get(REF, 'acct-A')?.rows.length, 2);
});

test('解析错误返回 422 与可定位 issues，且不产生任何写入', () => {
  const { catalog, rowStore } = setup();
  const response = importDatasetFromCsv(catalog, rowStore, { accountId: 'acct-A' }, input({
    csv: 'query,answer\n,空查询\n',
  }), NOW);
  const error = errorOf(response);
  assert.equal(error.httpStatus, 422);
  assert.equal(error.code, 'IMPORT_INVALID');
  assert.ok(error.issues?.some((issue) => issue.code === 'QUERY_VALUE_EMPTY' && issue.field === 'query' && issue.row === 1));
  assert.equal(catalog.listDatasets('acct-A').length, 0);
  assert.equal(rowStore.list('acct-A').length, 0);
});

test('公式单元格与超限行数被拒绝，limits 非法值返回 400', () => {
  const { catalog, rowStore } = setup();
  const formula = errorOf(importDatasetFromCsv(catalog, rowStore, { accountId: 'acct-A' }, input({
    csv: 'query,answer\n你好,=SUM(1,2)\n',
  }), NOW));
  assert.ok(formula.issues?.some((issue) => issue.code === 'FORMULA_CELL' && issue.row === 1));
  const tooMany = errorOf(importDatasetFromCsv(catalog, rowStore, { accountId: 'acct-A' }, input({
    limits: { maxRows: 1 },
  }), NOW));
  assert.ok(tooMany.issues?.some((issue) => issue.code === 'TOO_MANY_ROWS'));
  const badLimit = errorOf(importDatasetFromCsv(catalog, rowStore, { accountId: 'acct-A' }, input({
    limits: { maxRows: 0 },
  }), NOW));
  assert.equal(badLimit.httpStatus, 400);
  assert.match(badLimit.message, /limits\.maxRows/);
  assert.equal(catalog.listDatasets('acct-A').length, 0);
});

test('同一版本改内容返回 409 并保留原始快照与行', () => {
  const { catalog, rowStore } = setup();
  const first = unwrap(importDatasetFromCsv(catalog, rowStore, { accountId: 'acct-A' }, input(), NOW));
  const conflict = errorOf(importDatasetFromCsv(catalog, rowStore, { accountId: 'acct-A' }, input({
    name: '改名后的样本',
  }), NOW));
  assert.equal(conflict.httpStatus, 409);
  assert.equal(conflict.code, 'VERSION_CONFLICT');
  assert.equal(catalog.getDataset(REF, 'acct-A')?.snapshot.name, first.name);
  assert.equal(rowStore.get(REF, 'acct-A')?.rows[1]?.cells.answer, '他说"你好"');
  const other = errorOf(importDatasetFromCsv(catalog, rowStore, { accountId: 'acct-B' }, input(), NOW));
  assert.equal(other.httpStatus, 409);
  assert.equal(catalog.listDatasets('acct-B').length, 0);
});

test('未登录与形状错误返回 400/401，不触碰目录', () => {
  const { catalog, rowStore } = setup();
  assert.equal(errorOf(importDatasetFromCsv(catalog, rowStore, {}, input(), NOW)).code, 'UNAUTHORIZED');
  assert.equal(errorOf(importDatasetFromCsv(catalog, rowStore, { accountId: 'acct-A' }, input({
    id: '',
  }), NOW)).httpStatus, 400);
  assert.equal(errorOf(importDatasetFromCsv(catalog, rowStore, { accountId: 'acct-A' }, input({
    csv: 123,
  }), NOW)).httpStatus, 400);
  assert.equal(errorOf(importDatasetFromCsv(catalog, rowStore, { accountId: 'acct-A' }, input({
    source: 'unknown',
  }), NOW)).httpStatus, 400);
  assert.equal(catalog.listDatasets('acct-A').length, 0);
  assert.equal(rowStore.list('acct-A').length, 0);
});

function xlsxInput(overrides: Partial<DatasetXlsxImportInput> = {}): DatasetXlsxImportInput {
  return {
    id: REF.id,
    version: REF.version,
    name: '客服样本',
    queryColumn: 'query',
    xlsxBase64: sampleXlsxBase64(),
    ...overrides,
  };
}

test('Excel 导入一次写入快照与行，来源为 excel，归属取自会话且自报归属被忽略', () => {
  const { catalog, rowStore } = setup();
  const response = importDatasetFromXlsx(catalog, rowStore, { accountId: 'acct-A' }, xlsxInput({
    ownerAccountId: 'acct-B',
  }), NOW);
  const data = unwrap(response);
  assert.equal(response.httpStatus, 201);
  assert.equal(data.source, 'excel');
  assert.equal(data.rowCount, 2);
  assert.equal(data.ownerAccountId, 'acct-A');
  assert.equal(data.id, REF.id);
  assert.equal(catalog.getDataset(REF, 'acct-A')?.snapshot.source, 'excel');
  assert.equal(catalog.getDataset(REF, 'acct-B'), undefined);
  const rows = unwrap(getImportedDatasetRows(rowStore, { accountId: 'acct-A' }, REF));
  assert.deepEqual(rows.rows.map((row) => row.cells.query), ['你好吗', '退货流程']);
  assert.equal(rows.rows[0]?.cells.answer, '我很好');
});

test('Excel 同内容重放幂等 200，显式选表按名称或序号取不同工作表', () => {
  const { catalog, rowStore } = setup();
  const first = importDatasetFromXlsx(catalog, rowStore, { accountId: 'acct-A' }, xlsxInput(), NOW);
  const replay = importDatasetFromXlsx(catalog, rowStore, { accountId: 'acct-A' }, xlsxInput(), NOW);
  assert.equal(first.ok, true);
  assert.equal(replay.httpStatus, 200);
  assert.equal(replay.replayed, true);
  if (!first.ok || !replay.ok) return;
  assert.deepEqual(JSON.parse(JSON.stringify(replay.data)), JSON.parse(JSON.stringify(first.data)));

  const second = { name: '备份', xml: `<row r="1">${'<c r="A1" t="inlineStr"><is><t xml:space="preserve">query</t></is></c>'}</row><row r="2">${'<c r="A2" t="inlineStr"><is><t xml:space="preserve">备份行</t></is></c>'}</row>` };
  const bytes = buildXlsxBytes([
    { name: '样本', xml: sampleSheetXml() },
    second,
  ]);
  const byName = importDatasetFromXlsx(catalog, rowStore, { accountId: 'acct-A' }, xlsxInput({
    id: 'ds-sheet-name', sheet: '备份', xlsxBase64: Buffer.from(bytes).toString('base64'),
  }), NOW);
  const byIndex = importDatasetFromXlsx(catalog, rowStore, { accountId: 'acct-A' }, xlsxInput({
    id: 'ds-sheet-index', sheet: 2, xlsxBase64: Buffer.from(bytes).toString('base64'),
  }), NOW);
  assert.equal(byName.ok, true);
  assert.equal(byIndex.ok, true);
  if (!byName.ok || !byIndex.ok) return;
  assert.equal(byName.data.rowCount, 1);
  assert.equal(byName.data.contentChecksum, byIndex.data.contentChecksum);
  const rows = unwrap(getImportedDatasetRows(rowStore, { accountId: 'acct-A' }, { id: 'ds-sheet-name', version: REF.version }));
  assert.equal(rows.rows[0]?.cells.query, '备份行');
});

test('Excel 公式单元格与缺列返回 422 且不写入，非法 xlsx/base64/sheet 返回 400', () => {
  const { catalog, rowStore } = setup();
  const formulaXml = sampleSheetXml().replace(
    inlineAnswer('我很好'),
    '<c r="B2" t="str"><f>1+1</f><v>我很好</v></c>',
  );
  const formula = errorOf(importDatasetFromXlsx(catalog, rowStore, { accountId: 'acct-A' }, xlsxInput({
    xlsxBase64: Buffer.from(buildXlsxBytes([{ name: '样本', xml: formulaXml }])).toString('base64'),
  }), NOW));
  assert.equal(formula.httpStatus, 422);
  assert.ok(formula.issues?.some((issue) => issue.code === 'FORMULA_CELL'));

  const missing = errorOf(importDatasetFromXlsx(catalog, rowStore, { accountId: 'acct-A' }, xlsxInput({
    xlsxBase64: Buffer.from(buildXlsxBytes([{ name: '样本', xml:
      '<row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">query</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve">你好</t></is></c></row>' }])).toString('base64'),
    queryColumn: 'answer',
  }), NOW));
  assert.equal(missing.httpStatus, 422);
  assert.ok(missing.issues?.some((issue) => issue.code === 'MISSING_COLUMN' || issue.code === 'QUERY_COLUMN_MISSING'));

  assert.equal(errorOf(importDatasetFromXlsx(catalog, rowStore, { accountId: 'acct-A' }, xlsxInput({
    xlsxBase64: '好%base64',
  }), NOW)).httpStatus, 400);
  assert.equal(errorOf(importDatasetFromXlsx(catalog, rowStore, { accountId: 'acct-A' }, xlsxInput({
    sheet: 0,
  }), NOW)).httpStatus, 400);
  assert.equal(errorOf(importDatasetFromXlsx(catalog, rowStore, { accountId: 'acct-A' }, xlsxInput({
    sheet: '',
  }), NOW)).httpStatus, 400);
  assert.equal(errorOf(importDatasetFromXlsx(catalog, rowStore, {}, xlsxInput(), NOW)).code, 'UNAUTHORIZED');
  assert.equal(catalog.listDatasets('acct-A').length, 0);
  assert.equal(rowStore.list('acct-A').length, 0);
});

test('Excel 同一版本改内容返回 409 且保留原数据', () => {
  const { catalog, rowStore } = setup();
  const first = unwrap(importDatasetFromXlsx(catalog, rowStore, { accountId: 'acct-A' }, xlsxInput(), NOW));
  const bytes = buildXlsxBytes([{ name: '样本', xml: sampleSheetXml('已修改') }]);
  const conflict = errorOf(importDatasetFromXlsx(catalog, rowStore, { accountId: 'acct-A' }, xlsxInput({
    xlsxBase64: Buffer.from(bytes).toString('base64'),
  }), NOW));
  assert.equal(conflict.httpStatus, 409);
  assert.equal(conflict.code, 'VERSION_CONFLICT');
  assert.equal(catalog.getDataset(REF, 'acct-A')?.snapshot.contentChecksum, first.contentChecksum);
  const rows = unwrap(getImportedDatasetRows(rowStore, { accountId: 'acct-A' }, REF));
  assert.equal(rows.rows[0]?.cells.answer, '我很好');
});

function inlineAnswer(value: string): string {
  return `<c r="B2" t="inlineStr"><is><t xml:space="preserve">${value}</t></is></c>`;
}

test('行读取按账号限定，越权与不存在同为 404，快照深冻结', () => {
  const { catalog, rowStore } = setup();
  importDatasetFromCsv(catalog, rowStore, { accountId: 'acct-A' }, input(), NOW);
  const mine = unwrap(getImportedDatasetRows(rowStore, { accountId: 'acct-A' }, REF));
  assert.equal(mine.rowCount, 2);
  assert.equal(mine.rows[0]?.cells.query, '你好吗');
  assert.equal(mine.rows[1]?.cells.query, '多行,查询');
  assert.equal(mine.rows[1]?.cells.answer, '他说"你好"');
  assert.ok(Object.isFrozen(mine.rows));
  assert.throws(() => { mine.rows[0]!.rowId = '改写'; });
  const foreign = errorOf(getImportedDatasetRows(rowStore, { accountId: 'acct-B' }, REF));
  const missing = errorOf(getImportedDatasetRows(rowStore, { accountId: 'acct-A' }, { id: '不存在', version: 'v1' }));
  assert.equal(foreign.httpStatus, 404);
  assert.deepEqual({ code: foreign.code, message: foreign.message }, { code: missing.code, message: missing.message });
  assert.equal(errorOf(getImportedDatasetRows(rowStore, {}, REF)).code, 'UNAUTHORIZED');
});

function inspectionInput(overrides: Partial<XlsxInspectionInput> = {}): XlsxInspectionInput {
  return { xlsxBase64: sampleXlsxBase64(), ...overrides };
}

test('工作表候选按工作簿顺序返回全部表名，冻结且不写任何资源', () => {
  const { catalog, rowStore } = setup();
  const bytes = buildXlsxBytes([
    { name: '样本', xml: sampleSheetXml() },
    { name: '备份 & 归档', xml: '<row r="1"><c r="A1" t="inlineStr"><is><t>query</t></is></c><c r="B1" t="inlineStr"><is><t>answer</t></is></c></row>' },
  ]);
  const data = unwrap(inspectDatasetXlsxSheets(
    { accountId: 'acct-A' },
    inspectionInput({ xlsxBase64: Buffer.from(bytes).toString('base64'), ownerAccountId: 'acct-B' }),
  ));
  assert.deepEqual(data.sheets, ['样本', '备份 & 归档']);
  assert.ok(Object.isFrozen(data.sheets));
  assert.deepEqual(catalog.listDatasets('acct-A'), []);
  assert.deepEqual(catalog.listDatasets('acct-B'), []);
  assert.equal(catalog.getDataset(REF, 'acct-A'), undefined);
  assert.equal(rowStore.get(REF, 'acct-A'), undefined);
});

test('工作表候选的坏容器与非法输入分别返回 422 可定位 issues 与 400/401', () => {
  const broken = errorOf(inspectDatasetXlsxSheets(
    { accountId: 'acct-A' },
    inspectionInput({ xlsxBase64: Buffer.from('不是工作簿').toString('base64') }),
  ));
  assert.equal(broken.httpStatus, 422);
  assert.equal(broken.code, 'IMPORT_INVALID');
  assert.ok(broken.issues?.some((issue) => issue.code === 'NOT_ZIP' || issue.code === 'MALFORMED_ZIP'));
  assert.equal(errorOf(inspectDatasetXlsxSheets({ accountId: 'acct-A' }, inspectionInput({ xlsxBase64: 'bad%' }))).httpStatus, 400);
  assert.equal(errorOf(inspectDatasetXlsxSheets({ accountId: 'acct-A' }, [] as unknown as XlsxInspectionInput)).code, 'INVALID_INPUT');
  assert.equal(errorOf(inspectDatasetXlsxSheets({}, inspectionInput())).code, 'UNAUTHORIZED');
});

test('工作表候选复用导入上限，超限 422 且非法上限 400', () => {
  const tooSmall = errorOf(inspectDatasetXlsxSheets(
    { accountId: 'acct-A' },
    inspectionInput({ limits: { maxFileBytes: 8 } }),
  ));
  assert.equal(tooSmall.httpStatus, 422);
  assert.ok(tooSmall.issues?.some((issue) => issue.code === 'FILE_TOO_LARGE'));
  const invalid = errorOf(inspectDatasetXlsxSheets(
    { accountId: 'acct-A' },
    inspectionInput({ limits: { maxFileBytes: 0 } }),
  ));
  assert.equal(invalid.httpStatus, 400);
  const allowed = unwrap(inspectDatasetXlsxSheets(
    { accountId: 'acct-A' },
    inspectionInput({ limits: { maxFileBytes: 5 * 1024 * 1024, maxRows: 100, maxCellChars: 100 } }),
  ));
  assert.deepEqual(allowed.sheets, ['样本']);
});
