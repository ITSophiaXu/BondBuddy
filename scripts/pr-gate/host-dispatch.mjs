import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { GROUPS, evaluateNode, evaluatePython, parseExclusions } from './run.mjs';
import { HOST_PROFILES } from './host-profiles.mjs';
import { DISPATCH_SCHEMA, makeRequest, planHash, requestName, sha256, verifyExecution, verifyPlan, verifyRequest } from './host-dispatch-protocol.mjs';
import { readPlainJson } from './host-dispatch-client.mjs';
import { verifyDockerTestEvidence } from './docker-evidence.mjs';

/** Use the original discovery and modulo sharding, in original matrix order. */
export function createHostPlan({ root, candidate, matrix, runId, sourceBlob }) {
  const lists = parseExclusions(JSON.parse(sourceBlob('scripts/pr-gate/exclusions.json').toString('utf8')));
  const discovered = Object.fromEntries(Object.entries(GROUPS).map(([name, group]) => [name, group.discover(root)]));
  const entries = [];
  for (const row of matrix) {
    const [index, total] = row.shard.split('/').map(Number);
    for (const group of row.groups.split(',').map(name => name.trim())) {
      const active = discovered[group].filter(item => !lists.notInCi.some(entry => entry.expression.test(item.id)));
      for (const [position, item] of active.entries()) {
        if (position % total !== index - 1 || !HOST_PROFILES[item.id]) continue;
        const profile = HOST_PROFILES[item.id];
        assert.equal(profile.runner, GROUPS[group].runner);
        entries.push({ sequence: entries.length, shard: row.name, group, testId: item.id, runPath: item.run, runner: profile.runner,
          profileId: profile.id, sourceSha256: sha256(sourceBlob(item.id)), fileTimeoutMs: 300_000 });
      }
    }
  }
  return verifyPlan({ schema: DISPATCH_SCHEMA, run_id: runId, commit: candidate.commit, tree: candidate.tree,
    profile_sha256: sha256(HOST_PROFILES), entries }, candidate);
}

