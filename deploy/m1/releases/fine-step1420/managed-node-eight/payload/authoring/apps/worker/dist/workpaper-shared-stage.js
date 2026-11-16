import { withPerformanceSpan, startPerformanceSpan } from '@bondbuddy/api/performance-trace';
import { workpaperChapters } from '@bondbuddy/contracts';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { WorkpaperSharedPlanSchema } from '@bondbuddy/contracts';
import { digest } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { checkpointStage } from '@bondbuddy/api/queue';
import { loadWorkpaperTemplate, publishWorkpaperItemResult, pauseSharedWorkpaperBatch } from '@bondbuddy/api/workpapers';
import { projectFilesRoot, projectFilePython } from './project-file-tools.js';
import { codexModelStage } from './run-pipeline.js';
import { loadCodexAdapterConfig, CodexOutputValidationError } from './codex-adapter.js';
import { loadM4RuntimeSkill } from './m4-runtime-skills.js';
import { m4ModelGate } from './m4-method.js';
import { m4ActionObserver, recordM4Progress } from './m4-action-progress.js';
import { checkedM4File, M4_FILE_MAX, m4ToolHashes } from './m4-file-workspace.js';
import { verifiedFileLinks } from './project-file-evidence.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareProgressiveGroup, progressiveItemPlanIdentity, progressivePlanGroup, WORKPAPER_PLAN_GROUP_SIZE } from './workpaper-progressive-groups.js';
import { workpaperMethodHash } from './workpaper-method.js';
import { withModelStagePerformance } from './model-performance.js';
const MAX_SNAPSHOT = 64 * 1024 * 1024;
const hash = (v) => inputManifestHash(v);
async function python(ctx, args, helper = 'bondbuddy_workpaper_batch.py') {
    const operation = args[0] === 'extract' ? 'material.extract' : args[0] === 'validate' ? 'document.quality_check' : 'document.render';
    try {
        return await withPerformanceSpan(operation, { operation: args[0] }, () => promisify(execFile)(process.env.BONDBUDDY_WORD_PYTHON ?? process.env.BONDBUDDY_TEST_PYTHON ?? 'python3', ['-B', join(projectFilesRoot, 'python', helper), ...args], { cwd: projectFilesRoot, env: { ...process.env, PYTHONPATH: join(projectFilesRoot, 'python'), PYTHONDONTWRITEBYTECODE: '1' }, signal: ctx.signal, timeout: 300000, maxBuffer: 16384 }));
    }
    catch (error) {
        const code = /^(?:BB_WORKPAPER_ERROR=|ValueError: )(WORKPAPER_[A-Z_]+)\s*$/m.exec(String(error.stderr ?? ''))?.[1];
        if (code)
            throw new WorkpaperOperationError(code);
        throw error;
    }
}
class WorkpaperOperationError extends Error {
}
class WorkpaperItemError extends Error {
}
// Only evidence/content failures are item-local. Missing image capability,
// source corruption, storage, permissions, cancellation and unknown failures
// must never be treated as permission to advance the rest of the batch.
export function isWorkpaperItemError(error) {
    return error instanceof WorkpaperItemError || error instanceof WorkpaperOperationError && isWorkpaperItemCode(error.message);
}
export function isWorkpaperItemCode(code) {
    return /^WORKPAPER_(?:PLAN_(?:VERSION_INVALID|SCOPE_MISMATCH|FULL_READING_REQUIRED|EXCLUSION_INVALID|EXCLUSION_DUPLICATE|ITEM_MISMATCH|UNKNOWN_FACT|USED_AND_EXCLUDED|UNMAPPED_DISCLOSURE)|CALC_[A-Z_]+|REQUIREMENT_EMPTY|REASON_GENERIC|DECISION_UNGROUNDED|DECISION_INVALID|DISCLOSED_FACT_REQUIRED|SILENCE_NOT_NONAPPLICABILITY|DUPLICATE_EXPLANATION|SPECIFIC_MISSING_EVIDENCE_REQUIRED|MISSING_MATERIAL_GENERIC|ORIGINAL_EVIDENCE_REQUIRED|NARRATIVE_UNGROUNDED|NARRATIVE_NUMBER_NOT_DISCLOSED|PLACEHOLDER_OR_SOURCE_LABEL|RENDER_FACT_LOST|PDF_PAGE_NOT_MAPPED|IMAGE_REVIEW_REQUIRED|IMAGE_REVIEW_INVALID)$/.test(code);
}
/** A stopped callback is not itself a failure. Only the exact current item's
 * settled durable failure is authoritative; cancelled, replaced, leased and
 * provider-reconciliation states deliberately do not match. */
