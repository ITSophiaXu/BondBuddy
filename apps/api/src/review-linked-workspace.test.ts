// Synthetic fixtures, real PostgreSQL transactions; no supplier/model result is claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { digest, uid } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { reviewReplyMetadataDto, reviewExecutionOriginDto } from './review-workspace.js';
import type { ReviewProposalV2, ReviewReport, ReviewContext, ReviewEvidenceRef } from '@bondbuddy/contracts';

test('reply citations require the actual immutable report, never finding text', () => {
  assert.equal(reviewReplyMetadataDto({ reply_metadata: null }), null);
  assert.equal(reviewReplyMetadataDto({ context: { project_id: 'p', report_id: 'r', finding_ids: [], material_refs: [] },
    reply_metadata: { version: 'review-reply-metadata-v1', context_report_ref: { report_id: 'r', sha256: digest('r') }, cited_finding_ids: ['F-001'] } }), null);
  assert.deepEqual(reviewReplyMetadataDto({ context: { project_id: 'p', report_id: null, finding_ids: [], material_refs: [] },
    reply_metadata: { version: 'review-reply-metadata-v1', context_report_ref: null, cited_finding_ids: [] } }),
  { version: 'review-reply-metadata-v1', context_report_ref: null, cited_finding_ids: [] });
});
test('legacy origin is explicitly unknown and nested internal fields never reach a task card', () => {
  assert.equal(reviewExecutionOriginDto(undefined).entrypoint, 'legacy_unrecorded');
  const quick = { version: 'review-execution-origin-v1', entrypoint: 'quick_action', accepted_proposal: null,
    context_report_ref: null, raw_cli_output: 'secret CLI text' };
  assert.deepEqual(reviewExecutionOriginDto(quick), { version: quick.version, entrypoint: quick.entrypoint, accepted_proposal: null, context_report_ref: null });
  assert.equal(quick.raw_cli_output, 'secret CLI text', 'public projection never rewrites immutable private evidence');
  const nested = { ...quick, entrypoint: 'assistant_proposal', accepted_proposal: { acceptance_id: 'a', hidden_prompt: 'hidden reasoning',
    proposal: { version: 'review-proposal-v2', prompt: 'private prompt' } } };
  assert.equal(reviewExecutionOriginDto(nested).entrypoint, 'legacy_unrecorded', 'invalid recorded origin is not guessed from another field');
  assert.ok(!JSON.stringify(reviewExecutionOriginDto(nested)).includes('hidden'));
  assert.ok(!JSON.stringify(reviewExecutionOriginDto(nested)).includes('private'));
});