const plainDirectory = directory => {
  const stat = lstatSync(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Dispatch directory was replaced');
};
const publish = (path, value) => {
  assert.ok(!existsSync(path) && !existsSync(path + '.tmp'), 'Dispatch response already exists');
  writeFileSync(path + '.tmp', JSON.stringify(value) + '\n', { flag: 'wx' }); renameSync(path + '.tmp', path);
};
const failureExecution = message => ({ code: null, signal: null, timedOut: false, stdout: '', stderr: message + '\n', durationMs: 0 });

export function verifyAdapterResult(result, { candidate, runId, entry }) {
  verifyExecution(result.execution);
  const evidence = result.evidence;
  assert.equal(evidence?.profile_id, entry.profileId);
  assert.equal(evidence.commit, candidate.commit); assert.equal(evidence.tree, candidate.tree);
  assert.equal(evidence.run_id, runId); assert.equal(evidence.test_id, entry.testId);
  const start = Date.parse(evidence.started_at), end = Date.parse(evidence.finished_at);
  assert.ok(Number.isFinite(start) && Number.isFinite(end) && end >= start);
  assert.ok(Array.isArray(evidence.commands) && evidence.commands.length > 0, 'Actual adapter command evidence missing');
  assert.ok(Array.isArray(evidence.resources), 'Adapter resource inventory missing');
  assert.equal(evidence.cleanup?.status, 'passed', 'Adapter resources were not verified clean');
  return result;
}

export async function executeRegisteredAdapter(context) {
  if (['docker-credentials', 'docker-backup'].includes(context.entry.profileId)) {
    const { executeDockerTests } = await import('./host-adapters/docker-tests.mjs');
    return executeDockerTests(context);
  }
  if (context.entry.profileId === 'windows-archive') {
    const { executeWindowsArchive } = await import('./host-adapters/windows-archive.mjs');
    return executeWindowsArchive(context);
  }
  if (context.entry.profileId === 'windows-billing') {
    const { executeWindowsBilling } = await import('./host-adapters/windows-billing.mjs');
    return executeWindowsBilling(context);
  }
  if (['native-sandbox', 'native-desktop', 'native-ocr'].includes(context.entry.profileId)) {
    const { executeNativeCapability } = await import('./host-adapters/native.mjs');
    return executeNativeCapability(context);
  }
  throw new Error('No committed host adapter for ' + context.entry.profileId);
}

/** The plan and completed records stay in host memory, outside the core mount. */
export function createHostBroker({ plan, directory, evidenceRoot, sourceRoot, dependencyRoot, runtime, executeAdapter = executeRegisteredAdapter }) {
  verifyPlan(plan, plan);
  for (const path of [directory, join(directory, 'requests'), join(directory, 'responses'), evidenceRoot]) mkdirSync(path, { recursive: false });
  publish(join(directory, 'plan.json'), plan);
  const records = [], errors = [], consumed = new Set();
  let running = false;
  const snapshot = () => ({ schema: DISPATCH_SCHEMA, plan, plan_sha256: planHash(plan), records, errors, runtime: runtime?.evidence ?? null });
  const save = () => writeFileSync(join(evidenceRoot, 'dispatch.json'), JSON.stringify(snapshot(), null, 2) + '\n');
  save();

  return {
    snapshot, save,
    setRuntime(value) { assert.equal(running, false); runtime = value; save(); },
    startShard(shard) {
      assert.equal(running, false, 'Only one host shard may run at a time'); running = true;
      const selected = plan.entries.filter(entry => entry.shard === shard), controller = new AbortController();
      let stopped = false, cursor = 0;
      const pump = (async () => {
        try {
          while (!stopped && cursor < selected.length) {
            plainDirectory(directory); plainDirectory(join(directory, 'requests')); plainDirectory(join(directory, 'responses'));
            const entry = selected[cursor], name = requestName(entry.sequence);
            const pending = readdirSync(join(directory, 'requests')).filter(file => !file.endsWith('.tmp') && !consumed.has(file));
            if (!pending.length) { await new Promise(resolve => setTimeout(resolve, 50)); continue; }
            let result, infrastructureError = null;
            const startedAt = new Date().toISOString();
            try {
              assert.deepEqual(pending, [name], 'Host request arrived out of original plan order');
              verifyRequest(readPlainJson(join(directory, 'requests', name), 8192), plan, entry);
              const entryRoot = join(evidenceRoot, String(entry.sequence).padStart(6, '0')); mkdirSync(entryRoot);
              result = await executeAdapter({ candidate: { commit: plan.commit, tree: plan.tree }, sourceRoot, dependencyRoot,
                evidenceRoot: entryRoot, runId: plan.run_id, entry, runtime, signal: controller.signal });
              verifyAdapterResult(result, { candidate: plan, runId: plan.run_id, entry });
            } catch (error) {
              infrastructureError = error.message; errors.push(`${entry.testId}: ${error.message}`);
              result = { execution: result?.execution ?? error.execution ?? failureExecution(error.message),
                evidence: result?.evidence ?? error.evidence ?? { profile_id: entry.profileId, commit: plan.commit, tree: plan.tree,
                  run_id: plan.run_id, test_id: entry.testId, started_at: startedAt, finished_at: new Date().toISOString(), error: error.message } };
              try { verifyExecution(result.execution); } catch { result.execution = failureExecution(error.message); }
            }
            const evidenceHash = sha256(result.evidence);
            const evaluated = entry.runner === 'python' ? evaluatePython(result.execution) : evaluateNode(result.execution);
            if (infrastructureError) { evaluated.status = 'failed'; evaluated.reason = `Host capability failed: ${infrastructureError}`; }
            const { stdout: _stdout, stderr: _stderr, ...execution } = result.execution;
            const record = { sequence: entry.sequence, shard: entry.shard, test_id: entry.testId, profile_id: entry.profileId,
              plan_sha256: planHash(plan), evidence_sha256: evidenceHash, evidence: result.evidence,
              stdout_sha256: sha256(result.execution.stdout), stderr_sha256: sha256(result.execution.stderr),
              execution, evaluated, infrastructure_error: infrastructureError };
            // These raw outputs are not mounted into the core runner. Later
            // requests cannot rewrite prior execution evidence or its hashes.
            const logRoot = join(evidenceRoot, String(entry.sequence).padStart(6, '0')); mkdirSync(logRoot, { recursive: true });
            writeFileSync(join(logRoot, 'test.stdout.log'), result.execution.stdout);
            writeFileSync(join(logRoot, 'test.stderr.log'), result.execution.stderr);
            writeFileSync(join(logRoot, 'record.json'), JSON.stringify(record, null, 2) + '\n');
            records.push(record); consumed.add(name); save();
            publish(join(directory, 'responses', name), { request: makeRequest(plan, entry), execution: result.execution,
              evidence_sha256: evidenceHash, infrastructure_error: infrastructureError });
            cursor++;
          }
        } catch (error) { errors.push(`${shard}: ${error.message}`); save(); }
      })();
      return {
        async finish() {
          stopped = true; controller.abort(); await pump; running = false;
          if (cursor !== selected.length) errors.push(`${shard}: executed ${cursor}/${selected.length} planned host files`);
          const extras = readdirSync(join(directory, 'requests')).filter(file => !consumed.has(file));
          if (extras.length) errors.push(`${shard}: unconsumed dispatch request files: ${extras.join(', ')}`);
          save();
        },
      };
    },
  };
}

export function verifyHostRuns(receipt, expected) {
  const dispatch = receipt.host_dispatch;
  assert.equal(dispatch?.schema, DISPATCH_SCHEMA, 'Host dispatch receipt missing');
  const plan = verifyPlan(dispatch.plan, expected);
  assert.equal(plan.run_id, receipt.run_id); assert.equal(dispatch.plan_sha256, planHash(plan));
  assert.deepEqual(dispatch.errors, [], 'Host dispatcher has errors');
  assert.equal(dispatch.runtime?.cleanup?.status, 'passed', 'Native candidate runtime cleanup missing');
  assert.equal(dispatch.runtime.run_id, receipt.run_id, 'Native runtime belongs to another gate run');
  for (const key of ['commit', 'tree']) assert.equal(dispatch.runtime[key], expected[key], 'Native runtime belongs to another candidate');
  for (const key of ['image_id', 'core_image_id']) assert.match(dispatch.runtime[key], /^sha256:[a-f0-9]{64}$/, 'Native runtime image identity missing');
  assert.match(dispatch.runtime.bundle_sha256, /^[a-f0-9]{64}$/);
  assert.match(dispatch.runtime.reportlab_cache_sha256, /^[a-f0-9]{64}$/);
  assert.ok(dispatch.runtime.source?.raw_source?.files > 0 && dispatch.runtime.source.raw_source.byte_count > 0, 'Raw candidate verification missing');
  assert.match(dispatch.runtime.source.raw_source.manifest_sha256, /^[a-f0-9]{64}$/);
  assert.equal(dispatch.records?.length, plan.entries.length, 'Host executions missing');
  const seen = receipt.shards.flatMap(shard => {
    assert.ok(Array.isArray(shard.summary?.host_dispatch), 'Shard host execution references missing');
    return shard.summary.host_dispatch.map(row => ({ ...row, shard: shard.name }));
  });
  assert.equal(seen.length, plan.entries.length, 'Host execution references missing or duplicated');
  for (const [index, entry] of plan.entries.entries()) {
    const record = dispatch.records[index], row = seen[index];
    assert.equal(expected.host_source_sha256?.[entry.testId], entry.sourceSha256, 'Host test source differs from requested Git commit');
    for (const actual of [record, row]) {
      assert.equal(actual.sequence, entry.sequence); assert.equal(actual.shard, entry.shard);
      assert.equal(actual.test_id, entry.testId); assert.equal(actual.profile_id, entry.profileId);
      assert.equal(actual.plan_sha256, planHash(plan)); assert.equal(actual.infrastructure_error, null);
    }
    assert.equal(record.evidence_sha256, sha256(record.evidence)); assert.equal(row.evidence_sha256, record.evidence_sha256);
    for (const key of ['stdout_sha256', 'stderr_sha256', 'execution']) assert.deepEqual(row[key], record[key], 'Host and original runner execution evidence differs');
    assert.equal(record.evaluated.status, 'passed'); assert.ok(record.evaluated.tests > 0); assert.equal(record.evaluated.skipped, 0);
    assert.equal(row.status, 'passed'); assert.equal(row.tests, record.evaluated.tests); assert.equal(row.skipped, 0);
    assert.equal(record.evidence.cleanup.status, 'passed');
    assert.equal(record.evidence.run_id, receipt.run_id, 'Host evidence belongs to another gate run');
    assert.equal(record.evidence.test_id, entry.testId, 'Host evidence belongs to another test');
    assert.equal(record.evidence.profile_id, entry.profileId, 'Host evidence belongs to another capability');
    for (const key of ['commit', 'tree']) assert.equal(record.evidence[key], expected[key]);
    if (entry.profileId.startsWith('docker-')) verifyDockerTestEvidence(record.evidence, entry, dispatch.runtime);
    if (entry.profileId === 'windows-archive') {
      const evidence = record.evidence, command = evidence.original_command;
      assert.equal(record.evaluated.tests, 4, 'All four original archive cases must run');
      assert.equal(evidence.platform, 'win32'); assert.equal(evidence.node?.platform, 'win32');
      assert.ok(Number(evidence.node.version.split('.')[0]) >= 22);
      assert.equal(evidence.python?.platform, 'win32');
      const version = evidence.python.version;
      assert.ok(Array.isArray(version) && version.length === 3 && version.every(n => Number.isSafeInteger(n) && n >= 0));
      assert.ok(version[0] > 3 || (version[0] === 3 && version[1] >= 12));
      for (const tool of [evidence.node, evidence.python]) { assert.ok(win32.isAbsolute(tool.executable) && win32.parse(tool.executable).root.length > 1); assert.match(tool.sha256, /^[a-f0-9]{64}$/); }
      assert.ok(win32.isAbsolute(evidence.source_root)); assert.equal(evidence.test_source_sha256, entry.sourceSha256);
      assert.equal(evidence.source_before?.raw_bytes_verified, true); assert.ok(evidence.source_before.files > 0);
      assert.match(evidence.source_before.manifest_sha256, /^[a-f0-9]{64}$/);
      assert.deepEqual(evidence.source_after, evidence.source_before);
      assert.deepEqual(evidence.temporary_remaining, []); assert.deepEqual(evidence.cleanup.errors, []);
      assert.equal(command?.executable, evidence.node.executable); assert.equal(command.cwd, evidence.source_root);
      assert.deepEqual(command.args, ['--test', '--test-reporter=tap', entry.runPath]);
      assert.equal(command.timeout_ms, entry.fileTimeoutMs); assert.equal(command.cancelled, false); assert.equal(command.output_limit_failed, false);
      for (const key of ['code', 'signal', 'timedOut', 'durationMs']) assert.deepEqual(command[key], record.execution[key]);
      for (const key of ['stdout_sha256', 'stderr_sha256']) assert.equal(command[key], record[key]);
      assert.deepEqual(evidence.commands.filter(row => row.label === 'archive-test'), [command]);
      for (const label of ['python-identity', 'archive-support']) {
        const probes = evidence.commands.filter(row => row.label === label); assert.equal(probes.length, 1);
        assert.equal(probes[0].code, 0); assert.equal(probes[0].timedOut, false); assert.equal(probes[0].cancelled, false);
        assert.equal(probes[0].output_limit_failed, false); assert.equal(probes[0].cwd, evidence.source_root);
        assert.match(probes[0].stdout_sha256, /^[a-f0-9]{64}$/); assert.match(probes[0].stderr_sha256, /^[a-f0-9]{64}$/);
      }
      const support = evidence.commands.find(row => row.label === 'archive-support');
      assert.equal(support.executable, evidence.python.executable);
      assert.deepEqual(support.args, ['-I', win32.join(evidence.source_root, 'scripts/release-smoke/extract-archive.py'), '--check']);
    }
    if (entry.profileId.startsWith('native-')) {
      assert.equal(dispatch.runtime.source.files[entry.testId], entry.sourceSha256);
      assert.equal(record.evidence.source_bundle_sha256, dispatch.runtime.bundle_sha256);
      assert.equal(record.evidence.probe?.status, 'passed', 'Native capability probe missing');
      for (const key of ['commit', 'tree']) assert.equal(record.evidence.probe[key], expected[key]);
      assert.equal(record.evidence.probe.uid, 1000); assert.equal(record.evidence.probe.models, 0); assert.equal(record.evidence.probe.network, 'none');
      assert.equal(record.evidence.isolation?.user, '1000:1000'); assert.equal(record.evidence.isolation.network, 'none');
      assert.equal(record.evidence.isolation.rootfs_readonly, true); assert.equal(record.evidence.isolation.privileged, false);
      const command = record.evidence.original_command;
      assert.equal(command?.cwd, '/app'); assert.equal(command.output_limit_failed, false);
      assert.equal(command.command, entry.runner === 'python' ? '/opt/venv/bin/python' : '/usr/local/bin/node');
      assert.deepEqual(command.args, entry.runner === 'python' ? ['-m', 'unittest', '-v', 'test_ocr'] : ['--test', '--test-reporter=tap', '/app/' + entry.runPath]);
    }
    const start = Date.parse(record.evidence.started_at), end = Date.parse(record.evidence.finished_at);
    assert.ok(start >= Date.parse(receipt.started_at) && end >= start && end <= Date.parse(receipt.finished_at), 'Host evidence is outside this run');
  }
}
