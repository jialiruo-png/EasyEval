/**
 * P2 CSV 导入快照领域契约单元测试：
 *   node --test src/domain/imports.test.ts
 * 纯逻辑测试，仅用 Node 22 内置能力；不启动 Docker、不访问上游、不调用模型、不安装依赖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDatasetCsv, DEFAULT_IMPORT_LIMITS, type ImportIssueCode } from './imports.ts';
import { ResourceCatalog } from './resources.ts';
import { processQualityRule } from '../result-contract/fixtures.ts';

const DATASET_REF = { id: 'ds-imported', version: 'v1' } as const;

function simpleCsv(): string {
  return 'query,answer,source\n你好吗,我很好,faq\n退货流程,见帮助中心,policy\n';
}

function codes(issues: { code: ImportIssueCode }[]): ImportIssueCode[] {
  return issues.map((item) => item.code);
}

test('正常导入：产出可直接写入版本目录的冻结快照与逐行文本', () => {
  const result = parseDatasetCsv(simpleCsv(), { name: '客服样本', queryColumn: 'query' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { snapshot, rows, contentChecksum } = result.value;
  assert.equal(snapshot.name, '客服样本');
  assert.equal(snapshot.source, 'csv');
  assert.deepEqual(snapshot.columns, ['query', 'answer', 'source']);
  assert.deepEqual(snapshot.rowIds, ['R000001', 'R000002']);
  assert.equal(snapshot.rowCount, 2);
  assert.equal(snapshot.queryColumn, 'query');
  assert.equal(snapshot.contentChecksum, contentChecksum);
  assert.match(contentChecksum, /^[0-9a-f]{64}$/);
  assert.deepEqual(rows.map((row) => row.cells.query), ['你好吗', '退货流程']);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(rows), true);
  assert.equal(Object.isFrozen(rows[0].cells), true);

  // 快照无需改动即可通过资源目录写入与校验。
  const catalog = new ResourceCatalog(() => '2026-11-24T10:00:00+08:00');
  const stored = catalog.putDataset('acct-A', DATASET_REF, snapshot);
  assert.equal(stored.snapshot.contentChecksum, contentChecksum);
  assert.equal(catalog.getDataset(DATASET_REF, 'acct-A')?.snapshot.rowCount, 2);
  assert.equal(catalog.getDataset(DATASET_REF, 'acct-B'), undefined);
});

test('同一内容重复解析得到相同校验值；改行序或单元格则校验值改变', () => {
  const first = parseDatasetCsv(simpleCsv(), { name: '客服样本', queryColumn: 'query' });
  const replay = parseDatasetCsv(simpleCsv(), { name: '客服样本', queryColumn: 'query' });
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (!first.ok || !replay.ok) return;
  assert.equal(first.value.contentChecksum, replay.value.contentChecksum);

  const reordered = parseDatasetCsv(
    'query,answer,source\n退货流程,见帮助中心,policy\n你好吗,我很好,faq\n',
    { name: '客服样本', queryColumn: 'query' },
  );
  const edited = parseDatasetCsv(simpleCsv().replace('我很好', '挺好的'), { name: '客服样本', queryColumn: 'query' });
  assert.equal(reordered.ok, true);
  assert.equal(edited.ok, true);
  if (!reordered.ok || !edited.ok) return;
  assert.notEqual(first.value.contentChecksum, reordered.value.contentChecksum);
  assert.notEqual(first.value.contentChecksum, edited.value.contentChecksum);
});

test('UTF-8 BOM 不污染首列表头；CRLF 与 LF 等价', () => {
  const withBom = `\uFEFFquery,answer\r\n一行,内容\r\n`;
  const withLf = 'query,answer\n一行,内容\n';
  const a = parseDatasetCsv(withBom, { name: 'BOM', queryColumn: 'query' });
  const b = parseDatasetCsv(withLf, { name: 'BOM', queryColumn: 'query' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.deepEqual(a.value.snapshot.columns, ['query', 'answer']);
  assert.equal(a.value.snapshot.rowCount, 1);
  assert.equal(a.value.contentChecksum, b.value.contentChecksum);
});

test('带引号字段、跨行字段与 "" 转义被正确还原为单行文本', () => {
  const text = 'query,answer\n"多行\n查询","他说""你好"""\n普通,值\n';
  const result = parseDatasetCsv(text, { name: '引号', queryColumn: 'query' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.snapshot.rowCount, 2);
  assert.equal(result.value.rows[0].cells.query, '多行\n查询');
  assert.equal(result.value.rows[0].cells.answer, '他说"你好"');
  assert.deepEqual(result.value.snapshot.rowIds, ['R000001', 'R000002']);
});

test('空文件、空表头、缺列与重复列分别给出可定位错误', () => {
  const empty = parseDatasetCsv('', { name: '空', queryColumn: 'query' });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.ok(codes(empty.issues).includes('EMPTY_FILE'));

  const noHeader = parseDatasetCsv(',,', { name: '空表头', queryColumn: 'query' });
  assert.equal(noHeader.ok, false);
  if (!noHeader.ok) assert.ok(codes(noHeader.issues).includes('MISSING_COLUMN'));

  const duplicate = parseDatasetCsv('query,answer,query\n一,二,三', { name: '重复', queryColumn: 'query' });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) {
    assert.ok(codes(duplicate.issues).includes('DUPLICATE_COLUMN'));
    assert.ok(duplicate.issues.some((item) => item.field === 'query'));
  }
});

test('查询列缺失或某行为空时拒绝且不产出快照', () => {
  const missing = parseDatasetCsv('answer\n内容', { name: '缺列', queryColumn: 'query' });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.ok(codes(missing.issues).includes('QUERY_COLUMN_MISSING'));

  const emptyValue = parseDatasetCsv('query,answer\n有值,内容\n ,空值', { name: '空值', queryColumn: 'query' });
  assert.equal(emptyValue.ok, false);
  if (!emptyValue.ok) {
    assert.ok(codes(emptyValue.issues).includes('QUERY_VALUE_EMPTY'));
    assert.ok(emptyValue.issues.some((item) => item.row === 2 && item.field === 'query'));
  }
});

test('行宽不一致与非文本控制字符按行号定位', () => {
  const mismatch = parseDatasetCsv('query,answer\n只有一列\n三列,内容,额外', { name: '行宽', queryColumn: 'query' });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) {
    assert.deepEqual(codes(mismatch.issues).filter((code) => code === 'ROW_WIDTH_MISMATCH'), ['ROW_WIDTH_MISMATCH', 'ROW_WIDTH_MISMATCH']);
    assert.ok(mismatch.issues.some((item) => item.row === 1 && item.field === 'row[1]'));
    assert.ok(mismatch.issues.some((item) => item.row === 2 && item.field === 'row[2]'));
  }

  const nonText = parseDatasetCsv('query,answer\n有值,坏\u0000值', { name: '非文本', queryColumn: 'query' });
  assert.equal(nonText.ok, false);
  if (!nonText.ok) {
    assert.ok(codes(nonText.issues).includes('NON_TEXT_CELL'));
    assert.ok(nonText.issues.some((item) => item.row === 1 && item.field === 'answer'));
  }
});

test('Excel 公式单元格被拒绝，纯负数与小数仍作为文本内容导入', () => {
  const formula = parseDatasetCsv('query,answer\n=1+1,内容\n@SUM(A1),其他', { name: '公式', queryColumn: 'query' });
  assert.equal(formula.ok, false);
  if (!formula.ok) {
    assert.deepEqual(codes(formula.issues).filter((code) => code === 'FORMULA_CELL').length, 2);
    assert.ok(formula.issues.some((item) => item.row === 1));
    assert.ok(formula.issues.some((item) => item.row === 2));
  }

  const numeric = parseDatasetCsv('query,answer\n-1,负号\n+0.5,小数', { name: '数值', queryColumn: 'query' });
  assert.equal(numeric.ok, true);
  if (numeric.ok) assert.deepEqual(numeric.value.rows.map((row) => row.cells.query), ['-1', '+0.5']);
});

test('文件、行数与单元格上限均可覆盖默认值并被强制执行', () => {
  const big = parseDatasetCsv('query\n一行\n二行', {
    name: '超限', queryColumn: 'query', limits: { maxFileBytes: 3, maxRows: 1, maxCellChars: 1 },
  });
  assert.equal(big.ok, false);
  if (!big.ok) {
    const found = codes(big.issues);
    assert.ok(found.includes('FILE_TOO_LARGE'));
    assert.ok(found.includes('TOO_MANY_ROWS'));
    assert.ok(found.includes('CELL_TOO_LARGE'));
  }
  assert.equal(DEFAULT_IMPORT_LIMITS.maxFileBytes > 0, true);
});

test('四种来源元数据进入快照，未知来源被拒绝', () => {
  for (const source of ['excel', 'csv', 'feishu', 'sql'] as const) {
    const result = parseDatasetCsv(simpleCsv(), { name: `来源-${source}`, queryColumn: 'query', source });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.snapshot.source, source);
  }
  const unknown = parseDatasetCsv(simpleCsv(), { name: '未知', queryColumn: 'query', source: 'other' as 'csv' });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.ok(codes(unknown.issues).includes('NON_TEXT_CELL'));
});

test('导入快照在版本目录中同键同内容幂等，改内容被拒绝', () => {
  const first = parseDatasetCsv(simpleCsv(), { name: '幂等', queryColumn: 'query' });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const catalog = new ResourceCatalog(() => '2026-11-24T10:00:00+08:00');
  const a = catalog.putDataset('acct-A', DATASET_REF, first.value.snapshot);
  const b = catalog.putDataset('acct-A', { ...DATASET_REF }, first.value.snapshot);
  assert.equal(a.contentHash, b.contentHash);
  assert.throws(
    () => catalog.putDataset('acct-A', DATASET_REF, { ...first.value.snapshot, name: '改名后的内容' }),
    /不可变/,
  );
});

test('规则版本与导入数据集同轴可用：结果契约不因导入快照改变口径', () => {
  const result = parseDatasetCsv(simpleCsv(), { name: '回归', queryColumn: 'query' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const catalog = new ResourceCatalog(() => '2026-11-24T10:00:00+08:00');
  const dataset = catalog.putDataset('acct-A', DATASET_REF, result.value.snapshot);
  const rule = catalog.putRule('acct-A', { id: 'rule-pq', version: 'v1' }, processQualityRule);
  assert.equal(dataset.snapshot.queryColumn, 'query');
  assert.equal(rule.snapshot.id, processQualityRule.id);
  assert.equal(catalog.getRule({ id: 'rule-pq', version: 'v1' }, 'acct-A')?.contentHash, rule.contentHash);
});

test('不完整 CSV 和只有表头的文件返回可定位错误', () => {
  const options = { name: '导入', queryColumn: 'query' };
  for (const csv of ['query\n"未闭合', 'query\n"已闭合"多余字符', 'query\n中间"引号']) {
    const result = parseDatasetCsv(csv, options);
    assert.ok(!result.ok);
    assert.equal(result.issues[0].code, 'MALFORMED_CSV');
    assert.equal(result.issues[0].row, 1);
  }
  const empty = parseDatasetCsv('query\n', options);
  assert.ok(!empty.ok);
  assert.equal(empty.issues[0].code, 'EMPTY_DATASET');
});
