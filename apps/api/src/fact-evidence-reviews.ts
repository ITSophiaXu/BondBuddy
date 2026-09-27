import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { schemas, type FactEvidenceReviewRequest, type FactEvidenceReviewResponse, type FactEvidenceReviewWithdrawalRequest } from '@bondbuddy/contracts';
import { Problem, missing } from './data.js';

type Row = Record<string, unknown>;
type Queryable = { query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }> };
type Client = Queryable & { release(): void | Promise<void> };
type Db = Queryable & { connect(): Promise<Client> };
type Principal = { userId: string };
type Assessment = FactEvidenceReviewRequest['assessments'][number];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
function fail(code: string): Error { const error = new Error(code); error.name = 'FactEvidenceReviewError'; return error; }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function json(value: unknown): unknown { if (typeof value !== 'string') return value; try { return JSON.parse(value) as unknown; } catch { throw fail('FACT_EVIDENCE_REVIEW_DATA_INVALID'); } }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  const encoded = JSON.stringify(value); if (encoded === undefined) throw fail('FACT_EVIDENCE_REVIEW_INVALID'); return encoded;
}
function hash(value: unknown): string { return createHash('sha256').update(canonical(value), 'utf8').digest('hex'); }
function iso(value: unknown): string { const date = value instanceof Date ? value : new Date(String(value)); if (!Number.isFinite(date.getTime())) throw fail('FACT_EVIDENCE_REVIEW_DATA_INVALID'); return date.toISOString(); }
function validate(principal: Principal, projectId: string, input: FactEvidenceReviewRequest): void {
  if (!principal || !ID.test(principal.userId) || !ID.test(projectId) || !input || !ID.test(input.request_id) ||
    !ID.test(input.candidate_id) || !ID.test(input.evidence_context_set_id) || !SHA.test(input.evidence_set_sha256) ||
    !input.reason.trim() || input.reason.trim().length > 2048 || !Array.isArray(input.assessments) ||
    input.assessments.length < 1 || input.assessments.length > 500) throw fail('FACT_EVIDENCE_REVIEW_INVALID');
  for (const item of input.assessments) if (!ID.test(item.target_id) || !['supports_candidate','contradicts_candidate','not_relevant','unresolved'].includes(item.assessment) ||
    !item.reason.trim() || item.reason.trim().length > 2048) throw fail('FACT_EVIDENCE_REVIEW_INVALID');
}
function exactAssessments(manifest: Record<string, unknown>, assessments: Assessment[]): void {
  const body = manifest.selected_body, auxiliary = manifest.auxiliary_targets;
  if (!Array.isArray(body) || !Array.isArray(auxiliary)) throw fail('FACT_EVIDENCE_CONTEXT_INVALID');
  const expected = new Map<string, 'body'|'auxiliary'>();
  for (const item of body) if (object(item) && typeof item.record_id === 'string') expected.set(item.record_id, 'body');
  for (const item of auxiliary) if (object(item) && typeof item.target_id === 'string') expected.set(item.target_id, 'auxiliary');
  if (expected.size !== body.length + auxiliary.length || expected.size !== assessments.length) throw fail('FACT_EVIDENCE_REVIEW_CONTEXT_COVERAGE_MISMATCH');
  const seen = new Set<string>();
  for (const item of assessments) {
    const kind = expected.get(item.target_id);
    if (!kind || seen.has(item.target_id) || (kind === 'body' && item.assessment === 'not_relevant')) throw fail('FACT_EVIDENCE_REVIEW_CONTEXT_COVERAGE_MISMATCH');
    seen.add(item.target_id);
  }
}
function outcome(context: Record<string, unknown>, candidate: Row, assessments: Assessment[]): FactEvidenceReviewResponse['outcome'] {
  const unresolved = context.completeness_status !== 'complete' || context.reviewable !== true ||
    ['conflicted','superseded'].includes(String(candidate.status)) ||
    (candidate.source_kind === 'audited' && Array.isArray(json(candidate.uncertainty)) && (json(candidate.uncertainty) as unknown[]).length > 0) ||
    assessments.some(item => item.assessment === 'contradicts_candidate' || item.assessment === 'unresolved');
  if (unresolved) return 'needs_more_evidence';
  return candidate.source_kind === 'external' ? 'external_evidence_impact_reviewed' : 'evidence_impact_reviewed';
}
function candidateSnapshot(candidate: Row): Record<string, unknown> {
  return { candidate_id: candidate.id, fact_key_hash: String(candidate.fact_key_hash).trim(), fact_key: json(candidate.fact_key),
    value_kind: candidate.value_kind, value_decimal: candidate.value_decimal, value_text: candidate.value_text,
    source_kind: candidate.source_kind, source_ref: candidate.source_ref, status: candidate.status,
    material_id: candidate.material_id, material_version: candidate.material_version,
    evidence: json(candidate.evidence), uncertainty: json(candidate.uncertainty) };
}
function response(row: Row, replayed: boolean): FactEvidenceReviewResponse {
  return { review_id: String(row.id), request_id: String(row.request_id), owner_user_id: String(row.owner_user_id), project_id: String(row.project_id),
    candidate_id: String(row.candidate_id), candidate_identity_sha256: String(row.candidate_identity_sha256).trim(), candidate_snapshot: json(row.candidate_snapshot) as Record<string, unknown>,
    evidence_context_set_id: String(row.evidence_context_set_id), evidence_set_sha256: String(row.evidence_set_sha256).trim(),
    input_revision: Number(row.input_revision), input_hash: String(row.input_hash).trim(), material_id: String(row.material_id), material_version: Number(row.material_version),
    material_sha256: String(row.material_sha256).trim(), snapshot_id: String(row.snapshot_id), parser_version: String(row.parser_version),
    parse_response_sha256: String(row.parse_response_sha256).trim(), source_kind: row.source_kind as 'audited'|'external', assessments: json(row.assessments) as Assessment[],
    outcome: row.outcome as FactEvidenceReviewResponse['outcome'], reviewer_user_id: String(row.reviewer_user_id), reviewer_grant_id: String(row.reviewer_grant_id),
    authority: 'fact_evidence_reviewer', reason: String(row.reason), reviewed_at: iso(row.reviewed_at), replayed, verification_effect: 'none' };
}
async function currentGrant(client: Queryable, reviewer: string, project: string): Promise<Row> {
  const rows = await client.query(`SELECT g.id,g.scope_owner_user_id FROM bb_fact_evidence_reviewer_grants g
    JOIN bb_projects p ON p.owner_user_id=g.scope_owner_user_id AND p.id=g.scope_project_id AND p.deleted_at IS NULL
    JOIN bb_users u ON u.id=g.user_id AND u.status='active'
    WHERE g.user_id=$1 AND g.role='fact_evidence_reviewer' AND g.scope_project_id=$2 AND g.revoked_at IS NULL
      AND g.scope_owner_user_id<>$1 FOR SHARE OF g,p,u`, [reviewer, project]);
  if (rows.rows.length !== 1) throw fail('FACT_EVIDENCE_REVIEWER_FORBIDDEN');
  return rows.rows[0]!;
}

