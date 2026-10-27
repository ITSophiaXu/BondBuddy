import type { Static } from '@sinclair/typebox';
import type { schemas } from '@bondbuddy/contracts';
import type { Pool } from 'pg';
import { date, Problem, project, projectDto, transaction, uid } from './data.js';
import { recordOperation } from './observability.js';
import { memberProjectsSql, collectionTasksSql, collectionFilesSql, activeTaskSql, terminalTaskSql, taskDto } from './project-collection.js';

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
    SELECT p.*, w.update_project_id, EXISTS(SELECT 1 FROM bb_material_versions m WHERE m.owner_user_id=p.owner_user_id AND m.project_id IN(p.id,w.update_project_id) AND m.role='historical' AND m.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM bb_prospectus_versions v WHERE v.owner_user_id=p.owner_user_id AND v.project_id IN(p.id,w.update_project_id) AND v.origin='generated') AS has_prospectus, r.id AS run_id, r.state AS run_state, r.updated_at AS run_updated_at,
      GREATEST(p.updated_at,r.updated_at,up.updated_at,summary.activity_at,files.activity_at) AS activity_at,
      summary.active,summary.attention,summary.completed,summary.total,summary.latest,summary.recent_result,files.file_count,
      a.id AS artifact_id, a.version AS artifact_version, a.run_id AS artifact_run_id, a.created_at AS artifact_created_at
    FROM bb_projects p
    LEFT JOIN bb_update_workspaces w ON w.owner_user_id=p.owner_user_id AND w.source_project_id=p.id
    LEFT JOIN bb_projects up ON up.owner_user_id=p.owner_user_id AND up.id=w.update_project_id
    LEFT JOIN LATERAL (
      WITH members AS (${memberProjectsSql('p')}),tasks AS (${collectionTasksSql})
      SELECT count(*)::int AS total,count(*) FILTER(WHERE state IN ${activeTaskSql})::int AS active,
        count(*) FILTER(WHERE lane_rank=1 AND state NOT IN ${activeTaskSql} AND state<>'succeeded')::int AS attention,
        count(*) FILTER(WHERE lane_rank=1 AND state='succeeded')::int AS completed,max(updated_at) AS activity_at,
        (SELECT to_jsonb(t) FROM tasks t ORDER BY (state IN ${terminalTaskSql}),created_at DESC,id DESC LIMIT 1) AS latest,
        (SELECT to_jsonb(t) FROM tasks t WHERE state IN ${terminalTaskSql} ORDER BY created_at DESC,id DESC LIMIT 1) AS recent_result
      FROM tasks
    ) summary ON true
    LEFT JOIN LATERAL (
      WITH members AS (${memberProjectsSql('p')}),files AS (${collectionFilesSql})
      SELECT count(DISTINCT file_key)::int AS file_count,max(created_at) AS activity_at FROM files
    ) files ON true
    LEFT JOIN LATERAL (
      SELECT id,state,updated_at FROM bb_runs
      WHERE owner_user_id=p.owner_user_id AND project_id IN(p.id,w.update_project_id)
        AND NOT (task_kind='qa' AND EXISTS(SELECT 1 FROM bb_m4_topics t WHERE t.project_id=p.id AND t.surface='assistant'))
      ORDER BY (state IN ('succeeded','test_completed','failed','cancelled','rejected')),created_at DESC,id DESC LIMIT 1
    ) r ON true
    LEFT JOIN LATERAL (
      SELECT a.id,a.version,a.run_id,delivered_final.delivered_at AS created_at FROM bb_run_execution_deliveries delivered_final
      JOIN bb_delivered_artifact_versions a ON a.owner_user_id=delivered_final.owner_user_id
        AND a.id=delivered_final.primary_artifact_id AND a.version=delivered_final.primary_artifact_version AND a.run_id=delivered_final.run_id
      WHERE delivered_final.owner_user_id=p.owner_user_id AND delivered_final.project_id IN(p.id,w.update_project_id)
        AND delivered_final.delivery_phase='final' AND delivered_final.terminal_state='succeeded' AND delivered_final.channel='production'
        AND bb_execution_delivery_phase_valid(delivered_final)
        AND a.quality_status='passed' AND a.delivery_status='available'
      ORDER BY delivered_final.delivered_at DESC,delivered_final.run_id DESC,delivered_final.execution_version DESC LIMIT 1
    ) a ON true
    WHERE p.owner_user_id=$1 AND p.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM bb_update_workspaces child WHERE child.owner_user_id=p.owner_user_id AND child.update_project_id=p.id)
      AND NOT EXISTS(SELECT 1 FROM bb_m4_topics child JOIN bb_projects source ON source.owner_user_id=child.owner_user_id AND source.id=child.source_project_id AND source.deleted_at IS NULL
        WHERE child.owner_user_id=p.owner_user_id AND child.project_id=p.id AND child.surface<>'assistant')
      AND NOT (p.kind='qa' AND EXISTS(SELECT 1 FROM bb_m4_topics t WHERE t.project_id=p.id AND t.surface='assistant'))
      AND ($2::text IS NULL OR strpos(lower(p.name),lower($2))>0 OR strpos(lower(coalesce(p.issuer_name,'')),lower($2))>0)
      AND ($3::text IS NULL OR p.kind=$3)
      AND ($4::text='all' OR (p.archived_at IS NOT NULL)=($4='archived'))
  ) SELECT *,to_char(activity_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
    FROM owned WHERE ($5::text IS NULL OR coalesce(latest->>'state','draft')=$5)
      AND ($6::timestamptz IS NULL OR (activity_at,id)<($6::timestamptz,$7::text))
    ORDER BY activity_at DESC,id DESC LIMIT $8`,
  [owner,search,query.kind ?? null,query.archive ?? 'active',query.status ?? null,boundary?.time ?? null,boundary?.id ?? null,limit+1]);
  const page = rows.rows.slice(0,limit);
  const last = page.at(-1);
  return {
    items: page.map(p => ({ project_id:p.id,name:p.name,draft_revision:p.draft_revision,updated_at:date(p.activity_at),
      file_count:p.file_count,task_summary:{active:p.active,attention:p.total?p.attention:1,completed:p.completed,total:p.total,latest:taskDto(p.latest),recent_result:taskDto(p.recent_result)},
      update_project_id:p.update_project_id??null,has_prospectus:p.has_prospectus,kind:p.kind,issuer_name:p.issuer_name,market:p.market,offering:p.offering,status:p.latest?.state ?? 'draft',
      archived_at:p.archived_at ? date(p.archived_at) : null,
      latest_run:p.latest ? {run_id:p.latest.id,state:p.latest.state,updated_at:date(p.latest.updated_at)} : null,
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
    await client.query('UPDATE bb_projects SET archived_at=CASE WHEN $3 THEN now() ELSE NULL END,updated_at=now() WHERE owner_user_id=$1 AND id IN (SELECT update_project_id FROM bb_update_workspaces WHERE owner_user_id=$1 AND source_project_id=$2)',[owner,id,archived]);
    await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,\'project\',$3,$4,$5)',
      [uid(),owner,id,archived ? 'project.archived' : 'project.restored',{project_id:id}]);
    await recordOperation(client,{owner,projectId:id,requestId,traceId:requestId,kind:archived?'project_archive':'project_restore',status:'submitted'});
    return projectDto(await project(client,owner,id));
  });
}
