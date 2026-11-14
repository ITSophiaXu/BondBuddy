import assert from 'node:assert/strict';
import { BROWSER_API_ORIGIN, BROWSER_ORIGIN, BROWSER_PROTOTYPE_ORIGIN, BROWSER_TERMS, browserHash, createBrowserPlan } from './browser-profiles.mjs';
import { browserFilesForShard } from './browser-host.mjs';
import { browserInvocation } from './browser-runtime.mjs';
import { BROWSER_TOOLS_ROOT } from './browser-tools.mjs';
import { verifyBrowserUploadConfirmation } from './browser-upload-confirmation.mjs';
import { browserGroupPaths, createBrowserDispatch, HISTORICAL_COLLECTORS, verifyBrowserDispatch } from './browser-dispatch.mjs';
import { verifyHistoricalRuns } from './browser-historical-source.mjs';
import { verifyBrowserOutputArchive } from './browser-artifacts.mjs';
import { verifyHistoricalApplication } from './browser-historical-runtime.mjs';
import { verifyQaScreenshots } from './browser-qa-collector.mjs';

const sha = value => assert.match(value, /^[a-f0-9]{64}$/);
const time = value => { const parsed = Date.parse(value); assert.ok(Number.isFinite(parsed)); return parsed; };
export function verifyBrowserRuns(receipt, expected) {
  assert.ok(expected.browser_source_sha256 && Object.keys(expected.browser_source_sha256).length > 0, 'Expected complete browser discovery is missing');
  if (Object.values(HISTORICAL_COLLECTORS).some(value => expected.browser_source_sha256[value.test_id])) verifyHistoricalRuns(receipt, expected);
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
    assert.ok(Number.isSafeInteger(runtime.pid) && runtime.pid > 0, 'Actual browser runtime process identity is required');
    assert.deepEqual(runtime.files, plan.files); assert.equal(runtime.model_calls, 0);
    assert.equal(runtime.environment.BB_QA_SINGLE_START_BASELINE, undefined, 'QA opt-in leaked into shared runtime');
    assert.equal(runtime.qa_single_start_baseline, undefined, 'QA aliases must belong to the separate historical app');
    assert.equal(shard.summary.counts.selected, files.length, 'Browser summary does not cover the original full shard');
    for (const [key, value] of Object.entries(plan.environment)) assert.equal(runtime.environment[key], value, 'Actual browser env differs: ' + key);
    assert.ok(Array.isArray(runtime.removed_environment_keys));
    const actualEnvKeys = Object.keys(runtime.environment).sort();
    assert.deepEqual(actualEnvKeys, [...Object.keys(plan.environment), 'PATH', ...(plan.needs.ocr ? ['TESSDATA_PREFIX', 'BB_OCR_TEST_FONT'] : [])].sort(), 'Unexpected browser environment switch');
    assert.ok(typeof runtime.environment.PATH === 'string' && runtime.environment.PATH.length > 0);
    const dispatch = createBrowserDispatch(files.map(id => ({ id }))); verifyBrowserDispatch(runtime.dispatch, files.map(id => ({ id })));
    const calls = runtime.invocations; assert.ok(Array.isArray(calls) && calls.length === dispatch.length, 'Browser invocations omitted or repeated a partition');
    const preparationDeadline = time(runtime.preparation_deadline); assert.ok(preparationDeadline <= time(runtime.started_at) + 120_000 && time(runtime.prepared_at) <= preparationDeadline);
    const deadline = time(runtime.deadline); assert.ok(preparationDeadline <= deadline); assert.ok(deadline <= time(runtime.started_at) + 70 * 60_000);
    assert.deepEqual(runtime.invocation, calls.length === 1 ? calls[0] : undefined, 'Single-invocation compatibility evidence differs');
    assert.equal(runtime.report?.file, `/evidence/shards/${row.name}/playwright-report.json`); sha(runtime.report.sha256);
    assert.equal(runtime.report.dispatch?.schema, 'pr-gate-browser-dispatch-v1'); assert.equal(runtime.report.dispatch.report_hash_encoding, 'JSON.stringify/utf8');
    assert.equal(runtime.report.dispatch.reports?.length, dispatch.length);
    let last = time(runtime.prepared_at);
    for (const [index, call] of calls.entries()) {
      const group = dispatch[index], report = runtime.report.dispatch.reports[index], paths = browserGroupPaths(group, plan);
      const collector = group.id === 'qa' ? runtime.historical_apps.find(app => app.id === 'qa')?.collector : null;
      if (group.id === 'qa') assert.ok(collector, 'Missing QA private collector receipt');
      const original = collector ?? browserInvocation(group.items, '', {});
      assert.equal(call.id, group.id); assert.deepEqual(call.files, group.items.map(item => item.id));
      assert.equal(call.command, original.command); assert.deepEqual(call.args, original.args, 'Browser command omitted or changed original partition files');
      assert.equal(call.cwd, paths.cwd);
      assert.equal(report.config_paths?.rootDir, paths.rootDir); assert.equal(report.config_paths?.configFile, paths.configFile);
      assert.ok(Array.isArray(report.config_paths?.projects) && report.config_paths.projects.length > 0);
      assert.equal(new Set(report.config_paths.projects.map(project => project.id)).size, report.config_paths.projects.length);
      for (const project of report.config_paths.projects) assert.equal(project.testDir, paths.rootDir);
      assert.equal(call.output_archive_error, undefined); assert.equal(call.qa_screenshots_error, undefined);
      if (group.id === 'qa') verifyQaScreenshots(call.qa_screenshots, plan); else assert.equal(call.qa_screenshots, undefined);
      assert.equal(call.exit_code, 0); assert.equal(call.timed_out, false);
      assert.ok(Number.isSafeInteger(call.timeout_ms) && call.timeout_ms > 0 && call.timeout_ms <= 70 * 60_000);
      const start = time(call.started_at), end = time(call.finished_at); assert.ok(start >= last && end >= start && end <= deadline && start + call.timeout_ms <= deadline + 100, 'Browser partition exceeded the original shared deadline'); last = end;
      assert.deepEqual(call.environment, { BB_E2E_BASE_URL: group.origin, ...(group.flag ? { [group.flag]: '1' } : {}) }, 'Historical flag or origin leaked across invocations');
      assert.ok(Array.isArray(report.attachment_paths)); verifyBrowserOutputArchive(call.output_archive, { shard: row.name, group: group.id, attachmentPaths: report.attachment_paths });
      assert.equal(call.report_file, `/evidence/shards/${row.name}/playwright-report-${group.id}.json`); sha(call.report_raw_sha256); sha(call.report_sha256);
      for (const key of ['id', 'origin', 'flag']) assert.deepEqual(report[key], group[key]); assert.deepEqual(report.files, call.files); assert.equal(report.report_sha256, call.report_sha256);
      if (group.id === 'qa') { assert.deepEqual(report.argv.slice(0, 2), [call.command, call.args[0]]); assert.equal(report.stats.expected, 2, 'Original QA two-case count differs'); }
      assert.deepEqual(report.argv.slice(2), call.args.slice(1)); assert.equal(report.stats.unexpected, 0); assert.equal(report.stats.flaky, 0); assert.equal(report.stats.skipped, 0); assert.ok(report.stats.expected > 0);
    }
    assert.deepEqual(runtime.historical_apps.map(app => app.id), plan.historical_apps);
    for (const app of runtime.historical_apps) {
      verifyHistoricalApplication(app, { id: app.id, plan, source: receipt.historical_browser_apps.container_before.identity.sources[app.id], caSha256: receipt.capabilities.tls.ca_sha256, candidateLockSha256: expected.cache_files['package-lock.json'] });
      assert.ok(time(app.compiler.started_at) + app.compiler.timeout_ms <= preparationDeadline + 100 && time(app.prepared_at) <= preparationDeadline, 'Historical compilers did not share the original preparation deadline');
      assert.equal(app.pid, runtime.pid); assert.ok(time(app.started_at) >= time(runtime.started_at) && time(app.prepared_at) <= time(runtime.prepared_at) && time(app.finished_at) >= last && time(app.finished_at) <= time(runtime.finished_at));
    }
    const firstCall = calls[0], lastCall = calls.at(-1);
    assert.deepEqual(runtime.services_alive_before_cleanup, { web: true, ...(plan.needs.api ? { api: true, upload_confirmation: true } : {}), ...(plan.needs.prototype ? { prototype: true } : {}) }, 'A prepared service did not survive the complete browser batch');
    const order = [shard.started_at, services.started_at, services.prepared_at, runtime.started_at, runtime.prepared_at, firstCall.started_at, lastCall.finished_at, runtime.finished_at, shard.summary.finishedAt, services.cleanup.finished_at, shard.finished_at];
    const stamps = order.map(time); assert.ok(stamps.every((value, i) => !i || value >= stamps[i - 1]), 'Browser readiness/test/cleanup timestamps are inconsistent');
    const web = runtime.probes?.web; assert.equal(web?.status, 'passed'); assert.equal(web.origin, BROWSER_ORIGIN); assert.equal(web.tls_verified, true);
    assert.equal(web.ca_sha256, receipt.capabilities.tls.ca_sha256); sha(web.response_sha256);
    const network = runtime.probes.browser_network; assert.equal(network?.status, 'passed'); assert.equal(network.navigator_online, true);
    assert.equal(network.origin, BROWSER_ORIGIN); assert.equal(network.same_origin_status, 200); assert.equal(network.public_probe_requests, 0); assert.ok(network.browser_version);
    if (plan.needs.api) {
      const upload = verifyBrowserUploadConfirmation(runtime.upload_confirmation, plan, { final: true, parentPid: runtime.pid });
      assert.ok(time(upload.started_at) >= time(runtime.started_at) && time(upload.ready_at) <= time(runtime.prepared_at) &&
        time(upload.stop_requested_at) >= time(lastCall.finished_at) && time(upload.finished_at) <= time(runtime.finished_at), 'Upload confirmation did not enclose the complete browser batch');
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
