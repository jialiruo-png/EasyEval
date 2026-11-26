/**
 * 草稿与预览 HTTP 挂载测试：
 *   node --test src/draft-api/http.test.ts
 * 仅监听 127.0.0.1 临时端口，用内存版草稿管理器；
 * 不连接数据库、不启动 Docker、不访问上游或模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  createDraftHttpServer, InMemorySessionStore, isDraftRoute, SESSION_COOKIE,
} from './http.ts';
import type { SessionStore } from './http.ts';
import { A, B, confirmBody, createBody, setup } from './draft-test-fixture.ts';

interface Reply {
  status: number;
  body: any;
  headers: Headers;
}

async function start(t: { after: (fn: () => void) => void }, maxBytes?: number) {
  const sessions: SessionStore = new InMemorySessionStore();
  const fixture = setup();
  const server: Server = createDraftHttpServer(fixture.accessor, { sessions, ...(maxBytes ? { maxBodyBytes: maxBytes } : {}) });
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

test('路由判定：只接纳草稿路径前缀', () => {
  assert.equal(isDraftRoute('/api/drafts'), true);
  assert.equal(isDraftRoute('/api/drafts/draft%3A1/previews/R1/retry'), true);
  assert.equal(isDraftRoute('/api/drafts-extra'), false);
  assert.equal(isDraftRoute('/api/runs'), false);
});

test('方法与路径：不支持的方法 405 带 Allow，未知路径 404', async (t) => {
  const { request } = await start(t);
  const cases: Array<[string, string, string]> = [
    ['DELETE', '/api/drafts', 'GET, POST'],
    ['POST', '/api/drafts/draft%3A1', 'GET, PATCH'],
    ['DELETE', '/api/drafts/draft%3A1/previews', 'GET, POST'],
    ['GET', '/api/drafts/draft%3A1/cancel', 'POST'],
    ['GET', '/api/drafts/draft%3A1/previews/R1/retry', 'POST'],
  ];
  for (const [method, path, allow] of cases) {
    const reply = await request(method, path);
    assert.equal(reply.status, 405);
    assert.equal(reply.headers.get('allow'), allow);
  }
  assert.equal((await request('GET', '/api/drafts/draft%3A1/unknown')).status, 404);
  assert.equal((await request('GET', '/api/drafts/draft%3A1/previews/R1/unknown')).status, 404);
});

test('未登录与伪造会话全部 401；撤销立即失效，Bearer 可用', async (t) => {
  const { request, sessions } = await start(t);
  const token = sessions.create(A);
  const bearer = await request('POST', '/api/drafts', {
    headers: { authorization: `Bearer ${token}` }, body: createBody(),
  });
  assert.equal(bearer.status, 201);
  sessions.invalidate(token);
  const paths: Array<[string, string, any]> = [
    ['GET', '/api/drafts', {}],
    ['POST', '/api/drafts', { body: createBody() }],
    ['PATCH', '/api/drafts/draft%3Aregression-1', { body: { expectedRevision: 1 } }],
    ['GET', '/api/drafts/draft%3Aregression-1', {}],
    ['POST', '/api/drafts/draft%3Aregression-1/cancel', {}],
    ['POST', '/api/drafts/draft%3Aregression-1/confirm', { body: confirmBody() }],
    ['GET', '/api/drafts/draft%3Aregression-1/previews', {}],
    ['POST', '/api/drafts/draft%3Aregression-1/previews', { body: { sampleId: 'R1' } }],
  ];
  for (const [method, path, opts] of paths) {
    const anon = await request(method, path, opts);
    assert.equal(anon.status, 401);
    assert.equal(anon.body.code, 'UNAUTHORIZED');
    const forged = await request(method, path, { ...opts, token: 'bogus-token' });
    assert.equal(forged.status, 401);
    const revoked = await request(method, path, { ...opts, headers: { authorization: `Bearer ${token}` } });
    assert.equal(revoked.status, 401);
  }
  assert.equal((await request('GET', '/api/drafts', { headers: { authorization: `Bearer ${token}` } })).status, 401);
});

test('创建 201 与列表详情：归属取会话、自报无效、URL 编码 ID 与 no-store', async (t) => {
  const { request, sessions } = await start(t);
  const tokenA = sessions.create(A);
  const tokenB = sessions.create(B);
  const created = await request('POST', '/api/drafts', { token: tokenA, body: createBody({ ownerAccountId: B }) });
  assert.equal(created.status, 201);
  assert.equal(created.body.ownerAccountId, A);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.equal(created.headers.get('x-replayed'), null);
  const detail = await request('GET', '/api/drafts/draft%3Aregression-1', { token: tokenA });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.id, 'draft:regression-1');
  const list = await request('GET', '/api/drafts?accountId=B', { token: tokenA });
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items[0].ownerAccountId, A);
  assert.equal((await request('GET', '/api/drafts', { token: tokenB })).body.total, 0);
  const other = await request('GET', '/api/drafts/draft%3Aregression-1', { token: tokenB });
  const missing = await request('GET', '/api/drafts/draft%3Amissing', { token: tokenA });
  assert.equal(other.status, 404);
  assert.deepEqual(other.body, missing.body);
});

test('请求体错误映射：坏 JSON 400、媒体类型 415、超限 413、形状错误 400', async (t) => {
  const { request, sessions } = await start(t, 120);
  const token = sessions.create(A);
  assert.equal((await request('POST', '/api/drafts', { token, rawBody: 'not-json' })).status, 400);
  assert.equal((await request('POST', '/api/drafts', {
    token, rawBody: 'x', headers: { 'content-type': 'text/plain' },
  })).status, 415);
  assert.equal((await request('POST', '/api/drafts', { token, body: createBody() })).status, 413);
});

async function seedWithHttp(request: (m: string, p: string, o?: any) => Promise<Reply>, token: string) {
  const created = await request('POST', '/api/drafts', { token, body: createBody() });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body;
}

test('更新与确认：revision 冲突 409、领域错误 422、取消与确认重放带 x-replayed', async (t) => {
  const { request, sessions } = await start(t);
  const token = sessions.create(A);
  await seedWithHttp(request, token);
  const path = '/api/drafts/draft%3Aregression-1';
  const stale = await request('PATCH', path, { token, body: { expectedRevision: 9 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'REVISION_CONFLICT');
  const badRef = await request('PATCH', path, { token, body: { expectedRevision: 1, dataset: { id: 'missing', version: 'v1' } } });
  assert.equal(badRef.status, 422);
  const updated = await request('PATCH', path, { token, body: { expectedRevision: 1, step: 3 } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.revision, 2);
  const confirm = { ...confirmBody(), expectedRevision: 2 };
  const first = await request('POST', path + '/confirm', { token, body: confirm });
  assert.equal(first.status, 200);
  assert.equal(first.body.binding.name, '过程质量回归评测');
  const replay = await request('POST', path + '/confirm', { token, body: confirm });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('x-replayed'), 'true');
  assert.deepEqual(replay.body, first.body);

  const cancelPath = '/api/drafts/draft%3Acancel-1';
  assert.equal((await request('POST', '/api/drafts', { token, body: createBody({ id: 'draft:cancel-1' }) })).status, 201);
  const cancel = await request('POST', cancelPath + '/cancel', { token: sessions.create(B) });
  assert.equal(cancel.status, 404);
  const cancelReplay = await request('POST', cancelPath + '/cancel', { token });
  assert.equal(cancelReplay.status, 200);
  const cancelAgain = await request('POST', cancelPath + '/cancel', { token });
  assert.equal(cancelAgain.headers.get('x-replayed'), 'true');
});

test('预览 HTTP：获取复用、列表、流转与重试，越权统一 404', async (t) => {
  const { request, sessions } = await start(t);
  const tokenA = sessions.create(A);
  const tokenB = sessions.create(B);
  await seedWithHttp(request, tokenA);
  const base = '/api/drafts/draft%3Aregression-1/previews';
  const first = await request('POST', base, { token: tokenA, body: { sampleId: 'R1' } });
  assert.equal(first.status, 201);
  const reused = await request('POST', base, { token: tokenA, body: { sampleId: 'R1', ownerAccountId: B } });
  assert.equal(reused.status, 200);
  assert.equal(reused.headers.get('x-replayed'), 'true');
  assert.equal(reused.body.key, first.body.key);
  const list = await request('GET', base, { token: tokenA });
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.draftId, 'draft:regression-1');
  assert.equal((await request('GET', base, { token: tokenB })).status, 404);
  assert.equal((await request('POST', base, { token: tokenB, body: { sampleId: 'R1' } })).status, 404);
  assert.equal((await request('POST', base, { token: tokenA, body: {} })).status, 400);

  const sample = base + '/R1';
  assert.equal((await request('POST', sample + '/transition', { token: tokenA, body: { status: 'weird' } })).status, 400);
  assert.equal((await request('POST', sample + '/transition', { token: tokenA, body: { status: 'running' } })).status, 200);
  assert.equal((await request('POST', sample + '/transition', {
    token: tokenA, body: { status: 'failed', reason: 'trace 延迟' },
  })).status, 200);
  const retried = await request('POST', sample + '/retry', { token: tokenA });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.attempts, 2);
  assert.equal(retried.body.status, 'pending');
  assert.equal((await request('POST', sample + '/retry', { token: tokenA })).headers.get('x-replayed'), 'true');
  assert.equal((await request('POST', sample + '/retry', { token: tokenB })).status, 404);
});
