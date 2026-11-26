/**
 * P2 数据集导入快照领域契约（P1 阻塞期可准备工作）。
 *
 * 把 plan.md P2「显式选 Excel 工作表与查询字段、冻结列名／行 ID／行顺序／
 * 内容校验值和来源元数据、固定文件／行数／单元格大小限制、验证缺列／重复列／
 * 非文本／空值／多行 CSV／UTF-8 BOM／Excel 公式」中不依赖上游的部分固化为纯逻辑：
 *  - CSV 文本解析支持 UTF-8 BOM、CRLF/LF、带引号字段、跨行字段与 "" 转义；
 *  - 行 ID 按行序稳定生成，内容校验值由列名、行 ID、行顺序与逐行文本稳定哈希；
 *  - 来源限定 excel/csv/feishu/sql，与 DatasetSnapshot.source 对齐，显式元数据；
 *  - 所有校验错误返回可定位的 code/field/行号，调用方据此给出字段级界面报错；
 *  - 只读取有明确列映射的文本值，公式单元格一律拒绝，不对其求值或缓存结果。
 *
 * 本模块不读取文件、不访问网络、不调用模型、不安装依赖。Excel 二进制的
 * 工作表读取由 xlsx.ts 提供，parseDatasetXlsx 将选定网格直接传给表格记录校验，
 * 与 CSV 共用一份取值与校验逻辑，避免两条导入路径的校验值和错误码分叉。
 */
import { createHash } from 'node:crypto';
import { deepFreeze, stableStringify, type DatasetSnapshot, type DatasetSource } from './resources.ts';
import {
  readXlsxSheet,
  DEFAULT_XLSX_LIMITS,
  type XlsxIssue,
  type XlsxLimits,
} from './xlsx.ts';

export type { DatasetSource } from './resources.ts';

