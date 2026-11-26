/**
 * P2 Excel `.xlsx` 读取契约（P1 阻塞期可准备工作）。
 *
 * plan.md P2 要求「显式选 Excel 工作表与查询字段」「Excel .xlsx 工作表选择与
 * 公式缓存值」「只读取文件中明确可用的值」。本模块只做文件→表格边界：
 *  - 直接读取 OOXML 的 ZIP 容器与工作表 XML，仅用 Node 22 内置 node:zlib，不安装依赖；
 *  - inspectXlsx 列出全部工作表名，供界面显式选择；readXlsxSheet 按名称或 1 起始序号读取；
 *  - 单元格返回已缓存的文本值并标记 hasFormula，供上层按既有「公式单元格不参与导入」
 *    口径决定拒绝或读取缓存，不在本层求值，也不二次调用模型；
 *  - 固定文件、条目、行列和单元格上限，错误返回可定位的 code/field/row/column；
 *  - 不读取文件、不访问网络、不调用模型、不修改上游源码。
 *
 * 与 csv 路径类似，本层产出矩形文本网格，后续 parseDatasetXlsx 复用同一份
 * 查询列／校验值／来源校验后写入版本目录和行集合，避免两套口径分叉。
 */
import { inflateRawSync } from 'node:zlib';
import { deepFreeze } from './resources.ts';

export interface XlsxLimits {
  maxFileBytes: number;
  maxUncompressedBytes: number;
  maxEntries: number;
  maxRows: number;
  maxColumns: number;
  maxCellChars: number;
}

/** 与 imports.ts 的 5 MiB／10000 行／4000 字符保持一致，另加解压与网格上限。 */
export const DEFAULT_XLSX_LIMITS: XlsxLimits = Object.freeze({
  maxFileBytes: 5 * 1024 * 1024,
  maxUncompressedBytes: 32 * 1024 * 1024,
  maxEntries: 512,
  maxRows: 10_000,
  maxColumns: 256,
  maxCellChars: 4_000,
});

export type XlsxIssueCode =
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'NOT_ZIP'
  | 'MALFORMED_ZIP'
  | 'TOO_MANY_ENTRIES'
  | 'ENTRY_TOO_LARGE'
  | 'UNSUPPORTED_COMPRESSION'
  | 'MISSING_PART'
  | 'MALFORMED_XML'
  | 'SHEET_NOT_FOUND'
  | 'INVALID_SHEET'
  | 'TOO_MANY_ROWS'
  | 'TOO_MANY_CELLS'
  | 'CELL_TOO_LARGE'
  | 'INVALID_CELL'
  | 'PARSE_FAILED';

export interface XlsxIssue {
  code: XlsxIssueCode;
  field: string;
  message: string;
  row?: number;
  column?: number;
}

export type XlsxCellType = 'string' | 'number' | 'boolean' | 'error' | 'empty';

export interface XlsxCell {
  /** 文件中已明确存在的缓存文本；公式不求值。 */
  text: string;
  type: XlsxCellType;
  /** 原始单元格含 <f>，由上层决定是否按公式拒绝。 */
  hasFormula: boolean;
}

export interface XlsxSheet {
  name: string;
  /** 矩形网格：稀疏列与空行补 empty 单元格，行列序号与工作表一致。 */
  rows: readonly (readonly XlsxCell[])[];
}

export interface XlsxWorkbook {
  sheetNames: readonly string[];
  sheet: XlsxSheet;
}

export type XlsxResult<T> = { ok: true; value: T } | { ok: false; issues: readonly XlsxIssue[] };

export interface ReadXlsxSheetOptions {
  /** 显式工作表名或 1 起始序号；省略时读第一张，结果仍返回全部表名。 */
  sheet?: string | number;
  limits?: Partial<XlsxLimits>;
}

class XlsxParseError extends Error {
  readonly code: XlsxIssueCode;
  readonly field: string;
  readonly row?: number;
  readonly column?: number;

  constructor(code: XlsxIssueCode, field: string, message: string, row?: number, column?: number) {
    super(message);
    this.name = 'XlsxParseError';
    this.code = code;
    this.field = field;
    this.row = row;
    this.column = column;
  }
}

function fail(code: XlsxIssueCode, field: string, message: string, row?: number, column?: number): never {
  throw new XlsxParseError(code, field, message, row, column);
}

