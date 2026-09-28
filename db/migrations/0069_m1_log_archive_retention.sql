-- Archive lifecycle keeps the original immutable receipt as evidence of the first upload.
CREATE TABLE bb_log_archive_lifecycle (
 segment_id uuid PRIMARY KEY REFERENCES bb_log_archive_receipts(segment_id),
 object_key text NOT NULL UNIQUE CHECK (object_key ~ '^log-archive/[a-z][a-z0-9_]{0,63}/[a-f0-9-]{36}([.][a-f0-9]{64})?[.]ndjson$'),
 byte_length bigint NOT NULL CHECK (byte_length >= 0),
 sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 record_count bigint NOT NULL CHECK (record_count >= 0),
 retired_at timestamptz NOT NULL DEFAULT now(),
 pending_old_key text CHECK (pending_old_key IS NULL OR pending_old_key ~ '^log-archive/[a-z][a-z0-9_]{0,63}/[a-f0-9-]{36}([.][a-f0-9]{64})?[.]ndjson$'),
 pending_old_byte_length bigint,
 pending_old_sha256 char(64),
 pending_old_count bigint,
 last_user_scan_at timestamptz,
 delete_started_at timestamptz,
 delete_reason text CHECK (delete_reason IS NULL OR delete_reason IN ('retention_expired','user_deleted')),
 delete_user_id text,
 deleted_at timestamptz,
 CHECK ((delete_started_at IS NULL) = (delete_reason IS NULL)),
 CHECK (coalesce(delete_reason='user_deleted',false) = (delete_user_id IS NOT NULL)),
 CHECK (deleted_at IS NULL OR delete_started_at IS NOT NULL),
 CHECK ((pending_old_key IS NULL) = (pending_old_sha256 IS NULL)
    AND (pending_old_key IS NULL) = (pending_old_byte_length IS NULL)
    AND (pending_old_key IS NULL) = (pending_old_count IS NULL))
);
CREATE INDEX bb_log_archive_lifecycle_due ON bb_log_archive_lifecycle(retired_at,segment_id) WHERE deleted_at IS NULL;
CREATE INDEX bb_log_archive_closed_users ON bb_users(closed_at) WHERE status='closed';

CREATE TABLE bb_log_archive_legal_holds (
 id uuid PRIMARY KEY,
 segment_id uuid REFERENCES bb_log_segments(id),
 user_id text,
 from_at timestamptz,
 to_at timestamptz,
 actor_id text NOT NULL,
 reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
 set_at timestamptz NOT NULL DEFAULT now(),
 released_at timestamptz,
 released_by text,
 CHECK (segment_id IS NOT NULL OR user_id IS NOT NULL OR from_at IS NOT NULL OR to_at IS NOT NULL),
 CHECK (from_at IS NULL OR to_at IS NULL OR from_at <= to_at),
 CHECK ((released_at IS NULL) = (released_by IS NULL))
);
CREATE INDEX bb_log_archive_holds_active ON bb_log_archive_legal_holds(segment_id,user_id) WHERE released_at IS NULL;
CREATE FUNCTION bb_guard_log_archive_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.released_at IS NOT NULL OR NEW.id<>OLD.id
    OR NEW.segment_id IS DISTINCT FROM OLD.segment_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.from_at IS DISTINCT FROM OLD.from_at OR NEW.to_at IS DISTINCT FROM OLD.to_at
    OR NEW.actor_id<>OLD.actor_id OR NEW.reason_code<>OLD.reason_code OR NEW.set_at<>OLD.set_at
    OR NEW.released_at IS NULL OR NEW.released_by IS NULL
 THEN RAISE EXCEPTION 'archive legal hold is immutable except one audited release' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_log_archive_hold_guard BEFORE UPDATE OR DELETE ON bb_log_archive_legal_holds
 FOR EACH ROW EXECUTE FUNCTION bb_guard_log_archive_hold();

CREATE TABLE bb_log_archive_user_purges (
 segment_id uuid NOT NULL REFERENCES bb_log_segments(id),
 user_id text NOT NULL,
 purged_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(segment_id,user_id)
);

CREATE TABLE bb_log_archive_audit (
 id uuid PRIMARY KEY,
 segment_id uuid NOT NULL REFERENCES bb_log_segments(id),
 action text NOT NULL CHECK (action IN ('hold_set','hold_released','skipped_hold','delete_started','deleted','rewritten','old_deleted','rewrite_failed','delete_failed')),
 reason text NOT NULL,
 actor_id text,
 user_id text,
 before_sha256 char(64),
 after_sha256 char(64),
 before_count bigint,
 after_count bigint,
 recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bb_log_archive_audit_segment ON bb_log_archive_audit(segment_id,recorded_at);
CREATE TRIGGER bb_log_archive_audit_immutable BEFORE UPDATE OR DELETE ON bb_log_archive_audit
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
