/**
 * 测试夹具：在测试内生成真实最小 OOXML/ZIP 的 .xlsx 字节并返回 base64。
 * 仅供 import-api 测试使用；不读本机文件、不安装依赖、不访问网络或模型。
 */
import { deflateRawSync } from 'node:zlib';

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

/** 由每张表的单元格 XML 构造 .xlsx 字节。 */
export function buildXlsxBytes(sheets: readonly { name: string; xml: string }[]): Uint8Array {
  const relationshipType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
  const relationships = sheets
    .map((_, index) => `<Relationship Id="rId${index + 1}" Type="${relationshipType}" Target="worksheets/sheet${index + 1}.xml"/>`)
    .join('');
  const sheetTags = sheets
    .map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('');
  const parts = [
    { name: '[Content_Types].xml', xml: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: '_rels/.rels', xml: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>' },
    { name: 'xl/workbook.xml', xml: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns:r="${relationshipType}"><sheets>${sheetTags}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', xml: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>` },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      xml: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet.xml}</sheetData></worksheet>`,
    })),
  ];
  return buildZip(parts);
}

/** 一张两列的样本表：表头 query/answer，两条中文数据行。 */
export function sampleSheetXml(answer2 = '我很好'): string {
  return [
    `<row r="1">${inline('A1', 'query')}${inline('B1', 'answer')}</row>`,
    `<row r="2">${inline('A2', '你好吗')}${inline('B2', answer2)}</row>`,
    `<row r="3">${inline('A3', '退货流程')}${inline('B3', '见帮助中心')}</row>`,
  ].join('');
}

/** 生成默认样本工作簿的 base64 文本。 */
export function sampleXlsxBase64(): string {
  return Buffer.from(buildXlsxBytes([{ name: '样本', xml: sampleSheetXml() }])).toString('base64');
}