function resolveLimits(overrides?: Partial<XlsxLimits>): XlsxLimits {
  return { ...DEFAULT_XLSX_LIMITS, ...overrides };
}

function toIssue(error: unknown): XlsxIssue {
  if (error instanceof XlsxParseError) {
    const issue: XlsxIssue = { code: error.code, field: error.field, message: error.message };
    if (error.row !== undefined) issue.row = error.row;
    if (error.column !== undefined) issue.column = error.column;
    return issue;
  }
  return {
    code: 'PARSE_FAILED',
    field: 'file',
    message: error instanceof Error ? error.message : '工作簿解析失败',
  };
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

function u16(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.length) fail('MALFORMED_ZIP', 'zip', 'ZIP 结构不完整');
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) fail('MALFORMED_ZIP', 'zip', 'ZIP 结构不完整');
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
  );
}

/** 读取中央目录：支持 deflate（方法 8）与 stored（方法 0），不支持 ZIP64。 */
function readZipEntries(bytes: Uint8Array, limits: XlsxLimits): Map<string, ZipEntry> {
  if (bytes.length === 0) fail('EMPTY_FILE', 'file', '文件为空');
  if (bytes.length > limits.maxFileBytes) {
    fail('FILE_TOO_LARGE', 'file', `文件超过 ${limits.maxFileBytes} 字节上限`);
  }
  const minEocd = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minEocd; offset -= 1) {
    if (u32(bytes, offset) === SIG_EOCD) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) fail('NOT_ZIP', 'file', '不是有效的 ZIP/OOXML 容器');
  const count = u16(bytes, eocd + 10);
  if (count === 0xffff) fail('MALFORMED_ZIP', 'zip', '暂不支持 ZIP64 工作簿');
  if (count > limits.maxEntries) fail('TOO_MANY_ENTRIES', 'zip', `条目超过 ${limits.maxEntries} 个上限`);
  const directorySize = u32(bytes, eocd + 12);
  const directoryOffset = u32(bytes, eocd + 16);
  if (directoryOffset > eocd || directoryOffset + directorySize > eocd) {
    fail('MALFORMED_ZIP', 'zip', '中央目录偏移越界');
  }
  const entries = new Map<string, ZipEntry>();
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (u32(bytes, cursor) !== SIG_CENTRAL) fail('MALFORMED_ZIP', 'zip', '中央目录条目损坏');
    const method = u16(bytes, cursor + 10);
    const compressedSize = u32(bytes, cursor + 20);
    const uncompressedSize = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const localOffset = u32(bytes, cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > directoryOffset + directorySize) fail('MALFORMED_ZIP', 'zip', '中央目录条目越界');
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (uncompressedSize > limits.maxUncompressedBytes) {
      fail('ENTRY_TOO_LARGE', name, `解压后超过 ${limits.maxUncompressedBytes} 字节上限`);
    }
    if (!entries.has(name)) {
      entries.set(name, { name, method, compressedSize, uncompressedSize, offset: localOffset });
    }
    cursor = end;
  }
  return entries;
}

function readEntry(bytes: Uint8Array, entry: ZipEntry, limits: XlsxLimits): Uint8Array {
  if (u32(bytes, entry.offset) !== SIG_LOCAL) fail('MALFORMED_ZIP', entry.name, '本地文件头损坏');
  const nameLength = u16(bytes, entry.offset + 26);
  const extraLength = u16(bytes, entry.offset + 28);
  const start = entry.offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.length) fail('MALFORMED_ZIP', entry.name, '条目数据越界');
  let output: Uint8Array;
  if (entry.method === 0) {
    output = bytes.subarray(start, end);
  } else if (entry.method === 8) {
    try {
      output = inflateRawSync(bytes.subarray(start, end), { maxOutputLength: Math.max(1, limits.maxUncompressedBytes) });
    } catch {
      fail('MALFORMED_ZIP', entry.name, '条目解压失败');
    }
  } else {
    fail('UNSUPPORTED_COMPRESSION', entry.name, `不支持的 ZIP 压缩方法 ${entry.method}`);
  }
  if (output.length !== entry.uncompressedSize) fail('MALFORMED_ZIP', entry.name, '条目解压长度不符');
  if (output.length > limits.maxUncompressedBytes) {
    fail('ENTRY_TOO_LARGE', entry.name, `解压后超过 ${limits.maxUncompressedBytes} 字节上限`);
  }
  return output;
}

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_match, token: string) => {
    if (token === 'amp') return '&';
    if (token === 'lt') return '<';
    if (token === 'gt') return '>';
    if (token === 'quot') return '"';
    if (token === 'apos') return "'";
    if (token.startsWith('#x')) return String.fromCodePoint(parseInt(token.slice(2), 16));
    return String.fromCodePoint(parseInt(token.slice(1), 10));
  });
}

