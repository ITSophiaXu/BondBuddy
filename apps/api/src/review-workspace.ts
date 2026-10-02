import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  ReviewDraftRequestSchema, ReviewMessageRequestSchema, ReviewPlanRequestSchema, ReviewExecutionRequestSchema,
  executableRevisionFinding, isReviewReport, isReviewRevisionPin, emptyUpdateDetails, RUN_PIPELINE_SUBTYPE,
  type ReviewContext, type ReviewDraftInput, type ReviewDraftRequest, type ReviewMessageRequest, type ReviewPlanRequest,
  type ReviewExecutionRequest, type ReviewPlan, type ReviewReport, type ReviewMaterialPin, type ReviewRevisionPin,
} from '@bondbuddy/contracts';
import { project, projectDto, materialDto, runDto, transaction, uid, date, Problem, conflict, missing, executionKeyStorage } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { enqueue } from './queue.js';
import { recordOperation } from './observability.js';

type Db = Pool | PoolClient;
const finalStates = ['succeeded', 'test_completed', 'failed', 'cancelled', 'rejected'];
const emptyInput = (): ReviewDraftInput => ({ source_material_ref: null, material_versions: [], requirements: [], as_of: null });
const invalid = (message: string): never => { throw new Problem(422, 'VALIDATION_FAILED', message); };
const stale = (): never => { throw conflict('INPUT_REVISION_CONFLICT', 'The saved input, report or plan changed; reload before executing'); };
const same = (a: unknown, b: unknown) => inputManifestHash(a) === inputManifestHash(b);

async function requireReview(db: Db, user: string, id: string, lock = false) {
  const p = await project(db, user, id, lock);
  if (p.kind !== 'review') invalid('This operation requires a review project');
  return p;
}
async function pins(db: Db, user: string, id: string, selected: ReviewMaterialPin[]) {
  if (new Set(selected.map(m => m.material_id)).size !== selected.length) invalid('A material can only be selected once');
  const rows = [];
  for (const pin of selected) {
    const m = (await db.query('SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL', [user, id, pin.material_id, pin.material_version])).rows[0];
    if (!m || String(m.sha256).trim() !== pin.sha256) stale();
    rows.push(m);
  }
  return rows;
}
export async function readReviewReport(db: Db, user: string, projectId: string, reportId: string): Promise<{ id: string; run_id: string; version: number; content_sha256: string; report: ReviewReport }> {
  const row = (await db.query('SELECT * FROM bb_review_reports WHERE owner_user_id=$1 AND project_id=$2 AND id=$3', [user, projectId, reportId])).rows[0];
  if (!row) throw missing();
  if (!isReviewReport(row.report) || inputManifestHash(row.report) !== row.content_sha256.trim()) throw new Problem(503, 'DATA_UNAVAILABLE', 'Report snapshot is invalid');
  return { ...row, report: row.report as ReviewReport };
}
async function context(db: Db, user: string, id: string, value: ReviewContext) {
  if (value.project_id !== id) invalid('The message is bound to another project');
  await pins(db, user, id, value.material_refs);
  if (!value.report_id && value.finding_ids.length) invalid('Finding context requires its original report');
  if (value.report_id) {
    const r = await readReviewReport(db, user, id, value.report_id);
    if (value.finding_ids.some(f => !r.report.findings.some((v: ReviewReport['findings'][number]) => v.finding_id === f))) invalid('Finding does not belong to the bound report');
  }
}
async function draft(db: Db, user: string, id: string) {
  const r = (await db.query('SELECT version,input FROM bb_review_drafts WHERE owner_user_id=$1 AND project_id=$2', [user, id])).rows[0];
  return r ? { ...r.input, version: r.version } : { ...emptyInput(), version: 0 };
}
async function messageDrafts(db: Db, user: string, id: string) {
  return (await db.query('SELECT context,content,version,updated_at FROM bb_review_message_drafts WHERE owner_user_id=$1 AND project_id=$2 ORDER BY updated_at', [user, id])).rows.map(r => ({ ...r, updated_at: date(r.updated_at) }));
}
async function latestPlan(db: Db, user: string, id: string): Promise<ReviewPlan | null> {
  return (await db.query('SELECT plan FROM bb_review_revision_plans WHERE owner_user_id=$1 AND project_id=$2 ORDER BY version DESC LIMIT 1', [user, id])).rows[0]?.plan ?? null;
}
const messageDto = (r: any) => ({ message_id: r.id, role: r.role, content: r.content, context: r.context, created_at: date(r.created_at), reply_status: r.reply_status, reply_to: r.reply_to, proposal: r.proposal, error: r.error });
async function artifacts(db: Db, user: string, id: string, runId: string) {
  return (await db.query(`SELECT a.artifact_id,a.artifact_version,a.kind,a.filename FROM bb_review_artifacts a
    JOIN bb_artifact_versions v ON v.id=a.artifact_id AND v.version=a.artifact_version AND v.owner_user_id=a.owner_user_id
    WHERE a.owner_user_id=$1 AND a.project_id=$2 AND a.run_id=$3 AND v.quality_status='passed' AND v.delivery_status='available' ORDER BY a.kind`, [user, id, runId])).rows;
}
async function outbox(db: Db, user: string, id: string, event: string, payload: unknown) {
  await db.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'review_project',$3,$4,$5)", [uid(), user, id, event, payload]);
}

