import {shortageInt64} from '@bondbuddy/contracts';
import { artifactNameColumns, artifactNameJoins, artifactDownloadName } from './artifact-filename.js';
import { activePrice, creditBalanceExact, quoteDto, reserveCredits } from './billing.js';
import { billingSchemas, type BillingTask } from '@bondbuddy/contracts';
import { ReviewUpdateRequestSchema, type ReviewUpdateRequest, type ReviewResultPin } from '@bondbuddy/contracts';
import { loadAuthoringKnowledge } from './unified-authoring.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { Value } from '@sinclair/typebox/value';
import {
  ReviewDraftRequestSchema, ReviewMessageRequestSchema, ReviewPlanRequestSchema, ReviewExecutionRequestSchema,
  ReviewProposalAdoptionRequestSchema, ReviewReplyMetadataSchema, ReviewAcceptedProposalSchema, ReviewExecutionOriginSchema, isReviewProposalV2,
  executableRevisionFinding, isReviewReport, isReviewRevisionPin, emptyUpdateDetails, RUN_PIPELINE_SUBTYPE, REVIEW_ACTION_CODES,
  type ReviewContext, type ReviewDraftInput, type ReviewDraftRequest, type ReviewMessageRequest, type ReviewPlanRequest,
  type ReviewExecutionRequest, type ReviewPlan, type ReviewReport, type ReviewMaterialPin, type ReviewRevisionPin,
  type ReviewMessage, type ReviewReplyMetadata, type ReviewProposalAdoptionRequest, type ReviewAcceptedProposal,
  type ReviewExecutionOrigin, type ReviewReportRef, type ReviewTimelineEntry, type RunEvent,
} from '@bondbuddy/contracts';
import { project, projectDto, materialDto, runDto, transaction, uid, date, Problem, conflict, missing, executionKeyStorage, assertCanonicalBusinessRunIdle } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { enqueue } from './queue.js';
import { lockReviewFileDelivery } from './review-file-knowledge.js';
import { recordOperation } from './observability.js';
import { runEventPayloadDto } from './run-event-dto.js';
import { reviewNonEvidenceMaterialIds, withoutWorkflowMaterials } from './review-materials.js';
import {requestScope} from './scope-quotations.js';
import {outcomeMetadata} from './outcome-pricing.js';

type Db = Pool | PoolClient;
const finalStates = ['succeeded', 'test_completed', 'failed', 'cancelled', 'rejected'];
const emptyInput = (): ReviewDraftInput => ({ source_material_ref: null, material_versions: [], requirements: [], as_of: null });
const invalid = (message: string): never => { throw new Problem(422, 'VALIDATION_FAILED', message); };
const stale = (): never => { throw conflict('INPUT_REVISION_CONFLICT', 'The saved input, report or plan changed; reload before executing'); };
const same = (a: unknown, b: unknown) => inputManifestHash(a) === inputManifestHash(b);