/** 轻量 OOXML 解析：保留标签、属性与文本，忽略注释、声明与 CDATA 包装。 */
function parseXml(text: string, part: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== '<') {
      let next = text.indexOf('<', cursor);
      if (next < 0) next = text.length;
      stack[stack.length - 1].text += decodeEntities(text.slice(cursor, next));
      cursor = next;
      continue;
    }
    if (text.startsWith('<!--', cursor)) {
      const next = text.indexOf('-->', cursor + 4);
      if (next < 0) fail('MALFORMED_XML', part, '注释未闭合');
      cursor = next + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', cursor)) {
      const next = text.indexOf(']]>', cursor + 9);
      if (next < 0) fail('MALFORMED_XML', part, 'CDATA 未闭合');
      stack[stack.length - 1].text += text.slice(cursor + 9, next);
      cursor = next + 3;
      continue;
    }
    if (text.startsWith('<?', cursor)) {
      const next = text.indexOf('?>', cursor + 2);
      if (next < 0) fail('MALFORMED_XML', part, '声明未闭合');
      cursor = next + 2;
      continue;
    }
    if (text.startsWith('<!', cursor)) {
      const next = text.indexOf('>', cursor + 2);
      if (next < 0) fail('MALFORMED_XML', part, '标记未闭合');
      cursor = next + 1;
      continue;
    }
    let next = cursor + 1;
    let quote = '';
    for (; next < text.length; next += 1) {
      const char = text[next];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
    }
    if (next >= text.length) fail('MALFORMED_XML', part, '标签未闭合');
    let body = text.slice(cursor + 1, next).trim();
    cursor = next + 1;
    const selfClosing = body.endsWith('/');
    if (selfClosing) body = body.slice(0, -1).trim();
    const closing = body.startsWith('/');
    if (closing) body = body.slice(1).trim();
    const matched = /^([A-Za-z_][\w.\-:]*)/.exec(body);
    if (!matched) fail('MALFORMED_XML', part, '无法识别的标签');
    const attrs: Record<string, string> = {};
    const attributePattern = /([A-Za-z_:][\w.\-:]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let attribute: RegExpExecArray | null;
    while ((attribute = attributePattern.exec(body.slice(matched[1].length))) !== null) {
      attrs[localName(attribute[1])] = decodeEntities(attribute[3] ?? attribute[4] ?? '');
    }
    if (closing) {
      const top = stack[stack.length - 1];
      if (stack.length < 2 || localName(top.name) !== localName(matched[1])) {
        fail('MALFORMED_XML', part, '标签闭合不匹配');
      }
      stack.pop();
    } else {
      const node: XmlNode = { name: localName(matched[1]), attrs, children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
    }
  }
  if (stack.length !== 1 || root.children.length === 0) fail('MALFORMED_XML', part, 'XML 根元素缺失或未闭合');
  return root.children[0];
}

function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

function firstChild(node: XmlNode, name: string): XmlNode | undefined {
  return childrenNamed(node, name)[0];
}

function textOf(node: XmlNode): string {
  let output = node.text;
  for (const child of node.children) output += textOf(child);
  return output;
}

function decodeUtf8(bytes: Uint8Array, part: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('MALFORMED_XML', part, 'XML 不是合法 UTF-8');
  }
}

function normalizePartPath(target: string, part: string): string {
  const trimmed = target.replace(/^\/+/, '');
  const base = trimmed.startsWith('xl/') ? trimmed : `xl/${trimmed}`;
  const segments: string[] = [];
  for (const segment of base.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) fail('MISSING_PART', part, '工作表路径越界');
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join('/');
}

interface WorkbookMeta {
  entries: Map<string, ZipEntry>;
  sheetNames: string[];
  sheetParts: string[];
}

