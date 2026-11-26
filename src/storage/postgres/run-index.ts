/**
 * 运行索引的 PostgreSQL 落盘适配层（P5 准备）。
 *
 * 与资源目录一致：事务开始时只加载本次涉及的冻结版本和该账号的运行记录，
 * 校验、幂等判断与状态流转全部复用 src/domain/runs.ts 的同步领域规则，
 * 成功后再把新增或变更的整份运行文档写回；失败事务不留半成品。
 * 归属始终由调用方（服务端会话）传入，请求体不能自报账号。
 * 不接 Runner 与调度，不访问上游、不调用模型。
 */
import type { Pool, PoolClient } from 'pg';
import { ResourceCatalog } from '../../domain/resources.ts';
import {
  InMemoryRunStore, RunIndex,
  type RequestRunInput, type RequestRunResult, type RunRecord, type RunResult,
  type RunStatus, type SampleStatus,
} from '../../domain/runs.ts';
import { catalogForRuns } from './catalog.ts';
import { transaction } from './database.ts';

interface RunRow {
  id: string;
  owner_id: string;
  idempotency_key: string;
  document: RunRecord;
}

export type RunRequest = Omit<RequestRunInput, 'ownerAccountId'>;

export interface PostgresRunIndex {
  requestRun(ownerAccountId: string, input: RunRequest): Promise<RequestRunResult>;
  transitionRun(runId: string, ownerAccountId: string | undefined, next: RunStatus): Promise<RunResult>;
  cancelRun(runId: string, ownerAccountId: string | undefined): Promise<RunResult>;
  setSampleStatus(
    runId: string, ownerAccountId: string | undefined, sampleId: string, next: SampleStatus, reason?: string,
  ): Promise<RunResult>;
  getRun(runId: string, ownerAccountId: string | undefined): Promise<RunRecord | undefined>;
  listRuns(ownerAccountId: string | undefined): Promise<RunRecord[]>;
  listRunsForTask(ownerAccountId: string | undefined, taskId: string): Promise<RunRecord[]>;
}

/** 同一账号的写操作按账号串行，与资源目录使用同一把事务锁。 */
async function lockOwner(client: PoolClient, owner: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [owner]);
}

async function loadStore(client: PoolClient, owner: string, runId?: string) {
  const result = await client.query<RunRow>(
    `SELECT id,owner_id,idempotency_key,document FROM run_index WHERE owner_id=$1
     ${runId === undefined ? '' : 'AND id=$2'} ORDER BY created_at DESC, id`,
    runId === undefined ? [owner] : [owner, runId],
  );
  const store = new InMemoryRunStore();
  for (const row of result.rows) store.save(row.document);
  return { store, rows: result.rows };
}

function indexFor(store: InMemoryRunStore, catalog: ResourceCatalog = new ResourceCatalog()): RunIndex {
  return new RunIndex(catalog, { store });
}

async function insertRun(client: PoolClient, record: RunRecord): Promise<void> {
  await client.query(
    `INSERT INTO run_index(id,owner_id,task_id,status,trigger_kind,idempotency_key,document,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [record.id, record.ownerAccountId, record.task.id, record.status, record.trigger,
      record.idempotencyKey, JSON.stringify(record), record.createdAt],
  );
}

async function persistChanges(client: PoolClient, rows: RunRow[], store: InMemoryRunStore): Promise<void> {
  for (const row of rows) {
    const updated = store.peek(row.id);
    if (!updated || JSON.stringify(updated) === JSON.stringify(row.document)) continue;
    await client.query('UPDATE run_index SET status=$1,document=$2::jsonb WHERE owner_id=$3 AND id=$4',
      [updated.status, JSON.stringify(updated), row.owner_id, row.id]);
  }
}

export function postgresRunIndex(pool: Pool): PostgresRunIndex {
  return {
    requestRun(owner, input) {
      return transaction(pool, false, async (client) => {
        await lockOwner(client, owner);
        const refs = [input?.task].filter((item): item is NonNullable<typeof item> => Boolean(item));
        const catalog = await catalogForRuns(client, owner, refs, input?.binding);
        const { store } = await loadStore(client, owner);
        const result = indexFor(store, catalog).requestRun({ ...input, ownerAccountId: owner });
        if (result.ok && result.run && !result.replayed && !result.skipped) {
          await insertRun(client, result.run);
        }
        return result;
      });
    },

    transitionRun(runId, owner, next) {
      return transaction(pool, false, async (client) => {
        await lockOwner(client, owner ?? '');
        const { store, rows } = await loadStore(client, owner ?? '', runId);
        const result = indexFor(store).transitionRun(runId, owner, next);
        if (result.ok) await persistChanges(client, rows, store);
        return result;
      });
    },

    cancelRun(runId, owner) {
      return transaction(pool, false, async (client) => {
        await lockOwner(client, owner ?? '');
        const { store, rows } = await loadStore(client, owner ?? '', runId);
        const result = indexFor(store).cancelRun(runId, owner);
        if (result.ok) await persistChanges(client, rows, store);
        return result;
      });
    },

    setSampleStatus(runId, owner, sampleId, next, reason) {
      return transaction(pool, false, async (client) => {
        await lockOwner(client, owner ?? '');
        const { store, rows } = await loadStore(client, owner ?? '', runId);
        const result = indexFor(store).setSampleStatus(runId, owner, sampleId, next, reason);
        if (result.ok) await persistChanges(client, rows, store);
        return result;
      });
    },

    getRun(runId, owner) {
      if (!owner) return Promise.resolve(undefined);
      return transaction(pool, true, async (client) => {
        const { store } = await loadStore(client, owner, runId);
        return store.get(runId, owner);
      });
    },

    listRuns(owner) {
      if (!owner) return Promise.resolve([]);
      return transaction(pool, true, async (client) => {
        const { store } = await loadStore(client, owner);
        return store.list(owner);
      });
    },

    listRunsForTask(owner, taskId) {
      if (!owner) return Promise.resolve([]);
      return transaction(pool, true, async (client) => {
        const { store } = await loadStore(client, owner);
        return store.list(owner).filter((run) => run.task.id === taskId);
      });
    },
  };
}
