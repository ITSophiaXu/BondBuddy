import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import type { ReviewExecutionOrigin, ReviewProposalV2 } from '@bondbuddy/contracts';
import type { ReviewManifest } from './review-input.js';
import { reviewRevisionCliStage, reviewRevisionCliDeliveryStage, REVIEW_REVISION_CLI_CHECKPOINT,
  validReviewRevisionCliResult, type ReviewRevisionCliResult } from './review-revision-cli-stage.js';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import { revisionCliFixture as fixture } from './review-revision-cli-test-fixture.js';

const python = process.env.BONDBUDDY_WORD_PYTHON ?? process.env.BONDBUDDY_TEST_PYTHON ?? 'python3';
const execute = promisify(execFile);
const config = { ...loadCodexAdapterConfig({}), work_root: tmpdir() };

const persist: NonNullable<Parameters<typeof reviewRevisionCliStage>[0]>['checkpoint'] = async (_pool, _lease, _name, _value) => {};

test('revision consumes the explicitly adopted input and refuses lineage or unconsumed requirement drift before a CLI send',async()=>{
  const f=await fixture();let calls=0;
  try{
    const adoptedRequirement='Synthetic explicit instruction: retain the other paragraph.';
    const draft={source_material_ref:f.pin.source_material,material_versions:f.input.materials.map(m=>({material_id:m.pin.material_id,material_version:m.pin.material_version,sha256:m.pin.sha256})),requirements:[adoptedRequirement],as_of:null};
    const proposal:ReviewProposalV2={version:'review-proposal-v2',proposal_id:'proposal',project_id:f.ctx.run.project_id,operation:'revision',
      source_report_id:f.pin.source_report.report_id,source_report_sha256:f.pin.source_report.sha256,
      context_report_ref:{report_id:f.pin.source_report.report_id,sha256:f.pin.source_report.sha256},
      input_version:1,input_sha256:inputManifestHash({...draft,requirements:[]}),source_material_ref:draft.source_material_ref,material_versions:draft.material_versions,
      finding_ids:f.pin.selected_findings.map(p=>p.finding_id),related_finding_ids:[],excluded_findings:f.pin.excluded_findings,requirements:[adoptedRequirement],explanation:'Synthetic confirmed revision'};
    const origin:ReviewExecutionOrigin={version:'review-execution-origin-v1',entrypoint:'assistant_proposal',context_report_ref:proposal.context_report_ref,
      accepted_proposal:{acceptance_id:'acceptance',proposal,proposal_sha256:inputManifestHash(proposal),adoption:'as_proposed',accepted_at:'2026-10-04T00:00:00Z',
        input_version:2,input_sha256:inputManifestHash(draft),report_catalog_version:1,finding_ids:proposal.finding_ids,excluded_findings:proposal.excluded_findings,requirements:proposal.requirements}};
    const review:ReviewManifest['review']={version:'review_v1',operation:'revision',report_id:'next-report',version_number:2,input:draft,
      source_report_id:proposal.source_report_id,source_report_sha256:proposal.source_report_sha256,finding_ids:proposal.finding_ids,draft_version:2,origin};
    f.input.manifest.review=review;f.input.requirements.push(adoptedRequirement);f.ctx.run.input_hash=inputManifestHash(f.input.manifest);
    const stage=reviewRevisionCliStage({load:async()=>f.input,config,checkpoint:persist,writer:f.writer,model:options=>({name:options.name,run:async()=>{
      calls++;const cwd=join(f.root,'accepted-model');await mkdir(cwd);await options.fileWorkspace!.prepare(cwd);
      const locked=JSON.parse(await readFile(join(cwd,'input.json'),'utf8'));assert.ok(locked.requirements.includes(adoptedRequirement));
      return {kind:'pause',stage:'provider_reconcile',reason:'synthetic_no_provider_send'};
    }})});
    assert.equal((await stage.run(f.ctx)).kind,'pause');assert.equal(calls,1);
    for(const mutate of [
      (r:typeof review)=>{r.source_report_id='foreign';},
      (r:typeof review)=>{r.finding_ids=['foreign'];},
      (r:typeof review)=>{r.input.requirements.push('Never adopted into the actual CLI input');r.origin!.accepted_proposal!.requirements.push('Never adopted into the actual CLI input');
        r.origin!.accepted_proposal!.input_sha256=inputManifestHash(r.input);r.origin!.accepted_proposal!.adoption='user_adjusted';},
    ]){const bad=structuredClone(review);mutate(bad);f.input.manifest.review=bad;
      assert.deepEqual(await stage.run(f.ctx),{kind:'fail',code:'INPUT_REVISION_CONFLICT'});assert.equal(calls,1);}
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('one CLI owns revision generation; collector verifies and delivery only reads durable artifacts', async () => {
  const f = await fixture(); let calls = 0;
  try {
    const stage = reviewRevisionCliStage({ load: async () => f.input, config, checkpoint: persist, writer:f.writer, model: options => ({ name: options.name, run: async ctx => {
      calls++; assert.ok(ctx.checkpoint[REVIEW_REVISION_CLI_CHECKPOINT], 'method is persisted before the model send');
      assert.equal(options.logicalCallId, 'review-revision-cli-v1'); assert.ok(options.fileWorkspace);
      assert.match(await options.buildPrompt(ctx), /accepted revision/);
      const cwd = join(f.root, 'model'); await mkdir(cwd); await options.fileWorkspace!.prepare(cwd);
      const locked = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
      assert.equal(locked.materials.length, 2); assert.equal(locked.records.length, 2); assert.deepEqual(locked.revision, f.pin);
      await writeFile(join(cwd, 'scratch/proposal.json'), JSON.stringify(f.proposal));
      await execute(python, ['-B', join(cwd, 'tools/revision_cli.py'), 'scratch/proposal.json'], { cwd, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      const value = await options.fileWorkspace!.collect(cwd, { call_id: 'synthetic-call' } as never);
      assert.ok(options.validate(value)); return { kind: 'done', value };
    } }) });
    const result = await stage.run(f.ctx); assert.equal(result.kind, 'done'); assert.equal(calls, 1);
    if (result.kind !== 'done') throw Error('expected completed CLI');
    const value = result.value as ReviewRevisionCliResult;
    assert.equal(value.error, undefined); assert.ok(validReviewRevisionCliResult(value, f.ctx, f.pin));
    assert.deepEqual(f.writes.map(write=>write.name),['tracked.docx','clean.docx','baseline.docx','handling.json','summary.json','proposal.json']);
    for(const write of f.writes){assert.deepEqual(write.source,{kind:'provider',attemptId:'synthetic-call',resultSchemaVersion:'review-revision-cli-v1'});assert.equal(write.lease,f.ctx.lease);assert.equal(write.key,value.files[write.name]!.key);}
    assert.equal(value.handling?.items[0]?.status, 'modified'); assert.equal(value.handling?.items[1]?.status, 'not_modified');
    assert.equal(value.summary.method, 'review-revision-cli-v1');
    f.ctx.values.set('model_generation', value);
    const delivery = await reviewRevisionCliDeliveryStage().run(f.ctx);
    assert.equal(delivery.kind, 'deliver'); assert.equal(calls, 1);
    if (delivery.kind !== 'deliver') throw Error('expected delivery');
    assert.ok(delivery.cleanBytes?.length); assert.ok(delivery.baselineBytes?.length); assert.equal(delivery.deliveryPolicy, undefined);
    assert.deepEqual(delivery.wordSummary?.revision_handling, value.handling); assert.equal(delivery.wordSummary?.review_passed, false);
    assert.equal(result.checkpoint?.execution_mode, 'review-revision-cli-v1');
    const originalRef = value.files['clean.docx']!.key;
    value.files['clean.docx']!.key = originalRef.replace('owners/owner/', 'owners/other/');
    assert.equal(validReviewRevisionCliResult(value, f.ctx), false);
    value.files['clean.docx']!.key = originalRef;
    f.blobs.set(originalRef, Buffer.from('tampered stored file'));
    await assert.rejects(reviewRevisionCliDeliveryStage().run(f.ctx), /WORD_OUTPUT_BLOB_MISMATCH/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('post-tool mutation outside the accepted paragraph is durably rejected before any delivery', async () => {
  const f = await fixture();
  try {
    const result = await reviewRevisionCliStage({ load: async () => f.input, config, checkpoint: persist, writer:f.writer, model: options => ({ name: options.name, run: async () => {
      const cwd = join(f.root, 'model'); await mkdir(cwd); await options.fileWorkspace!.prepare(cwd);
      await writeFile(join(cwd, 'scratch/proposal.json'), JSON.stringify(f.proposal));
      await execute(python, ['-B', join(cwd, 'tools/revision_cli.py'), 'scratch/proposal.json'], { cwd, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      await execute(python, ['-B', '-c', 'from docx import Document; import sys; d=Document(sys.argv[1]); d.paragraphs[1].text="Unauthorized replacement"; d.save(sys.argv[1])', join(cwd, 'output/clean.docx')]);
      const value = await options.fileWorkspace!.collect(cwd, { call_id: 'synthetic-call' } as never);
      assert.ok(options.validate(value), 'settled rejection preserves provider result/usage');
      return { kind: 'done', value };
    } }) }).run(f.ctx);
    assert.equal(result.kind, 'done'); if (result.kind !== 'done') throw Error('expected settled rejection');
    const value = result.value as ReviewRevisionCliResult; assert.equal(value.error, 'WORD_QUALITY_REJECTED');
    assert.deepEqual(value.files, {});assert.deepEqual(f.writes,[]); f.ctx.values.set('model_generation', value);
    assert.deepEqual(await reviewRevisionCliDeliveryStage().run(f.ctx), { kind: 'fail', code: 'WORD_QUALITY_REJECTED' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('changed method pauses before another provider call and unknown result never reaches delivery', async () => {
  const f = await fixture(); let calls = 0;
  try {
    const stage = reviewRevisionCliStage({ load: async () => f.input, config, checkpoint: persist, writer:f.writer, model: options => ({ name: options.name, run: async () => {
      calls++; return { kind: 'pause', stage: 'provider_reconcile', reason: 'provider_result_pending' };
    } }) });
    assert.deepEqual(await stage.run(f.ctx), { kind: 'pause', stage: 'provider_reconcile', reason: 'provider_result_pending' });
    assert.equal(calls, 1);
    f.ctx.checkpoint[REVIEW_REVISION_CLI_CHECKPOINT]!.helpers_sha256 = 'f'.repeat(64);
    assert.deepEqual(await stage.run(f.ctx), { kind: 'pause', stage: 'capability_not_ready', reason: 'revision_cli_method_changed' });
    assert.equal(calls, 1); assert.equal(f.ctx.values.get('model_generation'), undefined);
    delete f.ctx.checkpoint[REVIEW_REVISION_CLI_CHECKPOINT];
    f.ctx.checkpoint.review_revision_cli_v1_prompt = { prompt_snapshot_ref: 'old-unpinned-prompt' };
    assert.deepEqual(await stage.run(f.ctx), { kind: 'pause', stage: 'capability_not_ready', reason: 'revision_cli_method_missing' });
    assert.equal(calls, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('storage and verifier startup outages remain infrastructure failures rather than false quality rejections', async () => {
  for (const mode of ['storage', 'verifier']) {
  const f = await fixture();
  const priorPython = process.env.BONDBUDDY_WORD_PYTHON;
  try {
    if (mode === 'storage') f.ctx.blobs.put = async () => { throw Error('SYNTHETIC_BLOB_OUTAGE'); };
    const stage = reviewRevisionCliStage({ load: async () => f.input, config, checkpoint: persist, writer:f.writer, model: options => ({ name: options.name, run: async () => {
      const cwd = join(f.root, 'model'); await mkdir(cwd); await options.fileWorkspace!.prepare(cwd);
      await writeFile(join(cwd, 'scratch/proposal.json'), JSON.stringify(f.proposal));
      await execute(python, ['-B', join(cwd, 'tools/revision_cli.py'), 'scratch/proposal.json'], { cwd, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      if (mode === 'verifier') process.env.BONDBUDDY_WORD_PYTHON = join(f.root, 'missing-python-binary');
      const value = await options.fileWorkspace!.collect(cwd, { call_id: 'synthetic-outage' } as never);
      return { kind: 'done', value };
    } }) });
    await assert.rejects(stage.run(f.ctx), mode === 'storage' ? /SYNTHETIC_BLOB_OUTAGE/ : /ENOENT/);
    assert.equal(f.ctx.values.get('model_generation'), undefined);
  } finally {
    if (priorPython === undefined) delete process.env.BONDBUDDY_WORD_PYTHON; else process.env.BONDBUDDY_WORD_PYTHON = priorPython;
    await rm(f.root, { recursive: true, force: true });
  }
  }
});

test('no safe changes preserves actual handling and pauses instead of delivering an empty Word revision', async () => {
  const f = await fixture();
  try {
    f.proposal.edits = [];
    f.proposal.handling[0]!.status = 'needs_evidence';
    f.proposal.handling[0]!.reason = 'Original evidence does not establish the intended period.';
    const result = await reviewRevisionCliStage({ load: async () => f.input, config, checkpoint: persist, writer:f.writer, model: options => ({ name: options.name, run: async () => {
      const cwd = join(f.root, 'model'); await mkdir(cwd); await options.fileWorkspace!.prepare(cwd);
      await writeFile(join(cwd, 'scratch/proposal.json'), JSON.stringify(f.proposal));
      await execute(python, ['-B', join(cwd, 'tools/revision_cli.py'), 'scratch/proposal.json'], { cwd, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      const value = await options.fileWorkspace!.collect(cwd, { call_id: 'synthetic-no-changes' } as never);
      assert.ok(options.validate(value)); return { kind: 'done', value };
    } }) }).run(f.ctx);
    assert.equal(result.kind, 'done'); if (result.kind !== 'done') throw Error('expected actual handling');
    const value = result.value as ReviewRevisionCliResult;
    assert.equal(value.error, undefined); assert.equal(value.summary.no_changes, true); assert.equal(value.files['tracked.docx'], undefined);
    assert.deepEqual(f.writes.map(write=>write.name),['handling.json','summary.json','proposal.json']);
    for(const write of f.writes)assert.deepEqual(write.source,{kind:'provider',attemptId:'synthetic-no-changes',resultSchemaVersion:'review-revision-cli-v1'});
    assert.equal(value.handling?.items[0]?.status, 'needs_evidence');
    f.ctx.values.set('model_generation', value);
    assert.deepEqual(await reviewRevisionCliDeliveryStage().run(f.ctx), { kind: 'pause', stage: 'capability_not_ready', reason: 'revision_no_verified_changes' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('delivery rejects a different execution method and invented error states', async () => {
  const f = await fixture();
  try {
    const rejected: ReviewRevisionCliResult = { version: 'review-revision-cli-v1', input_hash: f.ctx.run.input_hash,
      revision_pin_sha256: inputManifestHash(f.pin), skill_sha256: 'f'.repeat(64), files: {},
      summary: { validation_error: 'WORD_REVISION_SCOPE_OR_ARTIFACT_INVALID' }, error: 'WORD_QUALITY_REJECTED' };
    assert.equal(validReviewRevisionCliResult({ ...rejected, error: 'INVENTED_ERROR' }, f.ctx), false);
    assert.equal(validReviewRevisionCliResult({ ...rejected, input_hash: '0'.repeat(64) }, f.ctx), false);
    f.ctx.values.set('model_generation', { ...rejected, version: 'codex-file-word-v1' });
    assert.deepEqual(await reviewRevisionCliDeliveryStage().run(f.ctx), { kind: 'fail', code: 'VALIDATION_FAILED' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