export async function appendFactEvidenceReview(db: Db, principal: Principal, projectId: string, input: FactEvidenceReviewRequest,
  newId: () => string = randomUUID): Promise<FactEvidenceReviewResponse> {
  validate(principal, projectId, input);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const grant = await currentGrant(client, principal.userId, projectId);
    const scopeOwner = String(grant.scope_owner_user_id), requestHash = hash({ ...input, assessments: [...input.assessments].sort((a,b) => a.target_id.localeCompare(b.target_id)) });
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`fact-evidence-review:${scopeOwner}:${projectId}:${input.request_id}`]);
    const prior = await client.query('SELECT * FROM bb_fact_evidence_reviews WHERE owner_user_id=$1 AND project_id=$2 AND request_id=$3', [scopeOwner, projectId, input.request_id]);
    if (prior.rows[0]) {
      const row = prior.rows[0]!;
      if (String(row.request_hash).trim() !== requestHash || row.reviewer_user_id !== principal.userId || row.reviewer_grant_id !== grant.id) throw fail('FACT_EVIDENCE_REVIEW_REPLAY_CONFLICT');
      await client.query('COMMIT'); return response(row, true);
    }
    const source = await client.query(`SELECT x.*,c.id AS c_id,c.fact_key_hash,c.fact_key,c.value_kind,c.value_decimal,c.value_text,c.source_kind,
        c.source_ref,c.status AS candidate_status,c.material_id AS candidate_material_id,c.material_version AS candidate_material_version,
        c.evidence,c.uncertainty,c.created_at AS candidate_created_at,c.entity_id
      FROM bb_fact_evidence_context_sets x JOIN bb_fact_candidates c ON c.owner_user_id=x.owner_user_id AND c.project_id=x.project_id AND c.id=x.candidate_id
      JOIN bb_projects p ON p.owner_user_id=x.owner_user_id AND p.id=x.project_id AND p.deleted_at IS NULL
      JOIN bb_input_revisions i ON i.owner_user_id=x.owner_user_id AND i.project_id=x.project_id AND i.revision=x.input_revision AND i.input_hash=x.input_hash
      JOIN bb_material_versions m ON m.owner_user_id=x.owner_user_id AND m.project_id=x.project_id AND m.id=x.material_id AND m.version=x.material_version
        AND m.sha256=x.content_sha256 AND m.deleted_at IS NULL
      JOIN bb_parse_snapshots s ON s.owner_user_id=x.owner_user_id AND s.project_id=x.project_id AND s.id=x.snapshot_id
        AND s.material_id=x.material_id AND s.material_version=x.material_version AND s.parser_version=x.parser_version AND s.response_sha256=x.parse_response_sha256
      WHERE x.owner_user_id=$1 AND x.project_id=$2 AND x.id=$3 AND x.candidate_id=$4 AND x.evidence_set_sha256=$5
        AND p.latest_input_revision=x.input_revision AND p.draft_revision=i.draft_revision
        AND NOT EXISTS(SELECT 1 FROM bb_material_versions newer WHERE newer.owner_user_id=m.owner_user_id AND newer.id=m.id AND newer.version>m.version AND newer.deleted_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM bb_parse_snapshots newer WHERE newer.owner_user_id=s.owner_user_id AND newer.project_id=s.project_id
          AND newer.material_id=s.material_id AND newer.material_version=s.material_version AND (newer.created_at,newer.id)>(s.created_at,s.id))
      FOR SHARE OF x,c,p,i,m,s`, [scopeOwner, projectId, input.evidence_context_set_id, input.candidate_id, input.evidence_set_sha256]);
    if (source.rows.length !== 1) throw fail('FACT_EVIDENCE_CONTEXT_NOT_CURRENT');
    const row = source.rows[0]!, manifest = json(row.manifest) as Record<string, unknown>;
    if (!object(manifest) || manifest.candidate_id !== input.candidate_id || String(row.fact_key_hash).trim() !== String(manifest.candidate_identity_sha256) ||
      row.source_kind !== manifest.source_kind || Number(row.material_version) !== Number(manifest.material_version) ||
      String(row.content_sha256).trim() !== String(manifest.material_sha256) || String(row.response_sha256 ?? row.parse_response_sha256).trim() !== String(manifest.parse_response_sha256))
      throw fail('FACT_EVIDENCE_CONTEXT_PIN_MISMATCH');
    exactAssessments(manifest, input.assessments);
    const candidate = { ...row, id: row.c_id, status: row.candidate_status, material_id: row.candidate_material_id,
      material_version: row.candidate_material_version, created_at: row.candidate_created_at };
    const derived = outcome(manifest, candidate, input.assessments);
    const responseRow = (await client.query(`INSERT INTO bb_fact_evidence_reviews
      (id,request_id,request_hash,owner_user_id,project_id,candidate_id,candidate_identity_sha256,candidate_snapshot,evidence_context_set_id,evidence_set_sha256,
       input_revision,input_hash,material_id,material_version,material_sha256,snapshot_id,parser_version,parse_response_sha256,source_kind,assessments,outcome,
       reviewer_user_id,reviewer_grant_id,authority,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22,$23,'fact_evidence_reviewer',$24)
      RETURNING *`, [newId(), input.request_id, requestHash, scopeOwner, projectId, input.candidate_id, String(row.fact_key_hash).trim(),
      JSON.stringify(candidateSnapshot({ ...candidate, fact_key_hash: String(row.fact_key_hash).trim(), fact_key: row.fact_key })), input.evidence_context_set_id,
      input.evidence_set_sha256, row.input_revision, String(row.input_hash).trim(), row.material_id, row.material_version,
      String(row.content_sha256).trim(), row.snapshot_id, row.parser_version, String(row.parse_response_sha256).trim(), row.source_kind,
      JSON.stringify(input.assessments), derived, principal.userId, String(grant.id), input.reason.trim()])).rows[0];
    if (!responseRow) throw fail('FACT_EVIDENCE_REVIEW_NOT_STORED');
    await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'fact_evidence_review',$3,'fact_evidence_review.appended',$4::jsonb)`, [newId(), scopeOwner, String(responseRow.id),
      JSON.stringify({ project_id: projectId, candidate_id: input.candidate_id, evidence_context_set_id: input.evidence_context_set_id,
        evidence_set_sha256: input.evidence_set_sha256, outcome: derived, reviewer_user_id: principal.userId, reviewer_grant_id: String(grant.id) })]);
    await client.query('COMMIT'); return response(responseRow, false);
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { await client.release(); }
}

export async function withdrawFactEvidenceReview(db: Db, principal: Principal, projectId: string, input: FactEvidenceReviewWithdrawalRequest,
  newId: () => string = randomUUID) {
  if (!principal || !ID.test(principal.userId) || !ID.test(projectId) || !ID.test(input.request_id) || !ID.test(input.review_id) || !input.reason.trim() || input.reason.trim().length > 2048) throw fail('FACT_EVIDENCE_REVIEW_INVALID');
  const client = await db.connect();
  try {
    await client.query('BEGIN'); const grant = await currentGrant(client, principal.userId, projectId);
    const owner = String(grant.scope_owner_user_id), requestHash = hash({ review_id: input.review_id, reason: input.reason.trim() });
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`fact-evidence-review-withdraw:${owner}:${projectId}:${input.request_id}`]);
    const prior = await client.query('SELECT * FROM bb_fact_evidence_review_withdrawals WHERE owner_user_id=$1 AND project_id=$2 AND request_id=$3', [owner, projectId, input.request_id]);
    if (prior.rows[0]) { const row = prior.rows[0]!; if (String(row.request_hash).trim() !== requestHash || row.reviewer_user_id !== principal.userId || row.reviewer_grant_id !== grant.id) throw fail('FACT_EVIDENCE_REVIEW_REPLAY_CONFLICT'); await client.query('COMMIT'); return { withdrawal_id:String(row.id),review_id:String(row.review_id),reviewer_user_id:principal.userId,reviewer_grant_id:String(grant.id),authority:'fact_evidence_reviewer' as const,reason:String(row.reason),withdrawn_at:iso(row.withdrawn_at),replayed:true }; }
    const review = await client.query('SELECT id FROM bb_fact_evidence_reviews WHERE id=$1 AND owner_user_id=$2 AND project_id=$3', [input.review_id, owner, projectId]);
    if (!review.rows[0]) throw fail('FACT_EVIDENCE_REVIEW_NOT_FOUND');
    const row = (await client.query(`INSERT INTO bb_fact_evidence_review_withdrawals(id,request_id,request_hash,review_id,owner_user_id,project_id,reviewer_user_id,reviewer_grant_id,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [newId(), input.request_id, requestHash, input.review_id, owner, projectId, principal.userId, String(grant.id), input.reason.trim()])).rows[0]!;
    await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'fact_evidence_review',$3,'fact_evidence_review.withdrawn',$4::jsonb)`,
      [newId(), owner, input.review_id, JSON.stringify({ project_id: projectId, reviewer_user_id: principal.userId, reviewer_grant_id: String(grant.id), reason: input.reason.trim() })]);
    await client.query('COMMIT'); return { withdrawal_id:String(row.id),review_id:input.review_id,reviewer_user_id:principal.userId,reviewer_grant_id:String(grant.id),authority:'fact_evidence_reviewer' as const,reason:String(row.reason),withdrawn_at:iso(row.withdrawn_at),replayed:false };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { await client.release(); }
}

export async function changeFactEvidenceReviewerGrant(db: Db, input: {action:'grant'|'revoke';reviewerUserId:string;actorUserId:string;reasonCode:string;authorizationBasis:string;ownerUserId:string;projectId:string;reason?:string}, newId:()=>string=randomUUID): Promise<string> {
  if (!['grant','revoke'].includes(input.action)||!ID.test(input.reviewerUserId)||!ID.test(input.actorUserId)||input.reviewerUserId===input.actorUserId||input.reviewerUserId===input.ownerUserId||!ID.test(input.ownerUserId)||!ID.test(input.projectId)||!/^[a-z][a-z0-9_]{0,63}$/.test(input.reasonCode)||!input.authorizationBasis.trim()||input.authorizationBasis.trim().length>2048||(input.action==='revoke'&&(!input.reason||!input.reason.trim()||input.reason.trim().length>2048))) throw fail('FACT_EVIDENCE_GRANT_INVALID');
  const client=await db.connect();
  try { await client.query('BEGIN'); const admin=await client.query(`SELECT 1 FROM pg_class c JOIN pg_roles o ON o.oid=c.relowner JOIN pg_roles a ON a.rolname=current_user WHERE c.oid='bb_fact_evidence_reviewer_grants'::regclass AND (a.rolsuper OR a.rolname=o.rolname)`); if(!admin.rows.length)throw fail('FACT_EVIDENCE_GRANT_ADMIN_REQUIRED');
    const actors=await client.query("SELECT id FROM bb_users WHERE id=ANY($1::text[]) AND status='active' ORDER BY id FOR SHARE",[[input.actorUserId,input.reviewerUserId]]);if(actors.rows.length!==2)throw fail('FACT_EVIDENCE_GRANT_ACTOR_NOT_ACTIVE');
    const project=await client.query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE',[input.ownerUserId,input.projectId]);if(!project.rows.length)throw fail('FACT_EVIDENCE_PROJECT_NOT_FOUND');
    let grantId:string,event:string;
    if(input.action==='grant'){const active=await client.query('SELECT 1 FROM bb_fact_evidence_reviewer_grants WHERE user_id=$1 AND scope_owner_user_id=$2 AND scope_project_id=$3 AND revoked_at IS NULL',[input.reviewerUserId,input.ownerUserId,input.projectId]);if(active.rows.length)throw fail('FACT_EVIDENCE_GRANT_ALREADY_ACTIVE');grantId=newId();await client.query(`INSERT INTO bb_fact_evidence_reviewer_grants(id,user_id,role,granted_by,reason_code,authorization_basis,scope_owner_user_id,scope_project_id) VALUES($1,$2,'fact_evidence_reviewer',$3,$4,$5,$6,$7)`,[grantId,input.reviewerUserId,input.actorUserId,input.reasonCode,input.authorizationBasis.trim(),input.ownerUserId,input.projectId]);event='fact_evidence_reviewer.granted';}
    else {const updated=await client.query(`UPDATE bb_fact_evidence_reviewer_grants SET revoked_at=now(),revoked_by=$4,revocation_reason=$5 WHERE user_id=$1 AND scope_owner_user_id=$2 AND scope_project_id=$3 AND revoked_at IS NULL RETURNING id`,[input.reviewerUserId,input.ownerUserId,input.projectId,input.actorUserId,input.reason!.trim()]);if(updated.rows.length!==1)throw fail('FACT_EVIDENCE_GRANT_NOT_ACTIVE');grantId=String(updated.rows[0]!.id);event='fact_evidence_reviewer.revoked';}
    await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'fact_evidence_reviewer_grant',$3,$4,$5::jsonb)`,[newId(),input.ownerUserId,grantId,event,JSON.stringify({reviewer_user_id:input.reviewerUserId,actor_user_id:input.actorUserId,project_id:input.projectId,reason_code:input.reasonCode,authorization_basis:input.authorizationBasis.trim(),...(input.reason?{reason:input.reason.trim()}:{})})]);await client.query('COMMIT');return grantId;
  } catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{await client.release();}
}

