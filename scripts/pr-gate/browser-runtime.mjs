import assert from 'node:assert/strict';
import { fork, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BROWSER_API_ORIGIN, BROWSER_DATABASE, BROWSER_ORIGIN, BROWSER_PROTOTYPE_ORIGIN, BROWSER_TERMS, browserEnvironment, browserHash, verifyBrowserPlan } from './browser-profiles.mjs';
import { BROWSER_TOOLS_ROOT, browserToolsEnvironment, probeBrowserTools, verifyBrowserTools } from './browser-tools.mjs';
import { startBrowserUploadConfirmation } from './browser-upload-confirmation.mjs';
import { startHistoricalApplication, historicalRemaining } from './browser-historical-runtime.mjs';
import { QA_BASELINE_TEST, createQaBaselineAliases, verifyQaBaselineAliases } from './browser-reference-source.mjs';

const here = fileURLToPath(import.meta.url);
const source = (root, commit, path) => {
  const result = spawnSync('git', ['--no-replace-objects', 'show', `${commit}:${path}`], { cwd: root, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' }, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error); assert.equal(result.status, 0); return result.stdout;
};
export function loadBrowserPlan(root, items, env) {
  assert.match(env.PR_GATE_BROWSER_PLAN_SHA256, /^[a-f0-9]{64}$/);
  const bytes = readFileSync(env.PR_GATE_BROWSER_PLAN); assert.equal(browserHash(bytes), env.PR_GATE_BROWSER_PLAN_SHA256);
  const plan = JSON.parse(bytes);
  return verifyBrowserPlan(plan, { candidate: { commit: env.GITHUB_SHA, tree: env.PR_GATE_TREE }, runId: env.PR_GATE_RUN_ID,
    shard: env.PR_GATE_BROWSER_SHARD, files: items.map(item => item.id), sourceBlob: path => source(root, env.GITHUB_SHA, path) });
}

export function browserInvocation(items, reportFile, env) {
  return { command: 'npx', args: ['playwright', 'test', ...items.map(item => 'tests/' + item.id.split('/').at(-1)), '--reporter=line,json'],
    env: { ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile, CI: env.CI ?? '1' } };
}

export function createBrowserStartupBarrier() {
  let finish, stopped = false;
  const settled = new Promise(done => { finish = done; });
  return { requestStop: () => { stopped = true; }, finish,
    wait: () => settled, requireStarting: () => assert.equal(stopped, false, 'Browser runtime stopped during preparation') };
}

/** The child owns API/Vite/prototype lifetimes and reports actual readiness. */
export async function startBrowserRuntime(root, items, inherited, deadline) {
  const plan = loadBrowserPlan(root, items, inherited);
  let { env, removed } = browserEnvironment(inherited, plan);
  if (plan.needs.ocr) { assert.match(inherited.PR_GATE_BROWSER_TOOLS_SHA256, /^[a-f0-9]{64}$/); env = browserToolsEnvironment(env); }
  const preparationDeadline = Math.min(deadline, Date.now() + 120_000);
  const control = { ...env, PR_GATE_BROWSER_CONTROL: JSON.stringify({ root, plan, removed, deadline, preparationDeadline, environment: Object.fromEntries(Object.entries(env).filter(([key]) => key in plan.environment || ['PATH', 'TESSDATA_PREFIX', 'BB_OCR_TEST_FONT'].includes(key))) }) };
  const child = fork(here, ['serve'], { cwd: root, env: control, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  let final, ready, failure;
  const ended = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })));
  try {
    ready = await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error('Browser runtime readiness timed out')), historicalRemaining(preparationDeadline));
      child.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); done(message.evidence); }
        if (message.type === 'failed') { clearTimeout(timer); reject(new Error(message.error)); }
        if (message.type === 'finished') final = message.evidence;
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); if (!ready) reject(new Error('Browser runtime exited before readiness')); });
    });
  } catch (error) { failure = error; }
  const cleanup = async () => {
    if (child.connected) child.send({ type: 'stop' }); else child.kill('SIGTERM');
    // The upload consumer may drain its owned in-flight confirmation for up to
    // 120 seconds. This cleanup grace does not change any test/batch timeout.
    const result = await Promise.race([ended, new Promise(done => { const timer = setTimeout(() => done(null), 150_000); timer.unref(); })]);
    if (!result) { child.kill('SIGKILL'); await ended; throw new Error('Browser runtime cleanup timed out'); }
    try { assert.equal(result.code, 0, 'Browser runtime did not shut down cleanly'); assert.equal(final?.cleanup?.status, 'passed'); } catch (error) { error.browserRuntimeEvidence = final ?? ready; throw error; }
    return final;
  };
  if (failure) { try { failure.browserRuntimeEvidence = await cleanup(); } catch (error) { failure.browserRuntimeEvidence = error.browserRuntimeEvidence ?? final ?? ready; } throw failure; }
  return { env, plan, evidence: ready, cleanup };
}