async function requireReview(db: Db, user: string, id: string, lock = false) {
  const p = await project(db, user, id, lock);
  if (p.archived_at && lock) invalid('请先恢复已归档项目。');
  return p;
}
async function pins(db: Db, user: string, id: string, selected: ReviewMaterialPin[]) {
  if (new Set(selected.map(m => m.material_id)).size !== selected.length) invalid('A material can only be selected once');
  const excluded = await reviewNonEvidenceMaterialIds(db, user, id);
  if (selected.some(pin => excluded.has(pin.material_id))) invalid('问题清单、底稿目录、生成模板等任务材料不能作为复核核验材料，请刷新材料列表后重试。');
  const rows = [];
  for (const pin of selected) {
    const m = (await db.query('SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL AND NOT internal_template', [user, id, pin.material_id, pin.material_version])).rows[0];
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
export async function draft(db: Db, user: string, id: string) {
  const r = (await db.query('SELECT version,input FROM bb_review_drafts WHERE owner_user_id=$1 AND project_id=$2', [user, id])).rows[0];
  return withoutWorkflowMaterials(r ? { ...r.input, version: r.version } : { ...emptyInput(), version: 0 }, await reviewNonEvidenceMaterialIds(db, user, id));
}
async function messageDrafts(db: Db, user: string, id: string) {
  return (await db.query('SELECT context,content,version,updated_at FROM bb_review_message_drafts WHERE owner_user_id=$1 AND project_id=$2 ORDER BY updated_at', [user, id])).rows.map(r => ({ ...r, updated_at: date(r.updated_at) }));
}
async function latestPlan(db: Db, user: string, id: string): Promise<ReviewPlan | null> {
  return (await db.query('SELECT plan FROM bb_review_revision_plans WHERE owner_user_id=$1 AND project_id=$2 ORDER BY version DESC LIMIT 1', [user, id])).rows[0]?.plan ?? null;
}
/** Only validated immutable report citations can become navigation targets. */
export function reviewReplyMetadataDto(r: { reply_metadata?: unknown; context?: ReviewContext; context_snapshot?: any }): ReviewReplyMetadata | null {
  if (!Value.Check(ReviewReplyMetadataSchema, r.reply_metadata)) return null;
  const metadata = r.reply_metadata, report = r.context_snapshot?.report;
  if (!metadata.context_report_ref) return !metadata.cited_finding_ids.length && !r.context?.report_id ? metadata : null;
  if (!isReviewReport(report) || report.project_id !== r.context?.project_id || report.report_id !== r.context?.report_id
    || metadata.context_report_ref.report_id !== report.report_id
    || metadata.context_report_ref.sha256 !== inputManifestHash(report)
    || r.context_snapshot?.report_sha256 !== metadata.context_report_ref.sha256
    || metadata.cited_finding_ids.some(id => !report.findings.some(finding => finding.finding_id === id))) return null;
  return metadata;
}
const messageDto = (r: any): ReviewMessage => ({ message_id: r.id, role: r.role, content: r.content, context: r.context, created_at: date(r.created_at), reply_status: r.reply_status, reply_to: r.reply_to, proposal: r.proposal, error: r.error, reply_metadata: reviewReplyMetadataDto(r) });
async function artifacts(db: Db, user: string, id: string, runId: string) {
  return (await db.query(`SELECT a.artifact_id,a.artifact_version,a.kind,v.media_type,${artifactNameColumns('v')} FROM bb_review_artifacts a
    JOIN bb_artifact_versions v ON v.id=a.artifact_id AND v.version=a.artifact_version AND v.owner_user_id=a.owner_user_id
    JOIN bb_runs r ON r.id=a.run_id AND r.owner_user_id=a.owner_user_id ${artifactNameJoins('v')}
    WHERE a.owner_user_id=$1 AND a.project_id=$2 AND a.run_id=$3 AND v.quality_status='passed' AND v.delivery_status='available' ORDER BY a.kind`, [user, id, runId])).rows.map(a=>({artifact_id:a.artifact_id,artifact_version:a.artifact_version,kind:a.kind,filename:artifactDownloadName(a).filename}));
}
async function outbox(db: Db, user: string, id: string, event: string, payload: unknown) {
  await db.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'review_project',$3,$4,$5)", [uid(), user, id, event, payload]);
}
const legacyOrigin = (): ReviewExecutionOrigin => ({ version: 'review-execution-origin-v1', entrypoint: 'legacy_unrecorded', accepted_proposal: null, context_report_ref: null });
/** Apply the public whitelist at every nested origin level, not only run events. */
export function reviewExecutionOriginDto(value: unknown): ReviewExecutionOrigin {
  if (!value || typeof value !== 'object') return legacyOrigin();
  const clean = Value.Clean(ReviewExecutionOriginSchema, structuredClone(value));
  if (!Value.Check(ReviewExecutionOriginSchema, clean)
    || clean.accepted_proposal && !isReviewProposalV2(clean.accepted_proposal.proposal)) return legacyOrigin();
  return clean;
}
const acceptedProposalDto = (value: unknown): ReviewAcceptedProposal | null => {
  const clean = Value.Clean(ReviewAcceptedProposalSchema, structuredClone(value));
  return Value.Check(ReviewAcceptedProposalSchema, clean) && isReviewProposalV2(clean.proposal) ? clean : null;
};
async function reportRef(db: Db, user: string, id: string, ref: ReviewReportRef | null) {
  if (!ref) return;
  const row = await readReviewReport(db, user, id, ref.report_id);
  if (row.content_sha256.trim() !== ref.sha256) stale();
}
async function executionRows(db: Db, user: string, id: string) {
  return (await db.query(`SELECT r.*,e.operation,e.version,e.source_report_id,e.snapshot,p.id AS report_id
    FROM bb_review_executions e JOIN bb_runs r ON r.id=e.run_id AND r.owner_user_id=e.owner_user_id AND r.project_id=e.project_id
    LEFT JOIN bb_review_reports p ON p.run_id=r.id AND p.owner_user_id=r.owner_user_id AND p.project_id=r.project_id
    WHERE e.owner_user_id=$1 AND e.project_id=$2 ORDER BY e.version DESC`, [user, id])).rows;
}
async function reportCatalogVersion(db: Db, user: string, id: string): Promise<number> {
  return Number((await db.query('SELECT COALESCE(max(version),0) AS version FROM bb_review_reports WHERE owner_user_id=$1 AND project_id=$2', [user, id])).rows[0].version);
}
async function timeline(db: Db, user: string, id: string, messages: ReviewMessage[]): Promise<ReviewTimelineEntry[]> {
  const rows = await executionRows(db, user, id);
  // Snapshot state is authoritative. Event sequence only supplies durable progress history.
  // Keep a bounded recent stream and one genuine completion per action category. Long
  // tool-reading sequences must not erase early financial/compliance work from the card.
  const eventRows = (await db.query(`WITH scoped AS (
    SELECT ev.*,row_number() OVER(PARTITION BY ev.run_id ORDER BY ev.seq DESC) AS position
    FROM bb_run_events ev JOIN bb_runs r ON r.id=ev.run_id AND r.owner_user_id=ev.owner_user_id
    WHERE ev.owner_user_id=$1 AND r.project_id=$2
  ), completed AS (
    SELECT DISTINCT ON(run_id,payload #>> '{action,code}') id FROM scoped
    WHERE type='run.progress' AND payload #>> '{action,version}'='review-action-v1'
      AND payload #>> '{action,state}'='completed' AND payload #>> '{action,code}'=ANY($3::text[])
      AND payload #>> '{action,action_id}' ~ '^[a-f0-9]{64}$'
      AND payload->'action'=jsonb_build_object('version',payload #>> '{action,version}',
        'action_id',payload #>> '{action,action_id}','code',payload #>> '{action,code}','state','completed')
    ORDER BY run_id,payload #>> '{action,code}',seq DESC
  ) SELECT scoped.* FROM scoped WHERE position<=60 OR id IN(SELECT id FROM completed)
    ORDER BY run_id,seq`, [user, id, REVIEW_ACTION_CODES])).rows;
  const times = (await db.query(`SELECT ev.run_id,min(ev.occurred_at) FILTER(WHERE ev.state='running') AS started_at,
    max(ev.occurred_at) FILTER(WHERE ev.state=ANY($3::text[])) AS completed_at
    FROM bb_run_events ev JOIN bb_runs r ON r.id=ev.run_id AND r.owner_user_id=ev.owner_user_id
    WHERE ev.owner_user_id=$1 AND r.project_id=$2 GROUP BY ev.run_id`, [user, id, finalStates])).rows;
  const runTimes = new Map(times.map(time => [time.run_id, time]));
  const tasks: ReviewTimelineEntry[] = await Promise.all(rows.map(async row => ({ kind: 'task' as const,
    entry_id: `task:${row.id}`, created_at: date(row.created_at), task: { run: runDto(row), operation: row.operation, export_only: row.snapshot.export_only === true,
      version: row.version, input_version: row.snapshot.input_version, input_revision: row.input_revision,
      input_sha256: inputManifestHash(row.snapshot.input), source_report_id: row.source_report_id,
      report_id: row.report_id ?? null, finding_ids: row.snapshot.finding_ids, origin: reviewExecutionOriginDto(row.snapshot.origin),
      started_at: runTimes.get(row.id)?.started_at ? date(runTimes.get(row.id)!.started_at) : null,
      completed_at: finalStates.includes(row.state) && runTimes.get(row.id)?.completed_at ? date(runTimes.get(row.id)!.completed_at) : null,
      artifacts: await artifacts(db, user, id, row.id), events: eventRows.filter(event => event.run_id === row.id).map(event => ({
        event_id: event.id, schema_version: 1 as const, trace_id: event.trace_id, run_id: row.id, seq: event.seq,
        occurred_at: date(event.occurred_at), type: event.type, state: event.state,
        stage: typeof event.stage === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(event.stage) ? event.stage : null,
        payload: runEventPayloadDto(event.payload),
      } as RunEvent)) } } )));
  return [...messages.map(message => ({ kind: 'message' as const, entry_id: `message:${message.message_id}`, created_at: message.created_at, message })), ...tasks]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.entry_id.localeCompare(b.entry_id));
}

