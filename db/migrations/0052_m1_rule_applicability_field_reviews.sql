-- #19: append-only, per-candidate review actions. These rows do not mutate
-- candidates and do not make an applicability context eligible for selection.
CREATE TABLE bb_rule_applicability_field_reviews (
  id text PRIMARY KEY,
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  context_version integer NOT NULL CHECK (context_version > 0),
  context_content_hash char(64) NOT NULL CHECK (context_content_hash ~ '^[a-f0-9]{64}$'),
  source_input_revision integer NOT NULL CHECK (source_input_revision > 0),
  source_input_hash char(64) NOT NULL CHECK (source_input_hash ~ '^[a-f0-9]{64}$'),
  candidate_id text NOT NULL,
  field_key text NOT NULL,
  candidate_ordinal integer NOT NULL CHECK (candidate_ordinal >= 0),
  candidate_hash char(64) NOT NULL CHECK (candidate_hash ~ '^[a-f0-9]{64}$'),
  candidate_snapshot jsonb NOT NULL CHECK (jsonb_typeof(candidate_snapshot)='object'),
  candidate_value jsonb NOT NULL,
  conflict_refs jsonb NOT NULL CHECK (jsonb_typeof(conflict_refs)='array'),
  source_kind text NOT NULL CHECK (source_kind IN ('parse_evidence','user_asserted','unknown')),
  source_status text NOT NULL CHECK (source_status IN ('recognized','user_asserted','unknown','conflicting')),
  action text NOT NULL CHECK (action IN ('adopt_candidate','request_more_evidence','out_of_scope')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2048),
  evidence_refs jsonb NOT NULL CHECK (jsonb_typeof(evidence_refs)='array'),
  reviewer_user_id text NOT NULL REFERENCES bb_users(id),
  reviewer_grant_id text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, project_id, request_id),
  UNIQUE (owner_user_id, project_id, context_id, context_version, candidate_id, id),
  FOREIGN KEY (owner_user_id, project_id, context_id, context_version, candidate_id)
    REFERENCES bb_rule_applicability_context_candidates(owner_user_id, project_id, context_id, context_version, candidate_id),
  FOREIGN KEY (owner_user_id, project_id, context_id, context_version)
    REFERENCES bb_rule_applicability_context_drafts(owner_user_id, project_id, id, version),
  FOREIGN KEY (reviewer_user_id, reviewer_grant_id, owner_user_id, project_id)
    REFERENCES bb_rule_applicability_reviewer_grants(user_id, id, scope_owner_user_id, scope_project_id),
  CHECK (source_input_hash=lower(btrim(source_input_hash::text))),
  CHECK (candidate_hash=lower(btrim(candidate_hash::text))),
  CHECK (request_hash=lower(btrim(request_hash::text))),
  CHECK (action <> 'adopt_candidate' OR (
    source_kind='parse_evidence' AND source_status='recognized'
    AND candidate_value <> 'null'::jsonb
    AND jsonb_array_length(conflict_refs)=0
    AND field_key NOT IN ('market','offering','industry','specialFeatures')
    AND jsonb_array_length(evidence_refs)>0
    AND NOT (field_key='specialFeatures' AND jsonb_typeof(candidate_value)='array' AND jsonb_array_length(candidate_value)=0)
  ))
);

CREATE FUNCTION bb_rule_applicability_candidate_snapshot(p_owner text,p_project text,p_context text,p_version integer,p_candidate text)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'ownerUserId',d.owner_user_id,'projectId',d.project_id,
    'context',jsonb_build_object('id',d.id,'version',d.version,'contentHash',trim(d.content_hash),
      'sourceInputRevision',d.source_input_revision,'sourceInputHash',trim(d.source_input_hash)),
    'candidate',jsonb_build_object('id',c.candidate_id,'fieldKey',c.field_key,'ordinal',c.ordinal,
      'value',c.candidate_value,'conflictRefs',c.conflict_refs,'sourceKind',c.source_kind,'sourceStatus',c.source_status,
      'evidence',COALESCE(jsonb_agg(jsonb_build_object('materialId',e.material_id,'materialVersion',e.material_version,
        'materialSha256',trim(e.material_sha256),'parseSnapshotId',e.parse_snapshot_id,
        'recordId',e.evidence_record_id,'recordSha256',trim(e.evidence_record_sha256))
        ORDER BY e.evidence_record_id) FILTER (WHERE e.evidence_record_id IS NOT NULL),'[]'::jsonb)))
    FROM bb_rule_applicability_context_drafts d
    JOIN bb_rule_applicability_context_candidates c ON c.owner_user_id=d.owner_user_id AND c.project_id=d.project_id
      AND c.context_id=d.id AND c.context_version=d.version
    LEFT JOIN bb_rule_applicability_context_candidate_evidence e ON e.owner_user_id=c.owner_user_id AND e.project_id=c.project_id
      AND e.context_id=c.context_id AND e.context_version=c.context_version AND e.candidate_id=c.candidate_id
   WHERE d.owner_user_id=p_owner AND d.project_id=p_project AND d.id=p_context AND d.version=p_version
     AND c.candidate_id=p_candidate
   GROUP BY d.owner_user_id,d.project_id,d.id,d.version,d.content_hash,d.source_input_revision,d.source_input_hash,
     c.candidate_id,c.field_key,c.ordinal,c.candidate_value,c.conflict_refs,c.source_kind,c.source_status
$$;