function httpsRead(url, ca) {
  return new Promise((done, reject) => {
    const request = get(url, { ca, rejectUnauthorized: true, timeout: 15_000 }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', data => body += data);
      response.on('end', () => done({ status: response.statusCode, body }));
    });
    request.on('error', reject); request.on('timeout', () => request.destroy(new Error('HTTPS readiness timeout')));
  });
}

async function serve() {
  const { root, plan, removed, deadline, preparationDeadline, environment } = JSON.parse(process.env.PR_GATE_BROWSER_CONTROL);
  delete process.env.PR_GATE_BROWSER_CONTROL;
  assert.equal(process.platform, 'linux'); assert.equal(root, '/workspace');
  verifyBrowserPlan(plan, { candidate: plan, runId: process.env.PR_GATE_RUN_ID, shard: process.env.PR_GATE_BROWSER_SHARD,
    files: plan.files.map(row => row.test_id), sourceBlob: path => source(root, plan.commit, path) });
  for (const [key, value] of Object.entries(environment)) assert.equal(process.env[key], value, 'Actual browser runtime environment differs');
  mkdirSync(plan.output_root, { recursive: true });
  const evidence = { schema: 'pr-gate-browser-runtime-v1', commit: plan.commit, tree: plan.tree, run_id: plan.run_id, shard: plan.shard,
    preparation_deadline: new Date(preparationDeadline).toISOString(), plan_sha256: process.env.PR_GATE_BROWSER_PLAN_SHA256, profile_sha256: plan.profile_sha256, files: plan.files,
    environment, removed_environment_keys: removed, started_at: new Date().toISOString(), pid: process.pid, probes: {}, model_calls: 0,
    status: 'failed', cleanup: { status: 'pending' } };
  let api, pool, vite, prototype, prototypeExit, stopping, uploadConfirmation, qaBaseline;
  const historicalApps = [], historicalFailed = [];
  const startup = createBrowserStartupBarrier(), requireStarting = () => { startup.requireStarting(); historicalRemaining(preparationDeadline); };
  const save = () => writeFileSync(join(plan.output_root, 'runtime.json'), JSON.stringify(evidence, null, 2) + '\n');
  const stop = async () => {
    startup.requestStop();
    if (stopping) return stopping;
    stopping = (async () => {
      // An in-flight startup owns resources before its promise resolves. Wait
      // for that acquisition to settle, then clean every acquired handle once.
      await startup.wait();
      const errors = historicalFailed.filter(app => app.cleanup?.status !== 'passed').flatMap(app => (app.cleanup?.errors?.length ? app.cleanup.errors : [app.error ?? 'Historical app cleanup did not complete']).map(message => app.id + ': ' + message));
      if (evidence.status === 'prepared') {
        evidence.services_alive_before_cleanup = { web: vite?.httpServer?.listening === true,
          ...(plan.needs.api ? { api: api?.server?.listening === true, upload_confirmation: uploadConfirmation?.isAlive() === true } : {}),
          ...(plan.needs.prototype ? { prototype: prototype?.exitCode === null && prototype?.signalCode === null } : {}) };
        if (Object.values(evidence.services_alive_before_cleanup).some(value => value !== true)) errors.push('A prepared browser service exited before batch cleanup');
      }
      evidence.historical_apps = [...historicalFailed];
      for (const app of historicalApps) try { evidence.historical_apps.push(await app.cleanup()); } catch (error) { evidence.historical_apps.push(error.historicalEvidence ?? app.evidence); errors.push(error.message); }
      for (const close of [async () => { if (uploadConfirmation) {
          try { evidence.upload_confirmation = await uploadConfirmation.cleanup(); }
          catch (error) { evidence.upload_confirmation = error.uploadConfirmationEvidence ?? uploadConfirmation.evidence; throw error; }
        } },
        async () => { if (prototype) { prototype.kill('SIGTERM'); const result = await Promise.race([prototypeExit, new Promise(done => { const t = setTimeout(() => done(null), 10_000); t.unref(); })]); if (!result) { prototype.kill('SIGKILL'); await prototypeExit; throw Error('Prototype shutdown timed out'); } } },
        async () => { await vite?.close(); }, async () => { await api?.close(); }, async () => { await pool?.end(); }]) {
        try { await close(); } catch (error) { errors.push(error.message); }
      }
      if (plan.needs.ocr) try { evidence.tools_final = verifyBrowserTools(BROWSER_TOOLS_ROOT, process.env.PR_GATE_BROWSER_TOOLS_SHA256); } catch (error) { errors.push(error.message); }
      if (qaBaseline) try {
        evidence.qa_single_start_baseline.after = qaBaseline.snapshot();
        verifyQaBaselineAliases(evidence.qa_single_start_baseline.before, evidence.qa_single_start_baseline.after);
      } catch (error) { errors.push(error.message); }
      evidence.finished_at = new Date().toISOString(); evidence.cleanup = { status: errors.length ? 'failed' : 'passed', errors }; save();
      if (process.connected) process.send({ type: 'finished', evidence }); process.exitCode = errors.length ? 1 : 0; if (process.connected) process.disconnect();
    })(); return stopping;
  };
  process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
  process.once('disconnect', () => void stop());
  process.on('message', message => { if (message.type === 'stop') void stop(); });
  try {
    requireStarting();
    // Candidate source restoration does not carry an ignored .env. Reject it
    // rather than allowing prototype/API startup to read a user's credentials.
    for (const path of ['.env', 'product-prototype/.env', 'apps/web/.env', 'apps/web/.env.local', 'apps/web/.env.development', 'apps/web/.env.development.local']) assert.ok(!existsSync(join(root, path)), 'Unexpected environment file in candidate');
    if (plan.needs.ocr) evidence.probes.ocr = probeBrowserTools(process.env.PR_GATE_BROWSER_TOOLS_SHA256, process.env, plan.output_root);
    if (plan.needs.parser || plan.needs.ocr) {
      const result = spawnSync(process.env.BB_PYTHON, ['-c', 'import json,sys,sysconfig;import docx,PIL,pypdf;import bondbuddy_document_parser,bondbuddy_ocr;print(json.dumps(dict(python=sys.version.split()[0],abi=sysconfig.get_config_var("SOABI"))))'], { env: process.env, cwd: root, encoding: 'utf8', timeout: 30_000 });
      assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); evidence.probes.python = { status: 'passed', ...JSON.parse(result.stdout) };
    }
    if (plan.needs.api) {
      assert.equal(process.env.BB_TEST_DATABASE_URL, BROWSER_DATABASE);
      const { Pool } = await import('pg'), { createServer } = await import(pathToFileURL(join(root, 'apps/api/dist/server.js'))), { azureBlobs } = await import(pathToFileURL(join(root, 'apps/api/dist/data.js')));
      requireStarting();
      pool = new Pool({ connectionString: BROWSER_DATABASE });
      const row = (await pool.query('SELECT current_database() AS database, inet_server_port() AS port, current_setting(\'server_version_num\') AS version')).rows[0];
      requireStarting();
      assert.equal(row.database, 'bondbuddy_local'); assert.equal(row.port, 55433); assert.ok(Number(row.version) >= 160000 && Number(row.version) < 170000);
      evidence.probes.database = { status: 'passed', ...row };
      api = createServer({ pool, blobs: azureBlobs('UseDevelopmentStorage=true'), allowedOrigin: BROWSER_ORIGIN, auth: { termsVersion: BROWSER_TERMS, supportContact: 'Synthetic local test support' },
        enableRunStaging: true, enableSyntheticQueue: false, enableRunRuntime: false });
      await api.listen({ host: '127.0.0.1', port: 3000 });
      requireStarting();
      const health = await fetch(BROWSER_API_ORIGIN + '/health'); assert.equal(health.status, 200);
      requireStarting();
      evidence.probes.api = { status: 'passed', origin: BROWSER_API_ORIGIN, health_sha256: browserHash(await health.text()), runtime_enabled: false, synthetic_queue: false };
      requireStarting();
      try { uploadConfirmation = await startBrowserUploadConfirmation({ root, plan }); evidence.upload_confirmation = uploadConfirmation.evidence; }
      catch (error) { evidence.upload_confirmation = error.uploadConfirmationEvidence; throw error; }
      requireStarting();
    }
    const { createServer } = await import('vite');
    requireStarting();
    if (plan.files.some(row => row.test_id === QA_BASELINE_TEST)) {
      assert.equal(process.env.BB_QA_SINGLE_START_BASELINE, '1'); qaBaseline = createQaBaselineAliases();
      evidence.qa_single_start_baseline = { before: qaBaseline.before };
    } else assert.equal(process.env.BB_QA_SINGLE_START_BASELINE, undefined);
    vite = await createServer({ root: join(root, 'apps/web'), configFile: join(root, 'apps/web/vite.config.ts'),
      plugins: qaBaseline ? [qaBaseline.plugin] : [], server: { host: '127.0.0.1', port: 5173, strictPort: true } }); requireStarting(); await vite.listen(); requireStarting();
    const ca = readFileSync(process.env.NODE_EXTRA_CA_CERTS), web = await httpsRead(BROWSER_ORIGIN, ca); assert.equal(web.status, 200); assert.match(web.body, /<html/i);
    evidence.probes.web = { status: 'passed', origin: BROWSER_ORIGIN, ca_sha256: browserHash(ca), tls_verified: true, response_sha256: browserHash(web.body) };
    requireStarting();
    if (plan.needs.api) {
      const response = await httpsRead(BROWSER_ORIGIN + '/api/v1/auth/agreement', ca); assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).terms_version, BROWSER_TERMS);
      evidence.probes.proxy = { status: 'passed', terms_version: BROWSER_TERMS, response_sha256: browserHash(response.body) };
      requireStarting();
    }
    if (plan.needs.prototype) {
      prototype = spawn(process.execPath, ['product-prototype/server.mjs'], { cwd: root, env: { PATH: process.env.PATH, HOME: '/tmp', LANG: 'C.UTF-8', PORT: '4320', BOND_BUDDY_RUNTIME: join(plan.output_root, 'prototype-state'),
        DEEPSEEK_API_KEY: '', TAVILY_API_KEY: '', REGISTRY_API_KEY: '', BOND_BUDDY_ADMIN_TOKEN: '' }, stdio: ['ignore', 'inherit', 'inherit'] });
      prototypeExit = new Promise(done => { prototype.once('exit', (code, signal) => done({ code, signal })); prototype.once('error', error => done({ error: error.message })); });
      for (let attempt = 0; ; attempt++) {
        requireStarting();
        try { const response = await fetch(BROWSER_PROTOTYPE_ORIGIN + '/api/health'); assert.equal(response.status, 200); evidence.probes.prototype = { status: 'passed', origin: BROWSER_PROTOTYPE_ORIGIN, response_sha256: browserHash(await response.text()), model_calls: 0 }; break; }
        catch (error) { if (attempt >= 29 || prototype.exitCode !== null) throw error; await new Promise(done => setTimeout(done, 500)); }
      }
    }
    for (const id of plan.historical_apps) { requireStarting(); const app = await startHistoricalApplication({ id, plan, deadline: preparationDeadline, httpsRead, requireStarting }); historicalApps.push(app); }
    evidence.historical_apps = historicalApps.map(app => app.evidence);
    // Check the browser's real interface state. Do not patch navigator or any
    // application's online/offline handlers to hide an isolated-network defect.
    const { chromium } = await import('playwright');
    requireStarting();
    const probeBrowser = await chromium.launch({ headless: true });
    try {
      requireStarting();
      const page = await probeBrowser.newPage({ ignoreHTTPSErrors: true });
      await page.goto(BROWSER_ORIGIN);
      const observed = await page.evaluate(async () => ({ navigator_online: navigator.onLine, origin: location.origin, same_origin_status: (await fetch('/')).status }));
      assert.equal(observed.navigator_online, true, 'Browser environment reports offline');
      assert.equal(observed.origin, BROWSER_ORIGIN); assert.equal(observed.same_origin_status, 200);
      evidence.probes.browser_network = { status: 'passed', ...observed, browser_version: probeBrowser.version(), public_probe_requests: 0 };
    } finally { await probeBrowser.close(); }
    requireStarting();
    evidence.status = 'prepared'; evidence.prepared_at = new Date().toISOString(); save(); startup.finish(); if (process.connected) process.send({ type: 'ready', evidence });
  } catch (error) { if (error.historicalEvidence) historicalFailed.push(error.historicalEvidence); startup.finish(); evidence.error = error.message; if (process.connected) process.send({ type: 'failed', error: error.message }); await stop(); }
}

if (process.argv[1] && resolve(process.argv[1]) === here) serve().catch(error => { console.error(error); process.exitCode = 1; process.disconnect?.(); });
