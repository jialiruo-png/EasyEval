-- P3/P4 前置：向导草稿与预览索引按账号隔离，与正式运行批次分表。
-- 草稿存整份冻结文档（引用、查询列、样本、映射、状态、revision、到期与确认载荷）。
CREATE TABLE drafts (
  owner_id text NOT NULL,
  id text NOT NULL,
  PRIMARY KEY (owner_id, id),
  step integer NOT NULL CHECK (step IN (1,2,3,4)),
  status text NOT NULL CHECK (status IN ('active','canceled','confirmed')),
  revision integer NOT NULL CHECK (revision >= 1),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  document jsonb NOT NULL,
  CHECK (document->>'id' = id),
  CHECK (document->>'ownerAccountId' = owner_id),
  CHECK (document->>'status' = status),
  CHECK ((document->>'revision')::integer = revision),
  CHECK ((document->>'step')::integer = step)
);
CREATE INDEX drafts_owner_created ON drafts(owner_id, created_at DESC, id);

-- 预览键含 NUL 分隔符，不能存进 text/jsonb，改存其 base64 编码并在读回时还原。
-- 同一账号下草稿＋样本唯一，签名变化时领域会删除旧行再以同键重建。
CREATE TABLE draft_previews (
  key_b64 text PRIMARY KEY,
  owner_id text NOT NULL,
  draft_id text NOT NULL,
  sample_id text NOT NULL,
  signature text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','running','succeeded','failed','canceled')),
  attempts integer NOT NULL CHECK (attempts >= 1),
  reason text,
  trace_ref text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (owner_id, draft_id, sample_id)
);
CREATE INDEX draft_previews_owner_draft ON draft_previews(owner_id, draft_id, created_at, sample_id);