function loadWorkbook(bytes: Uint8Array, limits: XlsxLimits): WorkbookMeta {
  const entries = readZipEntries(bytes, limits);
  const workbookEntry = entries.get('xl/workbook.xml');
  if (!workbookEntry) fail('MISSING_PART', 'xl/workbook.xml', '缺少工作簿定义');
  const relsEntry = entries.get('xl/_rels/workbook.xml.rels');
  if (!relsEntry) fail('MISSING_PART', 'xl/_rels/workbook.xml.rels', '缺少工作表关系定义');

  const workbook = parseXml(decodeUtf8(readEntry(bytes, workbookEntry, limits), workbookEntry.name), workbookEntry.name);
  const sheets = firstChild(workbook, 'sheets');
  if (!sheets) fail('MALFORMED_XML', workbookEntry.name, '缺少 sheets 节点');
  const sheetNodes = childrenNamed(sheets, 'sheet');
  if (sheetNodes.length === 0) fail('MISSING_PART', workbookEntry.name, '工作簿没有工作表');

  const relationships = parseXml(decodeUtf8(readEntry(bytes, relsEntry, limits), relsEntry.name), relsEntry.name);
  const targets = new Map<string, string>();
  for (const relationship of childrenNamed(relationships, 'Relationship')) {
    const id = relationship.attrs.Id;
    const target = relationship.attrs.Target;
    const type = relationship.attrs.Type ?? '';
    if (!id || !target || (!type.endsWith('/worksheet') && !type.endsWith('/chartsheet'))) continue;
    targets.set(id, normalizePartPath(target, relsEntry.name));
  }

  const sheetNames: string[] = [];
  const sheetParts: string[] = [];
  for (const sheet of sheetNodes) {
    const name = sheet.attrs.name;
    const id = sheet.attrs.id;
    if (!name || !id) fail('MALFORMED_XML', workbookEntry.name, '工作表缺少名称或关系 ID');
    const part = targets.get(id);
    if (!part) fail('MISSING_PART', relsEntry.name, `工作表 ${name} 的关系 ${id} 不存在`);
    sheetNames.push(name);
    sheetParts.push(part);
  }
  return { entries, sheetNames, sheetParts };
}

function readSharedStrings(
  bytes: Uint8Array,
  entries: Map<string, ZipEntry>,
  limits: XlsxLimits,
): string[] {
  const entry = entries.get('xl/sharedStrings.xml');
  if (!entry) return [];
  const root = parseXml(decodeUtf8(readEntry(bytes, entry, limits), entry.name), entry.name);
  const values: string[] = [];
  for (const item of childrenNamed(root, 'si')) {
    if (values.length >= limits.maxRows * limits.maxColumns) {
      fail('TOO_MANY_CELLS', 'xl/sharedStrings.xml', '共享字符串数量超过网格上限');
    }
    values.push(textOf(item));
  }
  return values;
}

const CONTROL_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function columnIndexFromRef(ref: string, fallback: number): number {
  const matched = /^([A-Z]+)/.exec(ref);
  if (!matched) return fallback;
  let index = 0;
  for (const char of matched[1]) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

const EMPTY_CELL: XlsxCell = Object.freeze({ text: '', type: 'empty', hasFormula: false });

function readCell(
  cell: XmlNode,
  shared: readonly string[],
  limits: XlsxLimits,
  row: number,
  column: number,
): XlsxCell {
  const type = cell.attrs.t ?? 'n';
  const valueNode = firstChild(cell, 'v');
  const raw = valueNode ? textOf(valueNode) : '';
  let text = '';
  let cellType: XlsxCellType;
  if (type === 's') {
    const index = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(index) || index >= shared.length) {
      fail('INVALID_CELL', `cell[${row},${column}]`, '共享字符串下标越界', row, column);
    }
    text = shared[index];
    cellType = 'string';
  } else if (type === 'inlineStr') {
    const inline = firstChild(cell, 'is');
    text = inline ? textOf(inline) : '';
    cellType = 'string';
  } else if (type === 'str') {
    text = raw;
    cellType = 'string';
  } else if (type === 'b') {
    text = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
    cellType = 'boolean';
  } else if (type === 'e') {
    text = raw;
    cellType = 'error';
  } else if (type === 'n') {
    text = raw;
    cellType = raw === '' ? 'empty' : 'number';
  } else {
    fail('INVALID_CELL', `cell[${row},${column}]`, `不支持的单元格类型 ${type}`, row, column);
  }
  if (text.length > limits.maxCellChars) {
    fail('CELL_TOO_LARGE', `cell[${row},${column}]`, `单元格超过 ${limits.maxCellChars} 字符上限`, row, column);
  }
  if (CONTROL_CHAR.test(text)) {
    fail('INVALID_CELL', `cell[${row},${column}]`, '单元格包含非文本控制字符', row, column);
  }
  return { text, type: cellType, hasFormula: firstChild(cell, 'f') !== undefined };
}

