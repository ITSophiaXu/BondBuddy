import assert from 'node:assert/strict';
import { isAbsolute, win32 } from 'node:path';

export const DOCKER_TESTS = Object.freeze({
  'scripts/release-smoke/credentials.linux.test.mjs': 'docker-credentials',
  'deploy/m1/scripts/backup-integration.test.mjs': 'docker-backup',
});
export function validateDockerConfig(config, testId) {
  assert.equal(config.test_id, testId); assert.equal(config.profile_id, DOCKER_TESTS[testId]);
  assert.ok(DOCKER_TESTS[testId], 'Only exact registered Docker tests are accepted');
  assert.match(config.commit, /^[a-f0-9]{40}$/); assert.match(config.tree, /^[a-f0-9]{40}$/);
  assert.match(config.run_id, /^[a-zA-Z0-9-]{8,80}$/);
  assert.match(config.prefix, /^bb-pr-gate-docker-[a-zA-Z0-9-]+$/);
  assert.match(config.image, /^sha256:[a-f0-9]{64}$/);
  assert.ok(typeof config.context === 'string' && config.context.length > 0);
  // Windows host receipts are also verified by Linux release tooling.
  const absolute = path => typeof path === 'string' && (isAbsolute(path) || win32.isAbsolute(path));
  assert.ok(absolute(config.scratch) && absolute(config.trace));
  if (config.profile_id === 'docker-backup') {
    assert.equal(config.network, config.prefix + '-network');
    assert.equal(config.azurite_name, config.prefix + '-azurite');
    assert.match(config.azurite_image, /^sha256:[a-f0-9]{64}$/);
    assert.equal(config.app_volume, 'bb-pr-gate-native-' + config.run_id);
    assert.match(config.host_connection, /;BlobEndpoint=http:\/\/127\.0\.0\.1:[1-9][0-9]*\/devstoreaccount1;$/);
    assert.ok(config.container_connection.endsWith(';BlobEndpoint=http://' + config.azurite_name + ':10000/devstoreaccount1;'));
  }
  return config;
}

