// Real SDK/Azurite checks with synthetic files on an internal, ephemeral network.
// No application environment, credentials, databases or production URLs are used.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const helper = readFileSync(fileURLToPath(new URL('./read-content.mjs', import.meta.url)), 'utf8');
const docker = process.env.BB_DIAG_DOCKER ?? 'docker';
const api = process.env.BB_DIAG_API_TEST_IMAGE ?? 'bondbuddy-m1-api:real-completion-66501ec7-84ecd6fe9d30-ff5c208c';
const token = 'bb-operations-test-' + randomBytes(6).toString('hex');
const network = token + '-network', container = token + '-blob';
const label = `io.bondbuddy.operations-test=${token}`;
let networkCreated = false, containerCreated = false;
const checks = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function run(args, input, allowFailure = false) {
  const result = spawnSync(docker, args, { input, encoding: 'utf8', timeout: 120000, maxBuffer: 5 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw Error(`Isolated Docker operation ${args[0]} failed`);
  return result;
}
function pass(name) { checks.push(name); console.log('PASS ' + name); }

try {
  const images = run(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']).stdout.split(/\r?\n/);
  const azurite = images.find(x => x.startsWith('mcr.microsoft.com/azure-storage/azurite:') && !x.endsWith(':<none>'));
  assert(azurite, 'Cached Azurite image is required');
  assert(images.includes(api), 'The explicitly selected cached API SDK image must exist');
  run(['network', 'create', '--internal', '--label', label, network]); networkCreated = true;
  const accountKey = randomBytes(32).toString('base64');
  run(['run', '-d', '--name', container, '--label', label, '--network', network, '--network-alias', 'blob', '-e', `AZURITE_ACCOUNTS=diag:${accountKey}`, azurite, 'azurite-blob', '--blobHost', '0.0.0.0', '--skipApiVersionCheck']); containerCreated = true;
  const connection = `DefaultEndpointsProtocol=http;AccountName=diag;AccountKey=${accountKey};BlobEndpoint=http://blob:10000/diag;`;
  const secret = 'synthetic-provider-secret-12345';
  function node(program, arg, allowFailure = false) {
    return run(['run', '--rm', '-i', '--network', network, '--entrypoint', 'node', '-e', `AZURE_STORAGE_CONNECTION_STRING=${connection}`, '-e', `API_KEY=${secret}`, api, '--input-type=module', '-', JSON.stringify(arg)], program, allowFailure);
  }
  const seed = `import{createRequire}from'node:module';const r=createRequire('/app/apps/api/package.json');const{BlobServiceClient}=r('@azure/storage-blob');const c=BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING).getContainerClient('bondbuddy-private');await c.createIfNotExists();for(const f of JSON.parse(process.argv[2]))await c.getBlockBlobClient(f.key).uploadData(Buffer.from(f.bytes,'base64'));console.log('seeded');`;
  function fixture(bytes = Buffer.from(JSON.stringify({ version: 'word-edit-operations-v1', operations: [{ text: `中文 ${secret}` }] }))) {
    const childHash = hash(bytes);
    const key = `owners/owner/projects/project/runs/run/file-authoring/attempt/${childHash}/operations.json`;
    const parent = Buffer.from(JSON.stringify({ version: 'codex-file-word-v1', files: { 'operations.json': { key, sha256: childHash, byte_size: bytes.length } } }));
    const parentHash = hash(parent), parentKey = `users/owner/projects/project/provider-results/attempt-${parentHash}.json`;
    return { bytes, childHash, key, parent, parentHash, parentKey, row: { kind: 'result', file: 'operations.json', owner_user_id: 'owner', project_id: 'project', run_id: 'run', attempt_id: 'attempt', object_key: parentKey, sha256: parentHash, byte_size: parent.length } };
  }
  const good = fixture();
  const records = value => [{ key: value.parentKey, bytes: value.parent.toString('base64') }, { key: value.key, bytes: value.bytes.toString('base64') }];
  let ready = false;
  for (let i = 0; i < 12; i++) {
    if (node(seed, records(good), true).status === 0) { ready = true; break; }
    await pause(500);
  }
  assert(ready, 'Isolated Azurite must become ready');
  const selected = node(helper, good.row);
  const payload = JSON.parse(selected.stdout);
  assert.equal(payload.verified_parent_sha256, good.parentHash);
  assert.equal(payload.verified_child_sha256, good.childHash);
  assert.equal(payload.verified_child_byte_size, good.bytes.length);
  assert.equal(Buffer.from(payload.redacted_content_base64, 'base64').toString(), good.bytes.toString().replace(secret, '[redacted]'));
  assert(!selected.stdout.includes(secret));
  pass('registered parent and fixed operations child verified by real SDK/Azurite with credential redaction');

  function denied(row) {
    const observed = node(helper, row, true);
    assert.equal(observed.status, 2);
    assert.equal(observed.stdout, '');
    assert.equal(observed.stderr, 'CONTENT_UNAVAILABLE_OR_INTEGRITY_FAILED\n');
    assert(!observed.stderr.includes(secret));
  }
  for (const row of [{ ...good.row, file: 'input.json' }, { ...good.row, attempt_id: 'other' }, { ...good.row, run_id: 'other' }]) denied(row);
  pass('unsupported selector and cross-attempt/run descriptors denied without plaintext');

  node(seed, [{ key: good.key, bytes: Buffer.alloc(good.bytes.length, 0x78).toString('base64') }]);
  denied(good.row);
  pass('child corruption rejected by immutable SHA verification');
  node(seed, records(good));
  node(seed, [{ key: good.parentKey, bytes: Buffer.alloc(good.parent.length, 0x78).toString('base64') }]);
  denied(good.row);
  pass('parent corruption rejected before child evidence can be released');

  for (const bytes of [Buffer.from('not-json'), Buffer.from([0xff, 0xfe])]) {
    const value = fixture(bytes); node(seed, records(value)); denied(value.row);
  }
  pass('validly hashed non-JSON and invalid UTF-8 operations rejected');
  console.log(JSON.stringify({ passed: true, checks, storage: 'isolated Azurite only', model_calls: 0, production_changed: false }));
} finally {
  if (containerCreated) {
    const observed = run(['inspect', '--format', '{{index .Config.Labels "io.bondbuddy.operations-test"}}', container], undefined, true).stdout.trim();
    if (observed === token) run(['rm', '-f', '-v', container]);
  }
  if (networkCreated) {
    const observed = run(['network', 'inspect', '--format', '{{index .Labels "io.bondbuddy.operations-test"}}', network], undefined, true).stdout.trim();
    if (observed === token) run(['network', 'rm', network]);
  }
}
