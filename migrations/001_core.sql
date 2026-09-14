CREATE TABLE IF NOT EXISTS work (
  id text PRIMARY KEY, tenant text NOT NULL, request_key text NOT NULL,
  digest text NOT NULL, data jsonb NOT NULL,
  UNIQUE (tenant, request_key)
);
CREATE TABLE IF NOT EXISTS outbox (
  work_id text PRIMARY KEY REFERENCES work(id), state text NOT NULL CHECK (state IN ('pending','claimed','dispatched','done')),
  generation integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS context (
  id text PRIMARY KEY, tenant text NOT NULL, owner text NOT NULL, name text NOT NULL,
  data jsonb NOT NULL, UNIQUE (tenant, owner, name)
);
CREATE TABLE IF NOT EXISTS binding (
  tenant text NOT NULL, thread text NOT NULL, revision integer NOT NULL,
  context_id text NOT NULL REFERENCES context(id), PRIMARY KEY (tenant, thread)
);
CREATE TABLE IF NOT EXISTS binding_request (
  tenant text NOT NULL, request_key text NOT NULL, digest text NOT NULL,
  data jsonb NOT NULL, PRIMARY KEY (tenant, request_key)
);
CREATE TABLE IF NOT EXISTS resource (
  id text NOT NULL, tenant text NOT NULL, manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant, id)
);
CREATE TABLE IF NOT EXISTS event (
  sequence bigserial PRIMARY KEY, work_id text NOT NULL REFERENCES work(id),
  tenant text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_work ON event(work_id, sequence);
CREATE TABLE IF NOT EXISTS scheduler (
  id integer PRIMARY KEY CHECK (id=1), last_tenant text
);
INSERT INTO scheduler(id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS job_allocation (
  work_id text PRIMARY KEY REFERENCES work(id), backend text NOT NULL,
  allocation jsonb NOT NULL, released boolean NOT NULL DEFAULT false,
  release_error text
);
CREATE TABLE IF NOT EXISTS thread_tools (
  tenant text NOT NULL, thread text NOT NULL, revision integer NOT NULL,
  connections jsonb NOT NULL, PRIMARY KEY (tenant, thread)
);
