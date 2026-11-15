-- Sole-database admission and capacity authority. Default preserves global four.
-- Node identity is trusted cloud account/region/instance plus explicit start epoch.
CREATE TABLE bb_execution_capacity_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision bigint NOT NULL DEFAULT 0,
 managed_nodes boolean NOT NULL DEFAULT false,
 global_model_limit integer NOT NULL DEFAULT 4 CHECK(global_model_limit IN (4,8)),
 node_model_limit integer NOT NULL DEFAULT 4 CHECK(node_model_limit=4),
 max_nodes integer NOT NULL DEFAULT 2 CHECK(max_nodes BETWEEN 1 AND 2),
 budget_available boolean NOT NULL DEFAULT true,
 cooldown_until timestamptz,
 provider_concurrency_limit integer NOT NULL DEFAULT 4 CHECK(provider_concurrency_limit BETWEEN 1 AND 64),
 provider_policy_sha256 char(64),expense_policy_sha256 char(64),
 CHECK(global_model_limit<=provider_concurrency_limit),
 CHECK(global_model_limit<=4 OR (provider_policy_sha256 IS NOT NULL AND expense_policy_sha256 IS NOT NULL)),
 CHECK(managed_nodes OR global_model_limit<=4)
);
INSERT INTO bb_execution_capacity_policy(singleton) VALUES(true);
CREATE TABLE bb_execution_nodes (
 id text PRIMARY KEY,
 account_id text NOT NULL,region text NOT NULL,instance_id text NOT NULL,
 epoch uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('starting','ready','draining','drained','stop_submitted','stopped','lost')),
 revision bigint NOT NULL DEFAULT 0,
 source_sha256 char(64) NOT NULL,image_sha256 char(64) NOT NULL,
 launch_manifest_sha256 char(64) NOT NULL,
 capabilities text[] NOT NULL,
 expected_services jsonb NOT NULL,
 registration_token_sha256 char(64),
 cloud_start_operation_id text NOT NULL,
 drain_operation_id text,stop_operation_id text,
 drain_proof jsonb,
 last_heartbeat_at timestamptz,idle_since timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),destroyed_at timestamptz,
 UNIQUE(account_id,region,instance_id)
);
CREATE TABLE bb_execution_node_sessions (
 session_id uuid PRIMARY KEY,
 service_id text NOT NULL,
 node_id text NOT NULL REFERENCES bb_execution_nodes(id),epoch uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('active','finished','lost')),
 process_identity jsonb NOT NULL,
 native_processes integer NOT NULL DEFAULT -1 CHECK(native_processes>=-1),
 unpersisted_results integer NOT NULL DEFAULT -1 CHECK(unpersisted_results>=-1),
 ready boolean NOT NULL DEFAULT false,
 heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 UNIQUE(node_id,epoch,service_id),
 CHECK(state<>'finished' OR (native_processes=0 AND unpersisted_results=0 AND finished_at IS NOT NULL))
);
CREATE TABLE bb_execution_cloud_operations (
 operation_id text PRIMARY KEY,
 account_id text NOT NULL,region text NOT NULL,instance_id text,
 epoch uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('run','start','stop','destroy')),
 state text NOT NULL CHECK(state IN ('intent','submitted','unknown','completed','rejected','cancelled')),
 revision bigint NOT NULL DEFAULT 0,
 request jsonb,request_sha256 char(64) NOT NULL,policy_revision bigint,
 client_token text NOT NULL UNIQUE,
 provider_request_id text,
 proof_sha256 char(64),
 holder_preimage jsonb NOT NULL DEFAULT '[]'::jsonb,
 node_preimage jsonb,reserved_node_preimage jsonb,
 cloud_observation jsonb,rejection_evidence jsonb,retry_after timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 dispatched_at timestamptz,
 completed_at timestamptz
);
CREATE INDEX bb_execution_cloud_pending ON bb_execution_cloud_operations(state,created_at);
ALTER TABLE bb_jobs ADD COLUMN execution_node_id text REFERENCES bb_execution_nodes(id),
 ADD COLUMN execution_node_epoch uuid,ADD COLUMN execution_session_id uuid REFERENCES bb_execution_node_sessions(session_id),ADD COLUMN execution_admission_policy_revision bigint;