const connection = await isolatedTestDatabase(undefined, 'm3-linked-workspace');
test('M3 proposals explicitly adopt, lock executable requirements and project one durable task timeline', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  let owner = 'synthetic-linked-owner';
  const origin = 'http://bondbuddy.test';
  const app = createServer({ pool, principal: async () => ({ userId: owner, csrfVerified: true }), allowedOrigin: origin });
  const send = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { origin }, payload: payload as any });
  const ok = (response: { statusCode: number; body: string }) => assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body);
  try {
    const created = await send('POST', '/api/v1/projects', { name: 'Synthetic linked M3', kind: 'review', issuer_name: null, market: null, offering: null }); ok(created);
    const projectId = created.json().project_id, base = `/api/v1/projects/${projectId}`, materialId = uid(), uploadId = uid(), sha256 = digest('synthetic linked source');
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic.pdf','application/pdf',23,$4,'historical',$5,now()+interval '1 hour','completed')`, [uploadId, owner, projectId, sha256, `synthetic/${uploadId}`]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'historical','synthetic.pdf','application/pdf',23,$5,$6,'persisted')`, [materialId, owner, projectId, uploadId, sha256, `synthetic/${materialId}`]);
    const pin = { material_id: materialId, material_version: 1, sha256 };
    const input = { source_material_ref: pin, material_versions: [pin], requirements: ['原始完整要求'], as_of: null, evidence_links: [] };
    ok(await send('PUT', `${base}/review-draft`, { kind: 'input', expected_version: 0, input }));
    const firstRequest = { execution_request_id: uid(), operation: 'full_review', expected_input_version: 1, source_report_id: null, expected_plan_version: null, finding_ids: [] };
    const initial = await send('POST', `${base}/review-executions`, firstRequest); ok(initial);
    const firstRunId = initial.json().run_id;
    await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1", [firstRunId]);
    const frozenReview = (await pool.query('SELECT manifest->\'review\' AS review FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
      [owner, projectId, initial.json().input_revision])).rows[0].review;
    const report: ReviewReport = { report_id: frozenReview.report_id, project_id: projectId, run_id: firstRunId, input_revision: initial.json().input_revision, version: frozenReview.version_number,
      source_material: pin, scope: { mode: 'full_review', finding_ids: [] }, findings: [], coverage: [], limitations: ['synthetic unverified fixture'], created_at: new Date().toISOString() };
    report.findings = ['F-001', 'F-002'].map(finding_id => ({ finding_id, report_id: report.report_id, dimension: 'financial', conclusion: 'needs_evidence',
      severity: 'P2', title: finding_id, description: 'Synthetic unresolved finding', target_refs: [], evidence_refs: [], limitations: ['未提供证据'],
      repairability: { can_revise: false, reason: 'No evidence', allowed_record_ids: [] }, origin_report_id: report.report_id, check_status: 'rechecked' }));
    await pool.query('INSERT INTO bb_review_reports(id,owner_user_id,project_id,run_id,version,content_sha256,report) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [report.report_id, owner, projectId, firstRunId, report.version, inputManifestHash(report), report]);
    const context: ReviewContext = { project_id: projectId, report_id: report.report_id, finding_ids: ['F-001'], material_refs: [pin] };
    const proposal = async (operation: ReviewProposalV2['operation']): Promise<ReviewProposalV2> => {
      const savedInput = (await send('GET', `${base}/review-draft`)).json().draft;
      const { version, ...currentInput } = savedInput;
      const sent = await send('POST', `${base}/review-messages`, { submission_request_id: uid(), content: 'Synthetic request; no execution permission yet', context }); ok(sent);
      const snapshot = (await pool.query('SELECT context_snapshot FROM bb_review_messages WHERE id=$1', [sent.json().message.message_id])).rows[0].context_snapshot;
      assert.equal(snapshot.version, 'review-assistant-context-v2');
      assert.equal(snapshot.reply_schema_version, 'review-assistant-reply-v2');
      const value: ReviewProposalV2 = { version: 'review-proposal-v2', proposal_id: uid(), project_id: projectId, operation,
        source_report_id: operation === 'full_review' ? null : report.report_id,
        source_report_sha256: operation === 'full_review' ? null : inputManifestHash(report),
        context_report_ref: { report_id: report.report_id, sha256: inputManifestHash(report) }, input_version: version, input_sha256: inputManifestHash(currentInput),
        source_material_ref: pin, material_versions: [pin], finding_ids: operation === 'full_review' ? [] : ['F-001'], related_finding_ids: [], excluded_findings: [],
        requirements: ['依据新增说明核验口径'], explanation: 'Synthetic typed proposal awaiting explicit adoption' };
      const messageId = uid();
      await pool.query(`INSERT INTO bb_review_messages(id,owner_user_id,project_id,submission_request_id,request_hash,role,content,context,context_snapshot,reply_status,reply_to,proposal,reply_metadata)
        VALUES($1,$2,$3,$4,$5,'assistant','Synthetic F-999 text is not a citation',$6,$7,'completed',$8,$9,$10)`,
      [messageId, owner, projectId, uid(), digest(messageId), context, snapshot, sent.json().message.message_id, value,
        { version: 'review-reply-metadata-v1', context_report_ref: value.context_report_ref, cited_finding_ids: ['F-001'] }]);
      return value;
    };
    const differential = await proposal('differential_review');
    const workspaceBefore = (await send('GET', `${base}/review-workspace`)).json();
    assert.equal(workspaceBefore.timeline.filter((entry: any) => entry.kind === 'task').length, 1);
    assert.equal(workspaceBefore.messages.at(-1).reply_metadata.cited_finding_ids[0], 'F-001');
    assert.ok(!workspaceBefore.messages.at(-1).reply_metadata.cited_finding_ids.includes('F-999'), 'text does not create citations');
    const adoptionRequest = { adoption_request_id: uid(), proposal_id: differential.proposal_id, expected_input_version: 1,
      finding_ids: ['F-001'], excluded_findings: [{ finding_id: 'F-002', reason: '本轮沿用原报告' }], requirements: ['用户确认后的口径要求'] };
    const adopted = await send('POST', `${base}/review-proposal-adoptions`, adoptionRequest); ok(adopted);
    const accepted = adopted.json().accepted_proposal;
    assert.equal(accepted.adoption, 'user_adjusted');
    assert.deepEqual(adopted.json().draft.requirements, ['原始完整要求', '用户确认后的口径要求']);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1', [projectId])).rows[0].n, 1, 'explicit adoption still does not execute');
    const replay = await send('POST', `${base}/review-proposal-adoptions`, adoptionRequest); ok(replay);
    assert.deepEqual(replay.json(), adopted.json());
    assert.equal((await send('POST', `${base}/review-proposal-adoptions`, { ...adoptionRequest, requirements: ['不同要求'] })).statusCode, 409);
    await assert.rejects(pool.query("UPDATE bb_review_proposal_adoptions SET acceptance='{}' WHERE id=$1", [accepted.acceptance_id]), /immutable/);
    const execute = { execution_request_id: uid(), operation: 'differential_review', expected_input_version: accepted.input_version,
      source_report_id: report.report_id, expected_plan_version: null, finding_ids: accepted.finding_ids,
      entrypoint: 'assistant_proposal', accepted_proposal_id: accepted.acceptance_id, context_report_ref: differential.context_report_ref };
    assert.equal((await send('POST', `${base}/review-executions`, { ...execute, finding_ids: ['F-002'] })).statusCode, 409, 'execution cannot replace the accepted scope');
    const concurrent = await Promise.all([send('POST', `${base}/review-executions`, execute), send('POST', `${base}/review-executions`, execute)]);
    concurrent.forEach(ok); assert.equal(concurrent[0]!.json().run_id, concurrent[1]!.json().run_id);
    const runId = concurrent[0]!.json().run_id;
    const locked = (await pool.query('SELECT manifest,input_hash FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
      [owner, projectId, concurrent[0]!.json().input_revision])).rows[0];
    assert.deepEqual(locked.manifest.review.input.requirements, adopted.json().draft.requirements);
    assert.equal(locked.manifest.review.origin.accepted_proposal.acceptance_id, accepted.acceptance_id);
    assert.equal(inputManifestHash(locked.manifest), locked.input_hash.trim());
    await pool.query(`INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload)
      VALUES($1,$2,$3,2,$3,'run.progress','running','review_sources',$4)`, [uid(), owner, runId,
      { reason: 'checkpoint_saved', channel: 'production', raw_tool_output: 'secret CLI stdout', prompt: 'hidden prompt', unexpected_field: 'private' }]);
    await pool.query('UPDATE bb_runs SET event_cursor=2 WHERE id=$1', [runId]);
    const workspace = (await send('GET', `${base}/review-workspace`)).json();
    const tasks = workspace.timeline.filter((entry: any) => entry.kind === 'task');
    assert.equal(tasks.length, 2); assert.equal(new Set(tasks.map((entry: any) => entry.entry_id)).size, 2);
    const task = tasks.find((entry: any) => entry.task.run.run_id === runId).task;
    assert.equal(task.origin.entrypoint, 'assistant_proposal'); assert.equal(task.source_report_id, report.report_id);
    assert.deepEqual(task.events.at(-1).payload, { reason: 'checkpoint_saved' });
    assert.equal(task.run.state, 'queued', 'current durable run snapshot remains authoritative over stale/replayed event state');
    assert.ok(!JSON.stringify(workspace).includes('secret CLI stdout'));
    assert.equal((await send('POST', `${base}/review-executions`, { ...execute, execution_request_id: uid() })).statusCode, 409, 'other intent cannot bypass project mutex');
    const recoveredConflict = (await send('GET', `${base}/review-workspace`)).json();
    assert.equal(recoveredConflict.active_run.run_id, runId, 'conflict recovery returns the original active run');
    assert.equal(recoveredConflict.timeline.filter((entry: any) => entry.kind === 'task').length, 2, 'conflict never creates a second active task or card');
    const full = await proposal('full_review');
    const fullAdoption = { adoption_request_id: uid(), proposal_id: full.proposal_id, expected_input_version: 2, finding_ids: [], excluded_findings: [], requirements: full.requirements };
    assert.equal((await send('POST', `${base}/review-proposal-adoptions`, { ...fullAdoption, finding_ids: ['F-001'] })).statusCode, 422);
    const saved = await send('POST', `${base}/review-proposal-adoptions`, fullAdoption); ok(saved);
    assert.deepEqual((await pool.query('SELECT manifest,input_hash FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
      [owner, projectId, concurrent[0]!.json().input_revision])).rows[0], locked, 'next input/adoption cannot mutate an active execution');
    await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1", [runId]);
    const complete = await send('POST', `${base}/review-executions`, { ...firstRequest, execution_request_id: uid(), expected_input_version: 3,
      entrypoint: 'assistant_proposal', accepted_proposal_id: saved.json().accepted_proposal.acceptance_id, context_report_ref: full.context_report_ref }); ok(complete);
    const manifest = (await pool.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2', [projectId, complete.json().input_revision])).rows[0].manifest.review;
    assert.equal(manifest.source_report_id, null); assert.deepEqual(manifest.finding_ids, []);
    assert.equal(manifest.origin.context_report_ref.report_id, report.report_id, 'discussion reference never narrows a complete request');
    const expired = await proposal('differential_review');
    const current = (await send('GET', `${base}/review-draft`)).json().draft, { version, ...currentInput } = current;
    ok(await send('PUT', `${base}/review-draft`, { kind: 'input', expected_version: version, input: { ...currentInput, requirements: [...currentInput.requirements, '下轮新增'] } }));
    assert.equal((await send('POST', `${base}/review-proposal-adoptions`, { ...adoptionRequest, adoption_request_id: uid(), proposal_id: expired.proposal_id, expected_input_version: version + 1 })).statusCode, 409);
    owner = 'synthetic-other-owner';
    assert.equal((await send('GET', `${base}/review-workspace`)).statusCode, 404);
    assert.equal((await send('POST', `${base}/review-proposal-adoptions`, adoptionRequest)).statusCode, 404);
    assert.equal((await send('POST', `${base}/review-executions`, execute)).statusCode, 404);
    owner = 'synthetic-linked-owner';
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1', [owner])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_review_assistant_attempts WHERE owner_user_id=$1', [owner])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_events WHERE owner_user_id=$1', [owner])).rows[0].n, 0, 'M2 billing never gates or charges M3');
  } finally { await app.close(); await pool.end(); }
});

