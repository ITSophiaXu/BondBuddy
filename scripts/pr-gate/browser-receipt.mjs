import assert from 'node:assert/strict';
import { BROWSER_API_ORIGIN, BROWSER_ORIGIN, BROWSER_PROTOTYPE_ORIGIN, BROWSER_TERMS, browserHash, createBrowserPlan } from './browser-profiles.mjs';
import { browserFilesForShard } from './browser-host.mjs';
import { browserInvocation } from './browser-runtime.mjs';
import { BROWSER_TOOLS_ROOT } from './browser-tools.mjs';
import { verifyBrowserUploadConfirmation } from './browser-upload-confirmation.mjs';

const sha = value => assert.match(value, /^[a-f0-9]{64}$/);
const time = value => { const parsed = Date.parse(value); assert.ok(Number.isFinite(parsed)); return parsed; };
export function verifyBrowserRuns(receipt, expected) {
  assert.ok(expected.browser_source_sha256 && Object.keys(expected.browser_source_sha256).length > 0, 'Expected complete browser discovery is missing');
  for (const row of expected.matrix.filter(row => row.groups === 'browser')) {
    const shard = receipt.shards.find(shard => shard.name === row.name), services = shard.browser_services, runtime = shard.summary?.browser_runtime;
    assert.equal(services?.status, 'prepared', 'Browser services are not prepared'); assert.equal(runtime?.status, 'prepared', 'Actual browser runtime evidence is missing');
    const files = browserFilesForShard(expected, row), plan = createBrowserPlan({ candidate: expected, runId: receipt.run_id, shard: row.name, files, sourceSha256: file => expected.browser_source_sha256[file] });
    assert.deepEqual(services.plan, plan, 'Browser plan omitted/changed a discovered file or environment profile');
    const planHash = browserHash(JSON.stringify(plan, null, 2) + '\n'); assert.equal(services.plan_sha256, planHash); assert.equal(runtime.plan_sha256, planHash);
    for (const record of [services, runtime]) {
      for (const key of ['commit', 'tree']) assert.equal(record[key], expected[key]);
      assert.equal(record.run_id, receipt.run_id); assert.equal(record.shard, row.name); assert.equal(record.cleanup?.status, 'passed');
    }
    assert.equal(runtime.schema, 'pr-gate-browser-runtime-v1'); assert.equal(runtime.profile_sha256, plan.profile_sha256);
    assert.deepEqual(runtime.files, plan.files); assert.equal(runtime.model_calls, 0);
    assert.equal(shard.summary.counts.selected, files.length, 'Browser summary does not cover the original full shard');
    for (const [key, value] of Object.entries(plan.environment)) assert.equal(runtime.environment[key], value, 'Actual browser env differs: ' + key);
    assert.ok(Array.isArray(runtime.removed_environment_keys));
    const actualEnvKeys = Object.keys(runtime.environment).sort();
    assert.deepEqual(actualEnvKeys, [...Object.keys(plan.environment), 'PATH', ...(plan.needs.ocr ? ['TESSDATA_PREFIX', 'BB_OCR_TEST_FONT'] : [])].sort(), 'Unexpected browser environment switch');
    assert.ok(typeof runtime.environment.PATH === 'string' && runtime.environment.PATH.length > 0);
    const call = runtime.invocation, original = browserInvocation(files.map(id => ({ id })), '', {});
    assert.equal(call?.command, original.command); assert.deepEqual(call.args, original.args, 'Browser batch command was narrowed or changed');
    assert.equal(call.cwd, '/workspace/apps/web'); assert.equal(call.exit_code, 0); assert.equal(call.timed_out, false); assert.ok(call.timeout_ms >= 60_000 && call.timeout_ms <= 70 * 60_000);
    assert.deepEqual(runtime.services_alive_before_cleanup, { web: true, ...(plan.needs.api ? { api: true, upload_confirmation: true } : {}), ...(plan.needs.prototype ? { prototype: true } : {}) }, 'A prepared service did not survive the complete browser batch');
    const order = [shard.started_at, services.started_at, services.prepared_at, runtime.started_at, runtime.prepared_at, call.started_at, call.finished_at, runtime.finished_at, shard.summary.finishedAt, services.cleanup.finished_at, shard.finished_at];
    const stamps = order.map(time); assert.ok(stamps.every((value, i) => !i || value >= stamps[i - 1]), 'Browser readiness/test/cleanup timestamps are inconsistent');
    const web = runtime.probes?.web; assert.equal(web?.status, 'passed'); assert.equal(web.origin, BROWSER_ORIGIN); assert.equal(web.tls_verified, true);
    assert.equal(web.ca_sha256, receipt.capabilities.tls.ca_sha256); sha(web.response_sha256);
    const network = runtime.probes.browser_network; assert.equal(network?.status, 'passed'); assert.equal(network.navigator_online, true);
    assert.equal(network.origin, BROWSER_ORIGIN); assert.equal(network.same_origin_status, 200); assert.equal(network.public_probe_requests, 0); assert.ok(network.browser_version);
    if (plan.needs.api) {
      const upload = verifyBrowserUploadConfirmation(runtime.upload_confirmation, plan, { final: true, parentPid: runtime.pid });
      assert.ok(time(upload.started_at) >= time(runtime.started_at) && time(upload.ready_at) <= time(runtime.prepared_at) &&
        time(upload.stop_requested_at) >= time(call.finished_at) && time(upload.finished_at) <= time(runtime.finished_at), 'Upload confirmation did not enclose the complete browser batch');
      const pg = services.database; assert.equal(pg?.migrated, true); assert.equal(pg.port, 55433); assert.equal(pg.database, 'bondbuddy_local');
      assert.match(pg.id, /^[a-f0-9]{64}$/); assert.match(pg.image_id, /^sha256:[a-f0-9]{64}$/); assert.equal(pg.run_id, receipt.run_id);
      assert.equal(pg.published_ports, 0); assert.equal(pg.privileged, false); assert.match(pg.network, /^container:bb-pr-gate-|^container:[a-f0-9]{64}$/);
      const database = runtime.probes.database; assert.equal(database?.status, 'passed'); assert.equal(database.database, pg.database); assert.equal(database.port, pg.port);
      assert.ok(Number(database.version) >= 160000 && Number(database.version) < 170000);
      assert.equal(runtime.probes.api?.status, 'passed'); assert.equal(runtime.probes.api.origin, BROWSER_API_ORIGIN); assert.equal(runtime.probes.api.runtime_enabled, false); assert.equal(runtime.probes.api.synthetic_queue, false); sha(runtime.probes.api.health_sha256);
      assert.equal(runtime.probes.proxy?.status, 'passed'); assert.equal(runtime.probes.proxy.terms_version, BROWSER_TERMS); sha(runtime.probes.proxy.response_sha256);
    }
    else assert.equal(runtime.upload_confirmation, undefined, 'Upload consumer started without an API profile');
    if (plan.needs.parser || plan.needs.ocr) { assert.equal(runtime.probes.python?.status, 'passed'); assert.match(runtime.probes.python.python, /^3\.\d+\.\d+/); assert.ok(runtime.probes.python.abi); }
    if (plan.needs.prototype) { assert.equal(runtime.probes.prototype?.status, 'passed'); assert.equal(runtime.probes.prototype.origin, BROWSER_PROTOTYPE_ORIGIN); assert.equal(runtime.probes.prototype.model_calls, 0); sha(runtime.probes.prototype.response_sha256); }
    if (plan.needs.ocr) {
      const tools = services.tools, probe = runtime.probes.ocr; assert.match(tools?.image_id, /^sha256:[a-f0-9]{64}$/);
      assert.equal(tools.image_id, receipt.host_dispatch.runtime.image_id, 'OCR tools did not come from this run\'s immutable worker image');
      assert.equal(browserHash(JSON.stringify(tools.manifest, null, 2) + '\n'), tools.manifest_sha256);
      assert.equal(probe?.status, 'passed'); assert.equal(probe.manifest_sha256, tools.manifest_sha256); assert.equal(probe.image_id, tools.image_id);
      assert.deepEqual(probe.languages, ['eng', 'chi_sim', 'osd']); assert.equal(probe.model_calls, 0); sha(probe.synthetic_image_sha256); sha(probe.output_sha256);
      assert.equal(runtime.environment.TESSDATA_PREFIX, BROWSER_TOOLS_ROOT + '/tessdata'); assert.equal(runtime.environment.BB_OCR_TEST_FONT, BROWSER_TOOLS_ROOT + '/fonts/NotoSansCJK-Regular.ttc');
      assert.ok(runtime.environment.PATH.startsWith(BROWSER_TOOLS_ROOT + '/bin:'));
      assert.deepEqual(runtime.tools_final, Object.fromEntries(['schema', 'image_id', 'manifest_sha256', 'arch', 'files', 'source_version'].map(key => [key, probe[key]])), 'OCR tool bytes changed during the batch');
    }
  }
}
