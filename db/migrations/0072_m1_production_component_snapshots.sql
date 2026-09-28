-- Immutable component snapshots referenced by frozen #19 production manifests.
-- Insertion records data only; this table is not a production release path.
CREATE TABLE bb_rule_pack_production_component_snapshots (
  component_kind text NOT NULL CHECK (component_kind IN ('rule_pack','chapter_template','coverage_manifest')),
  component_id text NOT NULL CHECK (length(btrim(component_id)) > 0),
  component_version text NOT NULL CHECK (length(btrim(component_version)) > 0),
  snapshot_sha256 char(64) NOT NULL CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (component_kind, component_id, component_version),
  UNIQUE (component_kind, component_id, component_version, snapshot_sha256),
  CHECK (snapshot->>'version' = component_version),
  CHECK (
    (component_kind = 'rule_pack' AND snapshot->>'schema_version' = 'rule-pack-v1' AND snapshot->>'pack_id' = component_id) OR
    (component_kind = 'chapter_template' AND snapshot->>'schema_version' = 'chapter-template-v1' AND snapshot->>'template_id' = component_id) OR
    (component_kind = 'coverage_manifest' AND snapshot->>'schema_version' = 'capability-coverage-v1' AND snapshot->>'manifest_id' = component_id)
  )
);

CREATE FUNCTION bb_rule_pack_production_component_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'production component snapshots are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bb_rule_pack_production_component_snapshot_immutable
  BEFORE UPDATE OR DELETE ON bb_rule_pack_production_component_snapshots
  FOR EACH ROW EXECUTE FUNCTION bb_rule_pack_production_component_snapshot_guard();

COMMENT ON TABLE bb_rule_pack_production_component_snapshots IS
  'Immutable complete canonical JSON snapshots addressed by kind, identity, version, and content hash. Snapshot insertion alone does not publish a production capability.';