export function registerReviewRoutes(app: FastifyInstance, db: () => Pool, owner: (request: FastifyRequest) => Promise<string>, paidReview = false, commercial=false) {
  const projectId = (request: FastifyRequest) => (request.params as { project_id: string }).project_id;
  app.get('/api/v1/projects/:project_id/review-workspace', async request => {
    const user = await owner(request), id = projectId(request), p = await requireReview(db(), user, id);
    const excluded = await reviewNonEvidenceMaterialIds(db(), user, id);
    const materials = (await db().query(`SELECT DISTINCT ON(id) * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND deleted_at IS NULL AND NOT internal_template ORDER BY id,version DESC`, [user, id])).rows.filter(m => !excluded.has(m.id));
    const reports = (await db().query('SELECT id AS report_id,version,run_id,created_at FROM bb_review_reports WHERE owner_user_id=$1 AND project_id=$2 ORDER BY version DESC', [user, id])).rows.map(r => ({ ...r, created_at: date(r.created_at) }));
    const requestedReport = (request.query as { report_id?: string }).report_id;
    const requested = requestedReport ? await readReviewReport(db(), user, id, requestedReport) : null;
    const artifactRun = (await db().query(`SELECT e.run_id,e.version,e.operation,e.source_report_id,e.snapshot->>'source_run_id' AS source_run_id FROM bb_review_executions e
      JOIN bb_runs r ON r.id=e.run_id AND r.owner_user_id=e.owner_user_id AND r.project_id=e.project_id
      WHERE e.owner_user_id=$1 AND e.project_id=$2 AND r.state IN ('succeeded','test_completed')
      AND ($3::text IS NULL OR e.run_id=$3) ORDER BY e.version DESC LIMIT 1`, [user, id, requested?.run_id ?? null])).rows[0] ?? null;
    // A report may be persisted before Word delivery fails. Default to the last successful
    // execution and, for revisions, its exact source report rather than an unrelated newer one.
    const chosen = requestedReport ?? (artifactRun?.operation === 'revision' ? artifactRun.source_report_id
      : reports.find(r => r.run_id === artifactRun?.run_id)?.report_id);
    const selected = requested ?? (chosen ? await readReviewReport(db(), user, id, chosen) : null);
    // A shared project can be updating while review is still only a draft.
    // The execution mutex remains cross-task; progress here belongs to review only.
    const active = (await db().query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND task_kind=\'review\' AND NOT(state=ANY($3::text[])) ORDER BY created_at DESC LIMIT 1', [user, id, finalStates])).rows[0];
    const messages = (await db().query('SELECT * FROM bb_review_messages WHERE owner_user_id=$1 AND project_id=$2 ORDER BY created_at,id', [user, id])).rows.map(messageDto);
    const accepted = (await db().query('SELECT acceptance FROM bb_review_proposal_adoptions WHERE owner_user_id=$1 AND project_id=$2 ORDER BY created_at,id', [user, id])).rows.map(row => acceptedProposalDto(row.acceptance)).filter(value => value !== null);
    return { project: projectDto(p), materials: materials.map(materialDto), draft: await draft(db(), user, id), message_drafts: await messageDrafts(db(), user, id), active_run: active ? runDto(active) : null,
      selected_report: selected?.report ?? null, reports, messages, timeline: await timeline(db(), user, id, messages), accepted_proposals: accepted,
      plan: await latestPlan(db(), user, id), artifact_run: artifactRun, artifacts: artifactRun ? await artifacts(db(), user, id, artifactRun.run_id) : [] };
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
      const snapshot = { version: 'review-assistant-context-v2', reply_schema_version: 'review-assistant-reply-v2', project: { issuer_name: p.issuer_name, market: p.market, offering: p.offering },
        input: await draft(client, user, id), report, report_sha256: report ? inputManifestHash(report) : null, material_refs: b.context.material_refs,
        report_catalog_version: await reportCatalogVersion(client, user, id),
        prior_message_ids: (await client.query('SELECT id FROM bb_review_messages WHERE owner_user_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 200', [user, id])).rows.map(r => r.id).reverse() };
      const message = (await client.query(`INSERT INTO bb_review_messages(id,owner_user_id,project_id,submission_request_id,request_hash,role,content,context,reply_status,context_snapshot)
        VALUES($1,$2,$3,$4,$5,'user',$6,$7,'queued',$8) RETURNING *`, [uid(), user, id, b.submission_request_id, hash, b.content, b.context, snapshot])).rows[0];
      // Sending never mutates the input, accepted plan, selection or execution queue.
      await outbox(client, user, id, 'review.message_saved', { message_id: message.id });
      return { message: messageDto(message) };
    });
  });
  app.post('/api/v1/projects/:project_id/review-proposal-adoptions', { schema: { body: ReviewProposalAdoptionRequestSchema } }, async request => {
    const user = await owner(request), id = projectId(request), b = request.body as ReviewProposalAdoptionRequest;
    return transaction(db(), async client => {
      await requireReview(client, user, id, true);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`review-adoption:${user}:${b.adoption_request_id}`]);
      const requestHash = inputManifestHash({ project_id: id, ...b });
      const prior = (await client.query('SELECT * FROM bb_review_proposal_adoptions WHERE owner_user_id=$1 AND adoption_request_id=$2', [user, b.adoption_request_id])).rows[0];
      if (prior) {
        if (prior.project_id !== id || prior.request_sha256.trim() !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', 'Adoption key already used');
        return { accepted_proposal: prior.acceptance, draft: { ...prior.input, version: prior.acceptance.input_version }, plan: prior.plan ?? null };
      }
      const row = (await client.query(`SELECT proposal,context,context_snapshot FROM bb_review_messages
        WHERE owner_user_id=$1 AND project_id=$2 AND role='assistant' AND reply_status='completed' AND proposal->>'proposal_id'=$3`, [user, id, b.proposal_id])).rows[0];
      const proposed: unknown = row?.proposal;
      if (!isReviewProposalV2(proposed) || proposed.project_id !== id) invalid('A current typed proposal from this project is required');
      const proposal = proposed as import('@bondbuddy/contracts').ReviewProposalV2;
      const current = await draft(client, user, id), { version: inputVersion, ...input } = current;
      if (inputVersion !== b.expected_input_version || proposal.input_version !== inputVersion || proposal.input_sha256 !== inputManifestHash(input)
        || !same(proposal.material_versions, input.material_versions) || !same(proposal.source_material_ref, input.source_material_ref)) stale();
      // The model cannot author execution pins. They must equal the API's immutable send-time context.
      const snapshot = row.context_snapshot, capturedInput = snapshot?.input;
      if (snapshot?.version !== 'review-assistant-context-v2' || snapshot.reply_schema_version !== 'review-assistant-reply-v2' || !capturedInput) invalid('Proposal context version is unavailable');
      const { version: capturedVersion, ...captured } = capturedInput;
      if (capturedVersion !== proposal.input_version || inputManifestHash(captured) !== proposal.input_sha256
        || row.context.project_id !== id || (proposal.context_report_ref?.report_id ?? null) !== row.context.report_id
        || (proposal.context_report_ref?.sha256 ?? null) !== snapshot.report_sha256) invalid('Proposal pins do not match its original discussion');
      const catalogVersion = await reportCatalogVersion(client, user, id);
      if (snapshot.report_catalog_version !== catalogVersion) stale();
      await pins(client, user, id, proposal.material_versions);
      await reportRef(client, user, id, proposal.context_report_ref);
      const source = proposal.source_report_id ? await readReviewReport(client, user, id, proposal.source_report_id) : null;
      if (source && source.content_sha256.trim() !== proposal.source_report_sha256) stale();
      if (proposal.operation === 'full_review' && (b.finding_ids.length || b.excluded_findings.length)) invalid('Complete review cannot be narrowed to finding context');
      if (proposal.operation !== 'full_review' && !b.finding_ids.length) invalid('An explicitly selected review scope is required');
      const allIds = [...b.finding_ids, ...b.excluded_findings.map(item => item.finding_id)];
      if (new Set(b.excluded_findings.map(item => item.finding_id)).size !== b.excluded_findings.length
        || b.excluded_findings.some(item => b.finding_ids.includes(item.finding_id))
        || source && allIds.some(finding => !source.report.findings.some(item => item.finding_id === finding))) invalid('Adopted findings and exclusions must belong to the pinned report');
      const nextInput: ReviewDraftInput = { ...input, requirements: [...new Set([...input.requirements, ...b.requirements])] };
      if (nextInput.requirements.length > 100) invalid('Too many adopted requirements');
      const acceptance: ReviewAcceptedProposal = { acceptance_id: uid(), proposal, proposal_sha256: inputManifestHash(proposal),
        adoption: same([...new Set([...proposal.finding_ids, ...proposal.related_finding_ids])].sort(), [...b.finding_ids].sort())
          && same(proposal.requirements, b.requirements) && same(proposal.excluded_findings, b.excluded_findings) ? 'as_proposed' : 'user_adjusted',
        accepted_at: new Date().toISOString(), input_version: inputVersion + 1, input_sha256: inputManifestHash(nextInput), report_catalog_version: catalogVersion,
        finding_ids: b.finding_ids, excluded_findings: b.excluded_findings, requirements: b.requirements };
      let plan: ReviewPlan | null = null;
      if (proposal.operation === 'revision') {
        if (!source || !source.report.findings.filter(finding => b.finding_ids.includes(finding.finding_id)).some(executableRevisionFinding)) invalid('No supported modification target was selected');
        const previous = await latestPlan(client, user, id);
        const content = { plan_id: previous?.plan_id ?? uid(), version: (previous?.version ?? 0) + 1, source_report_id: source!.id,
          finding_ids: b.finding_ids, excluded_findings: b.excluded_findings, requirements: nextInput.requirements, accepted_at: acceptance.accepted_at,
          proposal_origin: { proposal, sha256: acceptance.proposal_sha256, adoption: acceptance.adoption } };
        plan = { ...content, sha256: inputManifestHash(content) };
        await client.query('INSERT INTO bb_review_revision_plans(id,version,owner_user_id,project_id,content_sha256,accepted_at,plan) VALUES($1,$2,$3,$4,$5,$6,$7)', [plan.plan_id, plan.version, user, id, plan.sha256, plan.accepted_at, plan]);
      }
      await client.query(`INSERT INTO bb_review_drafts(owner_user_id,project_id,version,input) VALUES($1,$2,$3,$4)
        ON CONFLICT(owner_user_id,project_id) DO UPDATE SET version=EXCLUDED.version,input=EXCLUDED.input,updated_at=now()`, [user, id, acceptance.input_version, nextInput]);
      await client.query(`INSERT INTO bb_review_proposal_adoptions(id,owner_user_id,project_id,adoption_request_id,request_sha256,content_sha256,acceptance,input,plan)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [acceptance.acceptance_id, user, id, b.adoption_request_id, requestHash, inputManifestHash(acceptance), acceptance, nextInput, plan]);
      await outbox(client, user, id, 'review.proposal_adopted', { acceptance_id: acceptance.acceptance_id, proposal_id: proposal.proposal_id, input_version: acceptance.input_version });
      // Adoption changes the next input only. It never creates a bb_runs or model call.
      return { accepted_proposal: acceptance, draft: { ...nextInput, version: acceptance.input_version }, plan };
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
      let proposalOrigin: ReviewPlan['proposal_origin'];
      if (b.proposal_id) {
        const proposed = (await client.query("SELECT proposal FROM bb_review_messages WHERE owner_user_id=$1 AND project_id=$2 AND role='assistant' AND proposal->>'proposal_id'=$3", [user, id, b.proposal_id])).rows[0]?.proposal;
        if (!proposed || proposed.source_report_id !== b.source_report_id) invalid('Proposal does not belong to the source report');
        if (isReviewProposalV2(proposed)) invalid('Typed proposals must be explicitly adopted with their pinned execution input');
        // The proposal is provenance; the user's explicitly confirmed selection is the plan.
        proposalOrigin = { proposal: proposed, sha256: inputManifestHash(proposed),
          adoption: same([...proposed.finding_ids].sort(), [...b.finding_ids].sort()) && same(proposed.requirements, b.requirements) ? 'as_proposed' : 'user_adjusted' };
      }
      const snapshot = { plan_id: old?.plan_id ?? uid(), version: b.expected_version + 1, source_report_id: b.source_report_id, finding_ids: b.finding_ids, excluded_findings: b.excluded_findings, requirements: b.requirements, accepted_at: new Date().toISOString(), ...(proposalOrigin ? { proposal_origin: proposalOrigin } : {}) };
      const plan: ReviewPlan = { ...snapshot, sha256: inputManifestHash(snapshot) };
      await client.query('INSERT INTO bb_review_revision_plans(id,version,owner_user_id,project_id,content_sha256,accepted_at,plan) VALUES($1,$2,$3,$4,$5,$6,$7)', [plan.plan_id, plan.version, user, id, plan.sha256, plan.accepted_at, plan]);
      await outbox(client, user, id, 'review.plan_accepted', { plan_id: plan.plan_id, version: plan.version, source_report_id: plan.source_report_id });
      return plan;
    });
  });
  // A quote locks the user's execution intent before the run's immutable manifest exists.
  const intentHash = async (client: PoolClient, user: string, id: string, p: any, b: ReviewExecutionRequest | ReviewUpdateRequest) => {
    const {quote_id, ...intent}=b;
    return inputManifestHash({project_id:id, draft_revision:p.draft_revision, intent,
      ...('operation' in b ? {review_draft:await draft(client,user,id)} : {})});
  };
  for (const kind of ['review-executions','review-updates'] as const) {
    app.post(`/api/v1/projects/:project_id/${kind}/quote`, {schema:{body:kind==='review-executions'?ReviewExecutionRequestSchema:ReviewUpdateRequestSchema,response:{200:billingSchemas.FixedQuoteResponse}}}, async request => {
      const user=await owner(request),id=projectId(request),b=request.body as ReviewExecutionRequest | ReviewUpdateRequest;
      return transaction(db(),async client=>{
        const p=await requireReview(client,user,id,true),balance=await creditBalanceExact(client,user);
        if(!paidReview)return {enabled:false,quote:null,balance,shortage:0,reason:null};
        if('operation' in b){const d=await draft(client,user,id);if(d.version!==b.expected_input_version)stale();if(!d.source_material_ref)invalid('Select the reviewed source');await pins(client,user,id,d.material_versions);}
        else {const source=(await client.query("SELECT 1 FROM bb_runs r JOIN bb_review_executions e ON e.run_id=r.id WHERE r.id=$1 AND r.owner_user_id=$2 AND r.project_id=$3 AND r.state='succeeded' AND e.operation IN ('full_review','differential_review')",[b.source_run_id,user,id])).rowCount;if(!source)throw missing();}
        const task:BillingTask='operation' in b?(b.operation==='revision'?'review_revision':b.operation):'review_revision';
        const hash=await intentHash(client,user,id,p,b);
        const {quote_id:_quote,...scopeRequest}=b;
        const price=await activePrice(client,commercial),scope=commercial?await requestScope(client,user,id,'review',hash,{task,request:scopeRequest,...('operation' in b?{review_draft:await draft(client,user,id)}:{})}):null;
        if(scope&&scope.quote_status!=='ready')return {enabled:true,quote:{quote_id:scope.scope_quote_id,project_id:id,input_revision:p.draft_revision,input_hash:hash,task_type:task,points:0,
          reason:'本次复核范围待核实；核定覆盖范围及所需成果后，才能确认费用并执行。',created_at:new Date().toISOString(),...outcomeMetadata(0),...scope},balance,shortage:0,reason:'本次范围待核实，尚未形成可执行报价。'};
        const points=scope?.amount_fen??price.prices[task];
        if(!Number.isSafeInteger(points)||points<0||points===0&&!scope)throw new Problem(503,'BILLING_NOT_READY','该任务的价格尚未核定。');
        const priceVersion=scope?.price_version??price.id;
        const row=(await client.query(`INSERT INTO bb_credit_quotes(id,owner_user_id,project_id,input_revision,input_hash,price_version,task_type,points,reason,intent_hash,pricing_mode,scope_quote_id,scope_lines)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$5,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING *`,[uid(),user,id,p.draft_revision,hash,priceVersion,task,points,commercial?'按本次已核实的复核范围明细锁定人民币总价；交付后结算，失败或取消释放。':'按本次已确认的任务范围收取固定积分；系统重试不重复收费。',commercial?'outcome_cny_v1':'legacy_credit',scope?.scope_quote_id??null,JSON.stringify(scope?.scope_lines??[])])).rows[0]
          ??(await client.query('SELECT * FROM bb_credit_quotes WHERE owner_user_id=$1 AND project_id=$2 AND intent_hash=$3 AND price_version=$4 AND scope_quote_id IS NOT DISTINCT FROM $5::text',[user,id,hash,priceVersion,scope?.scope_quote_id??null])).rows[0];
        return {enabled:true,quote:quoteDto({...row,...scope}),balance,shortage:shortageInt64(points,balance.available),reason:null};
      });
    });
  }
  app.post('/api/v1/projects/:project_id/review-executions', { schema: { body: ReviewExecutionRequestSchema } }, async request => {
    const user = await owner(request), id = projectId(request), b = request.body as ReviewExecutionRequest;
    return transaction(db(), async client => {
      const p = await requireReview(client, user, id, true), requestHash = inputManifestHash({ project_id: id, ...b });
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${user}:${b.execution_request_id}`]);
      const key = executionKeyStorage(b.execution_request_id);
      const prior = (await client.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2', [user, key])).rows[0];
      if (prior) { if (prior.request_hash.trim() !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', 'Execution key already used'); return runDto(prior); }
      await assertCanonicalBusinessRunIdle(client,user,p);
      const active = await client.query('SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND NOT(state=ANY($3::text[])) LIMIT 1', [user, id, finalStates]);
      if (active.rowCount) throw conflict('INPUT_REVISION_CONFLICT', 'A project task is still active; stop it or wait before another execution');
      const current = await draft(client, user, id);
      if (current.version !== b.expected_input_version) stale();
      const { version: inputVersion, ...input } = current;
      if (!input.source_material_ref) invalid('Select the reviewed source before executing');
      const materialRows = await pins(client, user, id, input.material_versions);
      if (!input.material_versions.some((m: ReviewMaterialPin) => same(m, input.source_material_ref))) invalid('The source is absent from the input');
      const source = b.source_report_id ? await readReviewReport(client, user, id, b.source_report_id) : null;
      let accepted: ReviewAcceptedProposal | null = null;
      if (b.accepted_proposal_id) {
        const adopted = (await client.query('SELECT acceptance,content_sha256 FROM bb_review_proposal_adoptions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3', [user, id, b.accepted_proposal_id])).rows[0];
        if (!adopted) throw missing();
        accepted = adopted.acceptance as ReviewAcceptedProposal;
        if (!Value.Check(ReviewAcceptedProposalSchema, accepted) || inputManifestHash(accepted) !== adopted.content_sha256.trim() || !isReviewProposalV2(accepted.proposal)
          || accepted.proposal_sha256 !== inputManifestHash(accepted.proposal) || accepted.proposal.project_id !== id) throw new Problem(503, 'DATA_UNAVAILABLE', 'Accepted proposal snapshot is invalid');
        if (accepted.input_version !== inputVersion || accepted.input_sha256 !== inputManifestHash(input)
          || accepted.proposal.operation !== b.operation || accepted.proposal.source_report_id !== b.source_report_id
          || !same([...accepted.finding_ids].sort(), [...b.finding_ids].sort())
          || accepted.report_catalog_version !== await reportCatalogVersion(client, user, id)
          || (source?.content_sha256.trim() ?? null) !== accepted.proposal.source_report_sha256) stale();
        if (b.entrypoint === 'quick_action') invalid('Accepted assistant proposal requires the assistant entrypoint');
      } else if (b.entrypoint === 'assistant_proposal') invalid('Explicit proposal adoption is required before assistant execution');
      const contextReportRef = b.context_report_ref ?? accepted?.proposal.context_report_ref ?? null;
      if (accepted && b.context_report_ref !== undefined && !same(b.context_report_ref, accepted.proposal.context_report_ref)) stale();
      await reportRef(client, user, id, contextReportRef);
      const origin: ReviewExecutionOrigin = { version: 'review-execution-origin-v1', entrypoint: accepted ? 'assistant_proposal' : 'quick_action', accepted_proposal: accepted, context_report_ref: contextReportRef };
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
      const review = { version: 'review_v1', ...(revision ? {} : { file_delivery: await lockReviewFileDelivery(p) }), operation: b.operation, report_id: uid(), version_number: version, draft_version: inputVersion, input, origin, context_messages: discussion, source_report_id: b.source_report_id, finding_ids: b.finding_ids, source_report_sha256: source?.content_sha256.trim() ?? null };
      const manifest = { project_kind: 'review', name:p.name, draft_revision: p.draft_revision, issuer_name: p.issuer_name, market: p.market, offering: p.offering,
        update_details: { ...emptyUpdateDetails(), ...p.update_details, authoring_mode: 'unified_v1' },
        materials: materialRows.map(m => ({ material_id: m.id, material_version: m.version, sha256: m.sha256.trim(), role: m.role })), review,
        ...(revision ? { authoring: { version: 'unified_v1', source_prospectuses: [], requirements: [], knowledge: [], knowledge_status: 'authoring_reference_not_compliance_approval', review_revision: revision } } : {}) };
      const inputHash = inputManifestHash(manifest);
      await client.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,$2,$3,$4,$5,$6,$7,'[]')`, [id, inputRevision, user, p.draft_revision, inputHash, manifest, JSON.stringify(manifest.materials)]);
      await client.query('UPDATE bb_projects SET latest_input_revision=$3,updated_at=now() WHERE owner_user_id=$1 AND id=$2', [user, id, inputRevision]);
      const r = (await client.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued') RETURNING *`, [runId, user, id, inputRevision, inputHash, key, revision ? 'update' : 'review', requestHash])).rows[0];
      await client.query('INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,source_report_id,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)', [runId, user, id, version, b.operation, b.source_report_id, { input, input_version: inputVersion, finding_ids: b.finding_ids, plan, origin, context_messages: discussion }]);
      if(paidReview)await reserveCredits(client,user,r,b.quote_id,null,p,await intentHash(client,user,id,p,b),commercial);
      await recordOperation(client, { owner: user, projectId: id, runId, requestId: request.id, traceId: runId, kind: 'execute', status: 'submitted', inputRevision, inputHash });
      await enqueue(client, r, RUN_PIPELINE_SUBTYPE);
      return runDto({ ...r, stage: 'queued', event_cursor: 1 });
    });
  });
  // File-result revision reuses the reviewed inputs and the existing update worker.
  app.post('/api/v1/projects/:project_id/review-updates', {schema:{body:ReviewUpdateRequestSchema}}, async request => {
    const user=await owner(request),id=projectId(request),b=request.body as ReviewUpdateRequest;
    return transaction(db(),async client=>{
      const p=await requireReview(client,user,id,true),requestHash=inputManifestHash({project_id:id,review_update:b});
      const key=executionKeyStorage(b.execution_request_id);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${user}:${b.execution_request_id}`]);
      const prior=(await client.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[user,key])).rows[0];
      if(prior){if(prior.request_hash.trim()!==requestHash)throw conflict('IDEMPOTENCY_CONFLICT','Execution key already used');return runDto(prior);}
      await assertCanonicalBusinessRunIdle(client,user,p);
      if((await client.query('SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND NOT(state=ANY($3::text[])) LIMIT 1',[user,id,finalStates])).rowCount)throw conflict('INPUT_REVISION_CONFLICT','A project task is still active');
      const source=(await client.query(`SELECT r.input_revision,r.input_hash,e.snapshot,e.source_report_id,i.manifest,a.artifact_id,a.artifact_version,v.sha256
        FROM bb_runs r JOIN bb_review_executions e ON e.run_id=r.id AND e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id
        JOIN bb_input_revisions i ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id AND i.revision=r.input_revision
        JOIN bb_review_artifacts a ON a.run_id=r.id AND a.owner_user_id=r.owner_user_id AND a.project_id=r.project_id AND a.kind='report'
        JOIN bb_artifact_versions v ON v.id=a.artifact_id AND v.version=a.artifact_version AND v.owner_user_id=a.owner_user_id AND v.run_id=r.id
        WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.id=$3 AND r.state='succeeded' AND r.channel='production'
        AND e.operation IN ('full_review','differential_review') AND v.quality_status='passed' AND v.delivery_status='available'`,[user,id,b.source_run_id])).rows[0];
      if(!source)throw missing();
      const original=source.snapshot.input as ReviewDraftInput;
      if(!original?.source_material_ref||inputManifestHash(source.manifest)!==source.input_hash.trim())throw conflict('INPUT_REVISION_CONFLICT','Review input is unavailable');
      const materialRows=await pins(client,user,id,original.material_versions);
      if(!original.material_versions.some(m=>same(m,original.source_material_ref)))invalid('Reviewed source is absent');
      const pin:ReviewResultPin={version:'review-result-v1',run_id:b.source_run_id,input_revision:source.input_revision,input_hash:source.input_hash.trim(),artifact_id:source.artifact_id,artifact_version:source.artifact_version,sha256:source.sha256.trim(),source_material:original.source_material_ref,requirements:b.requirements.trim()};
      const version=Number((await client.query('SELECT COALESCE(max(version),0)+1 next FROM bb_review_executions WHERE owner_user_id=$1 AND project_id=$2',[user,id])).rows[0].next);
      const revision=Number((await client.query('SELECT COALESCE(max(revision),0)+1 next FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2',[user,id])).rows[0].next);
      const sourceProject={issuer_name:source.manifest.issuer_name,market:source.manifest.market,offering:source.manifest.offering};
      const formatSource=materialRows.find(m=>m.id===pin.source_material.material_id&&m.version===pin.source_material.material_version)!;
      const formatPolicy:import('@bondbuddy/contracts').SourceFormatPolicy={version:'source-format-v1',
        mode:formatSource.media_type==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'?'preserve_docx':'reconstruct_pdf',
        template:{kind:'material',...pin.source_material},selection:'review_source'};
      const input={...original,requirements:pin.requirements?[pin.requirements]:[]};
      const manifest={project_kind:'review',name:p.name,draft_revision:p.draft_revision,...sourceProject,
        update_details:{...emptyUpdateDetails(),...source.manifest.update_details,authoring_mode:'unified_v1',supplementary_notes:pin.requirements||null},
        materials:materialRows.map(m=>({material_id:m.id,material_version:m.version,sha256:m.sha256.trim(),role:m.role})),
        authoring:{version:'unified_v1',source_prospectuses:[],requirements:[],knowledge:await loadAuthoringKnowledge(sourceProject),knowledge_status:'authoring_reference_not_compliance_approval',review_result:pin,format_policy:formatPolicy}};
      const inputHash=inputManifestHash(manifest),runId=uid();
      await client.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,$3,$4,$5,$6,$7,'[]')`,[id,revision,user,p.draft_revision,inputHash,manifest,JSON.stringify(manifest.materials)]);
      await client.query('UPDATE bb_projects SET latest_input_revision=$3,updated_at=now() WHERE owner_user_id=$1 AND id=$2',[user,id,revision]);
      const run=(await client.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,$4,$5,$6,'update',$7,'queued') RETURNING *`,[runId,user,id,revision,inputHash,key,requestHash])).rows[0];
      const report=(await client.query('SELECT id FROM bb_review_reports WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3',[user,id,b.source_run_id])).rows[0];
      const origin:ReviewExecutionOrigin={version:'review-execution-origin-v1',entrypoint:'quick_action',accepted_proposal:null,context_report_ref:null};
      await client.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,source_report_id,snapshot) VALUES($1,$2,$3,$4,'revision',$5,$6)`,[runId,user,id,version,report?.id??null,{input,input_version:source.snapshot.input_version,finding_ids:[],plan:null,origin,context_messages:[],source_run_id:b.source_run_id}]);
      if(paidReview)await reserveCredits(client,user,run,b.quote_id,null,p,await intentHash(client,user,id,p,b),commercial);
      await recordOperation(client,{owner:user,projectId:id,runId,requestId:request.id,traceId:runId,kind:'execute',status:'submitted',inputRevision:revision,inputHash});
      await enqueue(client,run,RUN_PIPELINE_SUBTYPE);return runDto({...run,stage:'queued',event_cursor:1});
    });
  });
  app.get('/api/v1/projects/:project_id/review-history', async request => {
    const user = await owner(request), id = projectId(request); await requireReview(db(), user, id);
    const rows = await executionRows(db(), user, id);
    return { items: await Promise.all(rows.map(async r => ({ run: runDto(r), operation: r.operation, version: r.version, source_report_id: r.source_report_id, report_id: r.report_id ?? null, input: r.snapshot.input, input_revision: r.input_revision, finding_ids: r.snapshot.finding_ids, plan: r.snapshot.plan, origin: reviewExecutionOriginDto(r.snapshot.origin), context_messages: r.snapshot.context_messages ?? [], artifacts: await artifacts(db(), user, id, r.id), created_at: date(r.created_at) }))) };
  });
}