async function readFactEvidenceContext(db: Db, principal: Principal, projectId: string, candidateId: string) {
  if (!ID.test(principal.userId) || !ID.test(projectId) || !ID.test(candidateId)) throw fail('FACT_EVIDENCE_REVIEW_INVALID');
  const result=await db.query(`SELECT x.* FROM bb_fact_evidence_context_sets x JOIN bb_projects p ON p.owner_user_id=x.owner_user_id AND p.id=x.project_id AND p.deleted_at IS NULL
    WHERE x.project_id=$1 AND x.candidate_id=$2 AND x.id=(SELECT latest.id FROM bb_fact_evidence_context_sets latest
      WHERE latest.owner_user_id=x.owner_user_id AND latest.project_id=x.project_id AND latest.candidate_id=x.candidate_id
      ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)
      AND (x.owner_user_id=$3 OR EXISTS(SELECT 1 FROM bb_fact_evidence_reviewer_grants g JOIN bb_users u ON u.id=g.user_id AND u.status='active'
        WHERE g.user_id=$3 AND g.role='fact_evidence_reviewer' AND g.scope_owner_user_id=x.owner_user_id AND g.scope_project_id=x.project_id AND g.revoked_at IS NULL))`,
    [projectId,candidateId,principal.userId]);
  const row=result.rows[0];if(!row)throw fail('FACT_EVIDENCE_REVIEW_NOT_FOUND');
  return {evidence_context_set_id:String(row.id),owner_user_id:String(row.owner_user_id),project_id:String(row.project_id),candidate_id:String(row.candidate_id),
    evidence_set_sha256:String(row.evidence_set_sha256).trim(),completeness_status:row.completeness_status as 'complete'|'incomplete',reviewable:row.reviewable===true,
    manifest:json(row.manifest) as Record<string,unknown>};
}

