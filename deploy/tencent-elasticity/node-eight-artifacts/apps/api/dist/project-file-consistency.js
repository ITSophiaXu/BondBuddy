import { assertBatchAdmission, SHARED_BATCH_CAPACITY } from './batch-admission.js';
import { Value } from '@sinclair/typebox/value';
import { PROJECT_FILE_UPDATE_PRICE, safeBillingNumber, OUTCOME_PRICE_VERSION, isOutcomePriceVersion, projectFileSchemas, ProjectFilePatchInputSchema } from '@bondbuddy/contracts';
import { project, transaction, uid, conflict, missing, Problem, date, assertCanonicalBusinessRunIdle } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { projectFileSource, projectFileVersions, readProjectFileAsset } from './project-file-storage.js';
import { enqueue } from './queue.js';
import { requireFileUpdateCredits, reserveFileUpdate, reserveFileCheck, fileCheckPrice, fileUpdatePrice } from './project-file-billing.js';
import { OUTCOME_MODE, outcomeMetadata } from './outcome-pricing.js';
import { assertScopeQuote, acceptScopeBatch } from './scope-quotations.js';
const terminal = ['succeeded', 'failed', 'cancelled', 'rejected', 'test_completed'];
async function available(c, owner, id) {
    const p = await project(c, owner, id, true);
    if (p.archived_at)
        throw conflict('INPUT_REVISION_CONFLICT', '请先恢复已归档项目。');
    await assertCanonicalBusinessRunIdle(c, owner, p);
    if ((await c.query("SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND task_kind<>'qa' AND NOT(state=ANY($3::text[]))", [owner, id, terminal])).rowCount)
        throw conflict('PROJECT_RUN_ACTIVE', '此项目正在处理其他任务，请完成或结束后再试。');
    return p;
}
async function event(c, owner, id, type, payload) {
    await c.query('UPDATE bb_projects SET updated_at=now() WHERE owner_user_id=$1 AND id=$2', [owner, id]);
    await c.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,$4,$5)", [uid(), owner, id, type, payload]);
}
async function createOperation(c, owner, id, key, requestHash, manifest, commercial = false, expectedPoints, scopeQuoteId, acceptanceId, batchRun) {
    const p = batchRun ? await project(c, owner, id, true) : await available(c, owner, id), hash = inputManifestHash(manifest);
    const revision = Number((await c.query('SELECT COALESCE(max(revision),0)+1 AS next FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2', [owner, id])).rows[0].next);
    await c.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,$2,$3,$4,$5,$6,'[]','[]')`, [id, revision, owner, p.draft_revision, hash, manifest]);
    await c.query('UPDATE bb_projects SET latest_input_revision=$3,updated_at=now() WHERE owner_user_id=$1 AND id=$2', [owner, id, revision]);
    const run = (await c.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
    VALUES($1,$2,$3,$4,$5,$6,'generation',$7,'queued') RETURNING *`, [batchRun ?? uid(), owner, id, revision, hash, key, requestHash])).rows[0];
    await c.query('INSERT INTO bb_project_file_operations(run_id,owner_user_id,project_id,operation,manifest,input_hash) VALUES($1,$2,$3,$4,$5,$6)', [run.id, owner, id, manifest.operation, manifest, hash]);
    if (manifest.operation === 'patch')
        await reserveFileUpdate(c, owner, run, manifest, commercial, expectedPoints, scopeQuoteId, acceptanceId);
    else if (commercial)
        await reserveFileCheck(c, owner, run, manifest, expectedPoints, scopeQuoteId, acceptanceId);
    await enqueue(c, run, 'project_file_v1');
    await event(c, owner, id, 'project.file_' + manifest.operation + '_started', { run_id: run.id });
    return run;
}
/** Only a pre-persisted immutable batch item can bypass the one-file API preflight. */
export async function createBatchedFileCheck(c, owner, id, runId, manifest) {
    const ordinary = (await c.query(`SELECT i.*,a.attempt,s.id AS acceptance_id FROM bb_project_file_check_attempts a JOIN bb_project_file_check_batch_items i
    ON i.owner_user_id=a.owner_user_id AND i.batch_id=a.batch_id AND i.ordinal=a.ordinal
    JOIN bb_project_file_check_batches b ON b.owner_user_id=i.owner_user_id AND b.id=i.batch_id
    LEFT JOIN bb_scope_acceptances s ON s.owner_user_id=i.owner_user_id AND s.context='file_check_batch' AND s.context_id=i.batch_id AND s.item_index=i.ordinal
    WHERE a.owner_user_id=$1 AND a.run_id=$2 AND b.project_id=$3`, [owner, runId, id])).rows[0];
    if (ordinary) {
        if (manifest.files.length !== 1 || manifest.files[0].file_version_id !== ordinary.file_version_id || inputManifestHash(ordinary.manifest) !== inputManifestHash(manifest) || ordinary.scope_quote_id && !ordinary.acceptance_id)
            throw missing();
        return createOperation(c, owner, id, 'ordinary-file-check:' + ordinary.batch_id + ':' + ordinary.ordinal + ':' + ordinary.attempt, inputManifestHash(manifest), manifest, true, safeBillingNumber(ordinary.points), ordinary.scope_quote_id, ordinary.acceptance_id, runId);
    }
    const item = (await c.query(`SELECT i.*,b.source,b.project_id FROM bb_workpaper_paid_check_items i JOIN bb_workpaper_paid_check_batches b
    ON b.owner_user_id=i.owner_user_id AND b.id=i.batch_id WHERE i.owner_user_id=$1 AND i.run_id=$2 AND b.project_id=$3`, [owner, runId, id])).rows[0];
    if (!item || manifest.files.length !== 1 || manifest.files[0].file_version_id !== item.file_version_id || inputManifestHash(item.source) !== inputManifestHash(manifest.source))
        throw missing();
    return createOperation(c, owner, id, 'workpaper-file-check:' + item.batch_id + ':' + item.ordinal, inputManifestHash(manifest), manifest, true, Number(item.points), item.scope_quote_id, undefined, runId);
}
async function projectFileChecks(db, owner, id, runId, commercial = false) {
    await project(db, owner, id);
    const current = await projectFileSource(db, owner, id);
    const rows = (await db.query(`SELECT o.*,r.state,r.stage,q.points AS check_points,q.charged_file_versions,q.price_version AS check_price_version,q.scope_quote_id,q.scope_lines FROM bb_project_file_operations o JOIN bb_runs r ON r.owner_user_id=o.owner_user_id AND r.project_id=o.project_id AND r.id=o.run_id LEFT JOIN bb_project_file_check_quotes q ON q.run_id=o.run_id AND q.owner_user_id=o.owner_user_id
    WHERE o.owner_user_id=$1 AND o.project_id=$2 AND o.operation='check' ${runId === undefined ? 'ORDER BY o.created_at DESC LIMIT 30' : 'AND o.run_id=$3'}`, runId === undefined ? [owner, id] : [owner, id, runId])).rows;
    const updates = (await db.query(`SELECT a.*,r.state,v.id AS new_version_id FROM bb_project_file_acceptances a JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id
    LEFT JOIN bb_project_file_versions v ON v.owner_user_id=a.owner_user_id AND v.run_id=a.run_id WHERE a.owner_user_id=$1 AND a.check_run_id=ANY($2::text[])`, [owner, rows.map(r => r.run_id)])).rows;
    const batches = (await db.query("SELECT * FROM bb_project_file_update_batches WHERE owner_user_id=$1 AND project_id=$2 AND state IN ('queued','running','paused')", [owner, id])).rows;
    return rows.map(r => ({ run_id: r.run_id, state: r.state, stage: r.stage, created_at: date(r.created_at), source: r.manifest.source, ...(r.check_price_version ? { points: Number(r.check_points), ...outcomeMetadata(Number(r.check_points), Number(r.check_points), 1, r.check_price_version), scope_quote_id: r.scope_quote_id ?? undefined, quote_status: 'ready', scope_lines: r.scope_lines ?? [] } : {}), ...(commercial ? { update_price_version: OUTCOME_PRICE_VERSION } : {}),
        stale: r.manifest.source.version_id !== current?.version_id || r.manifest.source.selection_revision !== current?.selection_revision,
        sha256: r.result_hash?.trim() ?? null, result: r.state === 'succeeded' ? r.result : null,
        files: r.manifest.files.map((f) => ({ file_id: f.file_id, file_version_id: f.file_version_id, filename: f.filename, sequence: f.sequence })),
        updates: [...updates.filter(a => a.check_run_id === r.run_id).map(a => ({ file_version_id: a.file_version_id, issue_ids: a.issue_ids, run_id: a.run_id, state: a.state, new_version_id: a.new_version_id ?? null })),
            ...batches.filter(b => b.check_run_id === r.run_id).flatMap(b => b.items.filter(i => !i.run_id).map(i => ({ file_version_id: i.manifest.file_version_id, issue_ids: i.issue_ids, run_id: null, state: b.state === 'paused' ? 'paused' : 'queued', new_version_id: null })))] }));
}
export function readProjectFileChecks(db, owner, id, commercial = false) {
    return projectFileChecks(db, owner, id, undefined, commercial);
}
export async function readProjectFileCheck(db, owner, id, runId, commercial = false) {
    const checks = await projectFileChecks(db, owner, id, runId, commercial);
    if (checks.length !== 1)
        throw missing();
    return checks[0];
}
export async function readProjectFileUpdateCheck(db, owner, id, runId, commercial = false) {
    await project(db, owner, id);
    const accepted = (await db.query(`SELECT a.check_run_id,a.file_version_id,o.manifest FROM bb_project_file_acceptances a
    JOIN bb_project_file_operations o ON o.owner_user_id=a.owner_user_id AND o.run_id=a.run_id
    JOIN bb_runs r ON r.owner_user_id=o.owner_user_id AND r.project_id=o.project_id AND r.id=o.run_id
    WHERE a.owner_user_id=$1 AND o.project_id=$2 AND a.run_id=$3 AND o.operation='patch'`, [owner, id, runId])).rows;
    if (accepted.length !== 1)
        throw missing();
    const row = accepted[0], manifest = row.manifest;
    if (!Value.Check(ProjectFilePatchInputSchema, manifest) || manifest.check_run_id !== row.check_run_id || manifest.file_version_id !== row.file_version_id)
        throw missing();
    const check = await readProjectFileCheck(db, owner, id, row.check_run_id, commercial), updates = check.updates.filter(update => update.run_id === runId), files = check.files.filter(file => file.file_version_id === row.file_version_id);
    if (updates.length !== 1 || updates[0].file_version_id !== row.file_version_id || files.length !== 1 || files[0].file_id !== manifest.file_id || check.sha256 !== manifest.check_sha256 ||
        inputManifestHash(check.source) !== inputManifestHash(manifest.source))
        throw missing();
    return check;
}
async function currentSource(c, owner, id, expected) {
    const s = await projectFileSource(c, owner, id);
    if (!s || s.version_id !== expected.version_id || (expected.selection_revision !== undefined && s.selection_revision !== expected.selection_revision))
        throw conflict('INPUT_REVISION_CONFLICT', '项目当前募集书已变化，请重新检查后再接受修改。');
    return s;
}
/** Use the same validated, immutable work scope for quoting and accepting each file. */
async function prepareUpdateItems(c, owner, id, checkId, expectedHash, selections) {
    const check = (await c.query(`SELECT o.* FROM bb_project_file_operations o JOIN bb_runs r ON r.owner_user_id=o.owner_user_id AND r.id=o.run_id
    WHERE o.owner_user_id=$1 AND o.project_id=$2 AND o.run_id=$3 AND o.operation='check' AND r.state='succeeded'`, [owner, id, checkId])).rows[0];
    if (!check)
        throw missing();
    if (!check.result || check.result_hash.trim() !== expectedHash || inputManifestHash(check.result) !== expectedHash)
        throw conflict('INPUT_REVISION_CONFLICT', '检查结果已变化，请刷新。');
    await currentSource(c, owner, id, check.manifest.source);
    if (!selections.length || new Set(selections.map(f => f.file_version_id)).size !== selections.length)
        throw new Problem(422, 'VALIDATION_FAILED', '请选择文件且不能重复。');
    const items = [];
    for (const selection of selections) {
        const original = check.manifest.files.find((f) => f.file_version_id === selection.file_version_id), result = check.result.files.find((f) => f.file_version_id === selection.file_version_id);
        if (!original || !result)
            throw missing();
        const family = (await c.query('SELECT * FROM bb_project_files WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE', [owner, id, original.file_id])).rows[0];
        if (!family)
            throw missing();
        if (family.latest_version_id !== original.file_version_id)
            throw conflict('INPUT_REVISION_CONFLICT', '关联文件已有新版本，请重新检查后再更新。');
        if ((await c.query(`SELECT 1 FROM bb_project_file_acceptances a JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id
      WHERE a.owner_user_id=$1 AND a.check_run_id=$2 AND a.file_version_id=$3 AND r.state='succeeded'`, [owner, checkId, original.file_version_id])).rowCount)
            throw conflict('INPUT_REVISION_CONFLICT', '此文件本轮修订版已生成，请下载成果；无需重复更新或扣费。');
        const findings = result.findings.filter((f) => f.kind === 'conflict' && f.replacement !== null);
        if (!findings.length)
            throw new Problem(422, 'VALIDATION_FAILED', '此文件没有可自动更新的冲突；待确认事项请补充材料或人工处理。');
        await readProjectFileAsset(c, owner, original.asset);
        for (const f of findings)
            if (!f.source_span_id || !f.source_quote)
                throw conflict('INPUT_REVISION_CONFLICT', '缺少可核验依据。');
        items.push({ manifest: { version: 'project-file-operation-v1', operation: 'patch', source: check.manifest.source, check_run_id: checkId, check_sha256: check.result_hash.trim(),
                file_id: original.file_id, file_version_id: original.file_version_id, expected_current_version_id: family.latest_version_id, filename: original.filename, asset: original.asset, findings,
                manual_findings: result.findings.filter((f) => f.kind === 'manual') }, issue_ids: findings.map(f => f.id), run_id: null, error: null, attempt: 1 });
    }
    return items;
}
export async function advanceProjectFileUpdates(pool) {
    return transaction(pool, async (c) => {
        const b = (await c.query(`SELECT b.* FROM bb_project_file_update_batches b JOIN bb_projects p ON p.id=b.project_id AND p.owner_user_id=b.owner_user_id
      WHERE b.state IN ('queued','running') AND p.deleted_at IS NULL AND p.archived_at IS NULL ORDER BY b.updated_at,b.id FOR UPDATE OF b SKIP LOCKED LIMIT 1`)).rows[0];
        if (!b)
            return false;
        const items = b.items, next = items.find(i => !i.run_id);
        const running = items.filter(i => i.run_id).map(i => i.run_id);
        const states = (await c.query('SELECT id,state FROM bb_runs WHERE owner_user_id=$1 AND id=ANY($2::text[])', [b.owner_user_id, running])).rows;
        if (states.length !== running.length)
            throw conflict('INPUT_REVISION_CONFLICT', '批次任务记录不可用。');
        if (states.filter(r => !terminal.includes(r.state)).length >= SHARED_BATCH_CAPACITY) {
            await c.query('UPDATE bb_project_file_update_batches SET updated_at=now() WHERE id=$1', [b.id]);
            return false;
        }
        if (states.some(r => terminal.includes(r.state) && r.state !== 'succeeded')) {
            await c.query("UPDATE bb_project_file_update_batches SET state='paused',updated_at=now() WHERE id=$1", [b.id]);
            return true;
        }
        if (!next && states.some(r => !terminal.includes(r.state)))
            return false;
        if (!next) {
            await c.query("UPDATE bb_project_file_update_batches SET state='complete',updated_at=now() WHERE id=$1", [b.id]);
            return true;
        }
        await c.query('SAVEPOINT begin_file_patch');
        try {
            const p = await project(c, b.owner_user_id, b.project_id, true);
            await assertBatchAdmission(c, b.owner_user_id, p.execution_scope_project_id ?? p.id, 'patch:' + b.id, next.manifest.file_id);
            await currentSource(c, b.owner_user_id, b.project_id, next.manifest.source);
            const f = (await c.query('SELECT * FROM bb_project_files WHERE owner_user_id=$1 AND id=$2 FOR UPDATE', [b.owner_user_id, next.manifest.file_id])).rows[0];
            if (!f || f.latest_version_id !== next.manifest.expected_current_version_id)
                throw conflict('INPUT_REVISION_CONFLICT', '文件已有新版本，请重新检查。');
            const r = await createOperation(c, b.owner_user_id, p.id, 'file-patch:' + b.id + ':' + items.indexOf(next) + ':' + (next.attempt ?? 1), inputManifestHash(next.manifest), next.manifest, next.pricing_mode === OUTCOME_MODE, next.points, next.scope_quote_id, next.scope_acceptance_id, uid());
            next.run_id = r.id;
            next.error = null;
            await c.query('INSERT INTO bb_project_file_acceptances(owner_user_id,check_run_id,file_version_id,issue_ids,run_id) VALUES($1,$2,$3,$4,$5)', [b.owner_user_id, b.check_run_id, next.manifest.file_version_id, JSON.stringify(next.issue_ids), r.id]);
            await c.query("UPDATE bb_project_file_update_batches SET state='running',items=$2,updated_at=now() WHERE id=$1", [b.id, JSON.stringify(items)]);
        }
        catch (e) {
            await c.query('ROLLBACK TO SAVEPOINT begin_file_patch');
            if (e instanceof Problem && e.code === 'PROJECT_RUN_ACTIVE' || ['55P03', '40P01'].includes(e.code ?? '')) {
                await c.query('UPDATE bb_project_file_update_batches SET updated_at=now() WHERE id=$1', [b.id]);
                return false;
            }
            next.error = e instanceof Problem ? e.message : '文件更新未启动，请刷新后重新检查。';
            await c.query("UPDATE bb_project_file_update_batches SET state='paused',items=$2,updated_at=now() WHERE id=$1", [b.id, JSON.stringify(items)]);
        }
        return true;
    });
}
export function registerProjectFileConsistency(app, db, owner, commercial = false) {
    const base = '/api/v1/projects/:project_id/project-files', params = (r) => r.params;
    app.get(base + '/checks', async (r) => ({ checks: await readProjectFileChecks(db(), await owner(r), params(r).project_id, commercial) }));
    app.get(base + '/checks/:run_id', async (r) => ({ check: await readProjectFileCheck(db(), await owner(r), params(r).project_id, params(r).run_id, commercial) }));
    app.get(base + '/updates/:run_id/check', async (r) => ({ check: await readProjectFileUpdateCheck(db(), await owner(r), params(r).project_id, params(r).run_id) }));
    app.post(base + '/checks/quote', { schema: { body: projectFileSchemas.ProjectFileCheckRequest } }, async (r) => {
        const user = await owner(r), id = params(r).project_id, b = r.body;
        return transaction(db(), async (c) => {
            await project(c, user, id, true);
            const source = await currentSource(c, user, id, { version_id: b.expected_source_version_id });
            const availableFiles = (await projectFileVersions(c, user, id, !!b.file_version_ids)).filter(f => f.latest);
            const ids = b.file_version_ids ?? availableFiles.map(f => f.version_id);
            if (!ids.length || new Set(ids).size !== ids.length)
                throw new Problem(422, 'INPUT_REQUIRED', '请选择需要检查的文件，且不能重复。');
            if (ids.length > 1 && availableFiles.some(f => ids.includes(f.version_id) && f.document_type === 'workpaper'))
                throw new Problem(422, 'VALIDATION_FAILED', '批量底稿请从底稿库按逐份交付计费委托。');
            const files = ids.map(id => { const f = availableFiles.find(f => f.version_id === id); if (!f)
                throw conflict('INPUT_REVISION_CONFLICT', '所选文件已换版，请重新查看报价。'); return { file_id: f.file_id, file_version_id: f.version_id, filename: f.filename, sequence: f.sequence, asset: f.asset, links: f.links }; });
            const input = { version: 'project-file-operation-v1', operation: 'check', source, files };
            const price = commercial ? await fileCheckPrice(c, user, input, id) : null;
            return { points: price?.points ?? 0, price_version: price?.price_version ?? null, file_version_ids: ids, source_version_id: source.version_id, ...(price ? { ...outcomeMetadata(price.points, price.points, 1, price.price_version), scope_quote_id: price.scope_quote_id, quote_status: price.quote_status, scope_expires_at: price.scope_expires_at, scope_lines: price.scope_lines } : {}) };
        });
    });
    app.post(base + '/checks', { schema: { body: projectFileSchemas.ProjectFileCheckRequest } }, async (r) => {
        const user = await owner(r), id = params(r).project_id, b = r.body;
        const runId = await transaction(db(), async (c) => {
            await project(c, user, id, true);
            const hash = inputManifestHash({ project_id: id, ...b }), key = 'file-check:' + b.request_id;
            await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [user + ':' + key]);
            const old = (await c.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2', [user, key])).rows[0];
            if (old) {
                if (old.request_hash.trim() !== hash)
                    throw conflict('IDEMPOTENCY_CONFLICT', '此请求已用于其他检查。');
                return old.id;
            }
            const source = await currentSource(c, user, id, { version_id: b.expected_source_version_id }), availableFiles = (await projectFileVersions(c, user, id, !!b.file_version_ids)).filter(f => f.latest);
            const selected = b.file_version_ids ?? availableFiles.map(f => f.version_id);
            if (new Set(selected).size !== selected.length)
                throw new Problem(422, 'VALIDATION_FAILED', '检查文件不能重复。');
            const files = selected.map(id => { const f = availableFiles.find(f => f.version_id === id); if (!f)
                throw conflict('INPUT_REVISION_CONFLICT', '所选文件已换版，请重新查看报价。'); return f; });
            if (files.length > 1 && files.some(f => f.document_type === 'workpaper'))
                throw new Problem(422, 'VALIDATION_FAILED', '批量底稿请从底稿库按逐份交付计费委托。');
            if (!files.length)
                throw new Problem(422, 'INPUT_REQUIRED', '请先生成或上传需要检查的项目关联文件。');
            for (const f of files)
                await readProjectFileAsset(c, user, f.asset);
            const manifest = { version: 'project-file-operation-v1', operation: 'check', source,
                files: files.map(f => ({ file_id: f.file_id, file_version_id: f.version_id, filename: f.filename, sequence: f.sequence, asset: f.asset, links: f.links })) };
            if (commercial) {
                const price = await fileCheckPrice(c, user, manifest, id);
                if (!b.file_version_ids || b.price_version !== price.price_version || b.expected_points !== price.points)
                    throw conflict('QUOTE_CHANGED', '请确认当前版本与人民币检查总价后开始。');
                if (price.scope_quote_id)
                    await assertScopeQuote(c, b.scope_quote_id, user, id, 'project_file_check', price.scope_hash, b.expected_points);
                const prior = (await c.query(`SELECT o.run_id FROM bb_project_file_operations o JOIN bb_runs r ON r.id=o.run_id AND r.owner_user_id=o.owner_user_id JOIN bb_project_file_check_quotes q ON q.run_id=o.run_id AND q.owner_user_id=o.owner_user_id
          WHERE o.owner_user_id=$1 AND o.project_id=$2 AND o.operation='check' AND o.manifest=$3::jsonb AND r.state='succeeded' AND (q.points=0 OR EXISTS(SELECT 1 FROM bb_credit_reservations res WHERE res.quote_id=q.id AND res.owner_user_id=q.owner_user_id AND res.state='settled')) ORDER BY o.created_at LIMIT 1`, [user, id, JSON.stringify(manifest)])).rows[0];
                if (prior && price.points === 0)
                    return prior.run_id;
            }
            return (await createOperation(c, user, id, key, hash, manifest, commercial, b.expected_points, b.scope_quote_id)).id;
        });
        return { run_id: runId };
    });
    app.post(base + '/checks/:run_id/updates/quote', { schema: { body: projectFileSchemas.ProjectFileUpdateQuoteRequest, response: { 200: projectFileSchemas.ProjectFileUpdateQuoteResponse } } }, async (r) => {
        const user = await owner(r), { project_id: id, run_id: checkId } = params(r), b = r.body;
        return transaction(db(), async (c) => {
            await project(c, user, id, true);
            const work = await prepareUpdateItems(c, user, id, checkId, b.expected_check_sha256, b.files), items = [];
            for (const item of work) {
                const price = await fileUpdatePrice(c, user, item.manifest, commercial, id);
                items.push({ file_version_id: item.manifest.file_version_id, price_version: price.version, scope_quote_id: price.scope_quote_id, quote_status: commercial ? price.quote_status : 'ready', scope_expires_at: 'scope_expires_at' in price ? price.scope_expires_at : null, points: price.points, scope_lines: price.scope_lines ?? [] });
            }
            return { points: items.reduce((sum, p) => sum + p.points, 0), price_version: items[0]?.price_version ?? PROJECT_FILE_UPDATE_PRICE.version, quote_status: items.find(p => p.quote_status !== 'ready')?.quote_status ?? 'ready', items };
        });
    });
    app.post(base + '/checks/:run_id/updates', { schema: { body: projectFileSchemas.ProjectFileUpdateRequest } }, async (r) => {
        const user = await owner(r), { project_id: id, run_id: checkId } = params(r), b = r.body;
        return transaction(db(), async (c) => {
            const p = await project(c, user, id, true);
            if (p.archived_at)
                throw conflict('INPUT_REVISION_CONFLICT', '请先恢复已归档项目。');
            const hash = inputManifestHash({ project_id: id, check_run_id: checkId, ...b });
            await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [user + ':file-accept:' + b.request_id]);
            const old = (await c.query('SELECT * FROM bb_project_file_update_batches WHERE owner_user_id=$1 AND request_id=$2', [user, b.request_id])).rows[0];
            if (old) {
                if (old.request_hash.trim() !== hash)
                    throw conflict('IDEMPOTENCY_CONFLICT', '此请求已用于其他修改。');
                return { batch_id: old.id };
            }
            if ((await c.query("SELECT 1 FROM bb_project_file_update_batches WHERE owner_user_id=$1 AND project_id=$2 AND state IN ('queued','running','paused')", [user, id])).rowCount)
                throw conflict('PROJECT_RUN_ACTIVE', '已有文件更新任务待完成，请先处理该任务。');
            const items = await prepareUpdateItems(c, user, id, checkId, b.expected_check_sha256, b.files);
            let total = 0;
            for (const item of items) {
                const price = await fileUpdatePrice(c, user, item.manifest, commercial, id);
                if (commercial) {
                    const selection = b.files.find(f => f.file_version_id === item.manifest.file_version_id);
                    const scope = await assertScopeQuote(c, selection.scope_quote_id, user, id, 'project_file_patch', price.scope_hash, price.points);
                    item.pricing_mode = OUTCOME_MODE;
                    item.points = scope.amount_fen;
                    item.scope_quote_id = scope.scope_quote_id;
                }
                total += price.points;
            }
            if ((commercial ? !isOutcomePriceVersion(b.price_version) : b.price_version !== PROJECT_FILE_UPDATE_PRICE.version) || b.expected_points !== total)
                throw conflict('QUOTE_CHANGED', '实际修改范围与费用已变化，请重新确认。');
            await requireFileUpdateCredits(c, user, total, commercial);
            const batchId = uid();
            await c.query(`INSERT INTO bb_project_file_update_batches(id,owner_user_id,project_id,check_run_id,request_id,request_hash,items,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,'queued')`, [batchId, user, id, checkId, b.request_id, hash, JSON.stringify(items)]);
            if (commercial) {
                for (const [index, item] of items.entries())
                    item.scope_acceptance_id = await acceptScopeBatch(c, user, item.scope_quote_id, 'file_update_batch', batchId, index, item.manifest);
                await c.query('UPDATE bb_project_file_update_batches SET items=$2 WHERE id=$1', [batchId, JSON.stringify(items)]);
            }
            await event(c, user, id, 'project.file_updates_accepted', { batch_id: batchId, check_run_id: checkId, files: b.files });
            return { batch_id: batchId };
        });
    });
    app.get(base + '/updates', async (r) => {
        const user = await owner(r), id = params(r).project_id;
        await project(db(), user, id);
        const batches = (await db().query('SELECT id,state,items FROM bb_project_file_update_batches WHERE owner_user_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 30', [user, id])).rows;
        return { batches: batches.map(b => ({ batch_id: b.id, state: b.state, items: b.items.map((i) => ({ file_version_id: i.manifest.file_version_id, filename: i.manifest.filename, run_id: i.run_id, error: i.error })) })) };
    });
    app.post(base + '/updates/:run_id/retry', async (r) => {
        const user = await owner(r), { project_id: id, run_id: batchId } = params(r);
        await transaction(db(), async (c) => {
            await project(c, user, id, true);
            const b = (await c.query('SELECT * FROM bb_project_file_update_batches WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE', [user, id, batchId])).rows[0];
            if (!b)
                throw missing();
            if (b.state !== 'paused')
                throw conflict('INPUT_REVISION_CONFLICT', '文件包状态已变化，请刷新。');
            const items = b.items;
            let remainingPoints = 0;
            for (const item of items) {
                if (item.run_id) {
                    const run = (await c.query('SELECT state FROM bb_runs WHERE owner_user_id=$1 AND id=$2', [user, item.run_id])).rows[0];
                    if (!run || !terminal.includes(run.state))
                        throw conflict('PROJECT_RUN_ACTIVE', '请先继续或结束当前任务。');
                    if (run.state === 'succeeded')
                        continue;
                    item.run_id = null;
                    item.attempt = (item.attempt ?? 1) + 1;
                }
                await currentSource(c, user, id, item.manifest.source);
                const latest = (await c.query('SELECT latest_version_id FROM bb_project_files WHERE owner_user_id=$1 AND id=$2', [user, item.manifest.file_id])).rows[0];
                if (latest?.latest_version_id !== item.manifest.expected_current_version_id)
                    throw conflict('INPUT_REVISION_CONFLICT', '文件已有新版本，请重新检查。');
                item.error = null;
                remainingPoints += item.points ?? PROJECT_FILE_UPDATE_PRICE.points;
            }
            await requireFileUpdateCredits(c, user, remainingPoints, items.some(i => i.pricing_mode === OUTCOME_MODE));
            await c.query("UPDATE bb_project_file_update_batches SET state='queued',items=$2,updated_at=now() WHERE id=$1", [batchId, JSON.stringify(items)]);
            await event(c, user, id, 'project.file_updates_retried', { batch_id: batchId });
        });
        return { ok: true };
    });
    app.post(base + '/updates/:run_id/cancel', async (r) => {
        const user = await owner(r), { project_id: id, run_id: batchId } = params(r);
        await transaction(db(), async (c) => {
            await project(c, user, id, true);
            const b = (await c.query('SELECT * FROM bb_project_file_update_batches WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE', [user, id, batchId])).rows[0];
            if (!b)
                throw missing();
            await c.query("UPDATE bb_project_file_update_batches SET state='cancelled',updated_at=now() WHERE id=$1", [batchId]);
            await event(c, user, id, 'project.file_updates_stopped', { batch_id: batchId });
        });
        return { ok: true };
    });
}
