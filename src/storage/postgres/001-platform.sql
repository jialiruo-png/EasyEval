CREATE TABLE resource_versions (
  kind text NOT NULL CHECK (kind IN ('dataset','rule','scenario','task')),
  id text NOT NULL,
  version text NOT NULL,
  owner_id text NOT NULL,
  snapshot jsonb NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  archived_at timestamptz,
  PRIMARY KEY (kind,id,version),
  UNIQUE (owner_id,kind,id,version),
  CHECK (archived_at IS NULL OR kind <> 'scenario')
);
CREATE INDEX resource_versions_owner_created ON resource_versions(owner_id,kind,created_at DESC);
CREATE INDEX task_dataset_ref ON resource_versions(owner_id,(snapshot->'dataset'->>'id'),(snapshot->'dataset'->>'version')) WHERE kind = 'task';
CREATE INDEX task_rule_ref ON resource_versions(owner_id,(snapshot->'rule'->>'id'),(snapshot->'rule'->>'version')) WHERE kind = 'task';

CREATE TABLE dataset_row_sets (
  owner_id text NOT NULL,
  kind text NOT NULL DEFAULT 'dataset' CHECK (kind = 'dataset'),
  id text NOT NULL,
  version text NOT NULL,
  content_checksum text NOT NULL,
  cells json NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id,id,version),
  FOREIGN KEY (owner_id,kind,id,version) REFERENCES resource_versions(owner_id,kind,id,version)
);

CREATE TABLE result_runs (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  document json NOT NULL,
  CHECK (document->>'id' IS NOT NULL AND document->>'id' = id),
  CHECK (document->>'ownerAccountId' IS NOT NULL AND document->>'ownerAccountId' = owner_id),
  CHECK (document->>'status' IS NOT NULL AND document->>'status' IN ('queued','running','succeeded','partial_failed','failed','canceled')),
  CHECK (document->>'triggeredBy' IS NOT NULL AND document->>'triggeredBy' IN ('manual','schedule'))
);
CREATE INDEX result_runs_owner ON result_runs(owner_id,id);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  account_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_expires ON sessions(expires_at);
