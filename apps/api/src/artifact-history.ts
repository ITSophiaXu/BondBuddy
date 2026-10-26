import type { ArtifactExecutionRef } from './artifact-execution.js';
import type { Static } from '@sinclair/typebox';
import type { schemas } from '@bondbuddy/contracts';
import type { Pool } from 'pg';
import { date, digest, Problem, project } from './data.js';

type Query = Static<typeof schemas.ArtifactHistoryQuery>;
type Artifact = ArtifactExecutionRef & {
  id: string; version: number; media_type: string; sha256: string;
  object_key: string; delivery_evidence_byte_size: string;
};
type Row = {
  run_id: string; input_revision: number; state: 'succeeded' | 'test_completed';
  channel: 'production' | 'non_production_test'; completed_at: Date; cursor_time: string;
  primary_id: string; primary_version: number; primary_sha256: string; primary_object_key: string; primary_size: string;
  has_pair: boolean;
  clean_id: string | null; clean_version: number | null; clean_sha256: string | null; clean_object_key: string | null; clean_size: string | null;
  baseline_id: string | null; baseline_version: number | null; baseline_sha256: string | null; baseline_object_key: string | null; baseline_size: string | null;
};
type Position = { time: string; id: string };
const WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const invalidCursor = () => new Problem(422, 'VALIDATION_FAILED', 'Invalid artifact history cursor; refresh the list');
const cursorTime = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);

function decodeCursor(value: string, owner: string, projectId: string): { upper: Position; after: Position } {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value)
      throw invalidCursor();
    const parts: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parts) || parts.length !== 6 || parts[0] !== 1 ||
        parts[1] !== digest(JSON.stringify([owner, projectId])) || !cursorTime(parts[2]) ||
        typeof parts[3] !== 'string' || !parts[3] || parts[3].length > 128 ||
        !cursorTime(parts[4]) || typeof parts[5] !== 'string' || !parts[5] || parts[5].length > 128 ||
        (parts[2] < parts[4] || (parts[2] === parts[4] && parts[3] < parts[5])))
      throw invalidCursor();
    return { upper: { time: parts[2], id: parts[3] }, after: { time: parts[4], id: parts[5] } };
  } catch { throw invalidCursor(); }
}

