// Shared test-only production worker fixture. Synthetic supplier boundary; real
// input gates, queue, provider journal, private Word objects and delivery stages.
// Importing this module never clones, starts or connects to a database.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {INITIAL_FIXED_PRICES,emptyUpdateDetails,type RunSupplementDraftResponse} from '@bondbuddy/contracts';
import {digest,transaction,uid} from '@bondbuddy/api/data';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {action,type Lease} from '@bondbuddy/api/queue';
import {publishPrices,reserveCredits} from '../../api/dist/billing.js';
import {quoteM4,reserveM4} from '@bondbuddy/api/m4-billing';
import {createRunSupplementPreparationTestContext,type RunSupplementBeforeClaim} from '../../api/dist/run-supplement-preparation-test-fixture.js';
import {createRunSupplementFilePreparationFixture} from '../../api/dist/run-supplement-file-preparation-test-fixture.js';
import {buildM4Method} from './m4-method.js';
import {loadM4RuntimeSkill} from './m4-runtime-skills.js';
import {loadCodexAdapterConfig,type CodexAdapterConfig,type runContainedModelCall} from './codex-adapter.js';
import {reviewFileStage} from './review-file-stage.js';
import {fileAuthoringStage,fileAuthoringDeliveryStage} from './file-authoring-stage.js';
import {m4DocumentStage,m4DocumentDeliveryStage} from './m4-document-stage.js';
import {historicalWordDeliveryStage} from './historical-word-stage.js';
import {codexModelStage,inputLockStage,materialsReadyStage,runPipelineOnce,type RunStage} from './run-pipeline.js';
import {makeWorkerDocxFixture} from './docx-test-fixture.js';

const origin='http://bondbuddy.test';

export type Kind = 'authoring' | 'review' | 'm4';
export type Scope = Pick<Awaited<ReturnType<typeof createRunSupplementPreparationTestContext>>, 'pool' | 'blobs' | 'owner' | 'app'> &
  { projectId: string; runId: string; jobId: string };
const ok = (response: { statusCode: number; body: string; json(): any }) => {
  assert.equal(response.statusCode, 200, response.body); return response.json();
};