/** 固定上限：文件字节、行数、单元格字符数；界面需显示这些值。 */
export interface ImportLimits {
  maxFileBytes: number;
  maxRows: number;
  maxCellChars: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = Object.freeze({
  maxFileBytes: 5 * 1024 * 1024,
  maxRows: 10_000,
  maxCellChars: 4_000,
});

export type ImportIssueCode =
  | 'MALFORMED_CSV'
  | 'EMPTY_DATASET'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_ROWS'
  | 'MISSING_COLUMN'
  | 'DUPLICATE_COLUMN'
  | 'QUERY_COLUMN_MISSING'
  | 'QUERY_VALUE_EMPTY'
  | 'ROW_WIDTH_MISMATCH'
  | 'CELL_TOO_LARGE'
  | 'NON_TEXT_CELL'
  | 'FORMULA_CELL'
  // xlsx.ts 的文件层问题原样映射，供界面在同一 issues 列表中定位。
  | 'NOT_ZIP'
  | 'MALFORMED_ZIP'
  | 'TOO_MANY_ENTRIES'
  | 'ENTRY_TOO_LARGE'
  | 'UNSUPPORTED_COMPRESSION'
  | 'MISSING_PART'
  | 'MALFORMED_XML'
  | 'SHEET_NOT_FOUND'
  | 'INVALID_SHEET'
  | 'TOO_MANY_CELLS'
  | 'INVALID_CELL'
  | 'PARSE_FAILED';

/** 可定位到列与 1 起始数据行号的解析错误；xlsx 文件层问题附带 1 起始列号。 */
export interface ImportIssue {
  code: ImportIssueCode;
  field: string;
  row?: number;
  column?: number;
  message: string;
}

export interface ImportRow {
  rowId: string;
  cells: Readonly<Record<string, string>>;
}

export interface DatasetImport {
  snapshot: DatasetSnapshot;
  rows: readonly ImportRow[];
  contentChecksum: string;
}

export type ImportResult =
  | { ok: true; value: DatasetImport }
  | { ok: false; issues: ImportIssue[] };

export interface ParseCsvOptions {
  /** 数据集名称；必填非空。 */
  name: string;
  /** 来源标记，默认 csv；四值之一，与 DatasetSnapshot.source 对齐。 */
  source?: DatasetSource;
  /** 显式查询列；必须是表头中的一列，且每行都有非空文本。 */
  queryColumn: string;
  /** 覆盖默认固定上限，便于测试与后续按部署配置调整。 */
  limits?: Partial<ImportLimits>;
  /**
   * 公式识别方式：默认按文本前缀（CSV 无元数据时的既有口径）。
   * xlsx 路径传入 external，改用工作表单元格的 hasFormula 标记，避免重复报错
   * 或把以 = 开头的普通文本误判为公式。
   */
  formulaDetection?: 'prefix' | 'external';
}

export interface ParseXlsxOptions {
  /** 数据集名称；必填非空。 */
  name: string;
  /** 来源标记，默认 excel；四值之一，与 DatasetSnapshot.source 对齐。 */
  source?: DatasetSource;
  /** 显式查询列；必须是表头中的一列，且每行都有非空文本。 */
  queryColumn: string;
  /**
   * 显式工作表名或 1 起始序号；省略时读第一张。
   * 界面应先调用 inspectXlsx 列出表名让用户确认，不以默认选择代替显式确认。
   */
  sheet?: string | number;
  /** 读取上限；与 CSV 共用的字节／行数／单元格键同时约束导入校验。 */
  limits?: Partial<XlsxLimits>;
}

const SOURCES: DatasetSource[] = ['excel', 'csv', 'feishu', 'sql'];
/** Excel 公式前缀：以 = + - @ 开头的单元格视为公式，不读取其计算结果。 */
const FORMULA_PREFIX = /^[=+\-@]/;
/** 纯数值（含负号与小数）是内容而非公式，避免把 -1 误判为公式。 */
const NUMERIC_VALUE = /^[+-]?\d+(\.\d+)?$/;
/** 控制字符（含 NUL）视为非文本；换行由 CSV 解析处理，不在此列。 */
const CONTROL_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function issue(
  code: ImportIssueCode,
  field: string,
  message: string,
  row?: number,
  column?: number,
): ImportIssue {
  const result: ImportIssue = { code, field, message };
  if (row !== undefined) result.row = row;
  if (column !== undefined) result.column = column;
  return result;
}

function resolveLimits(overrides?: Partial<ImportLimits>): ImportLimits {
  return { ...DEFAULT_IMPORT_LIMITS, ...overrides };
}

/**
 * 解析一段 CSV 文本为带稳定行 ID 的表格。表头取第一条非空记录；
 * 空记录（仅含空字符串的一行）在数据区被跳过，避免尾部换行制造幽灵行。
 */
function parseCsvRecords(text: string): string[][] | ImportIssue {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let closedQuote = false;
  let recordHadContent = false;
  const pushRecord = (): void => {
    closedQuote = false;
    row.push(field);
    field = '';
    if (recordHadContent || row.some((cell) => cell !== '')) records.push(row);
    row = [];
    recordHadContent = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        field += char;
      }
      continue;
    }
    if ((closedQuote && ![',', '\r', '\n'].includes(char)) || (char === '"' && field !== '')) {
      return issue('MALFORMED_CSV', 'file', 'CSV 引号位置无效', records.length, row.length + 1);
    }
    if (char === '"' && field === '') {
      inQuotes = true;
      recordHadContent = true;
      continue;
    }
    if (char === ',') {
      closedQuote = false;
      row.push(field);
      field = '';
      recordHadContent = true;
      continue;
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      pushRecord();
      continue;
    }
    field += char;
    recordHadContent = true;
  }
  if (inQuotes) {
    return issue('MALFORMED_CSV', 'file', 'CSV 引号未闭合', records.length, row.length + 1);
  }
  pushRecord();
  return records;
}

function rowId(index: number): string {
  return `R${String(index + 1).padStart(6, '0')}`;
}

export function contentChecksumOf(
  columns: string[],
  ids: string[],
  rows: readonly ImportRow[],
  queryColumn: string,
  source: DatasetSource,
): string {
  return createHash('sha256')
    .update(stableStringify({ columns, rowIds: ids, rows, queryColumn, source }), 'utf8')
    .digest('hex');
}

/**
 * 把 CSV 文本解析为可写入版本目录的数据集快照。
 * 失败时返回全部定位信息且不产出快照，调用方保留草稿供修正。
 */