export async function stoppedWorkpaperFailure(ctx, batch, item, logicalCallId) {
    const row = (await ctx.pool.query(`SELECT o.error_code FROM bb_workpaper_items i
    JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
    JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
    JOIN LATERAL (SELECT a.* FROM bb_model_call_attempts a WHERE a.owner_user_id=j.owner_user_id AND a.job_id=j.id AND a.logical_call_id=$6 ORDER BY a.attempt_no DESC LIMIT 1) a ON true
    JOIN LATERAL (SELECT o.* FROM bb_provider_call_observations o WHERE o.attempt_id=a.id AND o.owner_user_id=i.owner_user_id AND o.run_id=r.id AND o.job_id=j.id ORDER BY o.observed_at DESC,o.id DESC LIMIT 1) o ON true
    WHERE i.owner_user_id=$1 AND i.batch_id=$2 AND i.item_id=$3 AND i.run_id=$4 AND j.id=$5
    AND r.state='failed' AND j.state='failed' AND j.lease_token IS NULL AND j.lease_until IS NULL
    AND a.status='failed' AND o.outcome='failed' AND o.logical_call_id=$6
    AND (o.usage_status='measured' OR o.error_code='MODEL_PROVIDER_REQUEST_REJECTED')
    AND NOT EXISTS(SELECT 1 FROM bb_model_call_attempts pending WHERE pending.owner_user_id=i.owner_user_id AND pending.job_id=j.id AND pending.status='pending_reconcile')`, [ctx.run.owner_user_id, batch, item, ctx.run.id, ctx.lease.jobId, logicalCallId])).rows[0];
    return row?.error_code ?? null;
}
async function jsonFile(dir, name, value) {
    await writeFile(join(dir, name), JSON.stringify(value), { mode: 0o600 });
}
export function sharedPlanIdentity(manifests) {
    return hash({ version: 'workpaper-shared-v1', manifests });
}
export function checkedSharedPlan(value, source, manifests) {
    if (!Value.Check(WorkpaperSharedPlanSchema, value) || value.source_sha256 !== source.source.sha256)
        return false;
    const expected = manifests.map(m => m.input.workpaper.entry.id), actual = value.items.map(i => i.item_id);
    return new Set(actual).size === actual.length && actual.length === expected.length && expected.every(id => actual.includes(id));
}
/** Legacy shared batches keep one complete plan. Progressive batches share only
 * extraction and cache one immutable plan per item, so an unrelated unfinished
 * plan cannot delay delivery. Both retain the existing run/accounting pipeline. */
