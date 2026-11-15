import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runBootstrapEntry} from './bootstrap-entry.mjs';
import {selectExecutionNodeConfig} from './node-adapter.mjs';
import {sha256} from './policy.mjs';

// Enrollment and runtime IO are synthetic. Configuration selection and the
// bootstrap binding/admission checks use the production implementations.
const adapterPath = new URL('./node-adapter.mjs', import.meta.url).pathname;
const binding = {role_name: 'synthetic-node-one', role_id: '101', secret_name: 'synthetic-one'};
const services = [{service_id: 'authoring', capabilities: ['authoring']}];
const template = {pool_tag: 'synthetic', account_id: '100', region: 'ap-beijing', image_sha256: 'b'.repeat(64), services,
  node_slots: [binding, {role_name: 'synthetic-node-two', role_id: '102', secret_name: 'synthetic-two'}]};
const manifest = {version: 'execution-bootstrap-v1', pool_tag: 'synthetic', account_id: '100', region: 'ap-beijing',
  source_sha256: 'a'.repeat(64), image_sha256: template.image_sha256, services, slot_binding: binding};
const identity = {account_id: '100', region: 'ap-beijing', instance_id: 'ins-synthetic', epoch: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'};

async function fixture({publicManifest = manifest, enabled = true, adapterHash, failEnable = false,
  failEnrollment = false, operationCompleted = true, rateLimited = false} = {}) {
  const events = [];
  const config = {enabled, adapter_path: adapterPath, adapter_sha256: adapterHash ?? sha256(await readFile(adapterPath))};
  const entry = () => runBootstrapEntry({
    readConfig: async () => config, readManifest: async () => publicManifest,
    importAdapter: async () => ({createConfiguredNodeAdapter: async ({publicManifest: supplied}) => {
      selectExecutionNodeConfig(template, supplied); events.push('binding');
      return {
        metadata: async () => {events.push('metadata'); return identity;},
        broker: {enroll: async () => {
          events.push('enroll'); if (failEnrollment) throw Error('synthetic issuance pending');
          return {verified: true, expires_at: Date.now() + 600000, identity,
            source_sha256: supplied.source_sha256, image_sha256: supplied.image_sha256, services,
            launch_manifest_sha256: 'c'.repeat(64), registration_token: 'synthetic-only', operation_completed: operationCompleted};
        }},
        runtime: {
          verifyArtifacts: async () => events.push('artifacts'),
          startService: async () => {events.push('start'); return 'synthetic';},
          verifyAllReady: async () => events.push('ready'), disableClaims: async () => events.push('disable'),
        },
      };
    }}),
    enableBootstrap: async () => {events.push('enable'); if (failEnable) throw Error('synthetic systemd failure');},
    acquireAdmission: async () => {events.push('admission'); return rateLimited ? null : async () => events.push('release');},
    writeEnvelope: async () => {events.push('envelope'); return 'synthetic';},
  });
  return {entry, events};
}

test('valid first binding persists the boot entry before enrollment and the original admission sequence', async () => {
  const {entry, events} = await fixture();
  assert.deepEqual((await entry()).identity, identity);
  assert.deepEqual(events, ['binding', 'enable', 'admission', 'metadata', 'enroll', 'artifacts', 'envelope', 'start', 'ready', 'release']);
});

test('pending issuance retains the boot entry without starting any transport or task', async () => {
  const {entry, events} = await fixture({failEnrollment: true});
  await assert.rejects(entry(), /issuance pending/);
  assert.deepEqual(events, ['binding', 'enable', 'admission', 'metadata', 'enroll', 'release']);
});

test('invalid manifest or disabled/changed image adapter never enables or reaches enrollment', async () => {
  for (const options of [
    {publicManifest: {...manifest, slot_binding: {...binding, secret_name: 'synthetic-two'}}},
    {publicManifest: {...manifest, version: 'unknown'}},
    {publicManifest: {...manifest, account_id: '999'}},
    {enabled: false}, {adapterHash: 'd'.repeat(64)},
  ]) {
    const {entry, events} = await fixture(options);
    await assert.rejects(entry()); assert.deepEqual(events, []);
  }
});

test('persistent-enable failure closes admission before metadata or enrollment', async () => {
  const {entry, events} = await fixture({failEnable: true});
  await assert.rejects(entry(), /systemd failure/);
  assert.deepEqual(events, ['binding', 'enable']);
});

test('enabled entry still rejects an unfinished operation before artifacts or task startup', async () => {
  const {entry, events} = await fixture({operationCompleted: false});
  await assert.rejects(entry(), /ENROLLMENT_UNPROVEN/);
  assert.deepEqual(events, ['binding', 'enable', 'admission', 'metadata', 'enroll', 'release']);
});

test('a persisted rate rejection enables future boots but performs no metadata or secret read', async () => {
  const {entry, events} = await fixture({rateLimited: true});
  await assert.rejects(entry(), /BOOTSTRAP_RATE_LIMITED/);
  assert.deepEqual(events, ['binding', 'enable', 'admission']);
});