export function parseDatasetCsv(rawText: string, options: ParseCsvOptions): ImportResult {
  const issues: ImportIssue[] = [];
  const limits = resolveLimits(options.limits);
  // UTF-8 BOM 位于文本起始时剥除，避免污染首列表头。
  const text = rawText.charCodeAt(0) === 0xFEFF ? rawText.slice(1) : rawText;
  const bytes = Buffer.byteLength(rawText, 'utf8');
  if (bytes === 0) issues.push(issue('EMPTY_FILE', 'file', '文件为空'));
  if (bytes > limits.maxFileBytes) {
    issues.push(issue('FILE_TOO_LARGE', 'file', `文件超过 ${limits.maxFileBytes} 字节上限`));
  }

  const records = parseCsvRecords(text);
  if (!Array.isArray(records)) return { ok: false, issues: [...issues, records] };
  return parseRecords(records, options, limits, issues);
}

function parseRecords(records: string[][], options: ParseCsvOptions, limits: ImportLimits, issues: ImportIssue[]): ImportResult {
  const source = options.source ?? 'csv';
  if (!options?.name?.trim()) issues.push(issue('MISSING_COLUMN', 'name', '数据集名称不能为空'));
  if (!SOURCES.includes(source)) issues.push(issue('NON_TEXT_CELL', 'source', '来源必须是 excel/csv/feishu/sql 之一'));
  if (!options?.queryColumn?.trim()) issues.push(issue('QUERY_COLUMN_MISSING', 'queryColumn', '必须指定查询列'));

  const header = records[0] ?? [];
  const columns = header.map((cell) => cell.trim());
  if (columns.length === 0 || columns.every((cell) => cell === '')) {
    if (!issues.some((entry) => entry.code === 'EMPTY_FILE')) issues.push(issue('MISSING_COLUMN', 'header', '缺少表头列'));
  } else {
    columns.forEach((column, index) => {
      if (!column) issues.push(issue('MISSING_COLUMN', `column[${index}]`, '列名不能为空'));
    });
    const seen = new Set<string>();
    columns.forEach((column) => {
      if (seen.has(column)) issues.push(issue('DUPLICATE_COLUMN', column, '列名重复', 0));
      seen.add(column);
    });
    if (options.queryColumn && !columns.includes(options.queryColumn)) {
      issues.push(issue('QUERY_COLUMN_MISSING', options.queryColumn, '查询列不在表头中', 0));
    }
  }

  const dataRecords = records.slice(1);
  if (records.length === 1) issues.push(issue('EMPTY_DATASET', 'file', '数据集至少需要一条样本'));
  if (dataRecords.length > limits.maxRows) {
    issues.push(issue('TOO_MANY_ROWS', 'file', `行数超过 ${limits.maxRows} 行上限`));
  }

  const ids: string[] = [];
  const rows: ImportRow[] = [];
  dataRecords.forEach((record, index) => {
    const rowNumber = index + 1;
    if (record.length !== columns.length) {
      issues.push(issue(
        'ROW_WIDTH_MISMATCH',
        `row[${rowNumber}]`,
        `该行 ${record.length} 列，表头 ${columns.length} 列`,
        rowNumber,
      ));
    }
    const cells = Object.fromEntries(columns.map((column, i) => [column, record[i] ?? '']));
    columns.forEach((column, columnIndex) => {
      if (!column) return;
      const value = record[columnIndex] ?? '';
      if (value.length > limits.maxCellChars) {
        issues.push(issue('CELL_TOO_LARGE', column, `单元格超过 ${limits.maxCellChars} 字符上限`, rowNumber));
      }
      if (CONTROL_CHAR.test(value)) {
        issues.push(issue('NON_TEXT_CELL', column, '单元格包含非文本控制字符', rowNumber));
      }
      const trimmedValue = value.trim();
      if (
        options.formulaDetection !== 'external'
        && FORMULA_PREFIX.test(trimmedValue)
        && !NUMERIC_VALUE.test(trimmedValue)
      ) {
        issues.push(issue('FORMULA_CELL', column, '公式单元格不参与导入', rowNumber));
      }
      if (column === options.queryColumn && !value.trim()) {
        issues.push(issue('QUERY_VALUE_EMPTY', column, '查询值不能为空', rowNumber));
      }
    });
    ids.push(rowId(index));
    rows.push({ rowId: rowId(index), cells });
  });

  if (issues.length > 0) return { ok: false, issues };
  const checksum = contentChecksumOf(columns, ids, rows, options.queryColumn, source);
  const snapshot: DatasetSnapshot = {
    name: options.name.trim(),
    source,
    columns,
    rowIds: ids,
    rowCount: rows.length,
    queryColumn: options.queryColumn,
    contentChecksum: checksum,
  };
  return {
    ok: true,
    value: deepFreeze({ snapshot, rows, contentChecksum: checksum }),
  };
}

