-- #79: local NDJSON segments and independently verified private Blob receipts.
-- 0040 belongs to #207; apply it before this migration when that branch lands.
CREATE TABLE bb_log_segments (
 id uuid PRIMARY KEY,
 sink text NOT NULL CHECK (sink ~ '^[a-z][a-z0-9_]{0,63}$'),
 state text NOT NULL CHECK (state IN ('active','sealed')),
 byte_length bigint NOT NULL CHECK (byte_length>=0),
 sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 record_count bigint NOT NULL CHECK (record_count>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 sealed_at timestamptz,
 CHECK ((state='sealed') = (sealed_at IS NOT NULL))
);
CREATE UNIQUE INDEX bb_log_one_active_segment ON bb_log_segments(sink) WHERE state='active';
CREATE INDEX bb_log_segments_sealed_idx ON bb_log_segments(sink,id) WHERE state='sealed';
CREATE FUNCTION bb_guard_log_segment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.state='sealed' OR NEW.id<>OLD.id OR NEW.sink<>OLD.sink
    OR NEW.created_at<>OLD.created_at OR (OLD.state='active' AND NEW.state='active' AND NEW.sealed_at IS NOT NULL)
 THEN RAISE EXCEPTION 'sealed log segment is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_log_segment_guard BEFORE UPDATE OR DELETE ON bb_log_segments
 FOR EACH ROW EXECUTE FUNCTION bb_guard_log_segment();

CREATE TABLE bb_log_archive_receipts (
 segment_id uuid PRIMARY KEY REFERENCES bb_log_segments(id),
 object_key text NOT NULL UNIQUE CHECK (object_key ~ '^log-archive/[a-z][a-z0-9_]{0,63}/[a-f0-9-]{36}[.]ndjson$'),
 byte_length bigint NOT NULL CHECK (byte_length>=0),
 sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 record_count bigint NOT NULL CHECK (record_count>=0),
 verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION bb_guard_log_archive_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM bb_log_segments s WHERE s.id=NEW.segment_id AND s.state='sealed'
    AND s.byte_length=NEW.byte_length AND s.sha256=NEW.sha256 AND s.record_count=NEW.record_count)
 THEN RAISE EXCEPTION 'archive receipt must match sealed segment' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_log_archive_receipt_match BEFORE INSERT ON bb_log_archive_receipts
 FOR EACH ROW EXECUTE FUNCTION bb_guard_log_archive_receipt();
CREATE TRIGGER bb_log_archive_receipt_immutable BEFORE UPDATE OR DELETE ON bb_log_archive_receipts
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
