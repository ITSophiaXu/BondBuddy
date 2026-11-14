-- A resource semaphore for the existing model-call journal, not another job queue.
-- Waiting tickets may expire; a granted permit NEVER expires by time alone.
CREATE SEQUENCE bb_model_capacity_order;
CREATE TABLE bb_model_capacity_scopes (
 scope text PRIMARY KEY,
 last_granted bigint NOT NULL DEFAULT nextval('bb_model_capacity_order')
);
CREATE TABLE bb_model_capacity_waiters (
 token text PRIMARY KEY,
 scope text NOT NULL REFERENCES bb_model_capacity_scopes(scope),
 ticket bigint NOT NULL DEFAULT nextval('bb_model_capacity_order'),
 wait_until timestamptz NOT NULL
);
CREATE INDEX bb_model_capacity_waiters_order ON bb_model_capacity_waiters(scope,ticket);
CREATE TABLE bb_model_capacity_holders (
 token text PRIMARY KEY,
 scope text NOT NULL REFERENCES bb_model_capacity_scopes(scope),
 slot integer NOT NULL UNIQUE CHECK(slot BETWEEN 1 AND 4),
 host_id text NOT NULL,
 execution_host text NOT NULL,
 host_boot_id text NOT NULL,
 pid_namespace text NOT NULL,
 namespace_init_start text NOT NULL,
 parent_pid integer NOT NULL,
 parent_start text NOT NULL,
 child_pid integer,
 child_start text,
 child_group integer,
 codex_home text,
 granted_at timestamptz NOT NULL DEFAULT now(),
 renewed_at timestamptz NOT NULL DEFAULT now(),
 CHECK((child_pid IS NULL)=(child_start IS NULL))
);
