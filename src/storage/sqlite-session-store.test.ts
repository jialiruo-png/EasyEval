/**
 * 服务端会话持久化测试：
 *   node --test src/storage/sqlite-session-store.test.ts
 * 仅使用临时目录中的本机 SQLite 文件与 127.0.0.1 临时端口；
 * 不访问上游、不启动 Docker、不安装依赖、不调用模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { createResultHttpServer, SESSION_COOKIE } from '../result-api/http.ts';
import type { RunRecord } from '../result-api/store.ts';
import { processQualityRule, processQualitySamples } from '../result-contract/fixtures.ts';
import { applyMigrations, migrationVersion, openDatabase } from './migrations.ts';
import { openSqliteStore } from './sqlite-store.ts';
import { openSqliteSessionStore, SqliteSessionStore } from './sqlite-session-store.ts';

function tempDbPath(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'eval-session-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'eval.sqlite');
}

test('令牌不明文落库；账本迁移到版本 6 且重复执行幂等', (t) => {
  const dbPath = tempDbPath(t);
  const store = openSqliteSessionStore(dbPath);
  assert.equal(migrationVersion(store.db), 6);

  const token = store.create('acct-A');
  const rows = store.db.prepare(
    'SELECT token_hash, account_id, created_at, expires_at, revoked_at FROM sessions',
  ).all() as {
    token_hash: string; account_id: string; created_at: string;
    expires_at: string; revoked_at: string | null;
  }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.account_id, 'acct-A');
  assert.equal(rows[0]!.revoked_at, null);
  assert.match(rows[0]!.token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(rows[0]!.token_hash, token);
  assert.ok(Date.parse(rows[0]!.expires_at) > Date.parse(rows[0]!.created_at));
  // 库文件中不出现明文令牌，拿到 SQLite 文件也无法直接冒充会话。
  assert.equal(readFileSync(dbPath).includes(token), false);
  assert.equal(store.accountFor(token), 'acct-A');
  assert.deepEqual(applyMigrations(store.db), []);
  store.close();
});

test('重启后会话仍有效；退出撤销立即生效且重启后不可恢复', (t) => {
  const dbPath = tempDbPath(t);
  const first = openSqliteSessionStore(dbPath);
  const revokedToken = first.create('acct-A');
  const survivor = first.create('acct-A');
  assert.equal(first.accountFor(revokedToken), 'acct-A');
  assert.equal(first.accountFor(survivor), 'acct-A');
  first.invalidate(revokedToken);
  assert.equal(first.accountFor(revokedToken), undefined);
  assert.equal(first.accountFor(survivor), 'acct-A');
  first.close();

  const reopened = openSqliteSessionStore(dbPath);
  assert.equal(reopened.accountFor(revokedToken), undefined);
  assert.equal(reopened.accountFor(survivor), 'acct-A');
  assert.doesNotThrow(() => reopened.invalidate(revokedToken)); // 重复退出幂等
  assert.equal(reopened.accountFor(survivor), 'acct-A');
  reopened.close();
});

test('过期会话返回 undefined，不影响其他仍有效的会话', (t) => {
  const dbPath = tempDbPath(t);
  const db = openDatabase(dbPath);
  applyMigrations(db);
  let now = 1_700_000_000_000;
  const store = new SqliteSessionStore(db, { ttlMs: 1000, now: () => now });

  const token = store.create('acct-A');
  assert.equal(store.accountFor(token), 'acct-A');
  now += 1001;
  assert.equal(store.accountFor(token), undefined);

  const fresh = store.create('acct-B');
  assert.equal(store.accountFor(fresh), 'acct-B');
  assert.equal(store.accountFor(undefined), undefined);
  assert.equal(store.accountFor('garbage'), undefined);
  assert.throws(() => new SqliteSessionStore(db, { ttlMs: 0 }), /有效期/);
  assert.throws(() => store.create('  '), /账号 ID/);
  store.close();
});

test('跨账号隔离：每枚令牌只解析到签发时的账号', (t) => {
  const dbPath = tempDbPath(t);
  const store = openSqliteSessionStore(dbPath);
  const tokenA = store.create('acct-A');
  const tokenB = store.create('acct-B');
  assert.equal(store.accountFor(tokenA), 'acct-A');
  assert.equal(store.accountFor(tokenB), 'acct-B');
  store.invalidate(tokenA);
  assert.equal(store.accountFor(tokenA), undefined);
  assert.equal(store.accountFor(tokenB), 'acct-B');

  const rowCount = store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
  assert.equal(rowCount.n, 2); // 撤销只标记，不删除历史，便于审计
  store.close();
});

test('purgeExpired 只删除已过期行：未过期会话及其撤销标记保留，幂等且不改变授权结果', (t) => {
  const dbPath = tempDbPath(t);
  const db = openDatabase(dbPath);
  applyMigrations(db);
  let now = 1_700_000_000_000;
  const store = new SqliteSessionStore(db, { ttlMs: 1000, now: () => now });

  const expired = store.create('acct-B');        // 将过期
  const revoked = store.create('acct-C');        // 已撤销且将过期
  store.invalidate(revoked);
  now += 1001;                                   // 两枚旧令牌已过期

  // 推进时钟后再签发仍有效的会话；旧的两枚解析为 undefined。
  const survivor = store.create('acct-A');
  const fresh = store.create('acct-D');
  assert.equal(store.accountFor(survivor), 'acct-A');
  assert.equal(store.accountFor(fresh), 'acct-D');
  assert.equal(store.accountFor(expired), undefined);
  assert.equal(store.accountFor(revoked), undefined);

  const before = store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
  assert.equal(before.n, 4);

  const removed = store.purgeExpired();
  assert.equal(removed, 2);
  const after = store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
  assert.equal(after.n, 2);
  assert.equal(store.purgeExpired(), 0);         // 幂等

  // 清理不改变可见行为：仍有效会话可读，过期令牌依旧查不到。
  assert.equal(store.accountFor(survivor), 'acct-A');
  assert.equal(store.accountFor(fresh), 'acct-D');
  assert.equal(store.accountFor(expired), undefined);
  assert.equal(store.accountFor(revoked), undefined);

  // 未过期但已撤销的会话其撤销标记保留（审计需要），重开库后同样解析为 undefined。
  store.close();
  const reopened = openSqliteSessionStore(dbPath, { ttlMs: 1000, now: () => now });
  assert.equal(reopened.accountFor(survivor), 'acct-A');
  assert.equal(reopened.purgeExpired(), 0);
  reopened.close();
});

test('purgeExpired 保留未过期的撤销标记，待其过期后才回收', (t) => {
  const dbPath = tempDbPath(t);
  const db = openDatabase(dbPath);
  applyMigrations(db);
  let now = 1_700_000_000_000;
  const store = new SqliteSessionStore(db, { ttlMs: 1000, now: () => now });

  const revoked = store.create('acct-A');
  store.invalidate(revoked);
  // 撤销但未过期：purgeExpired 不应删除，撤销历史保留供审计。
  assert.equal(store.purgeExpired(), 0);
  const kept = store.db.prepare(
    'SELECT revoked_at FROM sessions WHERE token_hash = ?',
  ).get(createHash('sha256').update(revoked, 'utf8').digest('hex')) as { revoked_at: string | null };
  assert.notEqual(kept.revoked_at, null);

  now += 1001;
  assert.equal(store.purgeExpired(), 1);         // 过期后回收
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
  assert.equal(store.accountFor(revoked), undefined);
  store.close();
});

test('HTTP 集成：重启后旧会话可读本人批次，他人会话 404，退出后 401', async (t) => {
  const dbPath = tempDbPath(t);
  const run: RunRecord = {
    id: 'RUN-A',
    ownerAccountId: 'acct-A',
    taskId: 'TASK-1',
    datasetVersionId: 'DS-v1',
    ruleVersionId: 'RULE-v1',
    rule: processQualityRule,
    triggeredBy: 'manual',
    triggeredAt: '2026-11-21T20:00:00+08:00',
    status: 'succeeded',
    progress: { completed: 5, total: 5 },
    samples: processQualitySamples,
  };

  const firstRead = openSqliteStore(dbPath);
  const firstSessions = openSqliteSessionStore(dbPath);
  firstRead.insertRun(run);
  const tokenA = firstSessions.create('acct-A');
  const tokenB = firstSessions.create('acct-B');
  firstRead.close();
  firstSessions.close(); // 模拟应用重启：会话仍在磁盘上

  const read = openSqliteStore(dbPath);
  const sessions = openSqliteSessionStore(dbPath);
  const server = createResultHttpServer(read, sessions);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  const get = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, { headers });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  try {
    const viaBearer = await get('/api/runs/RUN-A/results', { authorization: `Bearer ${tokenA}` });
    assert.equal(viaBearer.status, 200);
    assert.equal(viaBearer.body.meanPercent, '37.5%');

    const viaCookie = await get('/api/runs/RUN-A/samples?metricId=param_fill&metricValue=Fail', {
      cookie: `${SESSION_COOKIE}=${tokenA}`,
    });
    assert.equal(viaCookie.status, 200);
    assert.deepEqual(viaCookie.body.items.map((item: { sampleId: string }) => item.sampleId), ['A']);

    const otherAccount = await get('/api/runs/RUN-A/results', { authorization: `Bearer ${tokenB}` });
    assert.equal(otherAccount.status, 404);

    sessions.invalidate(tokenA);
    const afterLogout = await get('/api/runs/RUN-A/results', { authorization: `Bearer ${tokenA}` });
    assert.equal(afterLogout.status, 401);
    assert.equal(afterLogout.body.code, 'UNAUTHORIZED');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    read.close();
    sessions.close();
  }
});
