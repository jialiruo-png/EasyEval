import { createPlatformServer } from '../../server.ts';
import { migrate, openPool, PostgresStore } from './database.ts';

const pool = openPool();
const command = process.argv[2];
try {
  await migrate(pool);
  if (command === 'serve') {
    const host = process.env.HOST ?? '127.0.0.1';
    const port = Number(process.env.PORT ?? 8080);
    const server = createPlatformServer(new PostgresStore(pool));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    console.log(`评测平台 API 已启动 http://${host}:${port}/api/health`);
    const stop = () => server.close(() => { void pool.end(); });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } else if (command === 'migrate') {
    console.log('PostgreSQL 数据库迁移完成');
    await pool.end();
  } else if (command === 'session' && process.argv[3]?.trim()) {
    console.log(await new PostgresStore(pool).create(process.argv[3]));
    await pool.end();
  } else {
    throw new Error('可用命令为 serve、migrate、session <accountId>');
  }
} catch (error) {
  await pool.end();
  console.error('平台启动失败，请检查 DATABASE_URL、数据库权限及启动参数。',
    error && typeof error === 'object' && 'code' in error ? error.code : '');
  process.exitCode = 1;
}
