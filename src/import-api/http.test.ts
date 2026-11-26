/**
 * 数据集导入接口 HTTP 挂载测试：
 *   node --test src/import-api/http.test.ts
 * 仅监听 127.0.0.1 临时端口，临时库位于系统临时目录；
 * 不启动 Docker、不安装依赖、不访问上游或模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { ResourceCatalog } from '../domain/resources.ts';
import { InMemoryDatasetRowStore } from '../domain/dataset-rows.ts';
import { createResourceHttpServer } from '../resource-api/http.ts';
import { openSqliteResourceCatalog } from '../storage/sqlite-resource-store.ts';
import { openSqliteDatasetRowStore } from '../storage/sqlite-dataset-rows.ts';
import {
  createImportHttpServer,
  InMemorySessionStore,
  SESSION_COOKIE,
  type ImportHttpOptions,
  type SessionStore,
} from './http.ts';
import type { DatasetImportInput, DatasetXlsxImportInput } from './handlers.ts';
import { buildXlsxBytes, sampleSheetXml, sampleXlsxBase64 } from './xlsx-test-fixture.ts';

const A = 'acct-A';
const B = 'acct-B';
const REF = { id: 'ds/import', version: 'v1' };
const CSV = 'query,answer\n你好吗,我很好\n"多行,查询","他说""你好"""\n';
const NOW = () => '2026-11-24T19:00:00+08:00';

function body(overrides: Partial<DatasetImportInput> = {}): DatasetImportInput {
  return { id: REF.id, version: REF.version, name: '客服样本', queryColumn: 'query', csv: CSV, ...overrides };
}

interface Reply {
  status: number;
  body: any;
  headers: Headers;
}

async function start(
  t: { after: (fn: () => void) => void },
  options: ImportHttpOptions = {},
): Promise<{ base: string; sessions: SessionStore; request: (method: string, path: string, opts?: {
  token?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>;
}) => Promise<Reply> }> {
  const sessions = options.sessions ?? new InMemorySessionStore();
  const catalog = new ResourceCatalog(NOW);
  const server: Server = createImportHttpServer(catalog, new InMemoryDatasetRowStore(), {
    ...options,
    sessions,
    now: NOW,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.closeAllConnections());
  t.after(() => { server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(method: string, path: string, opts: {
    token?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>;
  } = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.token) headers.cookie = `${SESSION_COOKIE}=${opts.token}`;
    if (opts.body !== undefined || opts.rawBody !== undefined) {
      headers['content-type'] = headers['content-type'] ?? 'application/json';
    }
    const init: RequestInit = { method, headers };
    if (opts.rawBody !== undefined) init.body = opts.rawBody;
    else if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const response = await fetch(`${base}${path}`, init);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  }
  return { base, sessions, request };
}

function rowsPath(ref: { id: string; version: string } = REF): string {
  return `/api/imports/dataset/${encodeURIComponent(ref.id)}/${encodeURIComponent(ref.version)}/rows`;
}

test('POST 导入后 GET 逐字段一致，重放 200 带 x-replayed，响应禁止缓存', async (t) => {
  const { sessions, request } = await start(t);
  const token = sessions.create(A);
  const created = await request('POST', '/api/imports/dataset', { token, body: body() });
  assert.equal(created.status, 201);
  assert.equal(created.body.ownerAccountId, A);
  assert.equal(created.body.rowCount, 2);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.equal(created.headers.get('x-replayed'), null);

  const replay = await request('POST', '/api/imports/dataset', { token, body: body({ ownerAccountId: B }) });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('x-replayed'), 'true');
  assert.deepEqual(replay.body, created.body);

  const rows = await request('GET', rowsPath(), { token });
  assert.equal(rows.status, 200);
  assert.equal(rows.headers.get('cache-control'), 'no-store');
  assert.equal(rows.body.rowCount, 2);
  assert.equal(rows.body.rows[0].cells.query, '你好吗');
  assert.equal(rows.body.rows[1].cells.query, '多行,查询');
  assert.equal(rows.body.rows[1].cells.answer, '他说"你好"');
});

function xlsxBody(overrides: Partial<DatasetXlsxImportInput> = {}): DatasetXlsxImportInput {
  return { id: REF.id, version: REF.version, name: '客服样本', queryColumn: 'query', xlsxBase64: sampleXlsxBase64(), ...overrides };
}

test('POST Excel 导入后 GET 行一致，选表与重放幂等，响应禁止缓存', async (t) => {
  const { sessions, request } = await start(t);
  const token = sessions.create(A);
  const created = await request('POST', '/api/imports/dataset/xlsx', { token, body: xlsxBody({ ownerAccountId: B }) });
  assert.equal(created.status, 201);
  assert.equal(created.body.ownerAccountId, A);
  assert.equal(created.body.source, 'excel');
  assert.equal(created.body.rowCount, 2);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.equal(created.headers.get('x-replayed'), null);

  const replay = await request('POST', '/api/imports/dataset/xlsx', { token, body: xlsxBody() });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('x-replayed'), 'true');
  assert.deepEqual(replay.body, created.body);

  const rows = await request('GET', rowsPath(), { token });
  assert.equal(rows.status, 200);
  assert.equal(rows.body.rows[0].cells.query, '你好吗');
  assert.equal(rows.body.rows[1].cells.answer, '见帮助中心');

  const bytes = buildXlsxBytes([
    { name: '样本', xml: sampleSheetXml() },
    { name: '备份', xml: '<row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">query</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve">备份行</t></is></c></row>' },
  ]);
  const sheet = await request('POST', '/api/imports/dataset/xlsx', {
    token, body: xlsxBody({ id: 'ds-sheet', sheet: '备份', xlsxBase64: Buffer.from(bytes).toString('base64') }),
  });
  assert.equal(sheet.status, 201);
  const sheetRows = await request('GET', rowsPath({ id: 'ds-sheet', version: REF.version }), { token });
  assert.equal(sheetRows.body.rows[0].cells.query, '备份行');
});

test('Excel 路由：未登录 401、撤销后 401、错误 base64/sheet 400、公式 422、方法 405', async (t) => {
  const { sessions, request } = await start(t);
  const token = sessions.create(A);
  const anonymous = await request('POST', '/api/imports/dataset/xlsx', { body: xlsxBody({ ownerAccountId: A }) });
  assert.equal(anonymous.status, 401);
  const forged = await request('POST', '/api/imports/dataset/xlsx', { body: xlsxBody(), token: 'forged' });
  assert.equal(forged.status, 401);

  const badBase64 = await request('POST', '/api/imports/dataset/xlsx', { token, body: xlsxBody({ xlsxBase64: 'bad' }) });
  assert.equal(badBase64.status, 400);
  assert.equal(badBase64.body.code, 'INVALID_INPUT');
  assert.equal((await request('POST', '/api/imports/dataset/xlsx', { token, body: xlsxBody({ sheet: 0 }) })).status, 400);

  const formulaXml = sampleSheetXml().replace(
    '<c r="B2" t="inlineStr"><is><t xml:space="preserve">我很好</t></is></c>',
    '<c r="B2" t="str"><f>1+1</f><v>我很好</v></c>',
  );
  const formula = await request('POST', '/api/imports/dataset/xlsx', {
    token, body: xlsxBody({ xlsxBase64: Buffer.from(buildXlsxBytes([{ name: '样本', xml: formulaXml }])).toString('base64') }),
  });
  assert.equal(formula.status, 422);
  assert.equal(formula.body.code, 'IMPORT_INVALID');
  assert.ok(formula.body.issues.some((issue: any) => issue.code === 'FORMULA_CELL'));

  const wrongMethod = await request('GET', '/api/imports/dataset/xlsx', { token });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');

  sessions.invalidate(token);
  assert.equal((await request('POST', '/api/imports/dataset/xlsx', { token, body: xlsxBody() })).status, 401);
});

test('会话是唯一身份来源：未登录、伪造令牌与自报账号均无效，撤销后立即 401', async (t) => {
  const { sessions, request } = await start(t);
  const token = sessions.create(A);
  const anonymous = await request('POST', '/api/imports/dataset', { body: body({ ownerAccountId: A }), token: 'forged' });
  assert.equal(anonymous.status, 401);
  assert.equal((await request('GET', rowsPath(), { token: 'forged' })).status, 401);
  const created = await request('POST', '/api/imports/dataset', { token, body: body({ ownerAccountId: B }) });
  assert.equal(created.status, 201);
  assert.equal(created.body.ownerAccountId, A);
  sessions.invalidate(token);
  assert.equal((await request('GET', rowsPath(), { token })).status, 401);
  assert.equal((await request('POST', '/api/imports/dataset', { token, body: body() })).status, 401);
});

test('请求体错误稳定映射为 400/415/413，不写入数据', async (t) => {
  const { sessions, request } = await start(t, { maxBodyBytes: 120 });
  const token = sessions.create(A);
  const badJson = await request('POST', '/api/imports/dataset', { token, rawBody: '{坏JSON' });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.code, 'BAD_REQUEST');
  const empty = await request('POST', '/api/imports/dataset', { token, rawBody: '' });
  assert.equal(empty.status, 400);
  const array = await request('POST', '/api/imports/dataset', { token, body: [] });
  assert.equal(array.status, 400);
  const wrongType = await request('POST', '/api/imports/dataset', {
    token, rawBody: '{}', headers: { 'content-type': 'text/plain' },
  });
  assert.equal(wrongType.status, 415);
  const tooLarge = await request('POST', '/api/imports/dataset', { token, body: body() });
  assert.equal(tooLarge.status, 413);
  assert.equal((await request('GET', rowsPath(), { token })).status, 404);
});

test('解析失败回带 issues 的 422，版本内容变更回 409 且原数据不变', async (t) => {
  const { sessions, request } = await start(t);
  const token = sessions.create(A);
  const invalid = await request('POST', '/api/imports/dataset', {
    token, body: body({ csv: 'query,answer\n,空查询\n' }),
  });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.code, 'IMPORT_INVALID');
  assert.ok(invalid.body.issues.some((issue: any) => issue.code === 'QUERY_VALUE_EMPTY' && issue.row === 1));
  assert.equal((await request('GET', rowsPath(), { token })).status, 404);

  const first = await request('POST', '/api/imports/dataset', { token, body: body() });
  assert.equal(first.status, 201);
  const conflict = await request('POST', '/api/imports/dataset', { token, body: body({ name: '改名' }) });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'VERSION_CONFLICT');
  const rows = await request('GET', rowsPath(), { token });
  assert.equal(rows.body.rows[0].cells.answer, '我很好');
});

test('行读取跨账号与不存在统一 404，路径编码、方法与未知路由稳定', async (t) => {
  const { sessions, request } = await start(t);
  const tokenA = sessions.create(A);
  const tokenB = sessions.create(B);
  assert.equal((await request('POST', '/api/imports/dataset', { token: tokenA, body: body() })).status, 201);
  const foreign = await request('GET', rowsPath(), { token: tokenB });
  const missing = await request('GET', rowsPath({ id: '不存在', version: 'v1' }), { token: tokenA });
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(foreign.body, missing.body);
  const wrongMethod = await request('POST', rowsPath(), { token: tokenA, body: {} });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET');
  const getCollection = await request('GET', '/api/imports/dataset', { token: tokenA });
  assert.equal(getCollection.status, 405);
  assert.equal(getCollection.headers.get('allow'), 'POST');
  assert.equal((await request('GET', '/api/imports/unknown', { token: tokenA })).status, 404);
});

test('SQLite 关库重开后重放幂等、行逐字段一致，另一账号仍查不到', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-import-http-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'eval.sqlite');
  const catalog = openSqliteResourceCatalog(dbPath, { now: NOW });
  const rowStore = openSqliteDatasetRowStore(dbPath);
  const sessions = new InMemorySessionStore();
  const tokenA = sessions.create(A);
  const tokenB = sessions.create(B);
  const server = createImportHttpServer(catalog, rowStore, { sessions, now: NOW });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.closeAllConnections());
  t.after(() => { server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = async (method: string, path: string, token: string, data?: unknown): Promise<Reply> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        cookie: `${SESSION_COOKIE}=${token}`,
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };

  const first = await send('POST', '/api/imports/dataset', tokenA, body());
  assert.equal(first.status, 201);
  catalog.close();
  rowStore.db.close();

  const reopenedCatalog = openSqliteResourceCatalog(dbPath, { now: NOW });
  const reopenedRows = openSqliteDatasetRowStore(dbPath);
  const reopenedServer = createImportHttpServer(reopenedCatalog, reopenedRows, { sessions, now: NOW });
  await new Promise<void>((resolve) => reopenedServer.listen(0, '127.0.0.1', resolve));
  t.after(() => reopenedServer.closeAllConnections());
  t.after(() => {
    reopenedServer.close();
    reopenedCatalog.close();
    reopenedRows.db.close();
  });
  const reopenedBase = `http://127.0.0.1:${(reopenedServer.address() as AddressInfo).port}`;
  const sendReopened = async (method: string, path: string, token: string, data?: unknown): Promise<Reply> => {
    const response = await fetch(`${reopenedBase}${path}`, {
      method,
      headers: {
        cookie: `${SESSION_COOKIE}=${token}`,
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };

  const resources = createResourceHttpServer(reopenedCatalog, { sessions });
  await new Promise<void>((resolve) => resources.listen(0, '127.0.0.1', resolve));
  t.after(() => { resources.closeAllConnections(); resources.close(); });
  const copyUrl = `http://127.0.0.1:${(resources.address() as AddressInfo).port}/api/resources/dataset/${encodeURIComponent(REF.id)}/${REF.version}/copy`;
  const copy = () => fetch(copyUrl, {
    method: 'POST', headers: { authorization: 'Bearer ' + tokenA, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'copied', version: 'v2' }),
  });
  assert.equal((await copy()).status, 201);
  assert.equal((await copy()).headers.get('x-replayed'), 'true');
  const copiedRows = await sendReopened('GET', '/api/imports/dataset/copied/v2/rows', tokenA);
  assert.equal(copiedRows.status, 200);
  const sourceRows = await sendReopened('GET', rowsPath(), tokenA);
  assert.deepEqual(copiedRows.body.rows, sourceRows.body.rows);
  assert.equal((await sendReopened('GET', '/api/imports/dataset/copied/v2/rows', tokenB)).status, 404);

  const replay = await sendReopened('POST', '/api/imports/dataset', tokenA, body());
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('x-replayed'), 'true');
  assert.deepEqual(replay.body, first.body);
  const rows = await sendReopened('GET', rowsPath(), tokenA);
  assert.equal(rows.status, 200);
  assert.equal(rows.body.rows[1].cells.answer, '他说"你好"');
  const other = await sendReopened('GET', rowsPath(), tokenB);
  assert.equal(other.status, 404);
});

const SHEETS_PATH = '/api/imports/dataset/xlsx/sheets';

test('工作表候选接口按会话列出表名，不写资源且响应禁止缓存', async (t) => {
  const { sessions, request } = await start(t);
  const token = sessions.create(A);
  const bytes = buildXlsxBytes([
    { name: '样本', xml: sampleSheetXml() },
    { name: '备份 & 归档', xml: '<row r="1"><c r="A1" t="inlineStr"><is><t>query</t></is></c></row>' },
  ]);
  const listed = await request('POST', SHEETS_PATH, {
    token,
    body: { xlsxBase64: Buffer.from(bytes).toString('base64'), ownerAccountId: B },
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.sheets, ['样本', '备份 & 归档']);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  assert.equal(listed.headers.get('x-replayed'), null);
  assert.equal((await request('GET', rowsPath(), { token })).status, 404);
});

test('工作表候选接口：会话、方法、媒体类型与坏文件边界稳定', async (t) => {
  const { base, sessions, request } = await start(t);
  const token = sessions.create(A);
  const payload = { xlsxBase64: sampleXlsxBase64() };
  assert.equal((await request('POST', SHEETS_PATH, { body: payload })).status, 401);
  assert.equal((await request('POST', SHEETS_PATH, { token: 'forged', body: payload })).status, 401);
  const wrongMethod = await request('GET', SHEETS_PATH, { token });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  assert.equal((await request('POST', SHEETS_PATH, {
    token, rawBody: '{}', headers: { 'content-type': 'text/plain' },
  })).status, 415);
  assert.equal((await request('POST', SHEETS_PATH, { token, body: { xlsxBase64: 'bad%' } })).status, 400);
  const broken = await request('POST', SHEETS_PATH, {
    token, body: { xlsxBase64: Buffer.from('普通文本').toString('base64') },
  });
  assert.equal(broken.status, 422);
  assert.ok(broken.body.issues.some((issue: any) => issue.code === 'NOT_ZIP' || issue.code === 'MALFORMED_ZIP'));

  const tokenB = sessions.create(B);
  const bearer = await fetch(`${base}${SHEETS_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenB}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(bearer.status, 200);
  assert.deepEqual((await bearer.json()).sheets, ['样本']);
  sessions.invalidate(tokenB);
  assert.equal((await request('POST', SHEETS_PATH, { token: tokenB, body: payload })).status, 401);
});
