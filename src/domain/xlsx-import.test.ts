/**
 * P2 Excel 导入快照领域契约单元测试：
 *   node --test src/domain/xlsx-import.test.ts
 * 夹具在测试内生成真实 OOXML/ZIP 字节；仅用 Node 22 内置能力，
 * 不读本机文件、不启动 Docker、不安装依赖、不调用模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { parseDatasetXlsx, parseDatasetCsv, type ImportIssueCode } from './imports.ts';
import { ResourceCatalog } from './resources.ts';
import { importDataset, InMemoryDatasetRowStore } from './dataset-rows.ts';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(parts: readonly { name: string; xml: string }[]): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name, 'utf8');
    const data = Buffer.from(part.xml, 'utf8');
    const compressed = deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    locals.push(header, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc32(data), 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([directory, name]));
    offset += header.length + name.length + compressed.length;
  }
  const directorySize = central.reduce((sum, entry) => sum + entry.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(ref: string, value: string): string {
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function buildXlsx(sheets: readonly { name: string; xml: string }[]): Uint8Array {
  const relationshipType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
  const relationships = sheets
    .map((_, index) => `<Relationship Id="rId${index + 1}" Type="${relationshipType}" Target="worksheets/sheet${index + 1}.xml"/>`)
    .join('');
  const sheetTags = sheets
    .map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('');
  const parts = [
    {
      name: '[Content_Types].xml',
      xml: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    },
    {
      name: '_rels/.rels',
      xml: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    },
    {
      name: 'xl/workbook.xml',
      xml: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns:r="${relationshipType}"><sheets>${sheetTags}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      xml: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`,
    },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      xml: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet.xml}</sheetData></worksheet>`,
    })),
  ];
  return buildZip(parts);
}

function simpleSheet(): Uint8Array {
  const xml = [
    `<row r="1">${inline('A1', 'query')}${inline('B1', 'answer')}</row>`,
    `<row r="2">${inline('A2', '你好吗')}${inline('B2', '我很好')}</row>`,
    `<row r="3">${inline('A3', '退货流程')}${inline('B3', '见帮助中心')}</row>`,
  ].join('');
  return buildXlsx([{ name: '样本', xml }]);
}

function codes(issues: readonly { code: ImportIssueCode }[]): ImportIssueCode[] {
  return issues.map((item) => item.code);
}

test('单表导入：显式来源为 excel，产出冻结快照与逐行文本，可写入版本目录', () => {
  const result = parseDatasetXlsx(simpleSheet(), { name: '客服样本', queryColumn: 'query' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { snapshot, rows, contentChecksum } = result.value;
  assert.equal(snapshot.name, '客服样本');
  assert.equal(snapshot.source, 'excel');
  assert.deepEqual(snapshot.columns, ['query', 'answer']);
  assert.deepEqual(snapshot.rowIds, ['R000001', 'R000002']);
  assert.equal(snapshot.rowCount, 2);
  assert.equal(snapshot.contentChecksum, contentChecksum);
  assert.match(contentChecksum, /^[0-9a-f]{64}$/);
  assert.deepEqual(rows.map((row) => row.cells.answer), ['我很好', '见帮助中心']);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(rows[0].cells), true);

  const catalog = new ResourceCatalog(() => '2026-11-25T10:00:00+08:00');
  const ref = { id: 'ds-excel', version: 'v1' };
  catalog.putDataset('acct-A', ref, snapshot);
  assert.equal(catalog.getDataset(ref, 'acct-A')?.snapshot.rowCount, 2);
  assert.equal(catalog.getDataset(ref, 'acct-B'), undefined);
});

test('同一网格的 Excel 与 CSV 路径共用校验口径，仅来源参与校验值', () => {
  const xlsxResult = parseDatasetXlsx(simpleSheet(), { name: '同源', queryColumn: 'query' });
  const csvResult = parseDatasetCsv('query,answer\r\n你好吗,我很好\r\n退货流程,见帮助中心\r\n', {
    name: '同源',
    queryColumn: 'query',
  });
  assert.equal(xlsxResult.ok, true);
  assert.equal(csvResult.ok, true);
  if (!xlsxResult.ok || !csvResult.ok) return;
  assert.deepEqual(xlsxResult.value.snapshot.rowIds, csvResult.value.snapshot.rowIds);
  assert.deepEqual(xlsxResult.value.rows, csvResult.value.rows);
  assert.notEqual(xlsxResult.value.contentChecksum, csvResult.value.contentChecksum);
  assert.equal(
    parseDatasetCsv('query,answer\r\n你好吗,我很好\r\n退货流程,见帮助中心\r\n', {
      name: '同源',
      queryColumn: 'query',
      source: 'excel',
    }).ok,
    true,
  );
  const replay = parseDatasetXlsx(simpleSheet(), { name: '同源', queryColumn: 'query' });
  assert.equal(replay.ok && replay.value.contentChecksum, xlsxResult.value.contentChecksum);
});

test('显式选表：按名称或序号选择不同工作表，内容不同则校验值不同', () => {
  const first = `<row r="1">${inline('A1', 'query')}</row><row r="2">${inline('A2', '第一张')}</row>`;
  const second = `<row r="1">${inline('A1', 'query')}</row><row r="2">${inline('A2', '第二张')}</row>`;
  const bytes = buildXlsx([{ name: '主表', xml: first }, { name: '备份 & 归档', xml: second }]);
  const byName = parseDatasetXlsx(bytes, { name: '选表', queryColumn: 'query', sheet: '备份 & 归档' });
  const byIndex = parseDatasetXlsx(bytes, { name: '选表', queryColumn: 'query', sheet: 2 });
  const byDefault = parseDatasetXlsx(bytes, { name: '选表', queryColumn: 'query' });
  assert.equal(byName.ok && byName.value.rows[0].cells.query, '第二张');
  assert.equal(byIndex.ok && byIndex.value.contentChecksum, byName.ok ? byName.value.contentChecksum : '');
  assert.equal(byDefault.ok && byDefault.value.rows[0].cells.query, '第一张');
  assert.notEqual(byName.ok && byName.value.contentChecksum, byDefault.ok ? byDefault.value.contentChecksum : '');
});

test('中文、换行与转义引号逐字段一致，完全空行不产生幽灵行', () => {
  const xml = [
    `<row r="1">${inline('A1', 'query')}${inline('B1', 'answer')}</row>`,
    `<row r="2">${inline('A2', '中文，含逗号')}${inline('B2', '第一行\n第二行')}</row>`,
    '<row r="3"/>',
    `<row r="4">${inline('A4', '第二问')}${inline('B4', '他说"你好" & 已归档')}</row>`,
  ].join('');
  const result = parseDatasetXlsx(buildXlsx([{ name: '样本', xml }]), {
    name: '文本还原',
    queryColumn: 'query',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.snapshot.rowCount, 2);
  assert.deepEqual(result.value.snapshot.rowIds, ['R000001', 'R000002']);
  assert.equal(result.value.rows[0].cells.query, '中文，含逗号');
  assert.equal(result.value.rows[0].cells.answer, '第一行\n第二行');
  assert.equal(result.value.rows[1].cells.answer, '他说"你好" & 已归档');
});

test('公式单元格一律拒绝，缓存值不能冒充输入证据，并定位到列与数据行', () => {
  const xml = [
    `<row r="1">${inline('A1', 'query')}${inline('B1', 'answer')}</row>`,
    `<row r="2">${inline('A2', '正常问')}${inline('B2', '正常答')}</row>`,
    `<row r="3"><c r="A3"><f>1+1</f><v>2</v></c>${inline('B3', '缓存值旁边')}</row>`,
    `<row r="4">${inline('A4', '第四问')}<c r="B4" t="str"><f>A4&amp;"x"</f><v>=看起来像公式</v></c></row>`,
  ].join('');
  const result = parseDatasetXlsx(buildXlsx([{ name: '公式', xml }]), {
    name: '公式拒绝',
    queryColumn: 'query',
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  const formulas = result.issues.filter((item) => item.code === 'FORMULA_CELL');
  assert.equal(formulas.length, 2);
  assert.ok(formulas.some((item) => item.row === 2 && item.column === 1 && item.field === 'A'));
  assert.ok(formulas.some((item) => item.row === 3 && item.column === 2 && item.field === 'B'));
});

test('表头公式同样被拒绝；缺列、重复列与空查询由同一份 CSV 校验捕获', () => {
  const formulaHeader = buildXlsx([{
    name: '表头公式',
    xml: `<row r="1"><c r="A1"><f>"query"</f><v>query</v></c>${inline('B1', 'answer')}</row>`,
  }]);
  const header = parseDatasetXlsx(formulaHeader, { name: '表头', queryColumn: 'query' });
  assert.equal(header.ok, false);
  if (!header.ok) {
    assert.equal(codes(header.issues).filter((code) => code === 'FORMULA_CELL').length, 1);
    assert.equal(header.issues.some((item) => item.field === 'A' && item.row === undefined), true);
  }

  const missing = buildXlsx([{
    name: '缺列',
    xml: `<row r="1">${inline('A1', 'answer')}</row><row r="2">${inline('A2', '内容')}</row>`,
  }]);
  const missingResult = parseDatasetXlsx(missing, { name: '缺列', queryColumn: 'query' });
  assert.equal(missingResult.ok, false);
  if (!missingResult.ok) assert.ok(codes(missingResult.issues).includes('QUERY_COLUMN_MISSING'));

  const duplicate = buildXlsx([{
    name: '重复列',
    xml: `<row r="1">${inline('A1', 'query')}${inline('B1', 'query')}</row><row r="2">${inline('A2', '一')}${inline('B2', '二')}</row>`,
  }]);
  const duplicateResult = parseDatasetXlsx(duplicate, { name: '重复', queryColumn: 'query' });
  assert.equal(duplicateResult.ok, false);
  if (!duplicateResult.ok) assert.ok(codes(duplicateResult.issues).includes('DUPLICATE_COLUMN'));

  const emptyQuery = buildXlsx([{
    name: '空查询',
    xml: `<row r="1">${inline('A1', 'query')}</row><row r="2">${inline('A2', ' ')}</row>`,
  }]);
  const emptyResult = parseDatasetXlsx(emptyQuery, { name: '空查询', queryColumn: 'query' });
  assert.equal(emptyResult.ok, false);
  if (!emptyResult.ok) {
    assert.ok(emptyResult.issues.some((item) => item.code === 'QUERY_VALUE_EMPTY' && item.row === 1));
  }
});

test('工作表与容器错误映射为导入 issues，并保留定位字段', () => {
  const bytes = simpleSheet();
  const sheet = parseDatasetXlsx(bytes, { name: '选表', queryColumn: 'query', sheet: '不存在' });
  assert.equal(sheet.ok, false);
  if (!sheet.ok) {
    assert.ok(sheet.issues.some((item) => item.code === 'SHEET_NOT_FOUND' && item.field === 'sheet'));
  }
  const broken = parseDatasetXlsx(Buffer.from('不是 zip'), { name: '坏文件', queryColumn: 'query' });
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.equal(codes(broken.issues)[0], 'NOT_ZIP');
});

test('字节、解压、行数与单元格上限从 xlsx 读取层透传到导入结果', () => {
  const bytes = simpleSheet();
  const fileTooLarge = parseDatasetXlsx(bytes, {
    name: '超限', queryColumn: 'query', limits: { maxFileBytes: 10 },
  });
  assert.equal(fileTooLarge.ok, false);
  if (!fileTooLarge.ok) assert.ok(codes(fileTooLarge.issues).includes('FILE_TOO_LARGE'));

  const entryTooLarge = parseDatasetXlsx(bytes, {
    name: '超限', queryColumn: 'query', limits: { maxUncompressedBytes: 10 },
  });
  assert.equal(entryTooLarge.ok, false);
  if (!entryTooLarge.ok) assert.ok(codes(entryTooLarge.issues).includes('ENTRY_TOO_LARGE'));

  const tooManyRows = parseDatasetXlsx(bytes, {
    name: '超限', queryColumn: 'query', limits: { maxRows: 1 },
  });
  assert.equal(tooManyRows.ok, false);
  if (!tooManyRows.ok) assert.ok(codes(tooManyRows.issues).includes('TOO_MANY_ROWS'));

  const cellTooLarge = parseDatasetXlsx(bytes, {
    name: '超限', queryColumn: 'query', limits: { maxCellChars: 1 },
  });
  assert.equal(cellTooLarge.ok, false);
  if (!cellTooLarge.ok) assert.ok(codes(cellTooLarge.issues).includes('CELL_TOO_LARGE'));
});

test('Excel 导入结果可直接写入版本目录与行存储，重放幂等且行内容不丢失', () => {
  const imported = parseDatasetXlsx(simpleSheet(), { name: '写入链路', queryColumn: 'query' });
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  const catalog = new ResourceCatalog(() => '2026-11-25T10:00:00+08:00');
  const rowStore = new InMemoryDatasetRowStore();
  const ref = { id: 'ds-excel-write', version: 'v1' };
  const first = importDataset(catalog, rowStore, 'acct-A', ref, imported.value, () => '2026-11-25T10:00:00+08:00');
  const replay = importDataset(catalog, rowStore, 'acct-A', ref, imported.value, () => '2026-11-25T10:00:00+08:00');
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.rowSet.contentChecksum, imported.value.contentChecksum);
  assert.deepEqual(rowStore.get(ref, 'acct-A')?.rows[0].cells, { query: '你好吗', answer: '我很好' });
  assert.equal(rowStore.get(ref, 'acct-B'), undefined);
  assert.equal(catalog.getDataset(ref, 'acct-A')?.snapshot.source, 'excel');
});

test('Excel 的数据行额度不含表头；无缓存的公式也会指出位置', () => {
  const options = { name: '样本', queryColumn: 'query', limits: { maxRows: 2 } };
  assert.ok(parseDatasetXlsx(simpleSheet(), options).ok);
  const xml = `<row r="1">${inline('A1', 'query')}</row><row r="2"><c r="A2"><f>1+2</f></c></row>`;
  const invalid = parseDatasetXlsx(buildXlsx([{ name: '样本', xml }]), options);
  assert.ok(!invalid.ok);
  assert.ok(invalid.issues.some((i) => i.code === 'FORMULA_CELL' && i.row === 1 && i.column === 1));
});
