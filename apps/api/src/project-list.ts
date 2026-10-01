import type { Static } from '@sinclair/typebox';
import type { schemas } from '@bondbuddy/contracts';
import type { Pool } from 'pg';
import { date, Problem, project, projectDto, transaction, uid } from './data.js';
import { recordOperation } from './observability.js';

type Query = Static<typeof schemas.ProjectListQuery>;
const invalidCursor = () => new Problem(422, 'VALIDATION_FAILED', 'Invalid project cursor; refresh the list');

export async function listProjects(pool: Pool, owner: string, query: Query) {
  let boundary: { time: string; id: string } | null = null;
  if (query.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (parsed.v !== 1 || typeof parsed.id !== 'string' || !parsed.id.length || parsed.id.length > 128 ||
        typeof parsed.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.time) ||
        !Number.isFinite(Date.parse(parsed.time)) || new Date(parsed.time).toISOString().slice(0,19)!==parsed.time.slice(0,19)) throw invalidCursor();
      boundary = parsed;
    } catch { throw invalidCursor(); }
  }
  const limit = Number(query.limit ?? 50);
  // Literal substring matching: %, _ and backslash in an issuer/name are not wildcards.
  const search = query.q?.trim() || null;
  const rows = await pool.query(`WITH owned AS (
    SELECT p.*, r.id AS run_id, r.state AS run_state, r.updated_at AS run_updated_at,
      GREATEST(p.updated_at,r.updated_at) AS activity_at,
      a.id AS artifact_id, a.version AS artifact_version, a.run_id AS artifact_run_id, a.created_at AS artifact_created_at
    FROM bb_projects p
    LEFT JOIN LATERAL (
      SELECT id,state,updated_at FROM bb_runs
      WHERE owner_user_id=p.owner_user_id AND project_id=p.id
      ORDER BY (state IN ('succeeded','test_completed','failed','cancelled','rejected')),created_at DESC,id DESC LIMIT 1
    ) r ON true
    LEFT JOIN LATERAL (
      SELECT a.id,a.version,a.run_id,a.created_at FROM bb_runs completed
      JOIN bb_artifact_versions a ON a.owner_user_id=completed.owner_user_id
        AND a.id=completed.artifact_id AND a.version=completed.artifact_version AND a.run_id=completed.id
      WHERE completed.owner_user_id=p.owner_user_id AND completed.project_id=p.id AND completed.state='succeeded'
        AND a.quality_status='passed' AND a.delivery_status='available'
      ORDER BY completed.created_at DESC,completed.id DESC LIMIT 1
    ) a ON true
    WHERE p.owner_user_id=$1 AND p.deleted_at IS NULL
      AND ($2::text IS NULL OR strpos(lower(p.name),lower($2))>0 OR strpos(lower(coalesce(p.issuer_name,'')),lower($2))>0)
      AND ($3::text IS NULL OR p.kind=$3)
      AND ($4::text='all' OR (p.archived_at IS NOT NULL)=($4='archived'))
  ) SELECT *,to_char(activity_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
    FROM owned WHERE ($5::text IS NULL OR coalesce(run_state,'draft')=$5)
      AND ($6::timestamptz IS NULL OR (activity_at,id)<($6::timestamptz,$7::text))
    ORDER BY activity_at DESC,id DESC LIMIT $8`,
  [owner,search,query.kind ?? null,query.archive ?? 'active',query.status ?? null,boundary?.time ?? null,boundary?.id ?? null,limit+1]);
  const page = rows.rows.slice(0,limit);
  const last = page.at(-1);
  return {
    items: page.map(p => ({ project_id:p.id,name:p.name,draft_revision:p.draft_revision,updated_at:date(p.activity_at),
      kind:p.kind,issuer_name:p.issuer_name,market:p.market,offering:p.offering,status:p.run_state ?? 'draft',
      archived_at:p.archived_at ? date(p.archived_at) : null,
      latest_run:p.run_id ? {run_id:p.run_id,state:p.run_state,updated_at:date(p.run_updated_at)} : null,
      latest_artifact:p.artifact_id ? {artifact_id:p.artifact_id,run_id:p.artifact_run_id,version:p.artifact_version,created_at:date(p.artifact_created_at)} : null })),
    page: {has_more:rows.rows.length>limit,next_cursor:rows.rows.length>limit && last
      ? Buffer.from(JSON.stringify({v:1,time:last.cursor_time,id:last.id})).toString('base64url') : null}
  };
}

export async function archiveProject(pool: Pool, owner: string, id: string, archived: boolean, requestId: string) {
  return transaction(pool,async client => {
    const prior = await project(client,owner,id,true);
    if (Boolean(prior.archived_at) === archived) return projectDto(prior);
    await client.query('UPDATE bb_projects SET archived_at=CASE WHEN $3 THEN now() ELSE NULL END,updated_at=now() WHERE owner_user_id=$1 AND id=$2',[owner,id,archived]);
    await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,\'project\',$3,$4,$5)',
      [uid(),owner,id,archived ? 'project.archived' : 'project.restored',{project_id:id}]);
    await recordOperation(client,{owner,projectId:id,requestId,traceId:requestId,kind:archived?'project_archive':'project_restore',status:'submitted'});
    return projectDto(await project(client,owner,id));
  });
}