function xlsxColumnLabel(index: number): string {
  let value = index + 1;
  let label = '';
  while (value > 0) {
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

/** xlsx.ts 的文件层问题进入同一 issues 列表，保留行列定位信息。 */
export function xlsxIssuesToImport(issues: readonly XlsxIssue[]): ImportIssue[] {
  return issues.map((entry) => {
    const mapped: ImportIssue = {
      code: entry.code as ImportIssueCode,
      field: entry.field,
      message: entry.message,
    };
    if (entry.row !== undefined) mapped.row = entry.row;
    if (entry.column !== undefined) mapped.column = entry.column;
    return mapped;
  });
}

interface FormulaCellLocation {
  field: string;
  row?: number;
  column: number;
}

/**
 * 把显式选定的 Excel 工作表网格解析为与 CSV 同口径的数据集导入结果。
 *
 * 网格和 CSV 解析出的记录共用 parseRecords 做列名、查询列、行 ID、内容校验值与上限校验。这样 Excel 与
 * CSV 两条路径共用同一份实现，同名同内容的表格只在 source 上区分校验值。
 * 完全空行按 CSV 口径跳过，不产生幽灵行与多余行 ID。
 *
 * xlsx.ts 已按原始文件校验字节、解压、行列与单元格上限，因此归一化文本不再
 * 套用文件字节上限；公式单元格按既有「公式单元格不参与导入」决策一律拒绝，
 * 缓存值即使看起来像普通文本也不作为本次评分的输入证据。
 */
export function parseDatasetXlsx(bytes: Uint8Array, options: ParseXlsxOptions): ImportResult {
  const name = options?.name ?? '';
  const queryColumn = options?.queryColumn ?? '';
  const source = options?.source ?? 'excel';
  const limits: XlsxLimits = { ...DEFAULT_XLSX_LIMITS, ...(options?.limits ?? {}) };
  const workbook = readXlsxSheet(bytes, {
    ...(options?.sheet === undefined ? {} : { sheet: options.sheet }),
    limits: { ...limits, maxRows: limits.maxRows + 1 }, // 工作表另含一行表头。
  });
  if (!workbook.ok) return { ok: false, issues: xlsxIssuesToImport(workbook.issues) };

  const records: string[][] = [];
  const formulas: FormulaCellLocation[] = [];
  for (const sheetRow of workbook.value.sheet.rows) {
    const values = sheetRow.map((cell) => cell.text);
    if (sheetRow.every((cell) => !cell.text && !cell.hasFormula)) continue;
    const isHeader = records.length === 0;
    const dataRow = isHeader ? undefined : records.length;
    sheetRow.forEach((cell, index) => {
      if (!cell.hasFormula) return;
      formulas.push({
        field: xlsxColumnLabel(index),
        ...(dataRow === undefined ? {} : { row: dataRow }),
        column: index + 1,
      });
    });
    records.push(values);
  }

  const parsed = parseRecords(records, { name, source, queryColumn, formulaDetection: 'external' }, limits, []);

  if (formulas.length > 0) {
    const formulaIssues = formulas.map((cell) =>
      issue(
        'FORMULA_CELL',
        cell.field,
        cell.row === undefined ? '表头公式单元格不参与导入' : '公式单元格不参与导入',
        cell.row,
        cell.column,
      ),
    );
    return { ok: false, issues: [...(parsed.ok ? [] : parsed.issues), ...formulaIssues] };
  }
  return parsed;
}