export async function listArtifactHistory(
  pool: Pool, owner: string, projectId: string, query: Query, testEnabled: boolean,
  verify: (artifact: Artifact) => Promise<Buffer>,
) {
  await project(pool, owner, projectId);
  const boundary = query.cursor ? decodeCursor(query.cursor, owner, projectId) : null;
  const limit = Number(query.limit ?? 20);
  const rows = await pool.query<Row>(`
    SELECT r.id AS run_id,r.input_revision,r.state,r.channel,r.updated_at AS completed_at,
      to_char(r.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,
      a.id AS primary_id,a.version AS primary_version,a.sha256 AS primary_sha256,
      a.object_key AS primary_object_key,ae.byte_size AS primary_size,
      pair.value IS NOT NULL AS has_pair,
      c.id AS clean_id,c.version AS clean_version,c.sha256 AS clean_sha256,
      c.object_key AS clean_object_key,c.byte_size AS clean_size,
      b.id AS baseline_id,b.version AS baseline_version,b.sha256 AS baseline_sha256,
      b.object_key AS baseline_object_key,b.byte_size AS baseline_size
    FROM bb_projects p
    JOIN bb_runs r ON r.owner_user_id=p.owner_user_id AND r.project_id=p.id AND r.task_kind='update'
    JOIN bb_execution_artifact_versions a ON a.owner_user_id=r.owner_user_id AND a.run_id=r.id
      AND a.id=r.artifact_id AND a.version=r.artifact_version AND a.media_type=$4
      AND a.quality_status='passed'
      AND a.delivery_status=CASE WHEN r.channel='non_production_test' THEN 'test_only' ELSE 'available' END
    JOIN bb_word_delivery_evidence ae ON ae.owner_user_id=a.owner_user_id AND ae.run_id=a.run_id
      AND ae.id=a.word_delivery_evidence_id AND ae.artifact_id=a.id AND ae.artifact_version=a.version
      AND ae.quality_status='passed' AND ae.delivery_status='available' AND ae.delivery_code='readback_verified'
      AND ae.candidate_sha256=a.sha256 AND ae.readback_sha256=a.sha256 AND ae.readback_byte_size=ae.byte_size
    LEFT JOIN bb_non_production_test_grants tg ON tg.grant_id=r.test_grant_id AND tg.user_id=r.owner_user_id
      AND tg.project_id=r.project_id AND tg.input_revision=r.input_revision AND tg.input_hash=r.input_hash
    LEFT JOIN LATERAL (
      SELECT j.checkpoint#>'{stages,word_delivery_pair}' AS value FROM bb_jobs j
      WHERE j.owner_user_id=r.owner_user_id AND j.run_id=r.id
    ) pair ON true
    LEFT JOIN LATERAL (
      SELECT variant.id,variant.version,variant.sha256,variant.object_key,e.byte_size
      FROM bb_execution_artifact_versions variant
      JOIN bb_word_delivery_evidence e ON e.owner_user_id=variant.owner_user_id AND e.run_id=variant.run_id
        AND e.id=variant.word_delivery_evidence_id AND e.artifact_id=variant.id AND e.artifact_version=variant.version
        AND e.quality_status='passed' AND e.delivery_status='available' AND e.delivery_code='readback_verified'
        AND e.candidate_sha256=variant.sha256 AND e.readback_sha256=variant.sha256 AND e.readback_byte_size=e.byte_size
      WHERE variant.owner_user_id=r.owner_user_id AND variant.run_id=r.id
        AND variant.id=pair.value->>'clean_artifact_id' AND variant.media_type=$4
        AND variant.quality_status='passed' AND variant.delivery_status=a.delivery_status
      ORDER BY variant.version DESC LIMIT 1
    ) c ON true
    LEFT JOIN LATERAL (
      SELECT variant.id,variant.version,variant.sha256,variant.object_key,e.byte_size
      FROM bb_execution_artifact_versions variant
      JOIN bb_word_delivery_evidence e ON e.owner_user_id=variant.owner_user_id AND e.run_id=variant.run_id
        AND e.id=variant.word_delivery_evidence_id AND e.artifact_id=variant.id AND e.artifact_version=variant.version
        AND e.quality_status='passed' AND e.delivery_status='available' AND e.delivery_code='readback_verified'
        AND e.candidate_sha256=variant.sha256 AND e.readback_sha256=variant.sha256 AND e.readback_byte_size=e.byte_size
      WHERE variant.owner_user_id=r.owner_user_id AND variant.run_id=r.id
        AND variant.id=pair.value->>'baseline_artifact_id' AND variant.media_type=$4
        AND variant.quality_status='passed' AND variant.delivery_status=a.delivery_status
      ORDER BY variant.version DESC LIMIT 1
    ) b ON true
    WHERE p.owner_user_id=$1 AND p.id=$2 AND p.deleted_at IS NULL
      AND ((r.channel='production' AND r.state='succeeded') OR
        (r.channel='non_production_test' AND $3::boolean AND r.state='test_completed'
         AND tg.revoked_at IS NULL AND tg.expires_at>now() AND tg.grant_id IS NOT NULL))
      AND (pair.value IS NULL OR
        (jsonb_typeof(pair.value)='object' AND jsonb_typeof(pair.value->'revision_artifact_id')='string'
         AND pair.value->>'revision_artifact_id'=a.id AND c.id IS NOT NULL
         AND b.id IS NOT NULL AND a.id<>c.id AND a.id<>b.id AND c.id<>b.id))
      AND ($5::timestamptz IS NULL OR (r.updated_at,r.id)<=($5::timestamptz,$6::text))
      AND ($7::timestamptz IS NULL OR (r.updated_at,r.id)<($7::timestamptz,$8::text))
    ORDER BY r.updated_at DESC,r.id DESC LIMIT $9`,
    [owner, projectId, testEnabled, WORD, boundary?.upper.time ?? null, boundary?.upper.id ?? null,
      boundary?.after.time ?? null, boundary?.after.id ?? null, limit + 1]);
  const page = rows.rows.slice(0, limit);
  const items = [];
  for (const row of page) {
    const scope = { owner_user_id: owner, project_id: projectId, run_id: row.run_id };
    const primary: Artifact = { ...scope, id: row.primary_id, version: row.primary_version, media_type: WORD,
      sha256: row.primary_sha256, object_key: row.primary_object_key, delivery_evidence_byte_size: row.primary_size };
    await verify(primary);
    let wordDelivery: { revision: { artifact_id: string; version: number };
      clean: { artifact_id: string; version: number }; baseline: { artifact_id: string; version: number } } | null = null;
    if (row.has_pair) {
      const clean: Artifact = { ...scope, id: row.clean_id!, version: row.clean_version!, media_type: WORD,
        sha256: row.clean_sha256!, object_key: row.clean_object_key!, delivery_evidence_byte_size: row.clean_size! };
      const baseline: Artifact = { ...scope, id: row.baseline_id!, version: row.baseline_version!, media_type: WORD,
        sha256: row.baseline_sha256!, object_key: row.baseline_object_key!, delivery_evidence_byte_size: row.baseline_size! };
      await verify(clean);
      await verify(baseline);
      wordDelivery = { revision: { artifact_id: primary.id, version: primary.version },
        clean: { artifact_id: clean.id, version: clean.version },
        baseline: { artifact_id: baseline.id, version: baseline.version } };
    }
    items.push({ run_id: row.run_id, input_revision: row.input_revision, completed_at: date(row.completed_at),
      state: row.state, channel: row.channel, primary_artifact: { artifact_id: primary.id, version: primary.version },
      word_delivery: wordDelivery });
  }
  const last = page.at(-1);
  const upper = boundary?.upper ?? (page[0] ? { time: page[0].cursor_time, id: page[0].run_id } : null);
  return { items, page: { has_more: rows.rows.length > limit,
    next_cursor: rows.rows.length > limit && last && upper
      ? Buffer.from(JSON.stringify([1, digest(JSON.stringify([owner, projectId])),
          upper.time, upper.id, last.cursor_time, last.run_id])).toString('base64url')
      : null } };
}