ALTER TABLE bb_review_messages ADD COLUMN execution_node_id text REFERENCES bb_execution_nodes(id),
 ADD COLUMN execution_node_epoch uuid,ADD COLUMN execution_session_id uuid REFERENCES bb_execution_node_sessions(session_id),ADD COLUMN execution_admission_policy_revision bigint;
-- A full node must not head-of-line block another eligible node.
ALTER TABLE bb_model_capacity_waiters ADD COLUMN execution_node_id text REFERENCES bb_execution_nodes(id),
 ADD COLUMN execution_node_epoch uuid,ADD COLUMN execution_session_id uuid REFERENCES bb_execution_node_sessions(session_id),
 ADD COLUMN admission_job_id text REFERENCES bb_jobs(id),ADD COLUMN admission_message_id text REFERENCES bb_review_messages(id),ADD COLUMN admission_lease_token text;
-- Global slots remain unique; the authoritative range is now policy, not an env.
ALTER TABLE bb_model_capacity_holders DROP CONSTRAINT bb_model_capacity_holders_slot_check;
ALTER TABLE bb_model_capacity_holders ADD CONSTRAINT bb_model_capacity_global_slot_check CHECK(slot BETWEEN 1 AND 64),
 ADD COLUMN execution_node_id text REFERENCES bb_execution_nodes(id),
 ADD COLUMN execution_node_epoch uuid,ADD COLUMN execution_session_id uuid REFERENCES bb_execution_node_sessions(session_id),
 ADD COLUMN node_slot integer CHECK(node_slot BETWEEN 1 AND 4),
 ADD COLUMN admission_job_id text REFERENCES bb_jobs(id),
 ADD COLUMN admission_message_id text REFERENCES bb_review_messages(id),
 ADD CONSTRAINT bb_model_capacity_node_slot UNIQUE(execution_node_id,node_slot),
 ADD CONSTRAINT bb_model_capacity_node_binding CHECK((execution_node_id IS NULL)=(node_slot IS NULL));

CREATE FUNCTION bb_execution_claim_context() RETURNS bb_execution_nodes LANGUAGE plpgsql AS $$
DECLARE n bb_execution_nodes;s bb_execution_node_sessions;node_key text;session_key uuid;epoch_key uuid;policy bb_execution_capacity_policy;occupied integer;
BEGIN
 SELECT * INTO policy FROM bb_execution_capacity_policy WHERE singleton FOR SHARE;
 node_key:=NULLIF(current_setting('bb.execution_node_id',true),'');
 IF node_key IS NULL THEN
  IF policy.managed_nodes THEN RAISE EXCEPTION 'Execution node admission required' USING ERRCODE='55000'; END IF;
  RETURN NULL;
 END IF;
 epoch_key:=NULLIF(current_setting('bb.execution_node_epoch',true),'')::uuid;
 session_key:=NULLIF(current_setting('bb.execution_session_id',true),'')::uuid;
 -- Same node row lock is used by beginDrain. A claim commits before or after it,
 -- never between its gate and durable lease write.
 SELECT * INTO n FROM bb_execution_nodes WHERE id=node_key FOR UPDATE;
 SELECT * INTO s FROM bb_execution_node_sessions WHERE session_id=session_key AND node_id=node_key AND epoch=epoch_key;
 IF NOT policy.budget_available THEN RAISE EXCEPTION 'Execution admission budget unavailable' USING ERRCODE='55000'; END IF;
 IF n.id IS NULL OR n.epoch<>epoch_key OR n.state<>'ready' OR s.state IS DISTINCT FROM 'active'
  OR NOT s.ready OR s.heartbeat_at<clock_timestamp()-interval '30 seconds'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(n.expected_services) service
   WHERE NOT EXISTS(SELECT 1 FROM bb_execution_node_sessions peer WHERE peer.node_id=n.id AND peer.epoch=n.epoch
    AND peer.service_id=service->>'service_id' AND peer.state='active' AND peer.ready AND peer.heartbeat_at>clock_timestamp()-interval '30 seconds'))
  THEN RAISE EXCEPTION 'Execution node not ready' USING ERRCODE='55000'; END IF;
 SELECT (SELECT count(*) FROM bb_jobs WHERE execution_node_id=n.id AND lease_token IS NOT NULL)
  +(SELECT count(*) FROM bb_review_messages WHERE execution_node_id=n.id AND lease_token IS NOT NULL) INTO occupied;
 IF occupied>=4 THEN RAISE EXCEPTION 'Execution node claim slots full' USING ERRCODE='55000'; END IF;
 RETURN n;
