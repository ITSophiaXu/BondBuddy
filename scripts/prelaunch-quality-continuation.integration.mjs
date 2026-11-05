// Run only through the owning runner. All data/model output are explicitly synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import net from 'node:net';

assert.equal(process.env.BB_PRELAUNCH_CONTINUATION_ISOLATED, '1');
assert.equal(process.platform, 'linux');
const database = new URL(process.env.BB_TEST_DATABASE_URL);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/bb_prelaunch_continuation_[a-f0-9]{32}$/);
assert.equal(database.search, ''); assert.equal(database.hash, '');
for (const key of Object.keys(process.env))
  assert.ok(!/TOKEN|SECRET|API_KEY|PASSWORD|CONNECTION_STRING|DATABASE_URL$/.test(key) || key === 'BB_TEST_DATABASE_URL', key);

test('combined candidate continuation, first-draft history staleness and host quality refusal across real API/PG',
  { timeout: 150_000 }, async t => {
    const originalConnect = net.Socket.prototype.connect, externalSockets = [];
    net.Socket.prototype.connect = function (...args) {
      const values = Array.isArray(args[0]) ? args[0] : args, first = values[0];
      const host = typeof first === 'object' ? first?.host ?? first?.hostname ?? 'localhost'
        : typeof values[1] === 'string' ? values[1] : 'localhost';
      if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
        externalSockets.push(host); throw Error('CONTINUATION_EXTERNAL_SOCKET_BLOCKED');
      }
      return originalConnect.apply(this, args);
    };
    t.after(() => { net.Socket.prototype.connect = originalConnect; });
    const [{ Pool }, contracts, { createServer }, queue, data, { makeSyntheticDocxFixture }, billing,
      { inputManifestHash }, { unifiedInputGate }, { runPipelineOnce, inputLockStage, materialsReadyStage },
      { fileAuthoringDeliveryStage }, { readContinuationBasis }, firstDraft, { auditCredits }] = await Promise.all([
      import('pg'), import('@bondbuddy/contracts'), import('../apps/api/dist/server.js'),
      import('../apps/api/dist/queue.js'), import('../apps/api/dist/data.js'),
      import('../apps/api/dist/docx-fixtures.js'), import('../apps/api/dist/billing.js'),
      import('../apps/api/dist/production-rule-pin.js'), import('../apps/worker/dist/unified-input.js'),
      import('../apps/worker/dist/run-pipeline.js'), import('../apps/worker/dist/file-authoring-stage.js'),
      import('../apps/web/dist-test/authoring-continuation.js'), import('../apps/web/dist-test/first-draft-confirmation.js'),
      import('../apps/api/dist/billing-audit.js')]);
    const pool = new Pool({ connectionString: database.href }), owner = `synthetic-continuation-${randomUUID()}`;
    const files = new Map();
    const blobs = { put: async (key, bytes) => { files.set(key, Buffer.from(bytes)); },
      get: async key => { const bytes = files.get(key); assert.ok(bytes); return bytes; },
      getIfExists: async key => files.get(key) ?? null,
      getIfExistsBounded: async (key, limit) => { const bytes = files.get(key); if (bytes?.length > limit) throw Error('SYNTHETIC_BLOB_LIMIT'); return bytes ?? null; },
      exists: async key => files.has(key), delete: async key => { files.delete(key); } };
    const origin = 'http://bondbuddy.test';
    const app = createServer({ pool, blobs, allowedOrigin: origin, enableSyntheticQueue: true,
      enablePaidAuthoring: true, enableSubscriptionBilling: false, enableOutcomePricing: false,
      principal: async () => ({ userId: owner, csrfVerified: true }) });
    t.after(async () => { await app.close(); await pool.end(); });
    const send = (method, url, payload, headers = {}) => app.inject({ method, url, payload, headers: { origin, ...headers } });
    const ok = async (method, url, payload) => {
      const response = await send(method, url, payload);
      assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${method} ${url}: ${response.statusCode} ${response.body}`);
      return response.json();
    };
    const path = project => `/api/v1/projects/${project}`;
    const snapshot = async project => ({
      counts: (await pool.query(`SELECT
        (SELECT count(*)::int FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2) inputs,
        (SELECT count(*)::int FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2) runs`, [owner, project])).rows[0],
      balance: await billing.creditBalance(pool, owner),
      events: (await pool.query('SELECT event_key,kind,points,run_id FROM bb_credit_events WHERE owner_user_id=$1 ORDER BY event_key', [owner])).rows,
      reservations: (await pool.query('SELECT id,run_id,state,charged_points FROM bb_credit_reservations WHERE owner_user_id=$1 ORDER BY id', [owner])).rows
    });
    const read = async (project, runId, choice) => {
      const [versions, run] = await Promise.all([ok('GET', `${path(project)}/prospectus-versions`), ok('GET', `/api/v1/runs/${runId}`)]);
      return { versions, run, basis: await readContinuationBasis(versions, project, run, choice, id => ok('GET', `/api/v1/artifacts/${id}`)) };
    };
    const lock = async (project, basis, extra = {}) => {
      const p = await ok('GET', path(project));
      return send('POST', `${path(project)}/input-revisions`, { draft_revision: p.draft_revision,
        prospectus_selection_revision: basis.selectionRevision, edit_base: basis.editBase,
        material_versions: issuerMaterials.get(project) ?? [], requirement_message_ids: [], ...extra });
    };
    const issuerMaterials = new Map();
    const create = async (kind = 'update') => {
      const project = await ok('POST', '/api/v1/projects', { kind,
        name: 'Synthetic continuation integration', issuer_name: 'Synthetic issuer', market: 'sse', offering: 'private',
        update_details: { ...contracts.emptyUpdateDetails(), authoring_mode: 'unified_v1', reporting_cutoff: '2026-09-30',
          target_reporting_periods: contracts.reportingWindow('sse', 'private', '2026-09-30') } });
      // Meet the real input gate's issuer-material prerequisite through public upload.
      // No historical source is adopted; worker/input/quality functions remain unchanged.
      const bytes = makeSyntheticDocxFixture({ text: 'Synthetic issuer audit: 2026 net assets 120; all figures are synthetic.' });
      const declaration = { byte_size: bytes.length, sha256: data.digest(bytes) };
      const upload = await ok('POST', `${path(project.project_id)}/materials/uploads`, {
        ...declaration, filename: 'synthetic-issuer-audit.docx',
        media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', role: 'audit' });
      const uploaded = await send('PUT', upload.upload_url, bytes, { 'content-type': 'application/octet-stream' });
      assert.equal(uploaded.statusCode, 204, uploaded.body);
      const material = await ok('POST', `${path(project.project_id)}/materials/uploads/${upload.upload_id}/complete`, declaration);
      issuerMaterials.set(project.project_id, [{ material_id: material.material_id, material_version: material.material_version }]);
      return project;
    };
    const execute = async (project, input) => {
      const quoted = await ok('POST', `${path(project)}/credit-quote`, { input_revision: input.input_revision, input_hash: input.input_hash });
      assert.ok(quoted.quote?.quote_id, 'Exercise the enabled paid-authoring path');
      return ok('POST', '/api/v1/runs/execute', { execution_request_id: randomUUID(), project_id: project,
        input_revision: input.input_revision, input_hash: input.input_hash, task_kind: (await ok('GET', path(project))).kind,
        input_manifest_ref: input.input_hash, storage_origin: 'cloud', workspace_id: project, quote_id: quoted.quote.quote_id });
    };
    const start = async project => {
      const p = await ok('GET', path(project)), versions = await ok('GET', `${path(project)}/prospectus-versions`);
      const input = await ok('POST', `${path(project)}/input-revisions`, { draft_revision: p.draft_revision,
        prospectus_selection_revision: versions.selection_revision,
        ...(versions.current_version_id === null ? { edit_base: null } : {}),
        material_versions: issuerMaterials.get(project) ?? [], requirement_message_ids: [] });
      return { input, run: await execute(project, input), hasCurrent: versions.current_version_id !== null };
    };
    // Construct a legacy delivered pair through the current queue/storage APIs. It
    // intentionally has no host quality report, to verify old evidence is not backfilled.
    const legacy = async (project, label) => {
      const { input, run, hasCurrent } = await start(project), lease = await queue.claim(pool, 120);
      assert.ok(lease); assert.equal(lease.runId, run.run_id);
      const bytes = makeSyntheticDocxFixture({ text: `Synthetic legacy first draft ${label}` });
      const cleanBytes = hasCurrent ? makeSyntheticDocxFixture({ text: `Synthetic legacy clean continuation ${label}` }) : bytes;
      const artifact = await queue.promoteWordArtifact(pool, lease, bytes, blobs, 'generated_pair_v1');
      const clean = await queue.promoteWordArtifact(pool, lease, cleanBytes, blobs, 'generated_pair_v1');
      assert.equal(artifact.status, 'available'); assert.equal(clean.status, 'available');
      if (hasCurrent) assert.notEqual(clean.artifactId, artifact.artifactId);
      else { assert.equal(clean.artifactId, artifact.artifactId); assert.equal(clean.sha256, artifact.sha256); }
      await queue.checkpointStage(pool, lease, 'word_delivery_pair', { revision_artifact_id: artifact.artifactId,
        clean_artifact_id: clean.artifactId, baseline_kind: hasCurrent ? 'project_output' : 'none', delivery_policy: 'generated_pair_v1', writer_version: 'synthetic-legacy-integration' });
      assert.equal((await queue.finish(pool, lease, 'succeeded', { artifactId: artifact.artifactId, artifactVersion: artifact.artifactVersion, blobs })).state, 'succeeded');
      return { input, runId: run.run_id, artifact: clean, bytes: cleanBytes };
    };
    // Prepared, unadopted synthetic historical metadata is deliberate fixture setup.
    // Public upload/adoption is covered separately by the unchanged browser quality gate.
    const addHistory = async project => {
      const upload = randomUUID(), material = randomUUID(), bytes = makeSyntheticDocxFixture({ text: `Synthetic omitted history ${material}` }), sha = data.digest(bytes);
      const objectKey = `users/${owner}/projects/${project}/materials/${material}/1`;
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state,received_sha256,received_bytes)
        VALUES($1,$2,$3,'synthetic-omitted.docx',$4,$5,$6,'historical',$7,now()+interval '1 hour','completed',$6,$5)`,
      [upload, owner, project, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes.length, sha, objectKey]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'historical','synthetic-omitted.docx',$5,$6,$7,$8,'persisted')`,
      [material, owner, project, upload, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes.length, sha, objectKey]);
      files.set(objectKey, bytes);
    };
    const preview = async project => {
      const p = await ok('GET', path(project)), value = await ok('GET', `${path(project)}/first-draft-exclusions`);
      const checked = firstDraft.checkedFirstDraftExclusions(value, project, p.draft_revision); assert.ok(checked); return checked;
    };
    const confirmation = value => ({ decision: 'generate_first_draft', scope: value.scope,
      excluded_historical: value.excluded_historical.map(({ material_id, material_version, sha256 }) => ({ material_id, material_version, sha256 })) });
    const noCharge = async (runId, balance) => {
      assert.deepEqual(await billing.creditBalance(pool, owner), balance);
      assert.equal((await pool.query("SELECT count(*)::int n FROM bb_credit_events WHERE run_id=$1 AND kind='settle'", [runId])).rows[0].n, 0);
      const charged = await ok('GET', `/api/v1/runs/${runId}/credit-charge`);
      assert.equal(String(charged.progress.charged_points), '0');
    };
    // Legacy authoring_balance_v2 preserves progress debits and appends an exact
    // per-source refund on failure (2026-10-11 decision; migration 0104). Its
    // historical charged_points is gross; the public task projection is net zero.
    const fullyRefunded = async (runId, balance, lease) => {
      assert.ok(lease); assert.equal(lease.runId, runId);
      const reservationRows = (await pool.query(`SELECT c.*,r.state AS run_state,r.reservation_id AS run_reservation_id
        FROM bb_credit_reservations c JOIN bb_runs r ON r.id=c.run_id AND r.owner_user_id=c.owner_user_id
        WHERE c.run_id=$1`, [runId])).rows;
      assert.equal(reservationRows.length, 1);
      const reservation = reservationRows[0];
      assert.equal(reservation.owner_user_id, owner); assert.equal(reservation.run_id, runId);
      assert.equal(reservation.run_reservation_id, reservation.id); assert.equal(reservation.run_state, 'failed');
      assert.equal(reservation.billing_policy, 'authoring_balance_v2'); assert.equal(reservation.state, 'released');
      assert.ok(reservation.finalized_at);
      const events = (await pool.query(`SELECT * FROM bb_credit_events
        WHERE run_id=$1 OR reservation_id=$2 ORDER BY event_key`, [runId, reservation.id])).rows;
      assert.ok(events.length > 0);
      for (const event of events) {
        assert.equal(event.owner_user_id, owner); assert.equal(event.run_id, runId); assert.equal(event.reservation_id, reservation.id);
        assert.ok(['settle', 'correction'].includes(event.kind)); assert.ok(BigInt(event.points) > 0n);
        assert.equal(event.actor, 'system');
        assert.equal(event.reason, event.kind === 'settle' ? 'authoring_progress_debit' : 'authoring_platform_failure_refund');
      }
      const settlements = events.filter(event => event.kind === 'settle');
      assert.ok(settlements.length > 0, 'Exercise actual legacy progress debits before quality refusal');
      for (const event of settlements) assert.match(event.event_key, new RegExp(`^progress:${reservation.id}:[0-9]+$`));
      settlements.sort((a, b) => BigInt(a.event_key.split(':').at(-1)) < BigInt(b.event_key.split(':').at(-1)) ? -1 : 1);
      let gross = 0n;
      for (const event of settlements) {
        gross += BigInt(event.points);
        assert.equal(event.event_key, `progress:${reservation.id}:${gross}`);
      }
      assert.ok(gross > 0n && gross <= BigInt(reservation.points));
      assert.equal(BigInt(reservation.charged_points), gross, 'Keep the append-only gross debit history');
      const allocations = (await pool.query(`SELECT a.*,l.owner_user_id AS lot_owner,l.source AS lot_source,l.frozen AS lot_frozen
        FROM bb_credit_allocations a JOIN bb_credit_lots l ON l.id=a.lot_id
        WHERE a.reservation_id=$1 ORDER BY a.lot_id`, [reservation.id])).rows;
      assert.ok(allocations.length > 0);
      const corrections = events.filter(event => event.kind === 'correction');
      assert.equal(corrections.length, allocations.length);
      assert.equal(allocations.reduce((sum, allocation) => sum + BigInt(allocation.charged_points), 0n), gross);
      assert.equal(corrections.reduce((sum, event) => sum + BigInt(event.points), 0n), gross);
      for (const allocation of allocations) {
        assert.equal(allocation.reservation_id, reservation.id); assert.equal(allocation.lot_owner, owner);
        assert.ok(BigInt(allocation.charged_points) > 0n); assert.equal(BigInt(allocation.points), BigInt(allocation.charged_points));
        assert.equal(BigInt(allocation.lot_frozen), 0n);
        const key = `dynamic-failure:${reservation.id}:${allocation.lot_id}`;
        const matched = corrections.filter(event => event.event_key === key);
        assert.equal(matched.length, 1); assert.equal(matched[0].id, key); assert.equal(matched[0].lot_id, key);
        assert.equal(BigInt(matched[0].points), BigInt(allocation.charged_points));
        const refundLots = (await pool.query('SELECT * FROM bb_credit_lots WHERE id=$1 OR source_key=$1', [key])).rows;
        assert.equal(refundLots.length, 1);
        const refund = refundLots[0];
        assert.equal(refund.id, key); assert.equal(refund.source_key, key); assert.equal(refund.owner_user_id, owner);
        assert.equal(refund.source, allocation.lot_source === 'purchase' ? 'purchase' : 'correction');
        assert.equal(BigInt(refund.original_points), BigInt(allocation.charged_points));
        assert.equal(BigInt(refund.remaining), BigInt(allocation.charged_points)); assert.equal(BigInt(refund.frozen), 0n);
      }
      assert.equal(balance.frozen, 0); assert.deepEqual(await billing.creditBalance(pool, owner), balance);
      const charged = await ok('GET', `/api/v1/runs/${runId}/credit-charge`);
      assert.equal(charged.progress.policy, 'authoring_balance_v2'); assert.equal(String(charged.progress.charged_points), '0');
      const history = await ok('GET', '/api/v1/credits/consumption-history?limit=50');
      const entries = history.items.filter(item => item.run_id === runId);
      assert.equal(entries.length, 1);
      const entry = entries[0];
      assert.equal(entry.reservation_id, reservation.id); assert.equal(entry.state, 'released');
      assert.equal(entry.billing_policy, 'authoring_balance_v2');
      assert.equal(entry.reserved_points, '0'); assert.equal(entry.released_points, '0');
      assert.equal(BigInt(entry.charged_points), gross); assert.equal(BigInt(entry.corrected_points), gross);
      assert.equal((await auditCredits(pool, owner)).consistent, true);
      const ledgerSnapshot = async () => ({
        balance: await billing.creditBalance(pool, owner),
        events: (await pool.query('SELECT * FROM bb_credit_events WHERE owner_user_id=$1 ORDER BY event_key', [owner])).rows,
        lots: (await pool.query('SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 ORDER BY id', [owner])).rows,
        reservations: (await pool.query('SELECT * FROM bb_credit_reservations WHERE owner_user_id=$1 ORDER BY id', [owner])).rows,
        allocations: (await pool.query('SELECT * FROM bb_credit_allocations WHERE reservation_id=$1 ORDER BY lot_id', [reservation.id])).rows
      });
      const stable = await ledgerSnapshot();
      await assert.rejects(queue.finish(pool, lease, 'failed', { errorCode: 'DATA_UNAVAILABLE' }),
        error => error instanceof data.Problem && error.code === 'ALREADY_TERMINAL');
      assert.deepEqual(await ledgerSnapshot(), stable, 'A duplicate terminal attempt cannot refund or mutate the ledger again');
      assert.equal((await auditCredits(pool, owner)).consistent, true);
    };
    assert.ok(Number((await pool.query('SHOW server_version_num')).rows[0].server_version_num) >= 160000);
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, `synthetic_${randomUUID().replaceAll('-', '').slice(0,16)}`]);
    await billing.publishPrices(pool, { id: `synthetic-continuation-${randomUUID()}`, prices: { ...contracts.INITIAL_FIXED_PRICES, new_authoring: 10000 },
      effectiveAt: '2020-01-01T00:00:00Z', actor: 'synthetic-test', reason: 'isolated legacy billing regression' });
    await data.transaction(pool, client => billing.grantCredits(client, { owner, points: 200000, key: randomUUID(),
      source: 'existing_grant', expiresAt: null, actor: 'synthetic-test', reason: 'isolated test only' }));
    const project = await create(), id = project.project_id, first = await legacy(id, 'one');

    await t.test('Q15 shared-ID legacy first draft re-reads both choices and persists exact clean/template pins without running or charging', async () => {
      const before = await snapshot(id), result = await read(id, first.runId, 'result'), current = await read(id, first.runId, 'current');
      assert.deepEqual(result.basis.editBase, { artifact_id: first.artifact.artifactId, artifact_version: 1, sha256: data.digest(first.bytes) });
      assert.deepEqual(current.basis.editBase, result.basis.editBase);
      assert.equal(result.basis.version.artifact_id, result.basis.version.revision_artifact_id);
      const artifact = await ok('GET', `/api/v1/artifacts/${first.artifact.artifactId}`), download = await send('GET', artifact.download_url);
      assert.equal(download.statusCode, 200); assert.equal(data.digest(download.rawPayload), first.artifact.sha256);
      for (const choice of ['result', 'current']) {
        const prepared = await read(id, first.runId, choice), submitted = await read(id, first.runId, choice);
        assert.equal(prepared.basis.key, submitted.basis.key);
        const saved = await lock(id, submitted.basis); assert.equal(saved.statusCode, 201, saved.body);
        const manifest = (await pool.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2', [id, saved.json().input_revision])).rows[0].manifest;
        assert.deepEqual(manifest.authoring.previous_output, { artifact_id: first.artifact.artifactId, version: 1, sha256: first.artifact.sha256,
          run_id: first.runId, input_revision: first.input.input_revision });
        assert.equal(manifest.authoring.format_policy.selection, 'previous_output');
        assert.equal(manifest.authoring.format_policy.template.artifact_id, first.artifact.artifactId);
      }
      const after = await snapshot(id); assert.equal(after.counts.runs, before.counts.runs);
      assert.equal(after.counts.inputs, before.counts.inputs + 2, 'Exactly the two explicit saves create input revisions');
      assert.deepEqual({ ...after, counts: before.counts }, before);
    });
    await t.test('Q17 wrong hash/version input pins fail with zero input/run/credit changes', async () => {
      const valid = await read(id, first.runId, 'result'), before = await snapshot(id);
      for (const edit_base of [{ ...valid.basis.editBase, sha256: 'f'.repeat(64) }, { ...valid.basis.editBase, artifact_version: 2 }]) {
        const response = await lock(id, valid.basis, { edit_base }); assert.equal(response.statusCode, 409, response.body);
        assert.equal(response.json().code, 'INPUT_REVISION_CONFLICT'); assert.deepEqual(await snapshot(id), before);
      }
    });
    await t.test('Q17 normal current version change invalidates a prepared pin while keeping the earlier run result', async () => {
      const prepared = await read(id, first.runId, 'current'), second = await legacy(id, 'two'), before = await snapshot(id);
      const current = await read(id, first.runId, 'current'), historical = await read(id, first.runId, 'result');
      assert.notEqual(current.basis.key, prepared.basis.key); assert.notEqual(current.basis.editBase.sha256, prepared.basis.editBase.sha256);
      assert.equal(current.basis.editBase.artifact_id, second.artifact.artifactId); assert.equal(historical.basis.editBase.artifact_id, first.artifact.artifactId);
      const stale = await lock(id, prepared.basis); assert.equal(stale.statusCode, 409, stale.body);
      assert.equal(stale.json().code, 'INPUT_REVISION_CONFLICT'); assert.deepEqual(await snapshot(id), before);
    });
    await t.test('Q17 missing/corrupt synthetic Blob fails metadata and both compiled choices without input/run/credit changes', async () => {
      // Shared-ID legacy first drafts require a fresh alias read for both choices.
      // Distinct pairs intentionally use the established metadata-only continuation contract.
      const projectId = (await create()).project_id, delivered = await legacy(projectId, 'blob-fault');
      const current = await read(projectId, delivered.runId, 'current'), artifactId = current.basis.editBase.artifact_id;
      assert.equal(current.basis.version.artifact_id, current.basis.version.revision_artifact_id);
      const row = (await pool.query('SELECT object_key FROM bb_artifact_versions WHERE id=$1 AND version=1', [artifactId])).rows[0];
      const original = files.get(row.object_key), before = await snapshot(projectId); assert.ok(original);
      try {
        for (const fault of ['missing', 'corrupt']) {
          if (fault === 'missing') files.delete(row.object_key); else files.set(row.object_key, Buffer.alloc(original.length, 88));
          assert.equal((await send('GET', `/api/v1/artifacts/${artifactId}`)).statusCode, 503);
          for (const choice of ['result', 'current']) await assert.rejects(read(projectId, delivered.runId, choice), /503/);
          assert.deepEqual(await snapshot(projectId), before);
        }
      } finally { files.set(row.object_key, original); }
    });
    await t.test('Q18 reading legacy evidence does not backfill quality policy or alter passed/available identity', async () => {
      const evidence = async () => (await pool.query('SELECT quality_status,delivery_status,word_delivery_evidence_id FROM bb_artifact_versions WHERE id=$1 AND version=1', [first.artifact.artifactId])).rows[0];
      const before = await evidence(), account = await snapshot(id), artifact = await ok('GET', `/api/v1/artifacts/${first.artifact.artifactId}`);
      assert.equal(artifact.word_delivery.content_review, 'not_performed'); assert.equal(artifact.word_delivery.delivery_policy, 'generated_pair_v1');
      assert.equal(JSON.stringify(artifact).includes('word-quality-v1'), false);
      await read(id, first.runId, 'result'); assert.deepEqual(await evidence(), before); assert.deepEqual(await snapshot(id), account);
    });
    await t.test('first-draft exact confirmation becomes stale after history changes; real input-lock pipeline refuses the old snapshot and refunds billing', async () => {
      const p = await create('generation'), projectId = p.project_id; await addHistory(projectId);
      const basis = { selectionRevision: 0, editBase: null }, before = await snapshot(projectId);
      const absent = await lock(projectId, basis); assert.equal(absent.statusCode, 409); assert.equal(absent.json().code, 'FIRST_DRAFT_CONFIRMATION_REQUIRED');
      assert.deepEqual(await snapshot(projectId), before);
      const reviewed = await preview(projectId), versions = await ok('GET', `${path(projectId)}/prospectus-versions`);
      assert.equal(firstDraft.canReviewFirstDraft(projectId, 'generation', [], versions), true);
      await addHistory(projectId); const fresh = await preview(projectId);
      assert.equal(firstDraft.sameFirstDraftExclusions(reviewed, fresh), false);
      const stale = await lock(projectId, basis, { first_draft_confirmation: confirmation(reviewed) });
      assert.equal(stale.statusCode, 409); assert.equal(stale.json().code, 'FIRST_DRAFT_EXCLUSION_STALE'); assert.deepEqual(await snapshot(projectId), before);
      const accepted = await lock(projectId, basis, { first_draft_confirmation: confirmation(fresh) }); assert.equal(accepted.statusCode, 201, accepted.body);
      const input = accepted.json(), immutable = (await pool.query('SELECT * FROM bb_input_revisions WHERE project_id=$1 AND revision=$2', [projectId, input.input_revision])).rows[0];
      assert.equal(inputManifestHash(immutable.manifest), input.input_hash);
      assert.equal(immutable.manifest.authoring.none_baseline.first_draft_confirmation.confirmed_by, owner);
      const balance = await billing.creditBalance(pool, owner), run = await execute(projectId, input); await addHistory(projectId);
      const runRow = (await pool.query('SELECT * FROM bb_runs WHERE id=$1', [run.run_id])).rows[0];
      assert.deepEqual(await unifiedInputGate(pool, runRow, immutable), { kind: 'fail', code: 'FIRST_DRAFT_EXCLUSION_STALE' });
      let modelCalls = 0;
      const leaseEvents = [];
      assert.equal(await runPipelineOnce({ pool, blobs, stages: [inputLockStage, { name: 'model_generation', run: async () => { modelCalls++; return { kind: 'done' }; } }],
        onLease: lease => {
          if (lease !== null) { assert.ok(lease); assert.equal(lease.runId, run.run_id); }
          leaseEvents.push(lease === null ? null : lease.runId);
        },
        onUnexpectedError: error => assert.fail(JSON.stringify(error)) }), 'failed');
      assert.deepEqual(leaseEvents, [run.run_id, null], 'Claim the exact run and observe its normal release');
      assert.equal(modelCalls, 0); assert.equal((await ok('GET', `/api/v1/runs/${run.run_id}`)).state, 'failed'); await noCharge(run.run_id, balance);
      const stable = await snapshot(projectId), expired = await lock(projectId, basis, { first_draft_confirmation: confirmation(fresh) });
      assert.equal(expired.statusCode, 409); assert.equal(expired.json().code, 'FIRST_DRAFT_EXCLUSION_STALE'); assert.deepEqual(await snapshot(projectId), stable);
      assert.deepEqual((await pool.query('SELECT * FROM bb_input_revisions WHERE project_id=$1 AND revision=$2', [projectId, input.input_revision])).rows[0], immutable);
    });
    await t.test('real host Word rejection is durable, uncharged and never a result/current source with or without a previous current稿', async () => {
      for (const projectId of [id, (await create('generation')).project_id]) {
        const prior = await ok('GET', `${path(projectId)}/prospectus-versions`), balance = await billing.creditBalance(pool, owner), { run } = await start(projectId);
        let modelCalls = 0;
        let claimedLease;
        const leaseEvents = [];
        const syntheticModel = { name: 'model_generation', run: async ctx => {
          modelCalls++; assert.equal(await ctx.validateBeforeModelCall(), null);
          const prefix = `owners/${owner}/projects/${projectId}/runs/${ctx.run.id}/file-authoring/synthetic/`;
          const outputs = {};
          for (const [name, text] of [['tracked.docx', 'Synthetic complete first draft'], ['clean.docx', 'Synthetic mismatched clean draft']]) {
            const bytes = makeSyntheticDocxFixture({ text }), key = prefix + name; await blobs.put(key, bytes);
            outputs[name] = { key, sha256: data.digest(bytes), byte_size: bytes.length };
          }
          return { kind: 'done', value: { version: 'codex-file-word-v1', input_hash: ctx.run.input_hash.trim(), files: outputs, summary: {} } };
        } };
        assert.equal(await runPipelineOnce({ pool, blobs, leaseSeconds: 120, stages: [inputLockStage, materialsReadyStage, syntheticModel, fileAuthoringDeliveryStage()],
          onLease: lease => {
            if (lease !== null) { assert.ok(lease); assert.equal(lease.runId, run.run_id); claimedLease = lease; }
            leaseEvents.push(lease === null ? null : lease.runId);
          },
          onUnexpectedError: error => assert.fail(JSON.stringify(error)) }), 'failed');
        assert.deepEqual(leaseEvents, [run.run_id, null], 'Claim the exact run and observe its normal release');
        assert.equal(modelCalls, 1);
        const failed = await ok('GET', `/api/v1/runs/${run.run_id}`), versions = await ok('GET', `${path(projectId)}/prospectus-versions`);
        assert.equal(failed.state, 'failed'); assert.equal(failed.artifact_id, null); assert.deepEqual(versions, prior);
        const job = (await pool.query('SELECT checkpoint FROM bb_jobs WHERE run_id=$1', [run.run_id])).rows[0], gate = job.checkpoint.stages.word_delivery.quality_gate;
        assert.equal(gate.version, 'word-quality-v1'); assert.equal(gate.status, 'failed');
        const report = files.get(gate.report.key); assert.ok(report); assert.equal(data.digest(report), gate.report.sha256);
        assert.ok(JSON.parse(report).issues.length > 0, 'Use the actual installed host checker report');
        await fullyRefunded(run.run_id, balance, claimedLease);
        const stable = await snapshot(projectId);
        await assert.rejects(read(projectId, run.run_id, 'result'), /成功交付/);
        const current = await read(projectId, run.run_id, 'current');
        assert.equal(current.basis.version?.version_id ?? null, prior.current_version_id);
        assert.notEqual(current.basis.version?.run_id, run.run_id);
        if (prior.current_version_id === null) assert.equal(current.basis.editBase, null);
        const rejected = await lock(projectId, current.basis, { edit_base: { artifact_id: `unpublished-${run.run_id}`, artifact_version: 1, sha256: 'a'.repeat(64) } });
        assert.equal(rejected.statusCode, 409, rejected.body); assert.deepEqual(await snapshot(projectId), stable);
        assert.equal((await pool.query('SELECT count(*)::int n FROM bb_artifact_versions WHERE run_id=$1', [run.run_id])).rows[0].n, 0);
      }
    });
    await t.test('Q17 public project deletion revokes legacy artifacts and stale reads/requests add no input/run/credit changes', async () => {
      // Isolate deletion from other scenarios; an unfinished run correctly blocks deletion.
      const projectId = (await create()).project_id, delivered = await legacy(projectId, 'deletion');
      const prepared = await read(projectId, delivered.runId, 'current'), before = await snapshot(projectId);
      const deletion = await send('DELETE', path(projectId)); assert.equal(deletion.statusCode, 204, deletion.body);
      const statuses = (await pool.query('SELECT a.delivery_status FROM bb_artifact_versions a JOIN bb_runs r ON r.id=a.run_id WHERE r.project_id=$1', [projectId])).rows;
      assert.ok(statuses.length > 0 && statuses.every(value => value.delivery_status === 'revoked'));
      assert.equal((await send('GET', `/api/v1/artifacts/${prepared.basis.editBase.artifact_id}`)).statusCode, 404);
      for (const choice of ['result', 'current']) await assert.rejects(read(projectId, delivered.runId, choice), /404/);
      const response = await send('POST', `${path(projectId)}/input-revisions`, { draft_revision: project.draft_revision,
        prospectus_selection_revision: prepared.basis.selectionRevision, edit_base: prepared.basis.editBase, material_versions: [], requirement_message_ids: [] });
      assert.equal(response.statusCode, 404); assert.deepEqual(await snapshot(projectId), before);
    });
    for (const table of ['bb_model_call_attempts', 'bb_provider_call_observations'])
      assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
    assert.deepEqual(externalSockets, []);
    t.diagnostic('Real Fastify inject/API/PG/queue/paid legacy ledger/installed Python Word checker/compiled guards; synthetic principal/metadata/model output/Blob; no TCP browser or provider; no release receipt.');
  });