CREATE INDEX bb_rule_applicability_field_review_candidate_idx
  ON bb_rule_applicability_field_reviews(owner_user_id,project_id,context_id,context_version,candidate_id,reviewed_at DESC);

CREATE FUNCTION bb_rule_applicability_field_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE grant_revoked timestamptz;
DECLARE draft_input_revision integer;
DECLARE draft_input_hash char(64);
DECLARE draft_content_hash char(64);
DECLARE actual_value jsonb;
DECLARE actual_kind text;
DECLARE actual_status text;
DECLARE actual_conflicts jsonb;
DECLARE actual_ordinal integer;
DECLARE actual_evidence jsonb;
DECLARE actual_snapshot jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'rule applicability field reviews are append-only' USING ERRCODE='23514';
  END IF;
  SELECT g.revoked_at INTO grant_revoked FROM bb_rule_applicability_reviewer_grants g
    JOIN bb_projects p ON p.owner_user_id=g.scope_owner_user_id AND p.id=g.scope_project_id AND p.deleted_at IS NULL
    JOIN bb_users u ON u.id=g.user_id AND u.status='active'
   WHERE g.id=NEW.reviewer_grant_id AND g.user_id=NEW.reviewer_user_id AND g.role='rule_applicability_reviewer'
     AND g.scope_owner_user_id=NEW.owner_user_id AND g.scope_project_id=NEW.project_id FOR SHARE OF g,p,u;
  IF NOT FOUND OR grant_revoked IS NOT NULL OR NEW.reviewer_user_id=NEW.owner_user_id THEN
    RAISE EXCEPTION 'current exact rule-applicability reviewer grant required' USING ERRCODE='42501';
  END IF;
  SELECT source_input_revision,source_input_hash,content_hash INTO draft_input_revision,draft_input_hash,draft_content_hash
    FROM bb_rule_applicability_context_drafts
   WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id
     AND id=NEW.context_id AND version=NEW.context_version FOR SHARE;
  IF NOT FOUND OR draft_input_revision IS DISTINCT FROM NEW.source_input_revision
     OR draft_input_hash IS DISTINCT FROM NEW.source_input_hash
     OR draft_content_hash IS DISTINCT FROM NEW.context_content_hash THEN
    RAISE EXCEPTION 'field review source context mismatch' USING ERRCODE='23514';
  END IF;
  SELECT c.candidate_value,c.source_kind,c.source_status,c.conflict_refs,c.ordinal,
      COALESCE(jsonb_agg(jsonb_build_object('materialId',e.material_id,'materialVersion',e.material_version,
        'materialSha256',trim(e.material_sha256),'parseSnapshotId',e.parse_snapshot_id,
        'recordId',e.evidence_record_id,'recordSha256',trim(e.evidence_record_sha256))
        ORDER BY e.evidence_record_id) FILTER (WHERE e.evidence_record_id IS NOT NULL),'[]'::jsonb)
    INTO actual_value,actual_kind,actual_status,actual_conflicts,actual_ordinal,actual_evidence
    FROM bb_rule_applicability_context_candidates c
    LEFT JOIN bb_rule_applicability_context_candidate_evidence e
      ON e.owner_user_id=c.owner_user_id AND e.project_id=c.project_id AND e.context_id=c.context_id
     AND e.context_version=c.context_version AND e.candidate_id=c.candidate_id
   WHERE c.owner_user_id=NEW.owner_user_id AND c.project_id=NEW.project_id
     AND c.context_id=NEW.context_id AND c.context_version=NEW.context_version
     AND c.candidate_id=NEW.candidate_id AND c.field_key=NEW.field_key
   GROUP BY c.candidate_value,c.source_kind,c.source_status,c.conflict_refs,c.ordinal;
  IF NOT FOUND OR actual_value IS DISTINCT FROM NEW.candidate_value OR actual_kind IS DISTINCT FROM NEW.source_kind
     OR actual_status IS DISTINCT FROM NEW.source_status OR actual_conflicts IS DISTINCT FROM NEW.conflict_refs
     OR actual_ordinal IS DISTINCT FROM NEW.candidate_ordinal OR actual_evidence IS DISTINCT FROM NEW.evidence_refs THEN
    RAISE EXCEPTION 'field review candidate snapshot mismatch' USING ERRCODE='23514';
  END IF;
  actual_snapshot := bb_rule_applicability_candidate_snapshot(NEW.owner_user_id,NEW.project_id,NEW.context_id,
    NEW.context_version,NEW.candidate_id);
  IF actual_snapshot IS DISTINCT FROM NEW.candidate_snapshot
     OR encode(sha256(convert_to(actual_snapshot::text,'UTF8')),'hex') IS DISTINCT FROM trim(NEW.candidate_hash) THEN
    RAISE EXCEPTION 'field review candidate hash mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bb_rule_applicability_field_review_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bb_rule_applicability_field_reviews
  FOR EACH ROW EXECUTE FUNCTION bb_rule_applicability_field_review_guard();

CREATE FUNCTION bb_rule_applicability_field_review_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'rule applicability field reviews are append-only' USING ERRCODE='23514';
END $$;

CREATE TRIGGER bb_rule_applicability_field_review_no_truncate
  BEFORE TRUNCATE ON bb_rule_applicability_field_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION bb_rule_applicability_field_review_no_truncate();

COMMENT ON TABLE bb_rule_applicability_field_reviews IS
  'Append-only reviewer actions against exact immutable applicability candidates. Adoption is not aggregate approval, selector eligibility, or a production rule decision.';