test('an adopted typed revision can become a new quick-action scope without losing requirements or rewriting its prior execution', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const owner = 'synthetic-linked-shortcut-owner', origin = 'http://bondbuddy.test';
  const app = createServer({ pool, principal: async () => ({ userId: owner, csrfVerified: true }), allowedOrigin: origin });
  const send = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { origin }, payload: payload as any });
  const ok = (response: { statusCode: number; body: string }) => assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body);
  try {
    const created = await send('POST', '/api/v1/projects', { name: 'Synthetic typed-to-shortcut revision', kind: 'review', issuer_name: null, market: null, offering: null }); ok(created);
    const projectId = created.json().project_id, base = `/api/v1/projects/${projectId}`, materialId = uid(), uploadId = uid(), sha256 = digest('synthetic revision source');
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic.pdf','application/pdf',25,$4,'historical',$5,now()+interval '1 hour','completed')`, [uploadId, owner, projectId, sha256, `synthetic/${uploadId}`]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'historical','synthetic.pdf','application/pdf',25,$5,$6,'persisted')`, [materialId, owner, projectId, uploadId, sha256, `synthetic/${materialId}`]);
    const pin = { material_id: materialId, material_version: 1, sha256 };
    const input = { source_material_ref: pin, material_versions: [pin], requirements: ['原始修订要求'], as_of: null, evidence_links: [] };
    ok(await send('PUT', `${base}/review-draft`, { kind: 'input', expected_version: 0, input }));
    const initial = await send('POST', `${base}/review-executions`, { execution_request_id: uid(), operation: 'full_review', expected_input_version: 1,
      source_report_id: null, expected_plan_version: null, finding_ids: [] }); ok(initial);
    const firstRunId = initial.json().run_id;
    await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1", [firstRunId]);
    const frozenReview = (await pool.query('SELECT manifest->\'review\' AS review FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
      [owner, projectId, initial.json().input_revision])).rows[0].review;
    const report: ReviewReport = { report_id: frozenReview.report_id, project_id: projectId, run_id: firstRunId, input_revision: initial.json().input_revision, version: frozenReview.version_number,
      source_material: pin, scope: { mode: 'full_review', finding_ids: [] }, findings: [], coverage: [], limitations: ['Synthetic fixture; no supplier response'], created_at: new Date().toISOString() };
    const ref: ReviewEvidenceRef = { material_id: materialId, material_version: 1, material_sha256: sha256, parse_snapshot_id: 'synthetic-revision-parse',
      parse_response_sha256: digest('synthetic-revision-parse'), record_id: 'synthetic-revision-record', record_sha256: digest('synthetic-revision-record'),
      locator_type: 'pdf_bbox', locator: { page: 1 }, quote: 'synthetic revision source', extraction_method: 'native_text', uncertainty: [] };
    report.findings = ['F-001', 'F-002'].map(finding_id => ({ finding_id, report_id: report.report_id, dimension: 'financial', conclusion: 'error',
      severity: 'P2', title: finding_id, description: 'Synthetic supported revision', target_refs: [ref], evidence_refs: [ref], suggested_change: 'Synthetic supported change', limitations: [],
      repairability: { can_revise: true, reason: 'Synthetic native evidence', allowed_record_ids: [ref.record_id] }, origin_report_id: report.report_id, check_status: 'rechecked' }));
    const reportSha256 = inputManifestHash(report);
    await pool.query('INSERT INTO bb_review_reports(id,owner_user_id,project_id,run_id,version,content_sha256,report) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [report.report_id, owner, projectId, firstRunId, report.version, reportSha256, report]);
    const context = { project_id: projectId, report_id: report.report_id, finding_ids: ['F-001'], material_refs: [pin] };
    const sent = await send('POST', `${base}/review-messages`, { submission_request_id: uid(), content: 'Synthetic revision proposal awaiting explicit adoption', context }); ok(sent);
    const snapshot = (await pool.query('SELECT context_snapshot FROM bb_review_messages WHERE id=$1', [sent.json().message.message_id])).rows[0].context_snapshot;
    const proposal: ReviewProposalV2 = { version: 'review-proposal-v2', proposal_id: uid(), project_id: projectId, operation: 'revision',
      source_report_id: report.report_id, source_report_sha256: reportSha256, context_report_ref: { report_id: report.report_id, sha256: reportSha256 },
      input_version: 1, input_sha256: inputManifestHash(input), source_material_ref: pin, material_versions: [pin], finding_ids: ['F-001'], related_finding_ids: [],
      excluded_findings: [{ finding_id: 'F-002', reason: '原提议本轮不修改此项' }], requirements: ['保留已明确采纳的修订口径'], explanation: 'Synthetic typed revision' };
    const messageId = uid();
    await pool.query(`INSERT INTO bb_review_messages(id,owner_user_id,project_id,submission_request_id,request_hash,role,content,context,context_snapshot,reply_status,reply_to,proposal)
      VALUES($1,$2,$3,$4,$5,'assistant','Synthetic typed revision',$6,$7,'completed',$8,$9)`,
      [messageId, owner, projectId, uid(), digest(messageId), context, snapshot, sent.json().message.message_id, proposal]);
    const adoption = await send('POST', `${base}/review-proposal-adoptions`, { adoption_request_id: uid(), proposal_id: proposal.proposal_id,
      expected_input_version: 1, finding_ids: proposal.finding_ids, excluded_findings: proposal.excluded_findings, requirements: proposal.requirements }); ok(adoption);
    const accepted = adoption.json().accepted_proposal, typedPlan = adoption.json().plan;
    assert.deepEqual(adoption.json().draft.requirements, ['原始修订要求', '保留已明确采纳的修订口径']);
    const assistantRequest = { execution_request_id: uid(), operation: 'revision', expected_input_version: accepted.input_version,
      source_report_id: report.report_id, expected_plan_version: typedPlan.version, finding_ids: ['F-001'], entrypoint: 'assistant_proposal',
      accepted_proposal_id: accepted.acceptance_id, context_report_ref: proposal.context_report_ref };
    const assistantRun = await send('POST', `${base}/review-executions`, assistantRequest); ok(assistantRun);
    const lockedPrior = (await pool.query('SELECT manifest,input_hash FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',
      [projectId, assistantRun.json().input_revision])).rows[0];
    await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1", [assistantRun.json().run_id]);
    const shortcutPlanRequest = { expected_version: typedPlan.version, source_report_id: report.report_id, finding_ids: ['F-002'],
      excluded_findings: [{ finding_id: 'F-001', reason: '用户明确快捷修改本轮范围，原项保留' }], requirements: typedPlan.requirements };
    assert.equal((await send('PUT', `${base}/revision-plan`, { ...shortcutPlanRequest, proposal_id: proposal.proposal_id })).statusCode, 422,
      'a typed proposal cannot be misrepresented by the legacy plan endpoint');
    const shortcutPlan = await send('PUT', `${base}/revision-plan`, shortcutPlanRequest); ok(shortcutPlan);
    const savedPlan = shortcutPlan.json();
    assert.equal(savedPlan.version, typedPlan.version + 1);
    assert.equal(savedPlan.proposal_origin, undefined, 'a new shortcut plan does not bind the old typed acceptance');
    assert.deepEqual((await send('GET', `${base}/review-draft`)).json().draft.requirements, adoption.json().draft.requirements,
      'changing plan provenance and selection preserves the adopted next-input requirements');
    const quickRequest = { execution_request_id: uid(), operation: 'revision', expected_input_version: accepted.input_version,
      source_report_id: report.report_id, expected_plan_version: savedPlan.version, finding_ids: ['F-002'], entrypoint: 'quick_action' };
    assert.equal((await send('POST', `${base}/review-executions`, { ...quickRequest, expected_plan_version: typedPlan.version })).statusCode, 409,
      'the new shortcut must use its exact confirmed plan version');
    assert.equal((await send('POST', `${base}/review-executions`, { ...quickRequest, entrypoint: 'assistant_proposal', accepted_proposal_id: accepted.acceptance_id })).statusCode, 409,
      'the new selection cannot silently replace the old assistant acceptance');
    const concurrent = await Promise.all([send('POST', `${base}/review-executions`, quickRequest), send('POST', `${base}/review-executions`, quickRequest)]);
    concurrent.forEach(ok); assert.equal(concurrent[0]!.json().run_id, concurrent[1]!.json().run_id);
    const lockedNew = (await pool.query('SELECT manifest,input_hash FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',
      [projectId, concurrent[0]!.json().input_revision])).rows[0];
    assert.deepEqual(lockedNew.manifest.review.input.requirements, adoption.json().draft.requirements);
    assert.deepEqual(lockedNew.manifest.review.origin, { version: 'review-execution-origin-v1', entrypoint: 'quick_action', accepted_proposal: null, context_report_ref: null });
    assert.deepEqual(lockedNew.manifest.review.finding_ids, ['F-002']);
    assert.equal(lockedNew.manifest.authoring.review_revision.accepted_plan.version, savedPlan.version);
    assert.deepEqual(lockedNew.manifest.authoring.review_revision.selected_findings.map((finding: any) => finding.finding_id), ['F-002']);
    assert.deepEqual(lockedNew.manifest.authoring.review_revision.requirements, savedPlan.requirements);
    assert.equal(inputManifestHash(lockedNew.manifest), lockedNew.input_hash.trim());
    assert.deepEqual((await pool.query('SELECT manifest,input_hash FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',
      [projectId, assistantRun.json().input_revision])).rows[0], lockedPrior, 'new quick scope cannot rewrite the original assistant execution');
    assert.deepEqual((await pool.query('SELECT acceptance FROM bb_review_proposal_adoptions WHERE id=$1', [accepted.acceptance_id])).rows[0].acceptance, accepted);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1', [projectId])).rows[0].n, 3,
      'plan adoption, rejected drift and duplicate retry do not create extra executions');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1', [owner])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_events WHERE owner_user_id=$1', [owner])).rows[0].n, 0);
  } finally { await app.close(); await pool.end(); }
});
