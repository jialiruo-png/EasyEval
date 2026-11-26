/**
 * SQLite 迁移（阻塞期可准备工作）：结果读取的运行索引、服务端会话与 P2 四类版本化资源落盘。
 * 只使用 Node 22 内置 node:sqlite；不安装依赖、不访问上游、不调用模型。
 *
 * 迁移是前向、幂等的：schema_migrations 记录已应用版本；重复执行只读不写。
 * 迁移版本按数组顺序连续编号，代码版本低于账本版本时拒绝执行，避免降级破坏数据。
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'runs-and-migration-ledger',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        owner_account_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        dataset_version_id TEXT NOT NULL,
        rule_version_id TEXT NOT NULL,
        rule_json TEXT NOT NULL,
        triggered_by TEXT NOT NULL CHECK (triggered_by IN ('manual', 'schedule')),
        triggered_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'queued', 'running', 'succeeded', 'partial_failed', 'failed', 'canceled'
        )),
        progress_completed INTEGER,
        progress_total INTEGER,
        CHECK ((progress_completed IS NULL) = (progress_total IS NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_runs_owner ON runs(owner_account_id, id);
    `,
  },
  {
    version: 2,
    name: 'samples-and-judge-attempts',
    sql: `
      CREATE TABLE IF NOT EXISTS samples (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        query TEXT NOT NULL,
        answer_summary TEXT,
        answer TEXT,
        duration_ms REAL,
        effective_attempt_id TEXT,
        evidence_json TEXT,
        trace_json TEXT,
        PRIMARY KEY (run_id, id),
        UNIQUE (run_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS judge_attempts (
        run_id TEXT NOT NULL,
        sample_id TEXT NOT NULL,
        id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        raw_response TEXT,
        business_json TEXT,
        has_business_json INTEGER NOT NULL DEFAULT 0 CHECK (has_business_json IN (0, 1)),
        PRIMARY KEY (run_id, sample_id, id),
        UNIQUE (run_id, sample_id, ordinal),
        FOREIGN KEY (run_id, sample_id) REFERENCES samples(run_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_attempts_lookup
        ON judge_attempts(run_id, sample_id, ordinal);
    `,
  },
  {
    version: 3,
    name: 'server-sessions',
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
    `,
  },
  {
    version: 4,
    name: 'versioned-resources',
    sql: `
      CREATE TABLE IF NOT EXISTS resource_versions (
        resource_kind TEXT NOT NULL CHECK (resource_kind IN ('scenario', 'dataset', 'rule', 'task')),
        id TEXT NOT NULL,
        version TEXT NOT NULL,
        owner_account_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (resource_kind, id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_resource_versions_owner
        ON resource_versions(resource_kind, owner_account_id, id);
    `,
  },
  {
    version: 5,
    name: 'dataset-import-rows',
    sql: `
      CREATE TABLE IF NOT EXISTS dataset_row_sets (
        dataset_id TEXT NOT NULL,
        dataset_version TEXT NOT NULL,
        owner_account_id TEXT NOT NULL,
        content_checksum TEXT NOT NULL,
        row_count INTEGER NOT NULL CHECK (row_count >= 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (dataset_id, dataset_version)
      );
      CREATE INDEX IF NOT EXISTS idx_dataset_row_sets_owner
        ON dataset_row_sets(owner_account_id, dataset_id, dataset_version);
      CREATE TABLE IF NOT EXISTS dataset_rows (
        dataset_id TEXT NOT NULL,
        dataset_version TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        row_id TEXT NOT NULL,
        cells_json TEXT NOT NULL,
        PRIMARY KEY (dataset_id, dataset_version, ordinal),
        UNIQUE (dataset_id, dataset_version, row_id),
        FOREIGN KEY (dataset_id, dataset_version)
          REFERENCES dataset_row_sets(dataset_id, dataset_version) ON DELETE CASCADE
      );
    `,
  },
  {
    version: 6,
    name: 'archived-resources',
    sql: `
      CREATE TABLE IF NOT EXISTS archived_resources (
        resource_kind TEXT NOT NULL CHECK (resource_kind IN ('dataset', 'rule', 'task')),
        id TEXT NOT NULL,
        version TEXT NOT NULL,
        owner_account_id TEXT NOT NULL,
        archived_at TEXT NOT NULL,
        PRIMARY KEY (resource_kind, id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_archived_resources_owner
        ON archived_resources(resource_kind, owner_account_id, id);
    `,
  },
];

function assertMigrationOrder(): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`迁移版本必须连续且从 1 开始：${migration.version}`);
    }
  });
}

/** 打开本机 SQLite 文件；路径的父目录按需创建，并开启外键约束。 */
export function openDatabase(filePath: string): DatabaseSync {
  if (filePath !== ':memory:') {
    mkdirSync(dirname(resolve(filePath)), { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
  return db;
}

/** 当前账本版本；账本未建立时返回 0。 */
export function migrationVersion(db: DatabaseSync): number {
  const table = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get() as { name: string } | undefined;
  if (!table) return 0;
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    version: number | null;
  };
  return row.version ?? 0;
}

/** 顺序应用尚未应用的迁移；返回本轮实际应用的版本号。 */
export function applyMigrations(db: DatabaseSync): number[] {
  assertMigrationOrder();
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = migrationVersion(db);
    const latestCode = migrations.at(-1)?.version ?? 0;
    if (current > latestCode) throw new Error(`数据库迁移版本 ${current} 高于代码版本 ${latestCode}，请升级代码后再运行`);
    const applied: number[] = [];
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, new Date().toISOString());
      applied.push(migration.version);
    }
    db.exec('COMMIT');
    return applied;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
