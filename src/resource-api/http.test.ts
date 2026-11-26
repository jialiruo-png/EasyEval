/**
 * 资源管理接口 HTTP 挂载测试：
 *   node --test src/resource-api/http.test.ts
 * 仅监听 127.0.0.1 的临时端口；不启动 Docker、不访问上游、不调用模型。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import {
  ResourceCatalog,
  type DatasetSnapshot,
  type ScenarioConfigSnapshot,
  type TaskBinding,
} from '../domain/resources.ts';
import { processQualityRule } from '../result-contract/fixtures.ts';
import { openSqliteResourceCatalog } from '../storage/sqlite-resource-store.ts';
import { createResourceHttpServer, InMemorySessionStore, SESSION_COOKIE } from './http.ts';

const A = 'acct-A';
const B = 'acct-B';
const SCENARIO = { id: 'sc-harness', version: 'v1' };
const DATASET = { id: 'ds-support', version: 'v3' };
const RULE = { id: processQualityRule.id, version: processQualityRule.version };
const TASK = { id: 'task-regression', version: 'v1' };

function scenarioSnapshot(): ScenarioConfigSnapshot {
  return {
    name: 'DeepSeek Harness',
    profile: 'deepseek-harness',
    modelConfigRef: 'model-profile-A',
    toolWhitelist: ['read_file', 'calculator'],
  };
}

function datasetSnapshot(): DatasetSnapshot {
  return {
    name: '客服样本集',
    source: 'excel',
    columns: ['query', 'answer'],
    rowIds: ['R1', 'R2', 'R3'],
    rowCount: 3,
    queryColumn: 'query',
    contentChecksum: 'sha256:abc123',
  };
}

function binding(overrides: Partial<TaskBinding> = {}): TaskBinding {
  return {
    name: '过程质量回归评测',
    scenario: { ...SCENARIO },
    dataset: { ...DATASET },
    rule: { ...RULE },
    schedule: { enabled: false, timezone: 'Asia/Shanghai' },
    variableMappings: [{ placeholder: '{{query}}', source: 'dataset', path: 'query' }],
    ...overrides,
  };
}

let server: Server;
let base: string;
let sessions: InMemorySessionStore;
let tokenA: string;
let tokenB: string;

before(async () => {
  const catalog = new ResourceCatalog(() => '2026-11-24T12:00:00+08:00');
  catalog.putScenario(A, SCENARIO, scenarioSnapshot());
  catalog.putScenario(A, { id: 'sc-harness', version: 'v2' }, scenarioSnapshot());
  catalog.putScenario(B, { id: 'sc-other', version: 'v1' }, scenarioSnapshot());
  catalog.putDataset(A, DATASET, datasetSnapshot());
  catalog.putRule(A, RULE, processQualityRule);
  assert.equal(catalog.createTaskConfig(A, TASK, binding()).ok, true);

  sessions = new InMemorySessionStore();
  tokenA = sessions.create(A);
  tokenB = sessions.create(B);
  server = createResourceHttpServer(catalog, { sessions });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Reply {
  status: number;
  body: any;
  headers: Headers;
}

async function request(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string>; rawBody?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.cookie = `${SESSION_COOKIE}=${options.token}`;
  if (options.body !== undefined || options.rawBody !== undefined) {
    headers['content-type'] = headers['content-type'] ?? 'application/json';
  }
  const init: RequestInit = { method, headers };
  if (options.rawBody !== undefined) init.body = options.rawBody;
  else if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

const get = (path: string, token?: string) => request('GET', path, { token });
const post = (path: string, body: unknown, token?: string) => request('POST', path, { token, body });

test('未登录与伪造会话：列表、详情、写入均 401，自报账号不能切换身份', async () => {
  const paths = ['/api/resources/scenario', '/api/resources/scenario/sc-harness/v1'];
  for (const path of paths) {
    assert.equal((await get(path)).status, 401);
    assert.equal((await get(path, 'not-a-token')).status, 401);
    assert.equal((await request('GET', path, { headers: { authorization: 'Bearer not-a-token' } })).status, 401);
  }
  const write = await post('/api/resources/scenario', { id: 'sc-fake', version: 'v1', snapshot: scenarioSnapshot() });
  assert.equal(write.status, 401);

  const spoofed = await get('/api/resources/scenario?accountId=acct-B', tokenA);
  assert.equal(spoofed.status, 200);
  assert.ok(spoofed.body.items.every((item: any) => item.ownerAccountId === A));
});

test('GET 列表：只返回本人版本，按 id/version 稳定排序，新账号为空', async () => {
  const own = await get('/api/resources/scenario', tokenA);
  assert.equal(own.status, 200);
  assert.equal(own.body.kind, 'scenario');
  assert.equal(own.body.total, 2);
  assert.deepEqual(own.body.items.map((item: any) => [item.id, item.version]), [
    ['sc-harness', 'v1'], ['sc-harness', 'v2'],
  ]);

  const other = await get('/api/resources/scenario', tokenB);
  assert.deepEqual(other.body.items.map((item: any) => item.id), ['sc-other']);
  const empty = await get('/api/resources/dataset', sessions.create('acct-empty'));
  assert.equal(empty.body.total, 0);
  assert.deepEqual(empty.body.items, []);
});

test('GET 详情：四类资源可读；越权与不存在统一 404', async () => {
  const detail = await get('/api/resources/scenario/sc-harness/v1', tokenA);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.ownerAccountId, A);
  assert.deepEqual(detail.body.snapshot, scenarioSnapshot());
  assert.match(detail.body.contentHash, /^[0-9a-f]{64}$/);

  for (const [path, kind] of [
    ['/api/resources/dataset/ds-support/v3', 'dataset'],
    ['/api/resources/rule/' + encodeURIComponent(RULE.id) + '/' + RULE.version, 'rule'],
    ['/api/resources/task/task-regression/v1', 'task'],
  ]) {
    const reply = await get(path, tokenA);
    assert.equal(reply.status, 200, kind);
    assert.equal(reply.body.kind, kind);
  }

  const forbidden = await get('/api/resources/scenario/sc-harness/v1', tokenB);
  const missing = await get('/api/resources/scenario/sc-none/v1', tokenB);
  assert.equal(forbidden.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(forbidden.body, missing.body);
});

test('POST 写入：201 落盘，归属只来自会话，请求体自称归属被忽略', async () => {
  const reply = await post('/api/resources/scenario', {
    id: 'sc-new', version: 'v1', snapshot: scenarioSnapshot(), ownerAccountId: B,
  }, tokenA);
  assert.equal(reply.status, 201);
  assert.equal(reply.headers.get('x-replayed'), null);
  assert.equal(reply.body.ownerAccountId, A);
  assert.deepEqual((await get('/api/resources/scenario/sc-new/v1', tokenA)).body.snapshot, scenarioSnapshot());
  assert.equal((await get('/api/resources/scenario/sc-new/v1', tokenB)).status, 404);
});

test('POST 幂等与不可变：同内容乱序 200 + x-replayed，改内容或换归属 409', async () => {
  const reordered = await post('/api/resources/scenario', {
    id: 'sc-new',
    version: 'v1',
    snapshot: {
      toolWhitelist: ['read_file', 'calculator'],
      modelConfigRef: 'model-profile-A',
      profile: 'deepseek-harness',
      name: 'DeepSeek Harness',
    },
  }, tokenA);
  assert.equal(reordered.status, 200);
  assert.equal(reordered.headers.get('x-replayed'), 'true');

  const changed = await post('/api/resources/scenario', {
    id: 'sc-new', version: 'v1', snapshot: { ...scenarioSnapshot(), profile: 'other-profile' },
  }, tokenA);
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'VERSION_CONFLICT');

  const otherOwner = await post('/api/resources/scenario', {
    id: 'sc-new', version: 'v1', snapshot: scenarioSnapshot(),
  }, tokenB);
  assert.equal(otherOwner.status, 409);
  assert.equal((await get('/api/resources/scenario', tokenA)).body.total, 3);
});

test('POST 非法快照与任务绑定错误：422 带逐字段 issues 且不落库', async () => {
  const badDataset = await post('/api/resources/dataset', {
    id: 'ds-bad', version: 'v1', snapshot: { ...datasetSnapshot(), queryColumn: 'missing' },
  }, tokenA);
  assert.equal(badDataset.status, 422);
  assert.equal(badDataset.body.code, 'INVALID_INPUT');
  assert.match(badDataset.body.message, /查询列不在数据集列中/);
  assert.equal((await get('/api/resources/dataset/ds-bad/v1', tokenA)).status, 404);

  const foreignTask = await post('/api/resources/task', {
    id: 'task-foreign', version: 'v1', binding: binding({ dataset: { id: 'sc-other', version: 'v1' } }),
  }, tokenA);
  assert.equal(foreignTask.status, 422);
  assert.equal(foreignTask.body.code, 'BINDING_INVALID');
  assert.deepEqual(foreignTask.body.issues.map((issue: any) => [issue.code, issue.field]), [
    ['DATASET_NOT_FOUND', 'binding.dataset'],
  ]);
  assert.equal((await get('/api/resources/task/task-foreign/v1', tokenA)).status, 404);

  const validTask = await post('/api/resources/task', {
    id: 'task-over-http', version: 'v1', binding: binding(),
  }, tokenA);
  assert.equal(validTask.status, 201);
  assert.deepEqual(validTask.body.snapshot, binding());
});

test('路径编码：含斜杠的资源 ID 编码后仍可写入并读取', async () => {
  const id = 'sc/custom';
  const created = await post('/api/resources/scenario', {
    id, version: 'v1', snapshot: scenarioSnapshot(),
  }, tokenA);
  assert.equal(created.status, 201);
  const detail = await get(`/api/resources/scenario/${encodeURIComponent(id)}/v1`, tokenA);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.id, id);
});

test('方法、路径与请求体校验：405/404/415/400/413 且带稳定错误码', async () => {
  const postDetail = await request('POST', '/api/resources/scenario/sc-new/v1', { token: tokenA, body: {} });
  assert.equal(postDetail.status, 405);
  assert.equal(postDetail.headers.get('allow'), 'GET');

  const putCollection = await request('PUT', '/api/resources/scenario', { token: tokenA, body: {} });
  assert.equal(putCollection.status, 405);
  assert.equal(putCollection.headers.get('allow'), 'GET, POST');

  assert.equal((await get('/api/resources/unknown', tokenA)).status, 400);
  assert.equal((await get('/api/resources/scenario/sc-new/v1/extra', tokenA)).status, 404);

  const badJson = await request('POST', '/api/resources/scenario', { token: tokenA, rawBody: '{oops' });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.code, 'BAD_REQUEST');
  const wrongType = await request('POST', '/api/resources/scenario', {
    token: tokenA, body: {}, headers: { 'content-type': 'text/plain' },
  });
  assert.equal(wrongType.status, 415);
  const emptyBody = await request('POST', '/api/resources/scenario', { token: tokenA, rawBody: '' });
  assert.equal(emptyBody.status, 400);
  const arrayBody = await post('/api/resources/scenario', [], tokenA);
  assert.equal(arrayBody.status, 400);

  const small = createResourceHttpServer(new ResourceCatalog(), { sessions, maxBodyBytes: 32 });
  await new Promise<void>((resolve) => small.listen(0, '127.0.0.1', resolve));
  const smallBase = `http://127.0.0.1:${(small.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${smallBase}/api/resources/scenario`, {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${tokenA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'too-big', version: 'v1', snapshot: scenarioSnapshot() }),
    });
    assert.equal(response.status, 413);
  } finally {
    small.closeAllConnections();
    await new Promise<void>((resolve) => small.close(() => resolve()));
  }
});

test('POST copy：生成带新 ID 的副本，归属取自会话且源保持不变', async () => {
  const reply = await post('/api/resources/scenario/sc-harness/v1/copy', {
    id: 'sc-http-copy', version: 'v1', ownerAccountId: B,
  }, tokenA);
  assert.equal(reply.status, 201);
  assert.equal(reply.body.id, 'sc-http-copy');
  assert.equal(reply.body.ownerAccountId, A);
  assert.deepEqual(reply.body.snapshot, scenarioSnapshot());
  const source = await get('/api/resources/scenario/sc-harness/v1', tokenA);
  assert.equal(source.body.id, 'sc-harness');
  assert.equal((await get('/api/resources/scenario/sc-http-copy/v1', tokenB)).status, 404);

  const again = await post('/api/resources/scenario/sc-harness/v1/copy', {
    id: 'sc-http-copy', version: 'v1',
  }, tokenA);
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('x-replayed'), 'true');
});

test('POST copy：任务副本沿用冻结绑定、定时与引用不触发运行，空请求体可用', async () => {
  const reply = await request('POST', '/api/resources/task/task-regression/v1/copy', { token: tokenA });
  assert.equal(reply.status, 201);
  assert.match(reply.body.id, /^task-regression-copy-[0-9a-f]{8}$/);
  assert.deepEqual(reply.body.snapshot, binding());
  const before = await get('/api/resources/task', tokenA);
  assert.equal(before.body.total, 3);
  assert.ok(before.body.items.every((item: any) => item.kind === 'task'));
  assert.ok(before.body.items.some((item: any) => item.id === reply.body.id));
});

test('POST copy：未登录 401、越权与不存在统一 404、错误输入 400/405', async () => {
  assert.equal((await post('/api/resources/scenario/sc-harness/v1/copy', {}, undefined)).status, 401);
  const forbidden = await post('/api/resources/scenario/sc-harness/v1/copy', { id: 'sc-x' }, tokenB);
  const missing = await post('/api/resources/scenario/sc-none/v1/copy', { id: 'sc-x' }, tokenB);
  assert.equal(forbidden.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(forbidden.body, missing.body);

  const sameRef = await post('/api/resources/scenario/sc-harness/v1/copy', {
    id: 'sc-harness', version: 'v1',
  }, tokenA);
  assert.equal(sameRef.status, 400);
  const emptyId = await post('/api/resources/scenario/sc-harness/v1/copy', { id: '' }, tokenA);
  assert.equal(emptyId.status, 400);
  const getCopy = await get('/api/resources/scenario/sc-harness/v1/copy', tokenA);
  assert.equal(getCopy.status, 405);
  assert.equal(getCopy.headers.get('allow'), 'POST');
});

test('GET 列表查询：q/name/id/sortBy/order/page/pageSize 透传且结果限定本人', async (t) => {
  const localCatalog = new ResourceCatalog(() => '2026-11-24T12:00:00+08:00');
  localCatalog.putScenario(A, { id: 'sc-harness', version: 'v1' }, scenarioSnapshot());
  localCatalog.putScenario(A, { id: 'sc-harness', version: 'v2' }, scenarioSnapshot());
  localCatalog.putScenario(A, { id: 'sc-other-own', version: 'v1' }, { ...scenarioSnapshot(), name: '客服配置' });
  // 他人场景同样含 harness，经账号限定后不得出现在结果中。
  localCatalog.putScenario(B, { id: 'sc-foreign', version: 'v1' }, scenarioSnapshot());

  const localSessions = new InMemorySessionStore();
  const localToken = localSessions.create(A);
  const local = createResourceHttpServer(localCatalog, { sessions: localSessions });
  await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => { local.closeAllConnections(); local.close(); });
  const localBase = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  const call = async (path: string, token = localToken) => {
    const response = await fetch(`${localBase}${path}`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const fuzzy = await call('/api/resources/scenario?q=HARNESS');
  assert.equal(fuzzy.status, 200);
  assert.deepEqual(fuzzy.body.items.map((item: any) => item.id), ['sc-harness', 'sc-harness']);
  assert.equal(fuzzy.body.total, 2);

  const exactName = await call(`/api/resources/scenario?name=${encodeURIComponent('客服配置')}`);
  assert.deepEqual(exactName.body.items.map((item: any) => item.id), ['sc-other-own']);

  const byId = await call('/api/resources/scenario?id=sc-harness&sortBy=createdAt&order=desc');
  assert.deepEqual(byId.body.items.map((item: any) => item.version), ['v2', 'v1']);
  assert.equal(byId.body.query.sortBy, 'createdAt');
  assert.equal(byId.body.query.order, 'desc');

  const page2 = await call('/api/resources/scenario?page=2&pageSize=1');
  assert.equal(page2.body.total, 3);
  assert.deepEqual(page2.body.items.map((item: any) => item.id), ['sc-harness']);
  assert.equal(page2.body.query.page, 2);
  assert.equal(page2.body.query.pageSize, 1);

  // 自报他人归属返回空，且不泄露他人资源。
  const foreignOwner = await call('/api/resources/scenario?ownerAccountId=acct-B');
  assert.equal(foreignOwner.body.total, 0);
});

test('GET 列表非法查询参数返回 400 且带稳定错误码', async () => {
  for (const query of ['sortBy=bogus', 'order=sideways', 'page=0', 'page=abc', 'pageSize=99999', 'pageSize=0']) {
    const reply = await get(`/api/resources/scenario?${query}`, tokenA);
    assert.equal(reply.status, 400, query);
    assert.equal(reply.body.code, 'INVALID_INPUT', query);
  }
  // 未知参数被忽略，不影响既有行为。
  const ignored = await get('/api/resources/scenario?unknown=x', tokenA);
  assert.equal(ignored.status, 200);
  assert.ok(ignored.body.total >= 2);
});

test('会话失效后立即 401，所有响应禁止缓存', async () => {
  const token = sessions.create(A);
  assert.equal((await get('/api/resources/scenario', token)).status, 200);
  sessions.invalidate(token);
  const revoked = await get('/api/resources/scenario', token);
  assert.equal(revoked.status, 401);
  assert.equal(revoked.headers.get('cache-control'), 'no-store');
  assert.equal((await get('/api/resources/scenario/sc-harness/v1', tokenA)).headers.get('cache-control'), 'no-store');
});

test('SQLite 目录经 HTTP 写入后关库重开：列表与详情逐字段一致', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-resource-http-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'eval.sqlite');
  const now = () => '2026-11-24T12:00:00+08:00';

  let store = openSqliteResourceCatalog(dbPath, { now });
  let local = createResourceHttpServer(store, { sessions });
  await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
  let localBase = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${localBase}${path}`, {
      method,
      headers: {
        cookie: `${SESSION_COOKIE}=${tokenA}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  assert.equal((await call('POST', '/api/resources/scenario', { ...SCENARIO, snapshot: scenarioSnapshot() })).status, 201);
  assert.equal((await call('POST', '/api/resources/dataset', { ...DATASET, snapshot: datasetSnapshot() })).status, 201);
  assert.equal((await call('POST', '/api/resources/rule', { ...RULE, snapshot: processQualityRule })).status, 201);
  assert.equal((await call('POST', '/api/resources/task', { ...TASK, binding: binding() })).status, 201);
  const before = await call('GET', '/api/resources/task');

  local.closeAllConnections();
  await new Promise<void>((resolve) => local.close(() => resolve()));
  store.close();

  store = openSqliteResourceCatalog(dbPath, { now });
  local = createResourceHttpServer(store, { sessions });
  await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
  localBase = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;

  assert.deepEqual((await call('GET', '/api/resources/task')).body, before.body);
  const detail = await call('GET', '/api/resources/task/task-regression/v1');
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.snapshot, binding());
  assert.equal(detail.body.name, binding().name);
  const other = await fetch(`${localBase}/api/resources/task`, {
    headers: { cookie: `${SESSION_COOKIE}=${tokenB}` },
  });
  assert.equal((await other.json()).total, 0);

  local.closeAllConnections();
  await new Promise<void>((resolve) => local.close(() => resolve()));
  store.close();
});

test('管理页经 HTTP 按创建日期和任务名称筛选，拒绝倒置或无效的日期', async () => {
  const path = '/api/resources/task?' + new URLSearchParams({
    id: TASK.id, name: '过程质量回归评测', from: '2026-11-24', to: '2026-11-24',
  });
  const list = await get(path, tokenA);
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items[0].name, '过程质量回归评测');
  assert.equal(list.body.query.from, '2026-11-24');
  assert.equal(list.body.query.to, '2026-11-24');
  assert.equal(list.body.query.sortBy, 'createdAt');
  assert.equal(list.body.query.order, 'desc');
  assert.equal((await get(path, tokenB)).body.total, 0);
  for (const bounds of ['from=2026-11-25', 'to=2026-11-23']) {
    const outside = await get('/api/resources/task?id=' + TASK.id + '&' + bounds, tokenA);
    assert.equal(outside.status, 200);
    assert.equal(outside.body.total, 0);
  }
  for (const bounds of ['from=2026-02-30', 'from=2026-11-25&to=2026-11-24']) {
    const invalid = await get('/api/resources/task?' + bounds, tokenA);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'INVALID_INPUT');
  }
});

interface CallOptions {
  token?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

function makeCaller(baseUrl: string) {
  return async (method: string, path: string, options: CallOptions = {}) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token) headers.cookie = `${SESSION_COOKIE}=${options.token}`;
    if (options.body !== undefined || options.rawBody !== undefined) {
      headers['content-type'] = headers['content-type'] ?? 'application/json';
    }
    const init: RequestInit = { method, headers };
    if (options.rawBody !== undefined) init.body = options.rawBody;
    else if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const response = await fetch(`${baseUrl}${path}`, init);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };
}

test('归档 HTTP：活跃引用 409 带引用任务，归档后状态回显、幂等与归属隔离', async (t) => {
  const catalog = new ResourceCatalog(() => '2026-11-25T10:00:00+08:00');
  catalog.putScenario(A, SCENARIO, scenarioSnapshot());
  catalog.putDataset(A, DATASET, datasetSnapshot());
  catalog.putRule(A, RULE, processQualityRule);
  const task = { id: 'task-archive-http', version: 'v1' };
  assert.equal(catalog.createTaskConfig(A, task, binding({ name: '活跃任务' })).ok, true);
  const rule2 = { id: 'rule-archive-http', version: 'v1' };
  catalog.putRule(A, rule2, { ...processQualityRule, id: rule2.id, version: rule2.version });

  const localSessions = new InMemorySessionStore();
  const aToken = localSessions.create(A);
  const bToken = localSessions.create(B);
  const local = createResourceHttpServer(catalog, { sessions: localSessions });
  await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => { local.closeAllConnections(); local.close(); });
  const call = makeCaller(`http://127.0.0.1:${(local.address() as AddressInfo).port}`);
  const datasetArchive = `/api/resources/dataset/${DATASET.id}/${DATASET.version}/archive`;
  const taskArchive = `/api/resources/task/${task.id}/${task.version}/archive`;
  const ruleArchive = `/api/resources/rule/${rule2.id}/${rule2.version}/archive`;
  const references = `/api/resources/dataset/${DATASET.id}/${DATASET.version}/references`;

  const before = await call('GET', datasetArchive, { token: aToken });
  assert.equal(before.status, 200);
  assert.equal(before.body.archived, false);
  assert.equal('archivedAt' in before.body, false);
  assert.equal(before.headers.get('cache-control'), 'no-store');

  const refsBefore = await call('GET', references, { token: aToken });
  assert.equal(refsBefore.status, 200);
  assert.deepEqual(refsBefore.body.items.map((item: any) => [item.ref.id, item.archived]), [[task.id, false]]);

  // 归档请求不需要请求体：完全省略时仍可执行，活跃引用返回 409 且带引用任务。
  const blocked = await call('POST', datasetArchive, { token: aToken });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'ACTIVE_TASK_REFERENCE');
  assert.deepEqual(blocked.body.references.map((item: any) => [item.ref.id, item.name, item.archived]), [
    [task.id, '活跃任务', false],
  ]);
  assert.equal((await call('GET', datasetArchive, { token: aToken })).body.archived, false);

  const archivedTask = await call('POST', taskArchive, { token: aToken });
  assert.equal(archivedTask.status, 200);
  assert.equal(archivedTask.body.archivedAt, '2026-11-25T10:00:00+08:00');
  assert.equal(archivedTask.headers.get('x-replayed'), null);
  const refsAfter = await call('GET', references, { token: aToken });
  assert.deepEqual(refsAfter.body.items.map((item: any) => [item.ref.id, item.archived]), [[task.id, true]]);

  const archivedDataset = await call('POST', datasetArchive, { token: aToken });
  assert.equal(archivedDataset.status, 200);
  const replay = await call('POST', datasetArchive, { token: aToken });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('x-replayed'), 'true');
  assert.equal(replay.body.archivedAt, archivedDataset.body.archivedAt);
  const status = await call('GET', datasetArchive, { token: aToken });
  assert.equal(status.body.archived, true);
  assert.equal(status.body.archivedAt, archivedDataset.body.archivedAt);

  // 已归档数据集不能用于新建任务：经同一 HTTP 写入口仍返回逐字段绑定错误。
  const newTask = await call('POST', '/api/resources/task', {
    token: aToken,
    body: { ...task, id: 'task-after-archive', binding: binding() },
  });
  assert.equal(newTask.status, 422);
  assert.deepEqual(newTask.body.issues.map((item: any) => item.code), ['DATASET_ARCHIVED']);

  // 自称归属不参与鉴权，归档记录仍属于会话账号。
  const spoofed = await call('POST', ruleArchive, { token: aToken, body: { ownerAccountId: B } });
  assert.equal(spoofed.status, 200);
  assert.equal((await call('GET', ruleArchive, { token: aToken })).body.archived, true);
  assert.equal((await call('GET', ruleArchive, { token: bToken })).status, 404);
  const forbidden = await call('POST', datasetArchive, { token: bToken });
  const missing = await call('POST', '/api/resources/dataset/ds-none/v1/archive', { token: bToken });
  assert.equal(forbidden.status, 404);
  assert.deepEqual(forbidden.body, missing.body);
  assert.equal((await call('GET', references, { token: bToken })).status, 404);

  for (const path of [datasetArchive, references]) assert.equal((await call('GET', path)).status, 401);
  assert.equal((await call('POST', datasetArchive)).status, 401);
  const postRefs = await call('POST', references, { token: aToken, body: {} });
  assert.equal(postRefs.status, 405);
  assert.equal(postRefs.headers.get('allow'), 'GET');
  const deleteArchive = await call('DELETE', datasetArchive, { token: aToken });
  assert.equal(deleteArchive.status, 405);
  assert.equal(deleteArchive.headers.get('allow'), 'GET, POST');
  const scenarioArchive = await call('POST', '/api/resources/scenario/sc-harness/v1/archive', { token: aToken });
  assert.equal(scenarioArchive.status, 400);
  assert.equal(scenarioArchive.body.code, 'INVALID_INPUT');
  const badMedia = await call('POST', taskArchive, {
    token: aToken, rawBody: 'text', headers: { 'content-type': 'text/plain' },
  });
  assert.equal(badMedia.status, 415);
});

test('SQLite 目录经 HTTP 归档：关库重开后状态与引用任务逐字段一致', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-archive-http-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'eval.sqlite');
  const localSessions = new InMemorySessionStore();
  const token = localSessions.create(A);
  let store = openSqliteResourceCatalog(dbPath, { now: () => '2026-11-25T11:00:00+08:00' });
  store.putScenario(A, SCENARIO, scenarioSnapshot());
  store.putDataset(A, DATASET, datasetSnapshot());
  store.putRule(A, RULE, processQualityRule);
  const task = { id: 'task-sqlite-http', version: 'v1' };
  assert.equal(store.createTaskConfig(A, task, binding()).ok, true);
  let local = createResourceHttpServer(store, { sessions: localSessions });
  await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
  let call = makeCaller(`http://127.0.0.1:${(local.address() as AddressInfo).port}`);
  const datasetArchive = `/api/resources/dataset/${DATASET.id}/${DATASET.version}/archive`;
  const taskArchive = `/api/resources/task/${task.id}/${task.version}/archive`;
  const references = `/api/resources/dataset/${DATASET.id}/${DATASET.version}/references`;

  assert.equal((await call('POST', datasetArchive, { token })).status, 409);
  assert.equal((await call('POST', taskArchive, { token })).status, 200);
  const archived = await call('POST', datasetArchive, { token });
  assert.equal(archived.status, 200);
  const refsBefore = await call('GET', references, { token });
  assert.deepEqual(refsBefore.body.items.map((item: any) => [item.ref.id, item.archived]), [[task.id, true]]);

  local.closeAllConnections();
  await new Promise<void>((resolve) => local.close(() => resolve()));
  store.close();

  store = openSqliteResourceCatalog(dbPath, { now: () => '2026-11-26T11:00:00+08:00' });
  local = createResourceHttpServer(store, { sessions: localSessions });
  await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
  call = makeCaller(`http://127.0.0.1:${(local.address() as AddressInfo).port}`);
  try {
    const status = await call('GET', datasetArchive, { token });
    assert.equal(status.body.archived, true);
    assert.equal(status.body.archivedAt, archived.body.archivedAt);
    const replay = await call('POST', datasetArchive, { token });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('x-replayed'), 'true');
    assert.equal(replay.body.archivedAt, archived.body.archivedAt);
    assert.deepEqual((await call('GET', references, { token })).body, refsBefore.body);
    assert.equal((await call('GET', `/api/resources/dataset/${DATASET.id}/${DATASET.version}`, { token })).status, 200);
    assert.equal((await call('GET', `/api/resources/task/${task.id}/${task.version}`, { token })).status, 200);
  } finally {
    local.closeAllConnections();
    await new Promise<void>((resolve) => local.close(() => resolve()));
    store.close();
  }
});