function readSheet(
  bytes: Uint8Array,
  entry: ZipEntry,
  name: string,
  shared: readonly string[],
  limits: XlsxLimits,
): XlsxSheet {
  const root = parseXml(decodeUtf8(readEntry(bytes, entry, limits), entry.name), entry.name);
  const data = firstChild(root, 'sheetData');
  if (!data) fail('MALFORMED_XML', entry.name, '缺少 sheetData 节点');
  const rows: XlsxCell[][] = [];
  let cellCount = 0;
  for (const rowNode of childrenNamed(data, 'row')) {
    const declared = Number(rowNode.attrs.r);
    const rowIndex = Number.isInteger(declared) && declared >= 1 ? declared - 1 : rows.length;
    if (rowIndex >= limits.maxRows) fail('TOO_MANY_ROWS', entry.name, `行数超过 ${limits.maxRows} 行上限`, rowIndex + 1);
    while (rows.length <= rowIndex) rows.push([]);
    let nextColumn = 0;
    for (const cellNode of childrenNamed(rowNode, 'c')) {
      const column = columnIndexFromRef(cellNode.attrs.r ?? '', nextColumn);
      if (column >= limits.maxColumns) {
        fail('TOO_MANY_CELLS', entry.name, `列数超过 ${limits.maxColumns} 列上限`, rowIndex + 1, column + 1);
      }
      cellCount += 1;
      if (cellCount > limits.maxRows * limits.maxColumns) {
        fail('TOO_MANY_CELLS', entry.name, '单元格总数超过网格上限', rowIndex + 1, column + 1);
      }
      while (rows[rowIndex].length <= column) rows[rowIndex].push(EMPTY_CELL);
      rows[rowIndex][column] = readCell(cellNode, shared, limits, rowIndex + 1, column + 1);
      nextColumn = column + 1;
    }
  }
  const width = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  for (const row of rows) {
    while (row.length < width) row.push(EMPTY_CELL);
  }
  return deepFreeze({ name, rows });
}

/** 列出工作表名，供界面在工作簿上传后显式选择；失败时返回可定位问题。 */
export function inspectXlsx(bytes: Uint8Array, overrides?: Partial<XlsxLimits>): XlsxResult<readonly string[]> {
  try {
    const workbook = loadWorkbook(bytes, resolveLimits(overrides));
    return { ok: true, value: deepFreeze(workbook.sheetNames) };
  } catch (error) {
    return { ok: false, issues: [toIssue(error)] };
  }
}

/** 读取选定工作表；缓存文本原样返回并标记 hasFormula，不在本层求值。 */
export function readXlsxSheet(bytes: Uint8Array, options: ReadXlsxSheetOptions = {}): XlsxResult<XlsxWorkbook> {
  try {
    const limits = resolveLimits(options.limits);
    const workbook = loadWorkbook(bytes, limits);
    let index: number;
    if (options.sheet === undefined) {
      index = 0;
    } else if (typeof options.sheet === 'number') {
      index = options.sheet - 1;
    } else if (typeof options.sheet === 'string') {
      index = workbook.sheetNames.indexOf(options.sheet);
    } else {
      fail('INVALID_SHEET', 'sheet', 'sheet 必须是工作表名或 1 起始序号');
    }
    if (!Number.isInteger(index) || index < 0 || index >= workbook.sheetNames.length) {
      fail('SHEET_NOT_FOUND', 'sheet', '工作表不存在，请用 inspectXlsx 列出的名称选择');
    }
    const name = workbook.sheetNames[index];
    const part = workbook.sheetParts[index];
    if (!workbook.entries.has(part)) fail('MISSING_PART', part, '工作表 XML 不存在');
    const shared = readSharedStrings(bytes, workbook.entries, limits);
    const sheet = readSheet(bytes, workbook.entries.get(part) as ZipEntry, name, shared, limits);
    return { ok: true, value: deepFreeze({ sheetNames: workbook.sheetNames, sheet }) };
  } catch (error) {
    return { ok: false, issues: [toIssue(error)] };
  }
}
