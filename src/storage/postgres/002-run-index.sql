-- P5 运行索引：冻结的运行文档按账号隔离，重复触发由唯一幂等键拦截。
CREATE TABLE run_index (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  task_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','partial_failed','failed','canceled')),
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('manual','scheduled')),
  idempotency_key text NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (document->>'id' = id),
  CHECK (document->>'ownerAccountId' = owner_id),
  CHECK (document->>'status' = status),
  CHECK (document->>'idempotencyKey' = idempotency_key),
  UNIQUE (owner_id, idempotency_key)
);
CREATE INDEX run_index_owner_task ON run_index(owner_id, task_id, created_at DESC);
