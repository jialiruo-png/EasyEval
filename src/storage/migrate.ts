/** The platform uses PostgreSQL. An explicit legacy file remains supported for offline maintenance. */
import { migrate, openPool } from './postgres/database.ts';

const legacyPath = process.env.EVAL_DB_PATH;
if (legacyPath && !process.env.DATABASE_URL) {
  const { applyMigrations, migrationVersion, openDatabase } = await import('./migrations.ts');
  const dbPath = legacyPath;
  const db = openDatabase(dbPath);
  try {
    const from = migrationVersion(db);
    const applied = applyMigrations(db);
    const to = migrationVersion(db);
    process.stdout.write(`${JSON.stringify({ dbPath, from, to, applied }, null, 2)}\n`);
  } finally {
    db.close();
  }
} else {
  const pool = openPool();
  try { await migrate(pool); } finally { await pool.end(); }
}