END $$;
CREATE FUNCTION bb_execution_guard_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bb_execution_nodes;capability text;
BEGIN
 IF NEW.lease_token IS NULL OR (TG_OP='UPDATE' AND NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token) THEN RETURN NEW; END IF;
 -- Resident material parsing is outside the elastic model pool.
 IF TG_TABLE_NAME='bb_jobs' THEN
  IF NEW.job_type='parse' THEN RETURN NEW; END IF;
 END IF;
 IF TG_OP='UPDATE' AND OLD.execution_node_id IS NOT NULL AND OLD.lease_token IS NOT NULL THEN RAISE EXCEPTION 'Owned node lease requires positive process recovery' USING ERRCODE='55000'; END IF;
 n:=bb_execution_claim_context();
 IF n.id IS NOT NULL THEN
  capability:=CASE WHEN TG_TABLE_NAME='bb_review_messages' THEN 'assistant' ELSE NULL END;
  IF TG_TABLE_NAME='bb_jobs' THEN capability:=CASE WHEN NEW.job_type='platform_probe' THEN 'probe' WHEN NEW.job_type='review' THEN 'review' ELSE 'authoring' END; END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(n.expected_services) svc WHERE svc->>'service_id'=(SELECT service_id FROM bb_execution_node_sessions WHERE session_id=NULLIF(current_setting('bb.execution_session_id',true),'')::uuid) AND svc->'capabilities' ? capability) THEN RAISE EXCEPTION 'Execution service capability mismatch' USING ERRCODE='55000'; END IF;
  UPDATE bb_execution_nodes SET idle_since=NULL WHERE id=n.id;
  NEW.execution_node_id:=n.id;NEW.execution_node_epoch:=n.epoch;
  SELECT revision INTO NEW.execution_admission_policy_revision FROM bb_execution_capacity_policy WHERE singleton;
  NEW.execution_session_id:=NULLIF(current_setting('bb.execution_session_id',true),'')::uuid;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_execution_job_admission BEFORE INSERT OR UPDATE OF lease_token ON bb_jobs FOR EACH ROW EXECUTE FUNCTION bb_execution_guard_claim();
CREATE TRIGGER bb_execution_assistant_admission BEFORE INSERT OR UPDATE OF lease_token ON bb_review_messages FOR EACH ROW EXECUTE FUNCTION bb_execution_guard_claim();

