-- #19 internal-only rule-pack test release ledger. Production publication is
-- intentionally not represented until a trusted operator/reviewer boundary exists.
CREATE TABLE bb_rule_pack_release_events (
  id text PRIMARY KEY,
  pack_id text NOT NULL,
  request_id text NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  sequence integer NOT NULL CHECK (sequence > 0),
  action text NOT NULL CHECK (action IN ('test_release','test_withdrawal','test_rollback')),
  release_hash char(64) NOT NULL CHECK (release_hash ~ '^[a-f0-9]{64}$'),
  target_event_id text,
  pack_snapshot jsonb NOT NULL CHECK (jsonb_typeof(pack_snapshot) = 'object'),
  actor_id text NOT NULL CHECK (length(btrim(actor_id)) > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, request_id),
  UNIQUE (pack_id, sequence),
  UNIQUE (pack_id, id),
  FOREIGN KEY (pack_id, target_event_id) REFERENCES bb_rule_pack_release_events(pack_id, id),
  CHECK ((action = 'test_rollback') = (target_event_id IS NOT NULL)),
  CHECK (pack_snapshot->>'pack_id' IS NOT NULL AND pack_snapshot->>'pack_id' = pack_id),
  CHECK (jsonb_typeof(pack_snapshot->'release') = 'object' AND
         pack_snapshot->'release'->>'channel' IS NOT NULL AND pack_snapshot->'release'->>'channel' = 'test'),
  CHECK (pack_snapshot->'release'->>'content_hash' IS NOT NULL AND
         pack_snapshot->'release'->>'content_hash' = release_hash),
  CHECK (pack_snapshot->>'status' IS NOT NULL AND
         ((action = 'test_withdrawal' AND pack_snapshot->>'status' = 'withdrawn') OR
          (action <> 'test_withdrawal' AND pack_snapshot->>'status' = 'published')))
);
CREATE INDEX bb_rule_pack_release_latest_idx
  ON bb_rule_pack_release_events(pack_id, sequence DESC);

CREATE FUNCTION bb_reject_rule_pack_release_event_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'rule-pack release ledger is append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_rule_pack_release_event_immutable
  BEFORE UPDATE OR DELETE ON bb_rule_pack_release_events
  FOR EACH ROW EXECUTE FUNCTION bb_reject_rule_pack_release_event_change();

COMMENT ON TABLE bb_rule_pack_release_events IS
  'Internal, append-only test-channel rule-pack release history. It cannot publish a production capability; operator and reviewer authentication remain a release blocker.';
