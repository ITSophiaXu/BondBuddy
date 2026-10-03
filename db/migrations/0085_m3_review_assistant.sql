-- M3 assistant messages use the contained model adapter without creating a review/update run.
-- The source context is fixed at send time; missing context from an older queued row fails closed.
ALTER TABLE bb_review_messages ADD COLUMN context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE bb_review_messages ADD COLUMN lease_token uuid;
ALTER TABLE bb_review_messages ADD COLUMN lease_until timestamptz;
ALTER TABLE bb_review_messages ADD COLUMN prompt_snapshot_id text REFERENCES bb_snapshot_refs(id);
ALTER TABLE bb_review_messages ADD CONSTRAINT bb_review_message_lease_pair CHECK ((lease_token IS NULL) = (lease_until IS NULL));
CREATE UNIQUE INDEX bb_review_assistant_one_reply ON bb_review_messages(reply_to) WHERE role='assistant';
CREATE INDEX bb_review_assistant_queue ON bb_review_messages(created_at,id) WHERE role='user' AND reply_status IN ('queued','running');

CREATE TABLE bb_review_assistant_attempts (
 id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text NOT NULL, message_id text NOT NULL,
 logical_call_id text NOT NULL, attempt_no integer NOT NULL CHECK(attempt_no>0),
 intent jsonb NOT NULL, intent_sha256 char(64) NOT NULL, prompt_snapshot_id text NOT NULL REFERENCES bb_snapshot_refs(id),
 status text NOT NULL DEFAULT 'pending_reconcile' CHECK(status IN ('pending_reconcile','confirmed_not_sent','completed','failed')),
 runtime jsonb, observation jsonb, observation_sha256 char(64),
 usage_status text NOT NULL DEFAULT 'unknown' CHECK(usage_status IN ('unknown','pending','measured')),
 input_tokens bigint, cached_input_tokens bigint, output_tokens bigint, reasoning_tokens bigint, total_tokens bigint,
 internal_cost numeric, pricing_status text NOT NULL DEFAULT 'unknown' CHECK(pricing_status='unknown'),
 result_ref text, result_sha256 char(64), result_schema_version text, result_byte_size bigint,
 error_code text, created_at timestamptz NOT NULL DEFAULT now(), observed_at timestamptz,
 UNIQUE(owner_user_id,project_id,message_id,logical_call_id,attempt_no),
 FOREIGN KEY(owner_user_id,project_id,message_id) REFERENCES bb_review_messages(owner_user_id,project_id,id),
 CHECK(internal_cost IS NULL),
 CHECK(input_tokens IS NULL OR input_tokens>=0), CHECK(output_tokens IS NULL OR output_tokens>=0),
 CHECK(cached_input_tokens IS NULL OR cached_input_tokens>=0), CHECK(reasoning_tokens IS NULL OR reasoning_tokens>=0),
 CHECK(total_tokens IS NULL OR total_tokens>=0),
 CHECK(usage_status<>'unknown' OR (input_tokens IS NULL AND cached_input_tokens IS NULL AND output_tokens IS NULL AND reasoning_tokens IS NULL AND total_tokens IS NULL)),
 CHECK(usage_status<>'measured' OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND total_tokens=input_tokens+output_tokens)),
 CHECK(status<>'completed' OR (usage_status='measured' AND observation IS NOT NULL AND result_ref IS NOT NULL AND result_sha256 IS NOT NULL)),
 CHECK((result_ref IS NULL AND result_sha256 IS NULL AND result_schema_version IS NULL AND result_byte_size IS NULL)
    OR (result_ref IS NOT NULL AND result_sha256 IS NOT NULL AND result_schema_version IS NOT NULL AND result_byte_size>0))
);

CREATE FUNCTION bb_guard_review_message_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.owner_user_id,NEW.project_id,NEW.submission_request_id,NEW.request_hash,NEW.role,NEW.content,NEW.context,
        NEW.context_snapshot,NEW.reply_to,NEW.proposal,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.owner_user_id,OLD.project_id,OLD.submission_request_id,OLD.request_hash,OLD.role,OLD.content,OLD.context,
        OLD.context_snapshot,OLD.reply_to,OLD.proposal,OLD.created_at)
    OR (OLD.prompt_snapshot_id IS NOT NULL AND NEW.prompt_snapshot_id IS DISTINCT FROM OLD.prompt_snapshot_id) THEN
   RAISE EXCEPTION 'Review message snapshot is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_review_message_snapshot_immutable BEFORE UPDATE ON bb_review_messages FOR EACH ROW EXECUTE FUNCTION bb_guard_review_message_snapshot();

CREATE FUNCTION bb_guard_review_assistant_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.owner_user_id,NEW.project_id,NEW.message_id,NEW.logical_call_id,NEW.attempt_no,NEW.intent,NEW.intent_sha256,NEW.prompt_snapshot_id,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.owner_user_id,OLD.project_id,OLD.message_id,OLD.logical_call_id,OLD.attempt_no,OLD.intent,OLD.intent_sha256,OLD.prompt_snapshot_id,OLD.created_at)
    OR (OLD.runtime IS NOT NULL AND NEW.runtime IS DISTINCT FROM OLD.runtime)
    OR (OLD.observation IS NOT NULL AND ROW(NEW.observation,NEW.observation_sha256,NEW.status,NEW.usage_status,NEW.input_tokens,NEW.cached_input_tokens,
        NEW.output_tokens,NEW.reasoning_tokens,NEW.total_tokens,NEW.error_code,NEW.observed_at)
       IS DISTINCT FROM ROW(OLD.observation,OLD.observation_sha256,OLD.status,OLD.usage_status,OLD.input_tokens,OLD.cached_input_tokens,
        OLD.output_tokens,OLD.reasoning_tokens,OLD.total_tokens,OLD.error_code,OLD.observed_at))
    OR (OLD.result_ref IS NOT NULL AND ROW(NEW.result_ref,NEW.result_sha256,NEW.result_schema_version,NEW.result_byte_size)
      IS DISTINCT FROM ROW(OLD.result_ref,OLD.result_sha256,OLD.result_schema_version,OLD.result_byte_size)) THEN
   RAISE EXCEPTION 'Review assistant attempt evidence is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_review_assistant_attempt_guard BEFORE UPDATE ON bb_review_assistant_attempts FOR EACH ROW EXECUTE FUNCTION bb_guard_review_assistant_attempt();