CREATE FUNCTION bb_execution_guard_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p bb_execution_capacity_policy;n bb_execution_nodes;s bb_execution_node_sessions;ok boolean;
BEGIN
 -- Renewal/binding keeps its existing entitlement, including draining/lost.
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.token,NEW.scope,NEW.slot,NEW.host_id,NEW.execution_host,NEW.host_boot_id,NEW.pid_namespace,NEW.namespace_init_start,NEW.parent_pid,NEW.parent_start,NEW.execution_node_id,NEW.execution_node_epoch,NEW.execution_session_id,NEW.node_slot,NEW.admission_job_id,NEW.admission_message_id)
   IS DISTINCT FROM ROW(OLD.token,OLD.scope,OLD.slot,OLD.host_id,OLD.execution_host,OLD.host_boot_id,OLD.pid_namespace,OLD.namespace_init_start,OLD.parent_pid,OLD.parent_start,OLD.execution_node_id,OLD.execution_node_epoch,OLD.execution_session_id,OLD.node_slot,OLD.admission_job_id,OLD.admission_message_id)
   THEN RAISE EXCEPTION 'Model entitlement identity immutable'; END IF;
  IF OLD.child_pid IS NOT NULL AND ROW(NEW.child_pid,NEW.child_start,NEW.child_group,NEW.codex_home) IS DISTINCT FROM ROW(OLD.child_pid,OLD.child_start,OLD.child_group,OLD.codex_home) THEN RAISE EXCEPTION 'Bound model process identity immutable'; END IF;
  RETURN NEW;
 END IF;
 PERFORM pg_advisory_xact_lock(1111641411,0);
 SELECT * INTO p FROM bb_execution_capacity_policy WHERE singleton FOR SHARE;
 IF (NOT p.budget_available AND NEW.execution_node_id IS NULL) OR NEW.slot>p.global_model_limit
  OR (SELECT count(*) FROM bb_model_capacity_holders)>=p.global_model_limit
  THEN RAISE EXCEPTION 'Global model budget unavailable' USING ERRCODE='55000'; END IF;
 IF NEW.execution_node_id IS NULL THEN
  IF p.managed_nodes THEN RAISE EXCEPTION 'Managed model entitlement required' USING ERRCODE='55000'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO n FROM bb_execution_nodes WHERE id=NEW.execution_node_id FOR UPDATE;
 SELECT * INTO s FROM bb_execution_node_sessions WHERE session_id=NEW.execution_session_id AND node_id=n.id AND epoch=NEW.execution_node_epoch;
 IF n.epoch IS DISTINCT FROM NEW.execution_node_epoch OR n.state NOT IN ('ready','draining')
  OR s.state IS DISTINCT FROM 'active' OR (SELECT count(*) FROM bb_model_capacity_holders WHERE execution_node_id=n.id)>=4
  THEN RAISE EXCEPTION 'Node model entitlement unavailable' USING ERRCODE='55000'; END IF;
 -- Only a positively owned current lease can authorize follow-up calls while
 -- draining; an unleased probe or a stale runtime epoch cannot create a call.
 SELECT EXISTS(SELECT 1 FROM bb_jobs j WHERE j.id=NEW.admission_job_id AND j.execution_node_id=n.id
  AND j.execution_node_epoch=n.epoch AND j.execution_session_id=s.session_id AND j.state='running' AND j.lease_token IS NOT NULL AND j.lease_until>clock_timestamp()
  AND j.execution_admission_policy_revision IS NOT NULL AND j.lease_token=current_setting('bb.execution_lease_token',true)) OR
  EXISTS(SELECT 1 FROM bb_review_messages m WHERE m.id=NEW.admission_message_id AND m.execution_node_id=n.id
  AND m.execution_node_epoch=n.epoch AND m.execution_session_id=s.session_id AND m.reply_status='running' AND m.lease_token IS NOT NULL AND m.lease_until>clock_timestamp()
  AND m.execution_admission_policy_revision IS NOT NULL AND m.lease_token::text=current_setting('bb.execution_lease_token',true)) INTO ok;
 IF NOT ok THEN RAISE EXCEPTION 'Model admission lease missing' USING ERRCODE='55000'; END IF;
 UPDATE bb_execution_nodes SET idle_since=NULL WHERE id=n.id;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_execution_model_admission BEFORE INSERT OR UPDATE ON bb_model_capacity_holders FOR EACH ROW EXECUTE FUNCTION bb_execution_guard_capacity();