export async function authenticated(f: Scope) {
  const access = uid(), csrf = uid();
  await f.pool.query(`INSERT INTO bb_auth_sessions(id,user_id,access_hash,refresh_hash,csrf_hash,access_expires_at,refresh_expires_at)
    VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '1 day')`,
  [uid(), f.owner, digest(access), digest(uid()), digest(csrf)]);
  return (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => f.app.inject({ method, url, payload: payload as any,
    headers: { origin, cookie: `bb_session=${access}; bb_csrf=${csrf}`, 'x-bb-csrf': csrf } });
}

/** Use the original reservation helpers before the first lease or provider
 * history. No billing pointer or policy is rewritten after immutable capture. */
export async function prices(pool: Scope['pool']) {
  const price = uid();
  await publishPrices(pool, { id: price, prices: { ...INITIAL_FIXED_PRICES, new_authoring: 4500,
    full_review: 4500, differential_review: 4500 }, effectiveAt: new Date().toISOString(),
  actor: 'synthetic-worker', reason: 'Private production-channel worker fixture' });
  return price;
}
export function paidSource(kind: Kind): RunSupplementBeforeClaim {
  return async ({ pool, owner, projectId, runId, manifest }) => {
    const price = await prices(pool);
    await transaction(pool, async db => {
      const project = (await db.query('SELECT * FROM bb_projects WHERE id=$1 FOR UPDATE', [projectId])).rows[0];
      const run = (await db.query('SELECT * FROM bb_runs WHERE id=$1 FOR UPDATE', [runId])).rows[0];
      await db.query('SELECT id FROM bb_jobs WHERE run_id=$1 FOR UPDATE', [runId]);
      if (kind === 'm4') {
        const hash = inputManifestHash(manifest), result = await quoteM4(db, owner, manifest.topic_id, manifest.billing_task, hash, manifest);
        await reserveM4(db, owner, run, result.quote.quote_id, manifest.topic_id, hash);
      } else {
        // Review quotation precedes its immutable worker manifest in the public
        // execution path, so its pin is a business-intent hash, not the run hash.
        const intent = kind === 'review' ? inputManifestHash({ project_id: projectId, draft_revision: manifest.draft_revision,
          operation: manifest.review.operation, input: manifest.review.input, origin: manifest.review.origin }) : null;
        const quote = uid();
        await db.query(`INSERT INTO bb_credit_quotes(id,owner_user_id,project_id,input_revision,input_hash,price_version,task_type,points,reason,intent_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,4500,'Synthetic original execution quotation',$8)`,
        [quote, owner, projectId, kind === 'review' ? manifest.draft_revision : run.input_revision, intent ?? run.input_hash,
          price, kind === 'review' ? manifest.review.operation : 'new_authoring', intent]);
        await reserveCredits(db, owner, run, quote, { revision: run.input_revision, manifest }, project, intent ?? undefined);
      }
    });
  };
}

/** Complete M1 target periods; all ordinary production input gates remain in
 * use. The shared preparation fixture deliberately has a smaller target scope. */
export async function authoringFixture(connectionString: string, paid: boolean) {
  const c = await createRunSupplementPreparationTestContext(connectionString), { pool, blobs, owner, app } = c;
  try {
    const projectId = uid(), runId = uid(), jobId = uid();
    const scope = { pool, blobs, owner, app, projectId, runId, jobId };
    const send = await authenticated(scope), docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,draft_revision)
      VALUES($1,$2,'Synthetic production supplement','update','Frozen issuer','sse','private',1)`, [projectId, owner]);
    const material = async () => {
      const material_id = uid(), upload = uid(), bytes = makeWorkerDocxFixture({ externalLink: false }), sha256 = digest(bytes);
      const objectKey = `users/${owner}/projects/${projectId}/materials/${material_id}/1`;
      await blobs.put(objectKey, bytes, docx);
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES($1,$2,$3,'synthetic.docx',$4,$5,$6,'audit',$7,now()+interval '1 hour','completed')`,
      [upload, owner, projectId, docx, bytes.length, sha256, `${objectKey}/upload`]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'audit','synthetic.docx',$5,$6,$7,$8,'persisted')`,
      [material_id, owner, projectId, upload, docx, bytes.length, sha256, objectKey]);
      return { material_id, material_version: 1, sha256, role: 'audit' };
    };
    const first = await material(), added = await material(), knowledge = 'Synthetic full-document recheck policy';
    const manifest = { issuer_name: 'Frozen issuer', market: 'sse', offering: 'private', draft_revision: 1,
      requirements: ['Frozen user requirement'], materials: [first], update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1',
        target_reporting_periods: [{ start: '2025-01-01', end: '2025-12-31', period_kind: 'annual', scope: 'consolidated', status: 'user_asserted', evidence_refs: [] }] },
      authoring: { version: 'unified_v1', source_prospectuses: [], requirements: [], knowledge: [{ path: 'frozen.md', markdown: knowledge, sha256: digest(knowledge) }],
        knowledge_status: 'authoring_reference_not_compliance_approval' } };
    const hash = inputManifestHash(manifest);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,$4,$5,'[]')`, [projectId, owner, hash, manifest, JSON.stringify(manifest.materials)]);
    await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1', [projectId]);
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage,channel)
      VALUES($1,$2,$3,1,$4,$5,'update',$6,'queued','queued','production')`, [runId, owner, projectId, hash, uid(), digest(uid())]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,channel)
      VALUES($1,$2,$3,'update','default','queued','queued','production')`, [jobId, owner, runId]);
    if (paid) await paidSource('authoring')({ pool, owner, projectId, runId, jobId, manifest });
    else await prices(pool);
    return { ...scope, hash, manifest, objects: c.objects, added,
      save: async (expectedRevision = 0): Promise<RunSupplementDraftResponse> => ok(await send('PUT', `/api/v1/runs/${runId}/supplement-draft`, {
        request_id: uid(), expected_revision: expectedRevision, base_input_revision: 1, base_input_hash: hash,
        changes: [{ material: { material_id: added.material_id, material_version: 1, sha256: added.sha256 }, replaces: null }] })),
      cleanup: c.close };
  } catch (error) { await c.close(); throw error; }
}

/** Explicit provider seam. Real prompt snapshots, durable attempts/results,
 * request builders, working-file writers and delivery stages execute unchanged. */
