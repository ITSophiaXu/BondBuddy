-- Internal #15 storage. Each source is a separate candidate, so a later source
-- never silently overwrites an earlier one.
CREATE TABLE bb_fact_candidates (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL,
 project_id text NOT NULL,
 entity_id text NOT NULL,
 fact_key_hash char(64) NOT NULL CHECK (fact_key_hash ~ '^[a-f0-9]{64}$'),
 fact_key jsonb NOT NULL CHECK (jsonb_typeof(fact_key) = 'object'),
 value_decimal text,
 value_text text,
 value_kind text NOT NULL CHECK (value_kind IN ('decimal','text','unknown','not_applicable')),
 source_kind text NOT NULL CHECK (source_kind IN ('audited','user_statement','external')),
 source_ref text NOT NULL CHECK (length(source_ref) > 0),
 status text NOT NULL CHECK (status IN ('extracted','verified','user_asserted','conflicted','needs_confirmation','superseded')),
 source_observed_at timestamptz,
 source_valid_as_of date,
 verification_actor_kind text CHECK (verification_actor_kind = 'internal_reviewer'),
 verification_actor_id text,
 verification_at timestamptz,
 material_id text,
 material_version integer,
 evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
 uncertainty jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(uncertainty) = 'array'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,project_id,id),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY(owner_user_id,material_id,material_version) REFERENCES bb_material_versions(owner_user_id,id,version),
 CHECK ((material_id IS NULL) = (material_version IS NULL)),
 CHECK ((value_kind = 'decimal' AND value_decimal IS NOT NULL AND value_text IS NULL)
     OR (value_kind = 'text' AND value_decimal IS NULL AND value_text IS NOT NULL)
     OR (value_kind IN ('unknown','not_applicable') AND value_decimal IS NULL AND value_text IS NULL)),
 CHECK (value_decimal IS NULL OR value_decimal ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'),
 CHECK (status <> 'verified' OR (source_kind = 'audited' AND material_id IS NOT NULL AND jsonb_array_length(evidence) > 0 AND jsonb_array_length(uncertainty) = 0 AND verification_actor_kind IS NOT NULL AND verification_actor_id IS NOT NULL AND verification_at IS NOT NULL)),
 CHECK (source_kind <> 'user_statement' OR (status IN ('user_asserted','conflicted','superseded') AND source_observed_at IS NOT NULL))
);
CREATE INDEX bb_fact_candidates_identity_idx
 ON bb_fact_candidates(owner_user_id,project_id,fact_key_hash,created_at,id);

CREATE FUNCTION bb_reject_reference_fact_material() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_role text;
BEGIN
 IF NEW.material_id IS NULL THEN RETURN NEW; END IF;
 SELECT role INTO source_role FROM bb_material_versions
  WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id
    AND id=NEW.material_id AND version=NEW.material_version AND deleted_at IS NULL;
 IF source_role IS NULL OR source_role='reference' THEN
  RAISE EXCEPTION 'fact source must be an owned, active issuer material'
   USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_fact_candidate_source_guard BEFORE INSERT OR UPDATE ON bb_fact_candidates
 FOR EACH ROW EXECUTE FUNCTION bb_reject_reference_fact_material();

-- The cache stores only a private object reference and checksum. Parsed text stays
-- in Blob, scoped to the owner. Filename and project deliberately are not keys.
CREATE TABLE bb_parse_cache (
 owner_user_id text NOT NULL,
 content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
 parser_version text NOT NULL CHECK (length(parser_version) > 0),
 ocr_version text NOT NULL CHECK (length(ocr_version) > 0),
 basis_version text NOT NULL CHECK (length(basis_version) > 0),
 result_state text NOT NULL CHECK (result_state IN ('parsed','needs_confirmation')),
 object_key text NOT NULL UNIQUE,
 object_sha256 char(64) NOT NULL CHECK (object_sha256 ~ '^[a-f0-9]{64}$'),
 object_bytes bigint NOT NULL CHECK (object_bytes > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_user_id,content_sha256,parser_version,ocr_version,basis_version)
);