CREATE FUNCTION bb_execution_guard_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE completed boolean;
BEGIN
 IF ROW(NEW.account_id,NEW.region,NEW.instance_id) IS DISTINCT FROM ROW(OLD.account_id,OLD.region,OLD.instance_id) THEN RAISE EXCEPTION 'Cloud identity immutable'; END IF;
 IF OLD.state='stop_submitted' AND (NEW.state<>OLD.state OR NEW.epoch<>OLD.epoch) THEN
  SELECT EXISTS(SELECT 1 FROM bb_execution_cloud_operations o WHERE o.operation_id=OLD.stop_operation_id AND o.state='completed'
   AND o.action IN ('stop','destroy') AND o.account_id=OLD.account_id AND o.region=OLD.region AND o.instance_id=OLD.instance_id AND o.epoch=OLD.epoch
   AND o.cloud_observation IS NOT NULL) INTO completed;
  IF NOT completed OR NEW.state<>'stopped' OR NEW.epoch<>OLD.epoch THEN RAISE EXCEPTION 'Stop outcome unresolved'; END IF;
 END IF;
 IF NEW.epoch<>OLD.epoch AND OLD.state='starting' AND NEW.state='stopped' AND NEW.revision=OLD.revision+1
  AND EXISTS(SELECT 1 FROM bb_execution_cloud_operations o WHERE o.operation_id=OLD.cloud_start_operation_id
   AND o.action='start' AND o.state='cancelled' AND o.dispatched_at IS NULL AND o.provider_request_id IS NULL
   AND o.reserved_node_preimage=to_jsonb(OLD) AND o.node_preimage-'revision'=to_jsonb(NEW)-'revision')
  AND NOT EXISTS(SELECT 1 FROM bb_execution_node_sessions WHERE node_id=OLD.id AND epoch=OLD.epoch)
  AND NOT EXISTS(SELECT 1 FROM bb_model_capacity_holders WHERE execution_node_id=OLD.id)
  AND NOT EXISTS(SELECT 1 FROM bb_jobs WHERE execution_node_id=OLD.id AND lease_token IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM bb_review_messages WHERE execution_node_id=OLD.id AND lease_token IS NOT NULL)
  THEN RETURN NEW; END IF;
 IF NEW.epoch<>OLD.epoch AND (OLD.state<>'stopped' OR EXISTS(SELECT 1 FROM bb_model_capacity_holders WHERE execution_node_id=OLD.id)) THEN RAISE EXCEPTION 'Prior node epoch not safely stopped'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_execution_epoch_fence BEFORE UPDATE ON bb_execution_nodes FOR EACH ROW EXECUTE FUNCTION bb_execution_guard_epoch();

-- Eligibility observation only. This never owns, schedules or requeues work.
CREATE TABLE bb_execution_work_readiness (work_key text PRIMARY KEY,capability text NOT NULL,ready_since timestamptz NOT NULL DEFAULT clock_timestamp());

CREATE FUNCTION bb_execution_policy_activation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.managed_nodes AND NOT OLD.managed_nodes AND (
  EXISTS(SELECT 1 FROM bb_jobs WHERE job_type<>'parse' AND execution_node_id IS NULL AND lease_token IS NOT NULL)
  OR EXISTS(SELECT 1 FROM bb_review_messages WHERE execution_node_id IS NULL AND lease_token IS NOT NULL)
  OR EXISTS(SELECT 1 FROM bb_model_capacity_holders WHERE execution_node_id IS NULL))
  THEN RAISE EXCEPTION 'Legacy execution must positively drain before activation' USING ERRCODE='55000'; END IF;
 IF OLD.managed_nodes AND NOT NEW.managed_nodes AND (EXISTS(SELECT 1 FROM bb_execution_nodes WHERE state<>'stopped') OR EXISTS(SELECT 1 FROM bb_model_capacity_holders WHERE execution_node_id IS NOT NULL) OR EXISTS(SELECT 1 FROM bb_jobs WHERE execution_node_id IS NOT NULL AND lease_token IS NOT NULL) OR EXISTS(SELECT 1 FROM bb_review_messages WHERE execution_node_id IS NOT NULL AND lease_token IS NOT NULL)) THEN RAISE EXCEPTION 'Managed execution must positively stop before legacy mode' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_execution_policy_activation_guard BEFORE UPDATE ON bb_execution_capacity_policy FOR EACH ROW EXECUTE FUNCTION bb_execution_policy_activation();