export function syntheticModel(config: CodexAdapterConfig, unknownSuccessor: boolean): typeof codexModelStage {
  const runContainedCall: typeof runContainedModelCall = async (input, journal) => {
    const prior = await journal.latestAttempt(input.logical_call_id);
    if (prior) {
      assert.equal(prior.status, 'completed');
      const saved = await journal.readCompleted(input.logical_call_id, prior.attempt_no); assert.ok(saved);
      return { status: 'reused', value: saved.value, error_code: null, attempts: [], thread_id: null, codex_home: null };
    }
    assert.ok(journal.attemptState); const state = await journal.attemptState(input.logical_call_id);
    const intent = { owner_user_id: input.owner_user_id, project_id: input.project_id, job_id: input.job_id,
      run_id: input.run_id, trace_id: input.trace_id, logical_call_id: input.logical_call_id, call_id: uid(), attempt_no: state.next_attempt_no,
      model_id: config.model_id, model_config_version: config.model_config_version, prompt_snapshot_ref: input.prompt_snapshot_ref };
    const cwd = join(config.work_root, intent.call_id); await mkdir(cwd);
    assert.ok(input.fileWorkspace); await input.fileWorkspace.prepare(cwd);
    await journal.recordIntent(intent);
    const result = spawnSync(config.command[0]!, [...config.command.slice(1), 'exec', '--cd', cwd], { cwd, input: input.prompt, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr);
    const value = await input.fileWorkspace.collect(cwd, intent, { text: 'Synthetic Word files saved.' });
    const ref = await journal.storeResult(intent, Buffer.from(JSON.stringify(value)), input.result_schema_version);
    const workspace = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
    const unknown = unknownSuccessor && !!workspace.continuation;
    await journal.recordObservation({ ...intent, ...ref, provider_request_id: null, finish_reason: 'stop',
      outcome: unknown ? 'pending_reconcile' : 'completed', error_code: unknown ? 'MODEL_USAGE_PENDING' : null,
      usage: unknown ? { status: 'unknown', input_tokens: null, cached_input_tokens: null, output_tokens: null, reasoning_tokens: null, total_tokens: null }
        : { status: 'measured', input_tokens: 100, cached_input_tokens: 0, output_tokens: 50, reasoning_tokens: 0, total_tokens: 150 } });
    // The real model stage must recover the completed, price-bound result while
    // the provider's cost evidence remains unknown. Returning done here would
    // skip the consumer branch these free-origin cases need to exercise.
    return { status: unknown ? 'needs_reconcile' : 'completed', value: unknown ? null : value,
      error_code: unknown ? 'MODEL_USAGE_PENDING' : null, attempts: [], thread_id: null, codex_home: null };
  };
  return options => codexModelStage({ ...options, runContainedCall });
}

/** Runs the actual worker pipeline against the caller's owned private clone. */
export function productionWordRunner(input:Pick<Scope,'pool'|'blobs'> & {kind:Kind;config:CodexAdapterConfig;unknownSuccessor?:boolean}){
  const modelOptions={config:input.config,model:syntheticModel(input.config,input.unknownSuccessor??false)};
  const model=input.kind==='authoring'?fileAuthoringStage(modelOptions):input.kind==='review'?reviewFileStage(modelOptions):m4DocumentStage(modelOptions);
  const delivery=input.kind==='authoring'?fileAuthoringDeliveryStage():input.kind==='review'?historicalWordDeliveryStage():m4DocumentDeliveryStage();
  let stageError:unknown;
  const trace=(stage:RunStage):RunStage=>({...stage,run:async ctx=>{try{return await stage.run(ctx);}catch(error){stageError=error;throw error;}}});
  const stages=[inputLockStage,materialsReadyStage,trace(model),trace(delivery)];
  return (afterStage?:(stage:string,lease:Lease)=>Promise<void>)=>runPipelineOnce({pool:input.pool,blobs:input.blobs,stages,leaseSeconds:300,afterStage,
    onUnexpectedError:error=>assert.fail(stageError instanceof Error?stageError.stack:stageError?String(stageError):JSON.stringify(error))});
}

export async function productionWordFixture(connectionString:string,kind:Kind,config:CodexAdapterConfig){
  const method=await buildM4Method('document',loadM4RuntimeSkill('m4-underwriter'),config);
  const fixture=kind==='authoring'?await authoringFixture(connectionString,true):
    await createRunSupplementFilePreparationFixture(connectionString,kind,{method,earlyPause:'before_prompt',beforeClaim:paidSource(kind)});
  if(kind!=='authoring')await action(fixture.pool,fixture.owner,fixture.runId,'resume');
  const topic='topic' in fixture?fixture.topic:null;
  const surface=kind==='authoring'?'m1':kind==='review'?'m3':'m4';
  const route=kind==='m4'?`/#generate?topic=${topic}&run=${fixture.runId}`:
    kind==='review'?`/#/projects/${fixture.projectId}/review?tab=making&run=${fixture.runId}`:`/#/projects/${fixture.projectId}?run=${fixture.runId}`;
  return {...fixture,surface,kind,topic,route};
}

export function productionWordConfig(workRoot:string,marker:string,python:string,repository:string):CodexAdapterConfig{
  return {...loadCodexAdapterConfig({}),command:[process.execPath,fileURLToPath(new URL('../test-fixtures/codex/supplement-word-files.mjs',import.meta.url)),
    `--marker=${marker}`,`--python=${python}`,`--repo=${repository}`],work_root:workRoot,timeout_ms:30000,authoring_timeout_ms:60000};
}
