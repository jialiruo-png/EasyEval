/**
 * 运行索引 HTTP 挂载测试：
 *   node --test src/run-api/http.test.ts
 * 仅监听 127.0.0.1 临时端口，用内存版运行索引；
 * 不连接数据库、不启动 Docker、不访问上游或模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  createRunHttpServer, InMemorySessionStore, isRunIndexRoute, SESSION_COOKIE,
} from './http.ts';
import type { SessionStore } from './http.ts';
import { A, B, createRun, setup, triggerBody } from './run-test-fixture.ts';

interface Reply {
  status: number;
  body: any;
  headers: Headers;
}

async function start(t: { after: (fn: () => void) => void }) {
  const sessions: SessionStore = new InMemorySessionStore();
  const fixture = setup();
  const server: Server = createRunHttpServer(fixture.accessor, { sessions });
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
  return { sessions, fixture, request };
}

test('路由分流：运行索引路径与结果读取路径互斥', () => {
  assert.equal(isRunIndexRoute('/api/runs'), true);
  assert.equal(isRunIndexRoute('/api/runs/'), true);
  assert.equal(isRunIndexRoute('/api/runs/RUN-1'), true);
  assert.equal(isRunIndexRoute('/api/runs/RUN-1/cancel'), true);
  assert.equal(isRunIndexRoute('/api/runs/RUN-1/results'), false);
  assert.equal(isRunIndexRoute('/api/runs/RUN-1/samples'), false);
  assert.equal(isRunIndexRoute('/api/runs/RUN-1/samples/R1'), false);
  assert.equal(isRunIndexRoute('/api/health'), false);
});

test('未登录与伪造会话对四类操作均 401；自报账号无效', async (t) => {
  const { request, sessions } = await start(t);
  const fake = sessions.create(B);
  const cases: Array<[string, string, any]> = [
    ['POST', '/api/runs', { body: triggerBody() }],
    ['GET', '/api/runs', {}],
    ['GET', '/api/runs/RUN-x', {}],
    ['POST', '/api/runs/RUN-x/cancel', {}],
  ];
  for (const [method, path, opts] of cases) {
    const anon = await request(method, path, opts);
    assert.equal(anon.status, 401);
    assert.equal(anon.body.code, 'UNAUTHORIZED');
    const forged = await request(method, path, { ...opts, headers: { authorization: 'Bearer bogus-token' } });
    assert.equal(forged.status, 401);
  }
  // 归属取会话（B），用 B 自己的绑定；请求体自报 A 不生效。
  const bBody = {
    task: { id: 'task-b', version: 'v1' },
    binding: {
      scenario: { id: 'sc-harness-b', version: 'v1' },
      dataset: { id: 'ds-support-b', version: 'v3' },
      rule: { id: 'rule-b', version: 'v1' },
    },
    requestId: 'b-manual-1', ownerAccountId: A,
  };
  const withFake = await request('POST', '/api/runs', { token: fake, body: bBody });
  assert.equal(withFake.status, 201);
  assert.equal(withFake.body.ownerAccountId, B);
  // 同样请求体若用 A 的绑定则在会话 B 名下找不到任务，证明自报账号不能切换身份。
  const crossOwner = await request('POST', '/api/runs', {
    token: fake, body: triggerBody({ ownerAccountId: A, requestId: 'b-manual-2' }),
  });
  assert.equal(crossOwner.status, 422);
});

test('手动触发 201、归属取会话、响应 no-store；重放 200 带 x-replayed', async (t) => {
  const { request, sessions } = await start(t);
  const token = sessions.create(A);
  const first = await request('POST', '/api/runs', {
    token, body: triggerBody({ ownerAccountId: B, accountId: B }),
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.ownerAccountId, A);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.headers.get('x-replayed'), null);
  const replay = await request('POST', '/api/runs', { token, body: triggerBody({ ownerAccountId: B }) });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('x-replayed'), 'true');
  assert.equal(replay.body.id, first.body.id);
});

test('会话撤销后触发立即 401，Bearer 同样可用', async (t) => {
  const { request, sessions } = await start(t);
  const token = sessions.create(A);
  const bearer = await request('POST', '/api/runs', {
    headers: { authorization: `Bearer ${token}` }, body: triggerBody(),
  });
  assert.equal(bearer.status, 201);
  sessions.invalidate(token);
  const after = await request('POST', '/api/runs', {
    headers: { authorization: `Bearer ${token}` }, body: triggerBody({ requestId: 'manual-2' }),
  });
  assert.equal(after.status, 401);
});

test('GET 详情与列表：本人可读、taskId 过滤、越权与不存在同 404', async (t) => {
  const { request, sessions, fixture } = await start(t);
  const tokenA = sessions.create(A);
  const tokenB = sessions.create(B);
  const run = createRun(fixture);
  const detail = await request('GET', `/api/runs/${encodeURIComponent(run.id)}`, { token: tokenA });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.id, run.id);
  assert.equal(detail.headers.get('cache-control'), 'no-store');
  const other = await request('GET', `/api/runs/${encodeURIComponent(run.id)}`, { token: tokenB });
  const missing = await request('GET', '/api/runs/RUN-NOPE', { token: tokenA });
  assert.equal(other.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(other.body, missing.body);

  const all = await request('GET', '/api/runs', { token: tokenA });
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 1);
  assert.equal(all.body.items[0].id, run.id);
  const filtered = await request('GET', '/api/runs?taskId=task-regression', { token: tokenA });
  assert.equal(filtered.body.taskId, 'task-regression');
  assert.equal(filtered.body.total, 1);
  const empty = await request('GET', '/api/runs?taskId=task-other', { token: tokenA });
  assert.equal(empty.body.total, 0);
  const bList = await request('GET', '/api/runs', { token: tokenB });
  assert.equal(bList.body.total, 0);
});

test('取消本批：200、保留已完成样本、重放 x-replayed、越权 404', async (t) => {
  const { request, sessions, fixture } = await start(t);
  const tokenA = sessions.create(A);
  const tokenB = sessions.create(B);
  const run = createRun(fixture);
  const canceled = await request('POST', `/api/runs/${encodeURIComponent(run.id)}/cancel`, { token: tokenA });
  assert.equal(canceled.status, 200);
  assert.equal(canceled.body.status, 'canceled');
  assert.deepEqual(canceled.body.samples.map((s: any) => s.status), ['canceled', 'canceled', 'canceled']);
  const replay = await request('POST', `/api/runs/${encodeURIComponent(run.id)}/cancel`, { token: tokenA });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('x-replayed'), 'true');
  const other = await request('POST', `/api/runs/${encodeURIComponent(run.id)}/cancel`, { token: tokenB });
  assert.equal(other.status, 404);
});

test('非法请求：405 带 Allow、坏 JSON 400、媒体类型 415、空体 400、缺字段 400', async (t) => {
  const { request, sessions } = await start(t);
  const token = sessions.create(A);
  const wrongMethod = await request('GET', '/api/runs/RUN-1/cancel', { token });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  const postDetail = await request('POST', '/api/runs/RUN-1', { token, body: {} });
  assert.equal(postDetail.status, 405);
  assert.equal(postDetail.headers.get('allow'), 'GET');

  const badJson = await request('POST', '/api/runs', { token, rawBody: '{not json' });
  assert.equal(badJson.status, 400);
  const wrongType = await request('POST', '/api/runs', {
    token, rawBody: JSON.stringify(triggerBody()), headers: { 'content-type': 'text/plain' },
  });
  assert.equal(wrongType.status, 415);
  const empty = await request('POST', '/api/runs', { token, rawBody: '' });
  assert.equal(empty.status, 400);
  const noRequestId = await request('POST', '/api/runs', { token, body: triggerBody({ requestId: '' }) });
  assert.equal(noRequestId.status, 400);
  assert.equal(noRequestId.body.code, 'INVALID_INPUT');
});
