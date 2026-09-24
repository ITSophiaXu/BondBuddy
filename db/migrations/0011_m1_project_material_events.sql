-- Durable, public project material events. These are separate from internal observability/outbox records.
ALTER TABLE bb_projects
  ADD COLUMN event_cursor integer NOT NULL DEFAULT 0 CHECK (event_cursor >= 0);

CREATE TABLE bb_project_events (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  trace_id text NOT NULL,
  type text NOT NULL CHECK (type = 'material.upload_progress'),
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, seq),
  CHECK (
    jsonb_typeof(payload) = 'object'
    AND payload ?& ARRAY['material_id','uploaded_bytes','total_bytes']
    AND payload - ARRAY['material_id','uploaded_bytes','total_bytes'] = '{}'::jsonb
    AND jsonb_typeof(payload->'material_id') = 'string'
    AND jsonb_typeof(payload->'uploaded_bytes') = 'number'
    AND jsonb_typeof(payload->'total_bytes') = 'number'
    AND (payload->>'uploaded_bytes')::numeric >= 0
    AND (payload->>'total_bytes')::numeric > 0
    AND (payload->>'uploaded_bytes')::numeric <= (payload->>'total_bytes')::numeric
  )
);

CREATE INDEX bb_project_events_owner_seq_idx
  ON bb_project_events(owner_user_id, project_id, seq);

CREATE FUNCTION bb_reject_project_event_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'project events are append-only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER bb_project_events_append_only
  BEFORE UPDATE OR DELETE ON bb_project_events
  FOR EACH ROW EXECUTE FUNCTION bb_reject_project_event_rewrite();

-- Give existing current materials the same recovery path after this migration is deployed.
WITH latest_materials AS (
  SELECT DISTINCT ON (m.owner_user_id,m.project_id,m.id)
         m.owner_user_id,m.project_id,m.id AS material_id,m.byte_size,m.persisted_at
    FROM bb_material_versions m
    JOIN bb_uploads u ON u.owner_user_id=m.owner_user_id AND u.id=m.upload_id AND u.state='completed'
   WHERE m.deleted_at IS NULL
   ORDER BY m.owner_user_id,m.project_id,m.id,m.version DESC
), numbered AS (
  SELECT owner_user_id,project_id,material_id,byte_size,persisted_at,
         row_number() OVER (PARTITION BY owner_user_id,project_id ORDER BY persisted_at,material_id)::integer AS seq
    FROM latest_materials
), inserted AS (
  INSERT INTO bb_project_events(id,owner_user_id,project_id,seq,trace_id,type,payload,occurred_at)
  SELECT 'material-backfill-' || md5(owner_user_id || ':' || material_id),
         owner_user_id,project_id,seq,
         'material-backfill-trace-' || md5(owner_user_id || ':' || material_id),
         'material.upload_progress',
         jsonb_build_object('material_id',material_id,'uploaded_bytes',byte_size,'total_bytes',byte_size),
         persisted_at
    FROM numbered
  RETURNING owner_user_id,project_id,seq
), counters AS (
  SELECT owner_user_id,project_id,max(seq) AS last_seq
    FROM inserted
   GROUP BY owner_user_id,project_id
)
UPDATE bb_projects p SET event_cursor=counters.last_seq
  FROM counters
 WHERE p.owner_user_id=counters.owner_user_id AND p.id=counters.project_id;

COMMENT ON TABLE bb_project_events IS
  'Public owner-scoped project event journal. Sequence allocation and event writes commit with the material and outbox state.';
COMMENT ON COLUMN bb_projects.event_cursor IS
  'Last allocated project-local public event sequence; incremented in the same transaction as each event.';