export function installFactEvidenceReviewRoutes(app: FastifyInstance, settings: {db:()=>Pool; principal:(request:FastifyRequest)=>Promise<Principal>}) {
  app.get('/api/v1/projects/:project_id/facts/candidates/:candidate_id/evidence-context',{schema:{response:{200:schemas.FactEvidenceContextResponse}}},async request=>{
    const principal=await settings.principal(request),params=request.params as {project_id:string;candidate_id:string};
    try{return await readFactEvidenceContext(settings.db(),principal,params.project_id,params.candidate_id);}catch(error){throw apiProblem(error);}
  });
  app.post('/api/v1/projects/:project_id/facts/evidence-reviews',{schema:{body:schemas.FactEvidenceReviewRequest,response:{200:schemas.FactEvidenceReviewResponse,201:schemas.FactEvidenceReviewResponse}}},async(request,reply)=>{
    const principal=await settings.principal(request),projectId=(request.params as {project_id:string}).project_id;
    try{const result=await appendFactEvidenceReview(settings.db(),principal,projectId,request.body as FactEvidenceReviewRequest);return reply.code(result.replayed?200:201).send(result);}catch(error){throw apiProblem(error);}
  });
  app.post('/api/v1/projects/:project_id/facts/evidence-reviews/withdraw',{schema:{body:schemas.FactEvidenceReviewWithdrawalRequest,response:{200:schemas.FactEvidenceReviewWithdrawalResponse,201:schemas.FactEvidenceReviewWithdrawalResponse}}},async(request,reply)=>{
    const principal=await settings.principal(request),projectId=(request.params as {project_id:string}).project_id;
    try{const result=await withdrawFactEvidenceReview(settings.db(),principal,projectId,request.body as FactEvidenceReviewWithdrawalRequest);return reply.code(result.replayed?200:201).send(result);}catch(error){throw apiProblem(error);}
  });
}

