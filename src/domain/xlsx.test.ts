import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { inspectXlsx, readXlsxSheet, DEFAULT_XLSX_LIMITS, type XlsxCell } from './xlsx.ts';

/** 测试夹具：按真实 OOXML/ZIP 结构生成 .xlsx 字节，不依赖任何第三方库。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
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
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    locals.push(header, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(checksum, 16);
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

interface SheetFixture {
  name: string;
  xml: string;
}

function buildXlsx(sheets: readonly SheetFixture[], shared?: readonly string[]): Uint8Array {
  const relationshipType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
  const relationships = sheets
    .map((_, index) => `<Relationship Id="rId${index + 1}" Type="${relationshipType}" Target="worksheets/sheet${index + 1}.xml"/>`)
    .join('');
  const sheetTags = sheets
    .map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('');
  const parts: { name: string; xml: string }[] = [
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
  ];
  if (shared) {
    parts.push({
      name: 'xl/sharedStrings.xml',
      xml: `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared
        .map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`)
        .join('')}</sst>`,
    });
  }
  sheets.forEach((sheet, index) => {
    parts.push({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      xml: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet.xml}</sheetData></worksheet>`,
    });
  });
  return buildZip(parts);
}

function textAt(result: ReturnType<typeof readXlsxSheet>, row: number, column: number): string {
  assert.equal(result.ok, true);
  return result.value.sheet.rows[row][column].text;
}

test('单工作表：表头与逐行文本按原样读出，行 ID 由上层按行序冻结', () => {
  const xml = [
    '<row r="1"><c r="A1" t="inlineStr"><is><t>query</t></is></c><c r="B1" t="inlineStr"><is><t>answer</t></is></c></row>',
    '<row r="2"><c r="A2" t="inlineStr"><is><t>中文，含逗号</t></is></c><c r="B2" t="inlineStr"><is><t>第一行&#10;第二行</t></is></c></row>',
    '<row r="3"><c r="A3" t="inlineStr"><is><t>第二问</t></is></c><c r="B3" t="inlineStr"><is><t>带 &quot;引号&quot; 与 &amp; 符号</t></is></c></row>',
  ].join('');
  const result = readXlsxSheet(buildXlsx([{ name: '样本', xml }]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.sheetNames, ['样本']);
  assert.equal(result.value.sheet.name, '样本');
  assert.equal(textAt(result, 0, 0), 'query');
  assert.equal(textAt(result, 1, 0), '中文，含逗号');
  assert.equal(textAt(result, 1, 1), '第一行\n第二行');
  assert.equal(textAt(result, 2, 1), '带 "引号" 与 & 符号');
  assert.equal(result.value.sheet.rows.length, 3);
  assert.equal(result.value.sheet.rows[0].length, 2);
});

test('多工作表：inspectXlsx 列出全部名称，按名称、序号或默认选择', () => {
  const first = '<row r="1"><c r="A1" t="inlineStr"><is><t>第一张</t></is></c></row>';
  const second = '<row r="1"><c r="A1" t="inlineStr"><is><t>第二张</t></is></c></row>';
  const bytes = buildXlsx([{ name: '评测集', xml: first }, { name: '备份 & 归档', xml: second }]);
  const names = inspectXlsx(bytes);
  assert.equal(names.ok, true);
  if (names.ok) assert.deepEqual(names.value, ['评测集', '备份 & 归档']);

  const byName = readXlsxSheet(bytes, { sheet: '备份 & 归档' });
  assert.equal(textAt(byName, 0, 0), '第二张');
  const byIndex = readXlsxSheet(bytes, { sheet: 2 });
  assert.equal(textAt(byIndex, 0, 0), '第二张');
  const byDefault = readXlsxSheet(bytes);
  assert.equal(textAt(byDefault, 0, 0), '第一张');
  assert.deepEqual(byName.ok && byName.value.sheetNames, ['评测集', '备份 & 归档']);
});

test('共享字符串与 inlineStr 混用：xml:space 空格保留，实体正确解码', () => {
  const xml = [
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t xml:space="preserve">  保留空格  </t></is></c></row>',
    '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>0</v></c></row>',
  ].join('');
  const result = readXlsxSheet(buildXlsx([{ name: '共享', xml }], ['问题 & 答案', '<标签>']));
  assert.equal(result.ok, true);
  assert.equal(textAt(result, 0, 0), '问题 & 答案');
  assert.equal(textAt(result, 0, 1), '  保留空格  ');
  assert.equal(textAt(result, 1, 0), '<标签>');
  assert.equal(textAt(result, 1, 1), '问题 & 答案');
});

test('公式单元格标记 hasFormula 并保留缓存文本，数字/布尔/错误分类可读', () => {
  const xml = [
    '<row r="1"><c r="A1" t="inlineStr"><is><t>query</t></is></c><c r="B1" t="inlineStr"><is><t>type</t></is></c></row>',
    '<row r="2"><c r="A2"><f>1+1</f><v>2</v></c><c r="B2" t="str"><f>A2&amp;"x"</f><v>缓存文本</v></c></row>',
    '<row r="3"><c r="A3" t="b"><v>1</v></c><c r="B3" t="e"><v>#DIV/0!</v></c></row>',
    '<row r="4"><c r="A4"><v>3.5</v></c><c r="B4"/></row>',
  ].join('');
  const result = readXlsxSheet(buildXlsx([{ name: '公式', xml }]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const rows = result.value.sheet.rows;
  assert.deepEqual(rows[1][0], { text: '2', type: 'number', hasFormula: true });
  assert.deepEqual(rows[1][1], { text: '缓存文本', type: 'string', hasFormula: true });
  assert.deepEqual(rows[2][0], { text: 'TRUE', type: 'boolean', hasFormula: false });
  assert.deepEqual(rows[2][1], { text: '#DIV/0!', type: 'error', hasFormula: false });
  assert.deepEqual(rows[3][0], { text: '3.5', type: 'number', hasFormula: false });
  assert.deepEqual(rows[3][1], { text: '', type: 'empty', hasFormula: false });
});

test('稀疏列与缺失行补成矩形网格，列字母按 Excel 列号映射', () => {
  const xml = [
    '<row r="1"><c r="C1" t="inlineStr"><is><t>第三列</t></is></c></row>',
    '<row r="3"><c r="B3" t="inlineStr"><is><t>三行二列</t></is></c><c r="AA3" t="inlineStr"><is><t>27列</t></is></c></row>',
  ].join('');
  const result = readXlsxSheet(buildXlsx([{ name: '稀疏', xml }]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const rows = result.value.sheet.rows;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].length, 27);
  assert.equal(rows[0][2].text, '第三列');
  assert.equal(rows[1].every((cell: XlsxCell) => cell.text === ''), true);
  assert.equal(rows[2][1].text, '三行二列');
  assert.equal(rows[2][26].text, '27列');
});

test('结果深冻结：外部改写表格不会污染后续读取', () => {
  const xml = '<row r="1"><c r="A1" t="inlineStr"><is><t>原始</t></is></c></row>';
  const bytes = buildXlsx([{ name: '冻结', xml }]);
  const result = readXlsxSheet(bytes);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.throws(() => {
    (result.value.sheet.rows[0][0] as { text: string }).text = '改写';
  });
  assert.equal(textAt(readXlsxSheet(bytes), 0, 0), '原始');
});

function firstIssue(result: ReturnType<typeof readXlsxSheet> | ReturnType<typeof inspectXlsx>): string {
  assert.ok(!result.ok);
  return result.issues[0].code;
}

test('非法容器与缺失部件返回可定位错误码', () => {
  assert.deepEqual(firstIssue(inspectXlsx(new Uint8Array())), 'EMPTY_FILE');
  assert.deepEqual(firstIssue(inspectXlsx(Buffer.from('not a zip'))), 'NOT_ZIP');
  const noWorkbook = buildZip([{ name: 'xl/worksheets/sheet1.xml', xml: '<worksheet/>' }]);
  assert.equal(firstIssue(inspectXlsx(noWorkbook)), 'MISSING_PART');

  const bytes = buildXlsx([{ name: '样本', xml: '<row r="1"/>' }]);
  const unknown = readXlsxSheet(bytes, { sheet: '不存在的表' });
  assert.equal(unknown.ok, false);
  assert.equal(firstIssue(unknown), 'SHEET_NOT_FOUND');
  assert.equal(firstIssue(readXlsxSheet(bytes, { sheet: 0 as number })), 'SHEET_NOT_FOUND');
  assert.equal(firstIssue(readXlsxSheet(bytes, { sheet: true as unknown as number })), 'INVALID_SHEET');
});

test('上限与坏 XML：文件、行数、列数、单元格、解压与标签错误都返回具体问题', () => {
  const row = '<row r="1"><c r="A1" t="inlineStr"><is><t>中文</t></is></c></row>';
  const bytes = buildXlsx([{ name: '上限', xml: row }]);
  assert.equal(firstIssue(inspectXlsx(bytes, { maxFileBytes: 10 })), 'FILE_TOO_LARGE');
  assert.equal(firstIssue(inspectXlsx(bytes, { maxEntries: 1 })), 'TOO_MANY_ENTRIES');
  assert.equal(firstIssue(inspectXlsx(bytes, { maxUncompressedBytes: 10 })), 'ENTRY_TOO_LARGE');
  assert.equal(firstIssue(readXlsxSheet(bytes, { limits: { maxCellChars: 1 } })), 'CELL_TOO_LARGE');
  assert.equal(firstIssue(readXlsxSheet(bytes, { limits: { maxRows: 0 } })), 'TOO_MANY_ROWS');
  assert.equal(firstIssue(readXlsxSheet(bytes, { limits: { maxColumns: 0 } })), 'TOO_MANY_CELLS');

  const broken = buildXlsx([{ name: '坏表', xml: '<row r="1"><c r="A1" t="s"><v>99</v></c></row>' }], ['x']);
  const invalidShared = readXlsxSheet(broken);
  assert.equal(firstIssue(invalidShared), 'INVALID_CELL');
  const malformed = buildXlsx([{ name: '坏表', xml: '<row r="1"><c r="A1"></row>' }]);
  assert.equal(firstIssue(readXlsxSheet(malformed)), 'MALFORMED_XML');

  assert.ok(DEFAULT_XLSX_LIMITS.maxRows >= 10_000);
});