export function registerReviewRoutes(app: FastifyInstance, db: () => Pool, owner: (request: FastifyRequest) => Promise<string>) {
  const projectId = (request: FastifyRequest) => (request.params as { project_id: string }).project_id;
  app.get('/api/v1/projects/:project_id/review-workspace', async request => {
    const user = await owner(request), id = projectId(request), p = await requireReview(db(), user, id);
    const materials = (await db().query(`SELECT DISTINCT ON(id) * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND deleted_at IS NULL ORDER BY id,version DESC`, [user, id])).rows;
    const reports = (await db().query('SELECT id AS report_id,version,run_id,created_at FROM bb_review_reports WHERE owner_user_id=$1 AND project_id=$2 ORDER BY version DESC', [user, id])).rows.map(r => ({ ...r, created_at: date(r.created_at) }));
    const requestedReport = (request.query as { report_id?: string }).report_id;
    const requested = requestedReport ? await readReviewReport(db(), user, id, requestedReport) : null;
    const artifactRun = (await db().query(`SELECT e.run_id,e.version,e.operation,e.source_report_id FROM bb_review_executions e
      JOIN bb_runs r ON r.id=e.run_id AND r.owner_user_id=e.owner_user_id AND r.project_id=e.project_id
      WHERE e.owner_user_id=$1 AND e.project_id=$2 AND r.state IN ('succeeded','test_completed')
      AND ($3::text IS NULL OR e.run_id=$3) ORDER BY e.version DESC LIMIT 1`, [user, id, requested?.run_id ?? null])).rows[0] ?? null;
    // A report may be persisted before Word delivery fails. Default to the last successful
    // execution and, for revisions, its exact source report rather than an unrelated newer one.
    const chosen = requestedReport ?? (artifactRun?.operation === 'revision' ? artifactRun.source_report_id
      : reports.find(r => r.run_id === artifactRun?.run_id)?.report_id);
    const selected = requested ?? (chosen ? await readReviewReport(db(), user, id, chosen) : null);
    const active = (await db().query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND task_kind IN (\'review\',\'update\') AND NOT(state=ANY($3::text[])) ORDER BY created_at DESC LIMIT 1', [user, id, finalStates])).rows[0];
    return { project: projectDto(p), materials: materials.map(materialDto), draft: await draft(db(), user, id), message_drafts: await messageDrafts(db(), user, id), active_run: active ? runDto(active) : null,
      selected_report: selected?.report ?? null, reports, messages: (await db().query('SELECT * FROM bb_review_messages WHERE owner_user_id=$1 AND project_id=$2 ORDER BY created_at,id', [user, id])).rows.map(messageDto), plan: await latestPlan(db(), user, id), artifact_run: artifactRun, artifacts: artifactRun ? await artifacts(db(), user, id, artifactRun.run_id) : [] };
  });
  app.get('/api/v1/projects/:project_id/review-draft', async request => {
    const user = await owner(request), id = projectId(request); await requireReview(db(), user, id);
    return { draft: await draft(db(), user, id), message_drafts: await messageDrafts(db(), user, id) };
  });
  app.put('/api/v1/projects/:project_id/review-draft', { schema: { body: ReviewDraftRequestSchema } }, async request => {
    const user = await owner(request), id = projectId(request), b = request.body as ReviewDraftRequest;
    return transaction(db(), async client => {
      await requireReview(client, user, id, true);
      if (b.kind === 'input') {
        const previous = await draft(client, user, id);
        if (previous.version !== b.expected_version) stale();
        const rows = await pins(client, user, id, b.input.material_versions);
        for (const link of b.input.evidence_links ?? []) {
          if (!b.input.material_versions.some(pin => same(pin, link.material_ref))) invalid('Evidence attachment must remain in the selected input');
          await context(client, user, id, { project_id: id, report_id: link.report_id, finding_ids: [link.finding_id], material_refs: [link.material_ref] });
        }
        if (b.input.source_material_ref) {
          const source = b.input.source_material_ref;
          const material = rows.find(m => m.id === source.material_id && m.version === source.material_version && m.sha256.trim() === source.sha256);
          if (!material || !['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(material.media_type)) invalid('The reviewed source must be a selected DOCX or PDF');
        }
        if (b.input.as_of && (!Number.isFinite(Date.parse(b.input.as_of)) || new Date(b.input.as_of).toISOString().slice(0, 10) !== b.input.as_of)) invalid('Invalid review date');
        await client.query(`INSERT INTO bb_review_drafts(owner_user_id,project_id,version,input) VALUES($1,$2,$3,$4)
          ON CONFLICT(owner_user_id,project_id) DO UPDATE SET version=EXCLUDED.version,input=EXCLUDED.input,updated_at=now()`, [user, id, previous.version + 1, b.input]);
      } else {
        await context(client, user, id, b.context);
        const key = inputManifestHash(b.context);
        const previous = (await client.query('SELECT version FROM bb_review_message_drafts WHERE owner_user_id=$1 AND project_id=$2 AND context_hash=$3', [user, id, key])).rows[0];
        if ((previous?.version ?? 0) !== b.expected_version) stale();
        await client.query(`INSERT INTO bb_review_message_drafts(owner_user_id,project_id,context_hash,context,version,content) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(owner_user_id,project_id,context_hash) DO UPDATE SET version=EXCLUDED.version,content=EXCLUDED.content,updated_at=now()`, [user, id, key, b.context, b.expected_version + 1, b.content]);
      }
      await outbox(client, user, id, 'review.draft_saved', { kind: b.kind });
      return { draft: await draft(client, user, id), message_drafts: await messageDrafts(client, user, id) };
    });
  });
  app.post('/api/v1/projects/:project_id/review-messages', { schema: { body: ReviewMessageRequestSchema } }, async request => {
    const user = await owner(request), id = projectId(request), b = request.body as ReviewMessageRequest;
    return transaction(db(), async client => {
      const p = await requireReview(client, user, id, true);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`review-message:${user}:${b.submission_request_id}`]);
      const hash = inputManifestHash({ project_id: id, content: b.content, context: b.context });
      const prior = (await client.query('SELECT * FROM bb_review_messages WHERE owner_user_id=$1 AND submission_request_id=$2', [user, b.submission_request_id])).rows[0];
      if (prior) { if (prior.project_id !== id || prior.request_hash.trim() !== hash) throw conflict('IDEMPOTENCY_CONFLICT', 'Message key already used'); return { message: messageDto(prior) }; }
      await context(client, user, id, b.context);
      const report = b.context.report_id ? (await readReviewReport(client, user, id, b.context.report_id)).report : null;
      const snapshot = { version: 'review-assistant-context-v1', project: { issuer_name: p.issuer_name, market: p.market, offering: p.offering },
        input: await draft(client, user, id), report, report_sha256: report ? inputManifestHash(report) : null, material_refs: b.context.material_refs,
        prior_message_ids: (await client.query('SELECT id FROM bb_review_messages WHERE owner_user_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 200', [user, id])).rows.map(r => r.id).reverse() };
      const message = (await client.query(`INSERT INTO bb_review_messages(id,owner_user_id,project_id,submission_request_id,request_hash,role,content,context,reply_status,context_snapshot)
        VALUES($1,$2,$3,$4,$5,'user',$6,$7,'queued',$8) RETURNING *`, [uid(), user, id, b.submission_request_id, hash, b.content, b.context, snapshot])).rows[0];
      // Sending never mutates the input, accepted plan, selection or execution queue.
      await outbox(client, user, id, 'review.message_saved', { message_id: message.id });
      return { message: messageDto(message) };
    });
  });
  app.put('/api/v1/projects/:project_id/revision-plan', { schema: { body: ReviewPlanRequestSchema } }, async request => {
    const user = await owner(request), id = projectId(request), b = request.body as ReviewPlanRequest;
    return transaction(db(), async client => {
      await requireReview(client, user, id, true);
      const old = await latestPlan(client, user, id);
      if ((old?.version ?? 0) !== b.expected_version) stale();
      const report = (await readReviewReport(client, user, id, b.source_report_id)).report;
      if ([...b.finding_ids, ...b.excluded_findings.map(f => f.finding_id)].some(f => !report.findings.some(v => v.finding_id === f)) || b.excluded_findings.some(f => b.finding_ids.includes(f.finding_id))) invalid('Plan findings must belong to the report and cannot be selected and excluded together');
      if (b.proposal_id) {
        const proposed = (await client.query("SELECT proposal FROM bb_review_messages WHERE owner_user_id=$1 AND project_id=$2 AND role='assistant' AND proposal->>'proposal_id'=$3", [user, id, b.proposal_id])).rows[0]?.proposal;
        if (!proposed || proposed.source_report_id !== b.source_report_id || !same(proposed.finding_ids, b.finding_ids) || !same(proposed.requirements, b.requirements)) invalid('Accepted proposal does not match the saved assistant proposal');
      }
      const snapshot = { plan_id: old?.plan_id ?? uid(), version: b.expected_version + 1, source_report_id: b.source_report_id, finding_ids: b.finding_ids, excluded_findings: b.excluded_findings, requirements: b.requirements, accepted_at: new Date().toISOString() };
      const plan: ReviewPlan = { ...snapshot, sha256: inputManifestHash(snapshot) };
      await client.query('INSERT INTO bb_review_revision_plans(id,version,owner_user_id,project_id,content_sha256,accepted_at,plan) VALUES($1,$2,$3,$4,$5,$6,$7)', [plan.plan_id, plan.version, user, id, plan.sha256, plan.accepted_at, plan]);
      await outbox(client, user, id, 'review.plan_accepted', { plan_id: plan.plan_id, version: plan.version, source_report_id: plan.source_report_id });
      return plan;
    });
  });
  app.post('/api/v1/projects/:project_id/review-executions', { schema: { body: ReviewExecutionRequestSchema } }, async request => {
    const user = await owner(request), id = projectId(request), b = request.body as ReviewExecutionRequest;
    return transaction(db(), async client => {
      const p = await requireReview(client, user, id, true), requestHash = inputManifestHash({ project_id: id, ...b });
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${user}:${b.execution_request_id}`]);
      const key = executionKeyStorage(b.execution_request_id);
      const prior = (await client.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2', [user, key])).rows[0];
      if (prior) { if (prior.request_hash.trim() !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', 'Execution key already used'); return runDto(prior); }
      const active = await client.query('SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND NOT(state=ANY($3::text[])) LIMIT 1', [user, id, finalStates]);
      if (active.rowCount) throw conflict('INPUT_REVISION_CONFLICT', 'A project task is still active; stop it or wait before another execution');
      const current = await draft(client, user, id);
      if (current.version !== b.expected_input_version) stale();
      const { version: inputVersion, ...input } = current;
      if (!input.source_material_ref) invalid('Select the reviewed source before executing');
      const materialRows = await pins(client, user, id, input.material_versions);
      if (!input.material_versions.some((m: ReviewMaterialPin) => same(m, input.source_material_ref))) invalid('The source is absent from the input');
      const source = b.source_report_id ? await readReviewReport(client, user, id, b.source_report_id) : null;
      if (b.operation === 'full_review' && (b.source_report_id || b.finding_ids.length || b.expected_plan_version)) invalid('Full review must show the complete new scope');
      if (b.operation !== 'full_review' && (!source || !b.finding_ids.length)) invalid('Choose findings from the source report');
      if (b.operation === 'revision' && !same(source!.report.source_material, input.source_material_ref)) invalid('Revision must use the reviewed source version');
      if (source && b.finding_ids.some(f => !source.report.findings.some((v: ReviewReport['findings'][number]) => v.finding_id === f))) invalid('Selected findings are not in the source report');
      let plan: ReviewPlan | null = null, revision: ReviewRevisionPin | undefined;
      if (b.operation === 'revision') {
        plan = await latestPlan(client, user, id);
        if (!source || !plan || plan.version !== b.expected_plan_version || plan.source_report_id !== source.id || !same(plan.finding_ids, b.finding_ids)) throw conflict('INPUT_REVISION_CONFLICT', 'Accepted plan changed');
        const selected = source.report.findings.filter((f: ReviewReport['findings'][number]) => b.finding_ids.includes(f.finding_id));
        if (!selected.some(executableRevisionFinding)) invalid('The selection contains no change supported by sufficient evidence');
        for (const ref of selected.flatMap((f: ReviewReport['findings'][number]) => [...f.target_refs, ...f.evidence_refs])) {
          if (!input.material_versions.some((m: ReviewMaterialPin) => m.material_id === ref.material_id && m.material_version === ref.material_version && m.sha256 === ref.material_sha256)) invalid('Keep all selected finding evidence materials in the execution input');
        }
        revision = { version: 'review-revision-v1', owner_user_id: user, project_id: id,
          source_report: { report_id: source.id, run_id: source.run_id, version: source.version, input_revision: source.report.input_revision, sha256: source.content_sha256.trim() },
          source_material: source.report.source_material, accepted_plan: { plan_id: plan!.plan_id, version: plan!.version, sha256: plan!.sha256, accepted_at: plan!.accepted_at },
          selected_findings: selected, excluded_findings: plan!.excluded_findings, requirements: plan!.requirements, limitations: source.report.limitations };
        if (!isReviewRevisionPin(revision)) invalid('The revision plan has incompatible evidence or source anchors');
      } else if (b.expected_plan_version !== null) invalid('Review execution does not apply a revision plan');
      const version = Number((await client.query('SELECT COALESCE(max(version),0)+1 AS next FROM bb_review_executions WHERE owner_user_id=$1 AND project_id=$2', [user, id])).rows[0].next);
      const inputRevision = Number((await client.query('SELECT COALESCE(max(revision),0)+1 AS next FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2', [user, id])).rows[0].next);
      const runId = uid();
      const discussion = (await client.query('SELECT * FROM bb_review_messages WHERE owner_user_id=$1 AND project_id=$2 ORDER BY created_at,id', [user, id])).rows.map(messageDto);
      const review = { version: 'review_v1', operation: b.operation, report_id: uid(), version_number: version, draft_version: inputVersion, input, context_messages: discussion, source_report_id: b.source_report_id, finding_ids: b.finding_ids, source_report_sha256: source?.content_sha256.trim() ?? null };
      const manifest = { project_kind: 'review', draft_revision: p.draft_revision, issuer_name: p.issuer_name, market: p.market, offering: p.offering,
        update_details: { ...emptyUpdateDetails(), ...p.update_details, authoring_mode: 'unified_v1' },
        materials: materialRows.map(m => ({ material_id: m.id, material_version: m.version, sha256: m.sha256.trim(), role: m.role })), review,
        ...(revision ? { authoring: { version: 'unified_v1', source_prospectuses: [], requirements: [], knowledge: [], knowledge_status: 'authoring_reference_not_compliance_approval', review_revision: revision } } : {}) };
      const inputHash = inputManifestHash(manifest);
      await client.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,$2,$3,$4,$5,$6,$7,'[]')`, [id, inputRevision, user, p.draft_revision, inputHash, manifest, JSON.stringify(manifest.materials)]);
      await client.query('UPDATE bb_projects SET latest_input_revision=$3,updated_at=now() WHERE owner_user_id=$1 AND id=$2', [user, id, inputRevision]);
      const r = (await client.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued') RETURNING *`, [runId, user, id, inputRevision, inputHash, key, revision ? 'update' : 'review', requestHash])).rows[0];
      await client.query('INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,source_report_id,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)', [runId, user, id, version, b.operation, b.source_report_id, { input, input_version: inputVersion, finding_ids: b.finding_ids, plan, context_messages: discussion }]);
      await recordOperation(client, { owner: user, projectId: id, runId, requestId: request.id, traceId: runId, kind: 'execute', status: 'submitted', inputRevision, inputHash });
      await enqueue(client, r, RUN_PIPELINE_SUBTYPE);
      return runDto({ ...r, stage: 'queued', event_cursor: 1 });
    });
  });
  app.get('/api/v1/projects/:project_id/review-history', async request => {
    const user = await owner(request), id = projectId(request); await requireReview(db(), user, id);
    const rows = (await db().query(`SELECT r.*,e.operation,e.version,e.source_report_id,e.snapshot,p.id AS report_id
      FROM bb_review_executions e JOIN bb_runs r ON r.id=e.run_id AND r.owner_user_id=e.owner_user_id
      LEFT JOIN bb_review_reports p ON p.run_id=r.id AND p.owner_user_id=r.owner_user_id
      WHERE e.owner_user_id=$1 AND e.project_id=$2 ORDER BY e.version DESC`, [user, id])).rows;
    return { items: await Promise.all(rows.map(async r => ({ run: runDto(r), operation: r.operation, version: r.version, source_report_id: r.source_report_id, report_id: r.report_id ?? null, input: r.snapshot.input, input_revision: r.input_revision, finding_ids: r.snapshot.finding_ids, plan: r.snapshot.plan, context_messages: r.snapshot.context_messages ?? [], artifacts: await artifacts(db(), user, id, r.id), created_at: date(r.created_at) }))) };
  });
}