function apiProblem(error:unknown): Error {
  const code=error instanceof Error?error.message:'FACT_EVIDENCE_REVIEW_FAILED';
  if(code==='FACT_EVIDENCE_REVIEWER_FORBIDDEN')return new Problem(403,'DATA_NOT_ENTITLED','Fact evidence reviewer authority is required');
  if(code==='FACT_EVIDENCE_REVIEW_NOT_FOUND'||code==='FACT_EVIDENCE_PROJECT_NOT_FOUND')return missing();
  if(code.includes('REPLAY_CONFLICT'))return new Problem(409,'IDEMPOTENCY_CONFLICT','The request key is bound to another fact evidence review');
  if(code==='FACT_EVIDENCE_CONTEXT_NOT_CURRENT'||code==='FACT_EVIDENCE_CONTEXT_PIN_MISMATCH')return new Problem(409,'INPUT_REVISION_CONFLICT','The candidate evidence context is stale');
  if(code.includes('INVALID')||code.includes('INCOMPLETE')||code.includes('COVERAGE_MISMATCH'))return new Problem(422,'VALIDATION_FAILED','Fact evidence review is invalid or incomplete');
  return new Problem(503,'DATA_UNAVAILABLE','Fact evidence review could not be persisted');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [action,reviewerUserId,actorUserId,reasonCode,authorizationBasis,ownerUserId,projectId,reason]=process.argv.slice(2);
  if (!process.env.DATABASE_URL || !['grant','revoke'].includes(action??'') || !reviewerUserId || !actorUserId || !reasonCode ||
    !authorizationBasis || !ownerUserId || !projectId || (action==='revoke'&&!reason))
    throw new Error('Usage: fact-evidence:grants grant|revoke REVIEWER ACTOR REASON_CODE BASIS OWNER PROJECT [REVOCATION_REASON] (DATABASE_URL required)');
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  try { process.stdout.write(`${await changeFactEvidenceReviewerGrant(pool,{action:action as 'grant'|'revoke',reviewerUserId,actorUserId,reasonCode,authorizationBasis,ownerUserId,projectId,...(reason?{reason}:{})})}\n`); }
  finally { await pool.end(); }
}