export function verifyDockerTestEvidence(evidence, entry, runtime) {
  const config = validateDockerConfig(evidence.configuration, entry.testId);
  assert.equal(config.profile_id, entry.profileId); assert.equal(config.run_id, runtime.run_id);
  assert.equal(config.prefix, 'bb-pr-gate-docker-' + runtime.run_id + '-' + entry.sequence);
  for (const key of ['commit','tree']) assert.equal(config[key], runtime[key]);
  assert.equal(config.image, runtime.image_id); assert.equal(evidence.source_bundle_sha256, runtime.bundle_sha256);
  assert.equal(evidence.source_sha256, entry.sourceSha256);
  assert.equal(evidence.source_before?.raw_bytes_verified, true); assert.ok(evidence.source_before.files > 0);
  assert.match(evidence.source_before.manifest_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(evidence.source_before, evidence.source_after);
  const original = evidence.original_command;
  assert.ok(original?.executable && original.cwd); assert.equal(original.output_limit_failed, false);
  assert.equal(original.cwd, evidence.source_root);
  assert.deepEqual(original.args, ['--test','--test-reporter=tap',entry.runPath]);
  assert.equal(original.timeout_ms, 300000); assert.equal(evidence.models, 0);
  assert.equal(evidence.engine_endpoint?.startsWith('unix://') || evidence.engine_endpoint?.startsWith('npipe://'), true);
  const expectedStatuses = entry.profileId === 'docker-credentials' ? [0,1,1,1] : [1,0,0,0,0];
  assert.equal(evidence.cases?.length, expectedStatuses.length);
  for (const [index,row] of evidence.cases.entries()) {
    assert.equal(row.index, index + 1); assert.equal(row.name, config.prefix + '-case-' + (index + 1));
    assert.equal(row.status, expectedStatuses[index]); assert.equal(row.signal, null); assert.equal(row.error, null);
    assert.equal(row.cleanup.status, 'passed'); assert.ok(row.commands.length >= 6);
    const isolation = row.isolation;
    assert.match(isolation.id, /^[a-f0-9]{64}$/); assert.equal(isolation.name, row.name); assert.equal(isolation.image, config.image);
    assert.equal(isolation.user, '1000:1000'); assert.equal(isolation.rootfs_readonly, true); assert.equal(isolation.privileged, false);
    assert.deepEqual(isolation.cap_drop, ['ALL']); assert.equal(isolation.no_new_privileges, true);
    assert.equal(isolation.memory, 512 * 1024 ** 2); assert.equal(isolation.memory_swap, 512 * 1024 ** 2);
    assert.equal(isolation.nano_cpus, 1000000000); assert.equal(isolation.pids_limit, 128);
    assert.equal(isolation.network, entry.profileId === 'docker-backup' ? config.network : 'none');
    const create=row.commands.find(command=>command.args?.[0]==='create');
    assert.ok(create && create.status===0 && create.error===null);
    for(const [flag,value] of [['--pull','never'],['--name',row.name],['--network',isolation.network],['--entrypoint',
      entry.profileId==='docker-credentials'?'/usr/local/bin/bb-copilot-token':'/usr/bin/env']]) assert.equal(create.args[create.args.indexOf(flag)+1],value);
    assert.ok(create.args.includes(config.image));
    const started=row.commands.find(command=>command.args?.[0]==='start');
    assert.deepEqual(started?.args,['start','-a',isolation.id]);assert.equal(started.status,row.status);assert.equal(started.error,null);
    assert.match(started.stdout_sha256,/^[a-f0-9]{64}$/);assert.match(started.stderr_sha256,/^[a-f0-9]{64}$/);
    assert.ok(row.commands.some(command=>JSON.stringify(command.args)===JSON.stringify(['rm','--force','--volumes',isolation.id])&&command.status===0));
    assert.equal(isolation.mounts.length, 2);
    if (entry.profileId === 'docker-credentials') assert.deepEqual(isolation.mounts.map(row => [row.destination,row.type,row.rw]),
      [['/run/secrets/bb-copilot-oauth','bind',false],['/usr/local/bin/bb-copilot-token','bind',false]]);
    else {
      assert.ok(isolation.mounts.some(row => row.destination === '/app' && row.name === config.app_volume && row.type === 'volume' && !row.rw));
      assert.ok(isolation.mounts.some(row => row.destination === '/backup' && row.type === 'bind' && row.rw));
    }
  }
  if (entry.profileId === 'docker-backup') {
    assert.equal(runtime.source.files[entry.testId], entry.sourceSha256);
    for (const file of ['backup-stream.mjs','blob-snapshot.mjs','backup-offhost.mjs']) assert.match(runtime.source.files['deploy/m1/scripts/' + file], /^[a-f0-9]{64}$/);
    assert.equal(evidence.network?.internal, false); assert.equal(evidence.network.name, config.network);
    assert.equal(evidence.network.driver, 'bridge'); assert.match(evidence.network.subnet, /^10\.238\.\d{1,3}\.0\/24$/);
    assert.equal(evidence.network.host_routes_changed, false);
    assert.equal(evidence.azurite?.image, config.azurite_image); assert.equal(evidence.azurite.name, config.azurite_name);
    assert.equal(evidence.azurite.host_ip, '127.0.0.1'); assert.ok(Number(evidence.azurite.host_port) > 0);
    assert.deepEqual(evidence.host_storage_probe, {status:'passed',endpoint:'http://127.0.0.1:'+evidence.azurite.host_port+'/devstoreaccount1',container_exists:false});
    assert.ok(evidence.dependencies?.normalized_lock_sha256); assert.equal(evidence.dependencies.installed, false);
    assert.equal(evidence.dependencies.product_packages, 'current candidate only');
  }
  assert.equal(evidence.cleanup?.status, 'passed');
}
