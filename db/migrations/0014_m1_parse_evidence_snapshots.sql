-- #13 durable parse snapshots and source anchors. A parser/version/material
-- identity has one effective immutable result; request IDs are aliases to it.
CREATE TABLE bb_parse_snapshots (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  material_id text NOT NULL,
  material_version integer NOT NULL CHECK (material_version > 0),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  parser_version text NOT NULL CHECK (length(btrim(parser_version)) > 0),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  request_options jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(request_options) = 'object'),
  response_status text NOT NULL CHECK (response_status IN ('failed','needs_confirmation','parsed')),
  response_schema_version text NOT NULL CHECK (response_schema_version = 'document-parse-response-v1'),
  response_sha256 char(64) NOT NULL CHECK (response_sha256 ~ '^[a-f0-9]{64}$'),
  record_count integer NOT NULL CHECK (record_count >= 0),
  response_meta jsonb NOT NULL CHECK (jsonb_typeof(response_meta) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, project_id, material_id, material_version, parser_version),
  UNIQUE (owner_user_id, project_id, material_id, material_version, id),
  FOREIGN KEY (owner_user_id, project_id, material_id, material_version)
    REFERENCES bb_material_versions(owner_user_id, project_id, id, version),
  CHECK (response_meta->>'schema_version' IS NOT DISTINCT FROM response_schema_version),
  CHECK (response_meta->>'request_id' IS NOT NULL AND length(btrim(response_meta->>'request_id')) > 0),
  CHECK (response_meta->>'status' IS NOT DISTINCT FROM response_status),
  CHECK (response_meta->>'parser_version' IS NOT DISTINCT FROM parser_version),
  CHECK (response_meta->'material'->>'material_id' IS NOT DISTINCT FROM material_id),
  CHECK ((response_meta->'material'->>'material_version')::integer IS NOT DISTINCT FROM material_version),
  CHECK (response_meta->'material'->>'sha256' IS NOT DISTINCT FROM content_sha256),
  CHECK (jsonb_typeof(response_meta->'warnings') = 'array'),
  CHECK (jsonb_typeof(response_meta->'document') = 'object'),
  CHECK ((response_status = 'failed' AND record_count = 0 AND jsonb_typeof(response_meta->'error') = 'object') OR
         (response_status <> 'failed' AND record_count > 0 AND response_meta->'error' = 'null'::jsonb))
);

CREATE INDEX bb_parse_snapshots_owner_material_idx
  ON bb_parse_snapshots(owner_user_id, project_id, material_id, material_version, created_at DESC);

CREATE TABLE bb_parse_snapshot_requests (
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  material_id text NOT NULL,
  material_version integer NOT NULL CHECK (material_version > 0),
  request_id text NOT NULL CHECK (length(btrim(request_id)) > 0),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  snapshot_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, project_id, material_id, material_version, request_id),
  FOREIGN KEY (owner_user_id, project_id, material_id, material_version, snapshot_id)
    REFERENCES bb_parse_snapshots(owner_user_id, project_id, material_id, material_version, id)
);

CREATE TABLE bb_parse_evidence (
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  material_id text NOT NULL,
  material_version integer NOT NULL CHECK (material_version > 0),
  snapshot_id text NOT NULL,
  record_id text NOT NULL,
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  locator_type text NOT NULL CHECK (locator_type IN ('docx_block','pdf_bbox','xlsx_cell','csv_cell','text_line')),
  locator jsonb NOT NULL CHECK (jsonb_typeof(locator) = 'object' AND octet_length(locator::text) <= 65536),
  literal_quote text NOT NULL CHECK (length(literal_quote) > 0 AND octet_length(literal_quote) <= 65536),
  context text NOT NULL CHECK (octet_length(context) <= 65536),
  extraction_method text NOT NULL CHECK (extraction_method = 'native_text'),
  extractor_version text NOT NULL CHECK (length(btrim(extractor_version)) > 0),
  confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  uncertainty jsonb NOT NULL CHECK (jsonb_typeof(uncertainty) = 'array' AND octet_length(uncertainty::text) <= 8192),
  formatting jsonb NOT NULL CHECK (jsonb_typeof(formatting) = 'object' AND octet_length(formatting::text) <= 65536),
  record_sha256 char(64) NOT NULL CHECK (record_sha256 ~ '^[a-f0-9]{64}$'),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, project_id, material_id, material_version, snapshot_id, record_id),
  UNIQUE (owner_user_id, project_id, material_id, material_version, snapshot_id, ordinal),
  FOREIGN KEY (owner_user_id, project_id, material_id, material_version, snapshot_id)
    REFERENCES bb_parse_snapshots(owner_user_id, project_id, material_id, material_version, id),
  CHECK (content_sha256 = lower(btrim(content_sha256::text))),
  CHECK (octet_length(context) + octet_length(literal_quote) + octet_length(locator::text) +
    octet_length(uncertainty::text) + octet_length(formatting::text) <= 262144)
);

CREATE INDEX bb_parse_evidence_anchor_idx
  ON bb_parse_evidence(owner_user_id, project_id, material_id, material_version, snapshot_id, record_id);

CREATE FUNCTION bb_reject_parse_snapshot_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'parse evidence snapshots are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_parse_snapshot_immutable BEFORE UPDATE OR DELETE ON bb_parse_snapshots
  FOR EACH ROW EXECUTE FUNCTION bb_reject_parse_snapshot_rewrite();
CREATE TRIGGER bb_parse_snapshot_request_immutable BEFORE UPDATE OR DELETE ON bb_parse_snapshot_requests
  FOR EACH ROW EXECUTE FUNCTION bb_reject_parse_snapshot_rewrite();
CREATE TRIGGER bb_parse_evidence_immutable BEFORE UPDATE OR DELETE ON bb_parse_evidence
  FOR EACH ROW EXECUTE FUNCTION bb_reject_parse_snapshot_rewrite();
