/**
 * 服务端会话的 SQLite 持久化实现（P1 阻塞期可准备工作）。
 *
 * 实现 src/result-api/http.ts 的 SessionStore 接口，三条结果读取接口无需改动即可在
 * 应用重启后继续识别已登录会话；退出（invalidate）与过期都立即失效。
 *
 * 安全边界：
 *  - 数据库只保存令牌的 SHA-256 摘要，不保存明文令牌；拿到库文件也无法直接冒充会话。
 *  - 令牌由服务端用密码学随机数签发，账号只随签发时确定，之后不信任任何客户端输入。
 *  - 会话查询在 SQL 中同时校验摘要、撤销时间与过期时间，不返回已失效会话的账号。
 *
 * 只使用 Node 22 内置 node:crypto / node:sqlite；不安装依赖、不访问上游、不调用模型。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SessionStore } from '../result-api/http.ts';
import { applyMigrations, openDatabase } from './migrations.ts';

/** 默认会话有效期 24 小时；真实登录方案确定后可调整而不改接口。 */
export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface SessionStoreOptions {
  ttlMs?: number;
  /** 可注入时钟，便于确定性地验证过期行为；默认取系统时间。 */
  now?: () => number;
}

interface SessionRow {
  account_id: string;
  expires_at: string;
  revoked_at: string | null;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function newToken(): string {
  // 32 字节随机数，base64url 便于放进 Cookie / Authorization，不含账号信息。
  return randomBytes(32).toString('base64url');
}

/** 打开（必要时建库并迁移）SQLite 文件，返回可交给 createResultHttpServer 的会话存储。 */
export function openSqliteSessionStore(
  filePath: string,
  options: SessionStoreOptions = {},
): SqliteSessionStore {
  const db = openDatabase(filePath);
  try {
    applyMigrations(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return new SqliteSessionStore(db, options);
}

export class SqliteSessionStore implements SessionStore {
  readonly db: DatabaseSync;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(db: DatabaseSync, options: SessionStoreOptions = {}) {
    this.db = db;
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('会话有效期必须为正数');
    }
  }

  /** 服务端在已验证身份后签发会话，只返回一次明文令牌。 */
  create(accountId: string): string {
    if (!accountId || !accountId.trim()) throw new Error('账号 ID 不能为空');
    const token = newToken();
    const nowMs = this.now();
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + this.ttlMs).toISOString();
    this.db.prepare(`
      INSERT INTO sessions(token_hash, account_id, created_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, NULL)
    `).run(tokenHash(token), accountId, createdAt, expiresAt);
    return token;
  }

  /** 仅当令牌有效且未撤销、未过期时返回账号；其余情况一律 undefined。 */
  accountFor(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const row = this.db.prepare(`
      SELECT account_id, expires_at, revoked_at FROM sessions WHERE token_hash = ?
    `).get(tokenHash(token)) as SessionRow | undefined;
    if (!row || row.revoked_at !== null) return undefined;
    if (Date.parse(row.expires_at) <= this.now()) return undefined;
    return row.account_id;
  }

  /** 退出登录：撤销会话。重复撤销不报错，已撤销的令牌永远不会恢复。 */
  invalidate(token: string): void {
    if (!token) return;
    this.db.prepare(`
      UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL
    `).run(new Date(this.now()).toISOString(), tokenHash(token));
  }

  /**
   * 清理已过期会话行，返回删除行数供运维观察；可重复调用（无过期行时返回 0）。
   * 只删过期行：未过期会话及其撤销标记保留，便于退出审计与"撤销后不可恢复"语义。
   * 过期行在任何授权判断中都会被 accountFor 拒绝，删除不改变可见行为，只回收磁盘空间。
   */
  purgeExpired(): number {
    const cutoff = new Date(this.now()).toISOString();
    const info = this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(cutoff);
    return Number(info.changes);
  }

  close(): void {
    this.db.close();
  }
}
