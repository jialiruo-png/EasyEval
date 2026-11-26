/**
 * 结果读取接口 HTTP 挂载测试：
 *   node --test src/result-api/http.test.ts
 * 仅监听 127.0.0.1 的临时端口，不发外部请求、不启动 Docker、不调用模型。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { heterogeneousRule } from '../result-contract/fixtures.ts';
import {
  createResultHttpServer,
  InMemorySessionStore,
  SESSION_COOKIE,
} from './http.ts';
import { InMemoryReadStore, type RunRecord, type SampleRecord } from './store.ts';

function makeSamples(): SampleRecord[] {
  return [
    {
      id: 'H-1',
      query: '异构规则样本',
      attempts: [{ id: 'h-1', rawResponse: JSON.stringify({
        grade: { overall: 88, comment: '回答完整' },
        timing: { first_token_ms: 320 },
        flags: { answered: true },
        checks: [{ name: 'formality', verdict: 'NA' }, { name: 'tone', verdict: 'Pass' }],
      }) }],
      answer: '异构规则回答',
      trace: { traceId: 'trace-h-1', expired: false },
    },
  ];
}

function makeRun(id: string, owner: string, rule = heterogeneousRule, samples = makeSamples()): RunRecord {
  return {
    id,
    ownerAccountId: owner,
    taskId: 'TASK-1',
    datasetVersionId: 'DS-v1',
    ruleVersionId: rule.id,
    rule,
    triggeredBy: 'manual',
    triggeredAt: '2026-11-21T20:00:00+08:00',
    status: 'succeeded',
    samples,
  };
}

let server: Server;
let base: string;
let sessions: InMemorySessionStore;
let tokenA: string;
let tokenB: string;

before(async () => {
  const { processQualityRule, processQualitySamples } = await import('../result-contract/fixtures.ts');
  const runA: RunRecord = {
    ...makeRun('RUN-A', 'acct-A', processQualityRule, processQualitySamples),
    ruleVersionId: 'RULE-v1',
  };
  const store = new InMemoryReadStore([runA, makeRun('RUN-B', 'acct-B')]);
  sessions = new InMemorySessionStore();
  tokenA = sessions.create('acct-A');
  tokenB = sessions.create('acct-B');
  server = createResultHttpServer(store, sessions);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Reply {
  status: number;
  body: any;
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(`${base}${path}`, { headers });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

// 令牌在 before 钩子中签发，不能用模块初始化时的快照。
const authA = (): Record<string, string> => ({ cookie: `${SESSION_COOKIE}=${tokenA}` });
const authB = (): Record<string, string> => ({ cookie: `${SESSION_COOKIE}=${tokenB}` });

test('未登录与伪造会话：三条接口均返回 401，且不泄露批次是否存在', async () => {
  for (const path of ['/api/runs/RUN-A/results', '/api/runs/RUN-A/samples', '/api/runs/RUN-A/samples/A']) {
    assert.equal((await get(path)).status, 401);
    assert.equal((await get(path, { cookie: `${SESSION_COOKIE}=not-a-token` })).status, 401);
    assert.equal((await get(path, { authorization: 'Bearer not-a-token' })).status, 401);
  }
  const reply = await get('/api/runs/RUN-A/results?accountId=acct-A');
  assert.equal(reply.status, 401);
  assert.equal(reply.body.code, 'UNAUTHORIZED');
});

test('GET results：真实 HTTP 返回批次概览与 37.5% 均分', async () => {
  const reply = await get('/api/runs/RUN-A/results', authA());
  assert.equal(reply.status, 200);
  assert.equal(reply.body.runId, 'RUN-A');
  assert.equal(reply.body.ruleVersion, 'v1');
  assert.equal(reply.body.mean, 0.375);
  assert.equal(reply.body.meanPercent, '37.5%');
  assert.equal(reply.body.counts.scoringFailureSubtotal, 2);
  assert.equal(reply.body.metrics.find((item: any) => item.id === 'param_fill').label, '0 / 1');
});

test('GET samples：HTTP 查询参数完成指标筛选与分页，批次统计不受影响', async () => {
  const byMetric = await get('/api/runs/RUN-A/samples?metricId=param_fill&metricValue=Fail', authA());
  assert.equal(byMetric.status, 200);
  assert.equal(byMetric.body.total, 1);
  assert.deepEqual(byMetric.body.items.map((item: any) => item.sampleId), ['A']);

  const page = await get('/api/runs/RUN-A/samples?limit=2&offset=1', authA());
  assert.equal(page.body.total, 5);
  assert.deepEqual(page.body.items.map((item: any) => item.sampleId), ['B', 'C']);

  const byStatus = await get('/api/runs/RUN-A/samples?status=scoring_failed', authA());
  assert.deepEqual(byStatus.body.items.map((item: any) => item.sampleId), ['E']);
  const results = await get('/api/runs/RUN-A/results', authA());
  assert.equal(results.body.counts.numericTotal, 2);
});

test('GET sample：详情、尝试与业务 JSON 经 HTTP 原样返回；异构规则可用同接口', async () => {
  const detail = await get('/api/runs/RUN-A/samples/A', authA());
  assert.equal(detail.status, 200);
  assert.equal(detail.body.scoring.totalScore, 0.75);
  assert.equal(detail.body.attempts.length, 1);
  assert.deepEqual(detail.body.businessJson.redline_fail_hits, []);

  const other = await get('/api/runs/RUN-B/samples/H-1', authB());
  assert.equal(other.status, 200);
  assert.equal(other.body.scoring.totalScore, 88);
  assert.equal(other.body.scoring.metrics.tone, 'Pass');
});

test('归属隔离：客户端自报账号无效；他人批次与不存在批次统一 404', async () => {
  const forbidden = await get('/api/runs/RUN-A/results', authB());
  const missing = await get('/api/runs/RUN-DOES-NOT-EXIST/results', authB());
  assert.equal(forbidden.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(forbidden.body, missing.body);

  // 同时带自己的会话与他人的 accountId 参数/请求头，仍以会话账号为准。
  const spoofed = await get('/api/runs/RUN-A/results?accountId=acct-B', {
    ...authA(), 'x-account-id': 'acct-B',
  });
  assert.equal(spoofed.status, 200);
  assert.equal(spoofed.body.runId, 'RUN-A');
  assert.equal((await get('/api/runs/RUN-B/results', authA())).status, 404);
});

test('服务端会话失效后立刻返回 401', async () => {
  const token = sessions.create('acct-A');
  assert.equal((await get('/api/runs/RUN-A/results', { cookie: `${SESSION_COOKIE}=${token}` })).status, 200);
  sessions.invalidate(token);
  const reply = await get('/api/runs/RUN-A/results', { cookie: `${SESSION_COOKIE}=${token}` });
  assert.equal(reply.status, 401);
});

test('参数与方法校验：非法筛选 400，非 GET 405，未知路径 404', async () => {
  assert.equal((await get('/api/runs/RUN-A/samples?scoreMin=abc', authA())).status, 400);
  assert.equal((await get('/api/runs/RUN-A/samples?metricId=param_fill', authA())).status, 400);
  assert.equal((await get('/api/runs/RUN-A/samples?status=bogus', authA())).status, 400);
  assert.equal((await get('/api/runs/RUN-A/samples?limit=0', authA())).status, 400);

  const posted = await fetch(`${base}/api/runs/RUN-A/samples`, { method: 'POST', headers: authA() });
  assert.equal(posted.status, 405);
  assert.equal(posted.headers.get('allow'), 'GET');
  const unknown = await get('/api/runs/RUN-A/unknown', authA());
  assert.equal(unknown.status, 404);
});

test('响应禁止缓存，避免换号后旧页面复用前一账号内容', async () => {
  const response = await fetch(`${base}/api/runs/RUN-A/results`, { headers: authA() });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('分页使用整数，下限大于上限返回 400，自定义量程可筛选负分', async () => {
  for (const query of ['limit=1.5', 'offset=0.5', 'offset=-1', 'scoreMin=8&scoreMax=3']) {
    assert.equal((await get('/api/runs/RUN-A/samples?' + query, authA())).status, 400);
  }
  assert.equal((await get('/api/runs/RUN-A/samples?scoreMin=-1', authA())).status, 200);
});
