-- Older backups cannot grant an old worker or an unverified account permission to resend.
CREATE TABLE bb_database_restore_quarantines (
 id text PRIMARY KEY,seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 backup_sha256 char(64) NOT NULL CHECK(backup_sha256 ~ '^[a-f0-9]{64}$'),
 manifest_sha256 char(64) NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 control_epoch uuid NOT NULL UNIQUE,receipt jsonb NOT NULL,preimage jsonb NOT NULL,
 gate_event_id text NOT NULL REFERENCES bb_evidence_gate_events(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(COALESCE(receipt->>'version'='database-restore-safety-v1',false)),
 CHECK(COALESCE(jsonb_typeof(receipt->'account_ids')='array',false))
);
CREATE TRIGGER bb_database_restore_quarantines_immutable BEFORE UPDATE OR DELETE ON bb_database_restore_quarantines
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TABLE bb_database_restore_reconciliations (
 id text PRIMARY KEY,quarantine_id text NOT NULL REFERENCES bb_database_restore_quarantines(id),
 owner_user_id text NOT NULL,manifest_sha256 char(64) NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 evidence jsonb NOT NULL,actor_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(quarantine_id,owner_user_id)
);
CREATE TRIGGER bb_database_restore_reconciliations_immutable BEFORE UPDATE OR DELETE ON bb_database_restore_reconciliations
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TABLE bb_database_restore_fence_releases (
 id text PRIMARY KEY,quarantine_id text NOT NULL REFERENCES bb_database_restore_quarantines(id),
 manifest_sha256 char(64) NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 original_node_id text NOT NULL,original_epoch uuid NOT NULL,
 evidence_ref text NOT NULL,evidence_sha256 char(64) NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
 release_preimage jsonb NOT NULL,actor_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(quarantine_id,original_node_id,original_epoch),
 CHECK(jsonb_typeof(release_preimage)='object')
);
CREATE TRIGGER bb_database_restore_fence_releases_immutable BEFORE UPDATE OR DELETE ON bb_database_restore_fence_releases
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE FUNCTION bb_restore_reconciliation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM bb_database_restore_quarantines q WHERE q.id=NEW.quarantine_id
  AND q.manifest_sha256=NEW.manifest_sha256 AND q.receipt->'account_ids' ? NEW.owner_user_id)
 THEN RAISE EXCEPTION 'Restore receipt/account mismatch' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_restore_reconciliation_identity BEFORE INSERT ON bb_database_restore_reconciliations
 FOR EACH ROW EXECUTE FUNCTION bb_restore_reconciliation_identity();
CREATE FUNCTION bb_restore_fence_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM bb_database_restore_quarantines q WHERE q.id=NEW.quarantine_id
  AND q.manifest_sha256=NEW.manifest_sha256 AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.receipt->'fences') f
   WHERE f->>'node_id'=NEW.original_node_id AND f->>'epoch'=NEW.original_epoch::text))
 THEN RAISE EXCEPTION 'Restore fence/receipt mismatch' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_restore_fence_identity BEFORE INSERT ON bb_database_restore_fence_releases
 FOR EACH ROW EXECUTE FUNCTION bb_restore_fence_identity();
CREATE FUNCTION bb_restore_account_permitted(p_owner text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public AS $$
 SELECT NOT EXISTS(SELECT 1 FROM (SELECT * FROM public.bb_database_restore_quarantines ORDER BY seq DESC LIMIT 1) q
  WHERE q.receipt->'account_ids' ? p_owner
   AND NOT EXISTS(SELECT 1 FROM public.bb_database_restore_reconciliations r
    WHERE r.quarantine_id=q.id AND r.owner_user_id=p_owner AND r.manifest_sha256=q.manifest_sha256))
$$;
CREATE FUNCTION bb_restore_guard_model_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT bb_restore_account_permitted(NEW.owner_user_id)
 THEN RAISE EXCEPTION 'Database restore account requires reconciliation' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_restore_model_intent BEFORE INSERT ON bb_model_call_attempts
 FOR EACH ROW EXECUTE FUNCTION bb_restore_guard_model_intent();
REVOKE ALL ON bb_database_restore_quarantines,bb_database_restore_reconciliations,bb_database_restore_fence_releases FROM PUBLIC;
