import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { validateRunRecord, type RunRecord } from '../../result-api/store.ts';

export function openPool(url = process.env.DATABASE_URL): Pool {
  if (!url || !/^postgres(?:ql)?:\/\//.test(url)) throw new Error('请在后端配置 PostgreSQL 的 DATABASE_URL');
  const pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000 });
  pool.on('error', () => console.error('PostgreSQL 空闲连接已断开'));
  return pool;
}

export async function transaction<T>(
  pool: Pool, readOnly: boolean, work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
  }
}

const migrations = ['001-platform.sql', '002-run-index.sql', '003-drafts.sql', '004-preview-execution.sql'];
export async function migrate(pool: Pool): Promise<void> {
  await transaction(pool, false, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(56071, 1)');
    await client.query('CREATE TABLE IF NOT EXISTS eval_schema_versions(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const { rows } = await client.query<{ version: number }>('SELECT version FROM eval_schema_versions ORDER BY version');
    if (rows.some((row, index) => row.version !== index + 1) || rows.length > migrations.length) {
      throw new Error('数据库迁移版本与当前平台不兼容');
    }
    for (const [index, name] of migrations.entries()) {
      if (index < rows.length) continue;
      const sql = await readFile(new URL(name, import.meta.url), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO eval_schema_versions(version) VALUES ($1)', [index + 1]);
    }
  });
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class PostgresStore {
  readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  async create(accountId: string): Promise<string> {
    if (!accountId?.trim()) throw new Error('账号 ID 不能为空');
    const token = randomBytes(32).toString('base64url');
    await this.pool.query("INSERT INTO sessions(token_hash,account_id,expires_at) VALUES ($1,$2,now()+interval '24 hours')",
      [tokenHash(token), accountId]);
    return token;
  }

  async accountFor(token: string | undefined): Promise<string | undefined> {
    if (!token) return undefined;
    const result = await this.pool.query<{ account_id: string }>(
      'SELECT account_id FROM sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now()', [tokenHash(token)]);
    return result.rows[0]?.account_id;
  }

  async invalidate(token: string): Promise<void> {
    await this.pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', [tokenHash(token)]);
  }

  async purgeExpired(): Promise<number> {
    const result = await this.pool.query('DELETE FROM sessions WHERE expires_at <= now()');
    return result.rowCount ?? 0;
  }

  async insertRun(record: RunRecord): Promise<void> {
    validateRunRecord(record);
    await this.pool.query('INSERT INTO result_runs(id,owner_id,document) VALUES ($1,$2,$3::json)',
      [record.id, record.ownerAccountId, JSON.stringify(record)]);
  }

  async findRunForAccount(id: string, owner: string | undefined): Promise<RunRecord | undefined> {
    if (!owner) return undefined;
    const result = await this.pool.query<{ document: RunRecord }>(
      'SELECT document FROM result_runs WHERE owner_id=$1 AND id=$2', [owner, id]);
    return result.rows[0]?.document;
  }
}
