import { createServer } from 'node:http';
import { sendError, sendJson } from './http/json.ts';
import { handleImportHttp } from './import-api/http.ts';
import { handleResourceHttp } from './resource-api/http.ts';
import { handleResultHttp } from './result-api/http.ts';
import { handleRunHttp, isRunIndexRoute } from './run-api/http.ts';
import { listPostgresResources, postgresCatalogAccess } from './storage/postgres/catalog.ts';
import { PostgresStore } from './storage/postgres/database.ts';
import { postgresRunIndex } from './storage/postgres/run-index.ts';

export function createPlatformServer(store: PostgresStore) {
  const access = postgresCatalogAccess(store.pool);
  const runs = postgresRunIndex(store.pool);
  return createServer(async (req, res) => {
    try {
      const path = (req.url ?? '').split('?')[0];
      if (path === '/api/health' && req.method === 'GET') {
        await store.pool.query('SELECT 1');
        sendJson(res, 200, { status: 'ok', database: 'postgresql' });
      } else if (path.startsWith('/api/resources/')) await handleResourceHttp(req, res, access, (owner, kind, query) => listPostgresResources(store.pool, owner, kind, query), store);
      else if (path.startsWith('/api/imports/')) await handleImportHttp(req, res, access, store);
      else if (path?.startsWith('/api/runs')) {
        if (isRunIndexRoute(path)) await handleRunHttp(req, res, runs, store);
        else await handleResultHttp(req, res, store, store);
      }
      else sendError(res, 404, 'NOT_FOUND', '接口不可用');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === '23505') sendError(res, 409, 'VERSION_CONFLICT', '资源版本已存在');
      else if (['22P05','22P02','22021','54000'].includes(code)) sendError(res, 400, 'BAD_REQUEST', '输入超出数据库支持范围');
      else {
        console.error('平台请求失败', /^\w{5}$/.test(code) ? code : 'internal');
        sendError(res, 500, 'INTERNAL', '服务器内部错误');
      }
    }
  });
}
