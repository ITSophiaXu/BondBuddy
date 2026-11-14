import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { HISTORICAL_COLLECTORS } from './browser-dispatch.mjs';

export const BROWSER_PROFILE_SCHEMA = 'pr-gate-browser-profile-v1';
export const BROWSER_ORIGIN = 'https://127.0.0.1:5173';
export const BROWSER_API_ORIGIN = 'http://127.0.0.1:3000';
export const BROWSER_PROTOTYPE_ORIGIN = 'http://127.0.0.1:4320';
export const BROWSER_DATABASE = 'postgresql://bondbuddy:synthetic-ci-only@127.0.0.1:55433/bondbuddy_local';
export const BROWSER_TERMS = 'synthetic-web-test-v1';
const prefix = 'apps/web/tests/';
export const browserHash = value => createHash('sha256').update(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

export const BROWSER_API_PROFILES = Object.freeze(Object.fromEntries(Object.entries({
  'account-live.spec.ts': ['BB_E2E_LIVE'],
  'account-recovery-live.spec.ts': ['BB_E2E_RECOVERY'],
  'live.spec.ts': ['BB_E2E_LIVE'],
  'register-live.spec.ts': ['BB_E2E_LIVE'],
  'project-management-live.spec.ts': ['BB_E2E_LIVE'],
  'update-form.integration.spec.ts': ['BB_E2E_LIVE'],
  'material-processing.integration.spec.ts': ['BB_E2E_PARSE'],
  'ocr.integration.spec.ts': ['BB_E2E_OCR'],
  'project-events.integration.spec.ts': ['BB_E2E_REAL_API'],
  'project-execution.integration.spec.ts': ['BB_E2E_REAL_API', 'BB_E2E_EXECUTION_STAGING'],
}).map(([file, flags]) => [prefix + file, Object.freeze(flags)])));

// Values are explicit inputs to existing test code, never a rewritten test or a
// new exclusion. Shared BB_UX_EVIDENCE_DIR consumers remain listed in the plan.
export const BROWSER_EVIDENCE_PROFILES = Object.freeze(Object.fromEntries(Object.entries({
  'account.spec.ts': ['BB_HISTORY_EVIDENCE_DIR'],
  'assistant-project-copy-sixteenth.spec.ts': ['BB_ASSISTANT_COPY_SIXTEENTH_EVIDENCE_DIR'],
  'assistant-template-fifteenth.spec.ts': ['BB_ASSISTANT_TEMPLATE_FIFTEENTH_EVIDENCE_DIR'],
  'assistant-upload-11th.spec.ts': ['BB_ASSISTANT_UPLOAD_11TH_EVIDENCE_DIR'],
  'consistency-confirmation.spec.ts': ['BB_CONSISTENCY_CONFIRMATION_EVIDENCE_DIR'],
  'consistency-manual-reading.spec.ts': ['BB_CONSISTENCY_MANUAL_BASELINE_EVIDENCE', 'BB_CONSISTENCY_MANUAL_EVIDENCE'],
  'm4-template-fourteenth.spec.ts': ['BB_M4_TEMPLATE_FOURTEENTH_EVIDENCE_DIR'],
  'm4-upload-thirteenth.spec.ts': ['BB_M4_UPLOAD_THIRTEENTH_EVIDENCE_DIR'],
  'm4-workspace.spec.ts': ['M4_UX_EVIDENCE_DIR'],
  'material-draft-comparison.spec.ts': ['BB_MATERIAL_DRAFT_COMPARISON_EVIDENCE_DIR'],
  'qa-upload-11th-reference.spec.ts': ['BB_ELEVENTH_EVIDENCE_DIR'],
  'review-upload-twelfth.spec.ts': ['BB_TWELFTH_EVIDENCE_DIR'],
  'review-workspace.spec.ts': ['BB_ANNOTATION_EVIDENCE_DIR', 'BB_WORKSPACE_EVIDENCE', 'BB_REVIEW_LIVE_EVIDENCE', 'BB_REVIEW_CREDIT_EVIDENCE_DIR', 'BB_WORKSPACE_SCENES_DIR'],
  'ux-review-comparison.spec.ts': ['BB_UX_COMPARE'],
}).map(([file, keys]) => [prefix + file, Object.freeze(keys)])));
export const BROWSER_OPT_INS = Object.freeze({
  [prefix + 'm4-workspace.spec.ts']: { M4_UX_EVIDENCE: '1' },
  [prefix + 'project-assistant.spec.ts']: { ASSISTANT_EVIDENCE: '1' },
  [prefix + 'review-workspace.spec.ts']: { BB_WORKSPACE_DESIGN: '1' },
  [prefix + 'qa-single-start-baseline.spec.ts']: { BB_QA_SINGLE_START_BASELINE: '1' },
});
export const BROWSER_PROTOTYPE_FILES = Object.freeze([prefix + 'review-agent-progress-prototype.spec.ts', prefix + 'review-readable-prototype.spec.ts', prefix + 'review-workspace.spec.ts']);
export const BROWSER_PROFILE_SHA256 = browserHash({ api: BROWSER_API_PROFILES, evidence: BROWSER_EVIDENCE_PROFILES, optIns: BROWSER_OPT_INS, prototype: BROWSER_PROTOTYPE_FILES, historical: HISTORICAL_COLLECTORS });

export function createBrowserPlan({ candidate, runId, shard, files, sourceBlob, sourceSha256 }) {
  for (const key of ['commit', 'tree']) assert.match(candidate[key], /^[a-f0-9]{40}$/);
  assert.match(runId, /^[a-zA-Z0-9-]{8,80}$/); assert.match(shard, /^browser-[123]$/);
  assert.ok(Array.isArray(files) && files.length > 0 && new Set(files).size === files.length);
  assert.ok(Boolean(sourceBlob) !== Boolean(sourceSha256), 'Exactly one trusted source reader is required');
  const output = `/evidence/shards/${shard}/browser`;
  const environment = { BB_E2E_BASE_URL: BROWSER_ORIGIN, BB_E2E_TERMS_VERSION: BROWSER_TERMS,
    BB_TEST_DATABASE_URL: BROWSER_DATABASE, BB_TEST_AZURITE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
    BB_UX_EVIDENCE_DIR: output + '/shared', BB_WEB_TLS_CERT: '/evidence/capabilities/tls/server.pem', BB_WEB_TLS_KEY: '/evidence/capabilities/tls/server.key',
    BB_API_PROXY_TARGET: BROWSER_API_ORIGIN, NODE_EXTRA_CA_CERTS: '/evidence/capabilities/tls/ca.pem',
    BB_PYTHON: '/usr/local/bin/python', PYTHONPATH: '/workspace/python:/workspace/python/tests', PYTHONDONTWRITEBYTECODE: '1',
    BB_TEST_LIVE_AUTHORING: '0', BB_PLATFORM_PROBE_ENABLED: '0', BB_REVIEW_WEB_SEARCH_ENABLED: '0' };
  const entries = files.map(file => {
    assert.match(file, /^apps\/web\/tests\/[^/]+\.spec\.ts$/); assert.ok(!file.startsWith(prefix + 'local-'));
    const directory = output + '/' + posix.basename(file, '.spec.ts');
    const keys = BROWSER_EVIDENCE_PROFILES[file] ?? [];
    for (const key of keys) { assert.equal(environment[key], undefined, 'Conflicting per-file evidence key'); environment[key] = directory + '/' + key.toLowerCase(); }
    for (const key of BROWSER_API_PROFILES[file] ?? []) environment[key] = '1';
    Object.assign(environment, BROWSER_OPT_INS[file] ?? {});
    const sha256 = sourceBlob ? browserHash(sourceBlob(file)) : sourceSha256(file); assert.match(sha256, /^[a-f0-9]{64}$/);
    return { test_id: file, source_sha256: sha256, profile: BROWSER_API_PROFILES[file] ? 'real-local-api' : 'synthetic-browser',
      evidence_keys: [...keys], shared_evidence_root: environment.BB_UX_EVIDENCE_DIR };
  });
  const prototype = files.some(file => BROWSER_PROTOTYPE_FILES.includes(file));
  if (prototype) environment.BB_E2E_PROTOTYPE_URL = BROWSER_PROTOTYPE_ORIGIN;
  if (files.includes(prefix + 'review-workspace.spec.ts')) environment.BB_PROTOTYPE_URL = BROWSER_PROTOTYPE_ORIGIN;
  return { schema: BROWSER_PROFILE_SCHEMA, commit: candidate.commit, tree: candidate.tree, run_id: runId, shard,
    profile_sha256: BROWSER_PROFILE_SHA256, files: entries, environment, historical_apps: Object.keys(HISTORICAL_COLLECTORS).filter(id => files.includes(HISTORICAL_COLLECTORS[id].test_id)), needs: {
      api: entries.some(row => row.profile === 'real-local-api'), prototype,
      parser: files.includes(prefix + 'material-processing.integration.spec.ts'), ocr: files.includes(prefix + 'ocr.integration.spec.ts') }, output_root: output };
}

export function verifyBrowserPlan(plan, expected) {
  assert.deepEqual(plan, createBrowserPlan(expected), 'Browser plan differs from the original complete shard or candidate');
  return plan;
}

export function browserEnvironment(base, plan) {
  const env = { ...base }, removed = [];
  // Clear all inherited browser modes, URLs and evidence switches before using
  // the committed plan. In particular a false-looking nonempty "0" is unsafe
  // for tests that interpret a reference path/flag by truthiness.
  for (const key of Object.keys(env)) {
    if (/^BB_E2E_|^BB_WEB_TLS_|^BB_API_PROXY_TARGET$/.test(key) ||
      /^BB_.*(?:REFERENCE|BASELINE)(?:_DIR)?$/.test(key) ||
      /^(?:BB_|M4_|ASSISTANT_|QA_).*(?:EVIDENCE|SCREENSHOTS|DESIGN|UX_COMPARE|CAPTURE|PROTOTYPE|UX_DIR)/.test(key)) { removed.push(key); delete env[key]; }
  }
  for (const key of ['BB_TEST_LIVE_AUTHORING', 'BB_PLATFORM_PROBE_ENABLED', 'BB_REVIEW_WEB_SEARCH_ENABLED']) assert.equal(env[key], '0', 'Browser gate requires live models/probes/search to remain disabled');
  assert.notEqual(env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
  // The real local API must not discover inherited provider/payment credentials,
  // proxy overrides, runtime flags or Node startup hooks from a developer shell.
  const inherited = new Set(['PATH', 'HOME', 'LANG', 'TMPDIR', 'CI', 'PLAYWRIGHT_BROWSERS_PATH', 'GITHUB_SHA', 'PR_GATE_TREE', 'PR_GATE_RUN_ID',
    'PR_GATE_BROWSER_PLAN', 'PR_GATE_BROWSER_PLAN_SHA256', 'PR_GATE_BROWSER_TOOLS_SHA256', 'PR_GATE_BROWSER_SHARD',
    'BB_TEST_LIVE_AUTHORING', 'BB_PLATFORM_PROBE_ENABLED', 'BB_REVIEW_WEB_SEARCH_ENABLED']);
  for (const key of Object.keys(env)) if (!inherited.has(key)) { removed.push(key); delete env[key]; }
  Object.assign(env, plan.environment);
  delete env.NODE_TEST_CONTEXT;
  return { env, removed: removed.sort() };
}