export async function sharedWorkpaperDocument(ctx, input, model = codexModelStage, providedConfig) {
    if (input.manifest.kind !== 'document')
        return { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' };
    const task = input.manifest.input.workpaper;
    const progressive = ['progressive_item_v1', 'grouped_batch_v1'].includes(task.execution ?? '');
    const owner = ctx.run.owner_user_id, batch = task.batch_id;
    const imagePrefix = `owners/${owner}/projects/${ctx.run.project_id}/workpaper-batches/${batch}/source-images/`;
    const imageBytes = async (image) => {
        if (!image.key || !image.key.startsWith(imagePrefix) || image.key !== imagePrefix + image.sha256)
            throw Error('WORKPAPER_IMAGE_UNSAFE');
        const bytes = await ctx.blobs.getIfExistsBounded(image.key, M4_FILE_MAX);
        if (!bytes || digest(bytes) !== image.sha256)
            throw Error('WORKPAPER_IMAGE_HASH_MISMATCH');
        return bytes;
    };
    const rows = (await ctx.pool.query(`SELECT i.manifest,i.attempt,b.progressive_plan,b.progressive_phase FROM bb_workpaper_items i JOIN bb_workpaper_batches b ON b.owner_user_id=i.owner_user_id AND b.id=i.batch_id
    WHERE i.owner_user_id=$1 AND i.batch_id=$2 ORDER BY i.ordinal`, [owner, batch])).rows;
    const manifests = rows.map(r => r.manifest);
    if (!manifests.length || manifests.some(m => m.input.workpaper?.execution !== task.execution) || !manifests.some(m => hash(m) === hash(input.manifest)))
        return { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' };
    const plannedManifests = progressive ? [input.manifest] : manifests;
    const identity = sharedPlanIdentity(manifests), config = providedConfig ?? loadCodexAdapterConfig();
    const planIdentity = progressive ? progressiveItemPlanIdentity(identity, input.manifest) : identity;
    const planTable = progressive ? 'bb_workpaper_progressive_plans' : 'bb_workpaper_shared_plans';
    const planParams = progressive ? [owner, batch, task.entry.id] : [owner, batch];
    const planWhere = `owner_user_id=$1 AND batch_id=$2${progressive ? ' AND item_id=$3' : ''}`;
    const logicalCallId = progressive ? 'workpaper-progressive-item-v1' : 'workpaper-shared-plan-v1';
    const gate = await m4ModelGate(ctx, config);
    if (gate)
        return gate;
    const skill = loadM4RuntimeSkill(progressive ? 'm4-workpaper-progressive' : 'm4-workpaper-batch');
    const groupSkill = progressive ? loadM4RuntimeSkill('m4-workpaper-progressive-group') : null;
    const method = workpaperMethodHash({ skill: skill.sha256,
        ...(progressive ? { progressive: { groupSkill: groupSkill.sha256, groupSize: WORKPAPER_PLAN_GROUP_SIZE, groupHelper: digest(await readFile(join(projectFilesRoot, 'python/bondbuddy_workpaper_progressive.py'))),
                renderer: digest(await readFile(join(projectFilesRoot, 'python/bondbuddy_workpaper_progressive_render.py'))) } } : {}),
        helper: digest(await readFile(join(projectFilesRoot, 'python/bondbuddy_workpaper_batch.py'))),
        sourceHelper: digest(await readFile(join(projectFilesRoot, 'python/bondbuddy_workpaper_source.py'))),
        tools: await m4ToolHashes(),
        templates: digest(await readFile(join(projectFilesRoot, 'knowledge/workpaper-templates/2026-10-27/catalog.json'))),
        model: { id: config.model_id, provider: config.model_provider, base: config.base_url, version: config.model_config_version, reasoning: config.reasoning_effort } });
    const methodKey = progressive ? 'workpaper_progressive_method_v1' : 'workpaper_shared_method_v1', prior = ctx.checkpoint[methodKey];
    if (prior && prior.hash !== method)
        return { kind: 'pause', stage: 'capability_not_ready', reason: 'm4_document_method_changed' };
    if (!prior) {
        await checkpointStage(ctx.pool, ctx.lease, methodKey, { hash: method });
        ctx.checkpoint[methodKey] = { hash: method };
    }
    const dir = await mkdtemp(join(tmpdir(), 'bb-shared-workpapers-'));
    const batchInput = { entries: plannedManifests.map(m => m.input.workpaper.entry), issuer_name: input.manifest.input.fields.issuer_name,
        requirements: input.manifest.input.supplemental_requirements ?? '', templates: plannedManifests.map(m => ({ item_id: m.input.workpaper.entry.id, template_id: m.knowledge?.template?.id })) };
    let phase = 'source';
    let sourceWait, planWait, sourcePolls = 0, planPolls = 0;
    try {
        const sourceGate = await ctx.validateBeforeModelCall?.();
        if (sourceGate)
            return sourceGate;
        const readSource = async () => (await ctx.pool.query('SELECT * FROM bb_workpaper_shared_sources WHERE owner_user_id=$1 AND batch_id=$2', [owner, batch])).rows[0];
        let sourceRow = await withPerformanceSpan('material.cache_lookup', { cache_kind: 'workpaper_source', batch_id: batch }, async (span) => {
            const value = await readSource();
            span.annotate({ cache_status: value ? 'hit' : 'miss' });
            return value;
        });
        const sourceAuthor = manifests[0].input.workpaper.entry.id;
        const sourceWasCached = !!sourceRow;
        if (!sourceRow && task.entry.id !== sourceAuthor)
            sourceWait = startPerformanceSpan('workpaper.source_wait', { batch_id: batch, work_item_id: task.entry.id, producer_item_id: sourceAuthor, wait_reason: 'shared_source', owns_worker_slot: true });
        while (!sourceRow && task.entry.id !== sourceAuthor) {
            sourcePolls++;
            ctx.signal.throwIfAborted();
            const author = (await ctx.pool.query(`SELECT b.state AS batch_state,r.state AS run_state,
        (r.state IN ('failed','cancelled','rejected','succeeded','test_completed') AND j.state=r.state AND j.lease_token IS NULL AND j.lease_until IS NULL
          AND NOT EXISTS(SELECT 1 FROM bb_model_call_attempts a WHERE a.owner_user_id=i.owner_user_id AND a.job_id=j.id AND a.status='pending_reconcile')) AS settled_terminal
        FROM bb_workpaper_items i
        JOIN bb_workpaper_batches b ON b.owner_user_id=i.owner_user_id AND b.id=i.batch_id
        LEFT JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
        LEFT JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
        WHERE i.owner_user_id=$1 AND i.batch_id=$2 AND i.item_id=$3`, [owner, batch, sourceAuthor])).rows[0];
            if (!author)
                throw Error('INPUT_REVISION_CONFLICT');
            if (author.settled_terminal) {
                sourceWait?.end('failed', { poll_count: sourcePolls, error_code: 'WORKPAPER_SOURCE_BLOCKED' });
                await pauseSharedWorkpaperBatch(ctx.pool, owner, batch, { itemId: task.entry.id, runId: ctx.run.id, jobId: ctx.lease.jobId, leaseToken: ctx.lease.token });
                return { kind: 'fail', code: 'WORKPAPER_SOURCE_BLOCKED' };
            }
            if (['paused', 'cancelled'].includes(author.batch_state) || ['paused', 'failed', 'cancelled', 'rejected', 'succeeded', 'test_completed'].includes(author.run_state)) {
                sourceWait?.end('paused', { poll_count: sourcePolls });
                return { kind: 'pause', stage: 'capability_not_ready', reason: 'workpaper_source_unavailable' };
            }
            await delay(100, undefined, { signal: ctx.signal });
            sourceRow = await readSource();
        }
        sourceWait?.end('succeeded', { poll_count: sourcePolls });
        const sourceReused = !!sourceRow;
        if (!sourceRow) {
            const sourceOutcome = await withPerformanceSpan('workpaper.source_prepare', { batch_id: batch, work_item_id: task.entry.id }, async (span) => {
                await recordM4Progress(ctx, 'm4_reading_materials');
                const pin = input.manifest.input.source_material, material = input.materials.find(m => hash(m.pin) === hash(pin));
                if (!material)
                    throw Error('WORKPAPER_SOURCE_UNAVAILABLE');
                const sourceGate = await ctx.validateBeforeModelCall?.();
                if (sourceGate) {
                    span.end(sourceGate.kind === 'pause' ? 'paused' : sourceGate.kind === 'fail' ? 'failed' : 'interrupted');
                    return sourceGate;
                }
                const bytes = await ctx.blobs.getIfExistsBounded(material.objectKey, M4_FILE_MAX);
                if (!bytes || digest(bytes) !== pin.sha256)
                    throw Error('INPUT_REVISION_CONFLICT');
                const path = join(dir, material.mediaType === 'application/pdf' ? 'source.pdf' : 'source.docx');
                await writeFile(path, bytes, { mode: 0o400 });
                await python(ctx, ['extract', path, join(dir, 'source-data.json')]);
                const snapshot = JSON.parse((await checkedM4File(dir, 'source-data.json', MAX_SNAPSHOT)).toString('utf8'));
                if (snapshot.source.sha256 !== pin.sha256)
                    throw Error('INPUT_REVISION_CONFLICT');
                // Private image bytes belong in Blob, not in PostgreSQL JSON. Later items
                // retrieve only their mapped graphics; PDF review pages are read once.
                for (const image of snapshot.images) {
                    const bytes = Buffer.from(image.data ?? '', 'base64');
                    if (digest(bytes) !== image.sha256)
                        throw Error('WORKPAPER_IMAGE_HASH_MISMATCH');
                    image.key = imagePrefix + image.sha256;
                    delete image.data;
                    await ctx.blobs.put(image.key, bytes, 'application/octet-stream');
                    await imageBytes(image);
                }
                await ctx.pool.query(`INSERT INTO bb_workpaper_shared_sources(owner_user_id,batch_id,input_hash,snapshot,snapshot_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [owner, batch, identity, snapshot, hash(snapshot)]);
                sourceRow = (await ctx.pool.query('SELECT * FROM bb_workpaper_shared_sources WHERE owner_user_id=$1 AND batch_id=$2', [owner, batch])).rows[0];
            });
            if (sourceOutcome)
                return sourceOutcome;
        }
        await withPerformanceSpan(sourceReused ? 'workpaper.source_reuse' : 'workpaper.source_validate', { batch_id: batch, work_item_id: task.entry.id, producer_item_id: sourceAuthor, cache_status: sourceReused ? (sourceWasCached ? 'hit' : 'waited') : 'miss' }, span => {
            if (sourceRow.input_hash.trim() !== identity || hash(sourceRow.snapshot) !== sourceRow.snapshot_hash.trim())
                throw Error('INPUT_REVISION_CONFLICT');
            if (sourceReused)
                span.end('reused');
        });
        const source = sourceRow.snapshot;
        await jsonFile(dir, 'source-data.json', source);
        await jsonFile(dir, 'batch-input.json', batchInput);
        const preparePlan = async (cwd, planInput) => {
            for (const name of ['scratch', 'output', 'images'])
                await mkdir(join(cwd, name), { mode: 0o700 });
            await jsonFile(cwd, 'input.json', planInput);
            await jsonFile(cwd, 'batch-input.json', planInput);
            await jsonFile(cwd, 'source-data.json', source);
            await jsonFile(cwd, 'batch-plan-schema.json', WorkpaperSharedPlanSchema);
            for (const image of source.images) {
                if (!/^image-\d+$/.test(image.id) || !/^[a-zA-Z0-9._-]+$/.test(image.name))
                    throw Error('WORKPAPER_IMAGE_UNSAFE');
                await writeFile(join(cwd, 'images', image.id + '-' + image.name), await imageBytes(image), { mode: 0o400 });
            }
        };
        const handleModelOutcome = async (outcome, callId) => {
            const failure = outcome.kind === 'stopped' ? await stoppedWorkpaperFailure(ctx, batch, task.entry.id, callId) : outcome.kind === 'fail' ? outcome.code : null;
            if (failure && (!progressive || failure !== 'MODEL_OUTPUT_SCHEMA_INVALID'))
                await pauseSharedWorkpaperBatch(ctx.pool, owner, batch, { itemId: task.entry.id, runId: ctx.run.id, jobId: ctx.lease.jobId, ...(outcome.kind === 'stopped' ? {} : { leaseToken: ctx.lease.token }) });
            return outcome;
        };
        phase = 'plan';
        let saved = await withPerformanceSpan('workpaper.plan_cache_lookup', { batch_id: batch, work_item_id: task.entry.id }, async (span) => {
            const value = (await ctx.pool.query(`SELECT * FROM ${planTable} WHERE ${planWhere}`, planParams)).rows[0];
            span.annotate({ cache_status: value ? 'hit' : 'miss' });
            return value;
        });
        const planWasCached = !!saved;
        if (!progressive && !saved && task.entry.id !== sourceAuthor)
            planWait = startPerformanceSpan('workpaper.plan_wait', { batch_id: batch, work_item_id: task.entry.id, producer_item_id: sourceAuthor, logical_call_id: logicalCallId, wait_reason: 'shared_plan', owns_worker_slot: true });
        while (!progressive && !saved && task.entry.id !== sourceAuthor) {
            planPolls++;
            ctx.signal.throwIfAborted();
            const author = (await ctx.pool.query(`SELECT b.state AS batch_state,r.state AS run_state FROM bb_workpaper_items i
        JOIN bb_workpaper_batches b ON b.owner_user_id=i.owner_user_id AND b.id=i.batch_id
        LEFT JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
        WHERE i.owner_user_id=$1 AND i.batch_id=$2 AND i.item_id=$3`, [owner, batch, sourceAuthor])).rows[0];
            if (!author)
                throw Error('INPUT_REVISION_CONFLICT');
            if (['paused', 'cancelled'].includes(author.batch_state) || ['paused', 'failed', 'cancelled', 'rejected', 'succeeded', 'test_completed'].includes(author.run_state)) {
                planWait?.end('paused', { poll_count: planPolls });
                return { kind: 'pause', stage: 'capability_not_ready', reason: 'workpaper_authoring_unavailable' };
            }
            await delay(100, undefined, { signal: ctx.signal });
            saved = (await ctx.pool.query(`SELECT * FROM ${planTable} WHERE ${planWhere}`, planParams)).rows[0];
        }
        planWait?.end('succeeded', { poll_count: planPolls });
        let planReused = !!saved, producerLogicalCallId = progressive ? undefined : logicalCallId;
        const grouping = task.execution === 'grouped_batch_v1' ? { phase: 'remaining', chapters: workpaperChapters(manifests.map(m => m.input.workpaper.entry)), trial_item_ids: [], max_parallel: 4 } : rows[0].progressive_plan ? { ...rows[0].progressive_plan, phase: rows[0].progressive_phase } : undefined;
        const group = progressive ? progressivePlanGroup(manifests, grouping, task.entry.id) : null;
        const itemAttempt = Number(rows.find(r => r.manifest.input.workpaper.entry.id === task.entry.id)?.attempt ?? 1);
        if (!saved && group && itemAttempt === 1) {
            const groupInput = { ...batchInput, entries: group.manifests.map(m => m.input.workpaper.entry), templates: group.manifests.map(m => ({ item_id: m.input.workpaper.entry.id, template_id: m.knowledge?.template?.id })) };
            const prepared = await prepareProgressiveGroup(ctx, { batch, itemId: task.entry.id, group, batchIdentity: identity, method, source, dir, input: groupInput, skill: groupSkill, config, model,
                prepare: preparePlan, validPlan: (value, expected) => checkedSharedPlan(value, source, expected), itemError: isWorkpaperItemCode });
            if (prepared.kind === 'outcome')
                return handleModelOutcome(prepared.outcome, prepared.logicalCallId);
            if (prepared.kind === 'item_failed')
                return { kind: 'fail', code: 'VALIDATION_FAILED' };
            if (prepared.kind === 'ready') {
                planReused = true;
                producerLogicalCallId = 'workpaper-group-' + group.id.slice(0, 40);
                saved = (await ctx.pool.query(`SELECT * FROM ${planTable} WHERE ${planWhere}`, planParams)).rows[0];
                if (!saved || saved.plan_hash.trim() !== prepared.planHash)
                    throw Error('INPUT_REVISION_CONFLICT');
            }
            // An explicit retry of an invalid item and a typed group-format fallback
            // both use a new single-item plan; accepted siblings keep their caches.
        }
        if (!saved) {
            const observer = m4ActionObserver(ctx, 'document');
            try {
                const outcome = await withModelStagePerformance('workpaper.plan_prepare', { batch_id: batch, work_item_id: task.entry.id, author_run_id: ctx.run.id, logical_call_id: logicalCallId }, () => model({ name: progressive ? 'workpaper_progressive_plan_v1' : 'workpaper_shared_plan_v1', logicalCallId, config: { ...config, max_schema_reasks: 0, max_output_bytes: MAX_SNAPSHOT },
                    schema: WorkpaperSharedPlanSchema, validate: v => checkedSharedPlan(v, source, plannedManifests), resultSchemaVersion: 'workpaper-shared-plan-v1', templateVersion: method,
                    buildPrompt: async () => skill.content, onActivity: e => observer.onEvent(e),
                    fileWorkspace: { prepare: cwd => preparePlan(cwd, batchInput), collect: async (cwd) => {
                            let plan;
                            try {
                                plan = JSON.parse((await checkedM4File(join(cwd, 'output'), 'batch-plan.json', MAX_SNAPSHOT)).toString('utf8'));
                            }
                            catch (error) {
                                if (error instanceof SyntaxError || error.code === 'ENOENT')
                                    throw new CodexOutputValidationError('WORKPAPER_PLAN_INVALID');
                                throw error;
                            }
                            if (plan && typeof plan === 'object' && 'source_sha256' in plan && plan.source_sha256 !== source.source.sha256)
                                throw Error('INPUT_REVISION_CONFLICT');
                            if (!checkedSharedPlan(plan, source, plannedManifests))
                                throw new CodexOutputValidationError('WORKPAPER_PLAN_INVALID');
                            // Validate against host-owned inputs, never agent-modified files.
                            await jsonFile(dir, 'batch-plan.json', plan);
                            try {
                                await python(ctx, ['validate', join(dir, 'source-data.json'), join(dir, 'batch-input.json'), join(dir, 'batch-plan.json')]);
                            }
                            catch (error) {
                                if (!progressive || isWorkpaperItemError(error))
                                    throw new CodexOutputValidationError('WORKPAPER_PLAN_CONTENT_INVALID');
                                throw error;
                            }
                            return plan;
                        } }
                }).run(ctx));
                if (outcome.kind !== 'done') {
                    return handleModelOutcome(outcome, logicalCallId);
                }
                if (!checkedSharedPlan(outcome.value, source, plannedManifests))
                    throw new WorkpaperItemError('WORKPAPER_PLAN_INVALID');
                // Also validate a journal replay. The model may have completed before
                // the worker crashed and before this batch cache was committed.
                await jsonFile(dir, 'batch-plan.json', outcome.value);
                await python(ctx, ['validate', join(dir, 'source-data.json'), join(dir, 'batch-input.json'), join(dir, 'batch-plan.json')]);
                // Store only after the durable model journal has accepted the result.
                await withPerformanceSpan('workpaper.plan.persist', { batch_id: batch, work_item_id: task.entry.id, author_run_id: ctx.run.id, logical_call_id: logicalCallId }, () => ctx.pool.query(`INSERT INTO ${planTable}(owner_user_id,batch_id,input_hash,method_hash,source_hash,plan,plan_hash,author_run_id${progressive ? ',item_id' : ''})
          VALUES($1,$2,$3,$4,$5,$6,$7,$8${progressive ? ',$9' : ''}) ON CONFLICT DO NOTHING`, [owner, batch, planIdentity, method, hash(source), outcome.value, hash(outcome.value), ctx.run.id, ...(progressive ? [task.entry.id] : [])]));
                saved = (await ctx.pool.query(`SELECT * FROM ${planTable} WHERE ${planWhere}`, planParams)).rows[0];
            }
            finally {
                await observer.drain();
            }
        }
        const planGate = await withPerformanceSpan(planReused ? 'workpaper.plan_reuse' : 'workpaper.plan_validate', { batch_id: batch, work_item_id: task.entry.id, author_run_id: saved.author_run_id,
            ...(producerLogicalCallId ? { logical_call_id: producerLogicalCallId } : {}), cache_status: planReused ? (planWasCached ? 'hit' : planWait ? 'waited' : 'group') : 'miss' }, span => {
            if (saved.input_hash.trim() !== planIdentity || saved.source_hash.trim() !== hash(source) || saved.plan_hash.trim() !== hash(saved.plan))
                throw Error('INPUT_REVISION_CONFLICT');
            if (saved.method_hash.trim() !== method) {
                span.end('paused');
                return { kind: 'pause', stage: 'capability_not_ready', reason: 'm4_document_method_changed' };
            }
            if (!checkedSharedPlan(saved.plan, source, plannedManifests))
                throw Error('WORKPAPER_PLAN_INVALID');
            if (planReused)
                span.end('reused');
        });
        if (planGate)
            return planGate;
        const plan = saved.plan, item = plan.items.find(i => i.item_id === task.entry.id);
        const beforeRender = await ctx.validateBeforeModelCall?.();
        if (beforeRender)
            return beforeRender;
        phase = 'render';
        await recordM4Progress(ctx, 'm4_writing_files');
        const template = loadWorkpaperTemplate({ code: task.entry.code, title: item.decision.status === 'generate' ? task.entry.title : '不适用说明' });
        // The generation template must still match the immutable input pin.
        if (item.decision.status === 'generate' && template.sha256 !== input.manifest.knowledge?.template?.sha256)
            throw Error('INPUT_REVISION_CONFLICT');
        await writeFile(join(dir, 'template.docx'), template.bytes, { mode: 0o400 });
        await jsonFile(dir, 'format.json', template.format);
        await jsonFile(dir, 'batch-plan.json', plan);
        const relevantImages = new Set(plan.image_reviews.filter(r => r.item_ids.includes(task.entry.id)).map(r => r.image_id));
        const renderImages = await Promise.all(source.images.map(async (image) => relevantImages.has(image.id) && !image.page ? { ...image, data: (await imageBytes(image)).toString('base64') } : image));
        await jsonFile(dir, 'source-data.json', { ...source, images: renderImages });
        const out = join(dir, 'output');
        await python(ctx, ['render-validated', join(dir, 'source-data.json'), join(dir, 'batch-input.json'), join(dir, 'batch-plan.json'), task.entry.id, join(dir, 'template.docx'), join(dir, 'format.json'), out], progressive ? 'bondbuddy_workpaper_progressive_render.py' : 'bondbuddy_workpaper_batch.py');
        const note = await checkedM4File(out, 'preparation-note.docx');
        const outputBytes = await checkedM4File(out, 'document.docx');
        await projectFilePython(ctx, ['inspect', join(out, 'document.docx'), join(dir, 'target.json')]);
        const target = JSON.parse((await checkedM4File(dir, 'target.json', MAX_SNAPSHOT)).toString('utf8'));
        const proposed = JSON.parse((await checkedM4File(out, 'file-links.json', MAX_SNAPSHOT)).toString('utf8')).links;
        const links = verifiedFileLinks(source.source, target, proposed, 100000);
        if (links.length !== proposed.length)
            throw new WorkpaperItemError('WORKPAPER_CONTENT_LINKS_MISSING');
        const files = {};
        for (const name of ['document.docx', 'preparation-note.docx']) {
            const bytes = name === 'document.docx' ? outputBytes : note, sha256 = digest(bytes);
            const key = `owners/${owner}/projects/${ctx.run.project_id}/runs/${ctx.run.id}/m4-documents/shared-${saved.plan_hash.trim()}/${sha256}/${name}`;
            await ctx.blobs.put(key, bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            const readback = await ctx.blobs.getIfExistsBounded(key, M4_FILE_MAX);
            if (!readback || digest(readback) !== sha256)
                throw Error('M4_OUTPUT_STORE_FAILED');
            files[name] = { key, sha256, byte_size: bytes.length };
        }
        const decision = { ...item.decision, citations: item.decision.citations.map(c => ({ ...c, location: source.source.spans.find(s => s.id === c.span_id).location })) };
        // Explanations must be accepted before the next billing milestone. Otherwise
        // a low balance could pause before the existing no-charge refund is applied.
        await publishWorkpaperItemResult(ctx.pool, owner, ctx.run.id, decision, decision.status === 'generate' ? null : { ...files['document.docx'], filename: '' });
        return { kind: 'done', value: { version: 'codex-m4-document-v1', input_hash: ctx.run.input_hash.trim(), skill_sha256: skill.sha256, method_hash: method, internal_note: true,
                workpaper_decision: decision, files, project_file_links: { links, source_sha256: source.source.sha256, target_sha256: digest(outputBytes), warnings: source.source.warnings } } };
    }
    catch (error) {
        sourceWait?.end(ctx.signal.aborted ? 'cancelled' : 'failed', { poll_count: sourcePolls });
        planWait?.end(ctx.signal.aborted ? 'cancelled' : 'failed', { poll_count: planPolls });
        if (progressive) {
            if (ctx.signal.aborted)
                return { kind: 'stopped' };
            if (phase !== 'source' && isWorkpaperItemError(error))
                return { kind: 'fail', code: phase === 'render' ? 'WORD_DELIVERY_UNAVAILABLE' : 'VALIDATION_FAILED' };
            await pauseSharedWorkpaperBatch(ctx.pool, owner, batch, { itemId: task.entry.id, runId: ctx.run.id, jobId: ctx.lease.jobId, leaseToken: ctx.lease.token });
            return { kind: 'pause', stage: 'capability_not_ready', reason: phase === 'source' ? 'workpaper_source_unavailable' : 'workpaper_authoring_unavailable' };
        }
        // A failed shared extraction/plan must not automatically repeat one expensive
        // model attempt per queued file. An explicit resume can retry the batch.
        const planned = (await ctx.pool.query('SELECT 1 FROM bb_workpaper_shared_plans WHERE owner_user_id=$1 AND batch_id=$2', [owner, batch])).rowCount;
        if (!planned)
            await pauseSharedWorkpaperBatch(ctx.pool, owner, batch);
        throw error;
    }
    finally {
        sourceWait?.end(ctx.signal.aborted ? 'cancelled' : 'interrupted', { poll_count: sourcePolls, wait_reason: 'scope_ended' });
        planWait?.end(ctx.signal.aborted ? 'cancelled' : 'interrupted', { poll_count: planPolls, wait_reason: 'scope_ended' });
        await rm(dir, { recursive: true, force: true });
    }
}
