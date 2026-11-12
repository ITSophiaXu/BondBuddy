// Synthetic records for verifier unit tests; never runtime/release evidence.
import { BROWSER_API_PROFILES, BROWSER_API_ORIGIN, BROWSER_ORIGIN, BROWSER_PROTOTYPE_FILES, BROWSER_PROTOTYPE_ORIGIN, BROWSER_TERMS, browserHash, createBrowserPlan } from './browser-profiles.mjs';
import { createBrowserDispatch } from './browser-dispatch.mjs';
import { browserFilesForShard } from './browser-host.mjs';
import { browserInvocation } from './browser-runtime.mjs';
import { BROWSER_TOOLS_ROOT, BROWSER_TOOLS_SCHEMA } from './browser-tools.mjs';
import { REFERENCE_TESTS, QA_BASELINE_TEST } from './browser-reference-source.mjs';
import { syntheticQaBaselineAliases } from './browser-reference.test-fixture.mjs';
import { syntheticBrowserUploadConfirmation } from './browser-upload-confirmation.test-fixture.mjs';

export const syntheticBrowserSources = () => Object.fromEntries([...new Set([...Object.keys(BROWSER_API_PROFILES), ...BROWSER_PROTOTYPE_FILES, ...REFERENCE_TESTS, QA_BASELINE_TEST])].sort().map(file => [file, browserHash(file)]));
const stamp = second => `2026-11-11T13:00:${String(second).padStart(2, '0')}.000Z`;
export function syntheticBrowserShard(expected, row, capabilities, runId, imageId) {
  const files = browserFilesForShard(expected, row), plan = createBrowserPlan({ candidate: expected, runId, shard: row.name, files, sourceSha256: path => expected.browser_source_sha256[path] });
  const plan_sha256 = browserHash(JSON.stringify(plan, null, 2) + '\n'), common = { commit: expected.commit, tree: expected.tree, run_id: runId, shard: row.name };
  const runtime = { ...common, schema: 'pr-gate-browser-runtime-v1', status: 'prepared', profile_sha256: plan.profile_sha256, plan_sha256, files: plan.files,
    environment: { ...plan.environment, PATH: '/usr/local/bin:/usr/bin:/bin' }, removed_environment_keys: [], model_calls: 0, pid: 100,
    started_at: stamp(11), prepared_at: stamp(12), finished_at: stamp(23), cleanup: { status: 'passed', errors: [] }, probes: {
      browser_network: { status: 'passed', navigator_online: true, origin: BROWSER_ORIGIN, same_origin_status: 200, public_probe_requests: 0, browser_version: 'synthetic' },
      web: { status: 'passed', origin: BROWSER_ORIGIN, tls_verified: true, ca_sha256: capabilities.tls.ca_sha256, response_sha256: browserHash('synthetic-web') } },
    invocation: { command: 'npx', args: browserInvocation(files.map(id => ({ id })), '', {}).args, cwd: '/workspace/apps/web', timeout_ms: 120000,
      exit_code: 0, timed_out: false, started_at: stamp(15), finished_at: stamp(22) } };
  runtime.preparation_deadline = '2026-11-11T13:02:11.000Z';
  runtime.dispatch = createBrowserDispatch(files.map(id => ({ id })));
  const call = runtime.invocation; Object.assign(call, { id: 'current', files, environment: { BB_E2E_BASE_URL: BROWSER_ORIGIN }, report_file: `/evidence/shards/${row.name}/playwright-report-current.json`,
    report_raw_sha256: browserHash('synthetic-raw-report'), report_sha256: browserHash('synthetic-parsed-report'), output_archive: { schema: 'pr-gate-browser-output-archive-v1', source_root: '/tmp/bondbuddy-web-test-results', source_exists: false, archive_root: `/evidence/shards/${row.name}/playwright-output-current`, files: [], attachments: [], manifest_sha256: browserHash({ files: [], attachments: [] }) } });
  runtime.invocations = [call]; runtime.historical_apps = []; runtime.deadline = '2026-11-11T13:02:15.000Z';
  runtime.report = { file: `/evidence/shards/${row.name}/playwright-report.json`, sha256: browserHash('synthetic-combined-report'), dispatch: { schema: 'pr-gate-browser-dispatch-v1', report_hash_encoding: 'JSON.stringify/utf8', reports: [{ id: 'current', origin: BROWSER_ORIGIN, flag: null, files, attachment_paths: [], report_sha256: call.report_sha256, argv: ['node', 'playwright', ...call.args.slice(1)], stats: { expected: files.length, unexpected: 0, flaky: 0, skipped: 0 } }] } };
  const services = { ...common, status: 'prepared', plan, plan_sha256, started_at: stamp(1), prepared_at: stamp(10), cleanup: { status: 'passed', finished_at: stamp(35) } };
  runtime.services_alive_before_cleanup = { web: true, ...(plan.needs.api ? { api: true, upload_confirmation: true } : {}), ...(plan.needs.prototype ? { prototype: true } : {}) };
  if (files.includes(QA_BASELINE_TEST)) runtime.qa_single_start_baseline = syntheticQaBaselineAliases();
  if (plan.needs.api) {
    runtime.upload_confirmation = syntheticBrowserUploadConfirmation(plan);
    services.database = { id: '1'.repeat(64), image_id: 'sha256:' + '2'.repeat(64), run_id: runId, port: 55433, database: 'bondbuddy_local', migrated: true,
      published_ports: 0, privileged: false, network: 'container:bb-pr-gate-synthetic' };
    runtime.probes.database = { status: 'passed', port: 55433, database: 'bondbuddy_local', version: '160014' };
    runtime.probes.api = { status: 'passed', origin: BROWSER_API_ORIGIN, runtime_enabled: false, synthetic_queue: false, health_sha256: browserHash('synthetic-api') };
    runtime.probes.proxy = { status: 'passed', terms_version: BROWSER_TERMS, response_sha256: browserHash('synthetic-proxy') };
  }
  if (plan.needs.parser || plan.needs.ocr) runtime.probes.python = { status: 'passed', python: '3.11.14', abi: 'synthetic-cpython-311' };
  if (plan.needs.prototype) runtime.probes.prototype = { status: 'passed', origin: BROWSER_PROTOTYPE_ORIGIN, response_sha256: browserHash('synthetic-prototype'), model_calls: 0 };
  if (plan.needs.ocr) {
    const manifest = { schema: BROWSER_TOOLS_SCHEMA, image_id: imageId, arch: 'x64', platform: 'linux', source_version: 'synthetic-tesseract-5', files: [] };
    services.tools = { image_id: imageId, manifest, manifest_sha256: browserHash(JSON.stringify(manifest, null, 2) + '\n') };
    const proof = { schema: BROWSER_TOOLS_SCHEMA, image_id: imageId, manifest_sha256: services.tools.manifest_sha256, arch: 'x64', files: 10, source_version: manifest.source_version };
    runtime.probes.ocr = { ...proof, status: 'passed', version: manifest.source_version, languages: ['eng', 'chi_sim', 'osd'], model_calls: 0, synthetic_image_sha256: browserHash('synthetic-png'), output_sha256: browserHash('synthetic-ocr') };
    runtime.tools_final = proof;
    runtime.environment.PATH = BROWSER_TOOLS_ROOT + '/bin:' + runtime.environment.PATH;
    runtime.environment.TESSDATA_PREFIX = BROWSER_TOOLS_ROOT + '/tessdata'; runtime.environment.BB_OCR_TEST_FONT = BROWSER_TOOLS_ROOT + '/fonts/NotoSansCJK-Regular.ttc';
  }
  return { services, runtime, files };
}
