import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPublicKey, randomUUID, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITY_SCHEMA, CAPABILITY_PATHS, PROFILE_SHA256, HTTPS_BLOB, TEMPLATE_DATABASE, CAPABILITY_DATABASE, DEDICATED_DATABASE, capabilityHash, verifyPreparedCapabilities } from './capabilities.mjs';
import { verifyParserDirectory } from './parser-source.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export function inspectTestCertificates(caPem, serverPem, serverKey, now = Date.now()) {
  const ca = new X509Certificate(caPem), server = new X509Certificate(serverPem);
  assert.equal(ca.ca, true); assert.equal(server.ca, false); assert.ok(server.verify(ca.publicKey));
  assert.equal(server.checkIP('127.0.0.1'), '127.0.0.1'); assert.equal(server.checkHost('localhost'), 'localhost');
  assert.equal(server.publicKey.export({ type: 'spki', format: 'pem' }), createPublicKey(serverKey).export({ type: 'spki', format: 'pem' }));
  const from = Math.max(Date.parse(ca.validFrom), Date.parse(server.validFrom));
  const to = Math.min(Date.parse(ca.validTo), Date.parse(server.validTo));
  assert.ok(from <= now && now < to && to - from <= 25 * 3600000, 'Test certificate must be current and short lived');
  return { ca_sha256: capabilityHash(caPem), server_sha256: capabilityHash(serverPem), valid_from: new Date(from).toISOString(), valid_to: new Date(to).toISOString(), ca_path: CAPABILITY_PATHS.ca, endpoint: 'https://127.0.0.1:10003/devstoreaccount1' };
}
export function prepareTestTls(directory) {
  if (existsSync(directory)) assert.equal(readdirSync(directory).length, 0, 'Never reuse a previous test certificate');
  else mkdirSync(directory, { recursive: true, mode: 0o700 });
  const run = args => {
    const result = spawnSync('openssl', args, { cwd: directory, windowsHide: true, encoding: 'utf8', timeout: 30000 });
    if (result.error || result.status !== 0) throw new Error('Existing OpenSSL could not create the isolated test TLS certificate');
  };
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=BondBuddy disposable PR gate CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', 'ca.key', '-out', 'ca.pem']);
  run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'server.key', '-out', 'server.csr']);
  writeFileSync(join(directory, 'server.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
  run(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'server.ext', '-out', 'server.pem']);
  for (const file of ['ca.key', 'server.key']) chmodSync(join(directory, file), 0o600);
  return inspectTestCertificates(readFileSync(join(directory, 'ca.pem')), readFileSync(join(directory, 'server.pem')), readFileSync(join(directory, 'server.key')));
}
export function prepareCapabilities(environment = process.env) {
  const parser = verifyParserDirectory(join(CAPABILITY_PATHS.directory, 'parser106.tar'), CAPABILITY_PATHS.parser);
  const tls = prepareTestTls(join(CAPABILITY_PATHS.directory, 'tls'));
  const prepared = { schema: CAPABILITY_SCHEMA, status: 'passed', commit: environment.GITHUB_SHA, tree: environment.PR_GATE_TREE,
    profile_sha256: PROFILE_SHA256, parser, tls, database: { template: TEMPLATE_DATABASE, dedicated: DEDICATED_DATABASE },
    authorized_manifest_sha256: capabilityHash(readFileSync(join(root, 'tests/samples/2026-09-25/manifest.json'))) };
  verifyPreparedCapabilities(prepared, { commit: environment.GITHUB_SHA, tree: environment.PR_GATE_TREE });
  writeFileSync(join(CAPABILITY_PATHS.directory, 'prepared.json'), JSON.stringify(prepared, null, 2) + '\n');
  return prepared;
}
export async function prepareCapabilityServices(shard, output, environment = process.env) {
  assert.match(shard, /^(api-[12]|worker-[12]|misc|browser-[123])$/);
  assert.equal(environment.BB_TEST_DATABASE_URL, TEMPLATE_DATABASE);
  assert.equal(environment.BB_TEST_AZURITE_CONNECTION_STRING, 'UseDevelopmentStorage=true');
  assert.equal(environment.NODE_EXTRA_CA_CERTS, CAPABILITY_PATHS.ca);
  const prepared = verifyPreparedCapabilities(JSON.parse(readFileSync(join(CAPABILITY_PATHS.directory, 'prepared.json'), 'utf8')), { commit: environment.GITHUB_SHA, tree: environment.PR_GATE_TREE });
  assert.notEqual(environment.NODE_TLS_REJECT_UNAUTHORIZED, '0');
  const tlsDirectory = join(CAPABILITY_PATHS.directory, 'tls');
  assert.deepEqual(inspectTestCertificates(readFileSync(join(tlsDirectory, 'ca.pem')), readFileSync(join(tlsDirectory, 'server.pem')), readFileSync(join(tlsDirectory, 'server.key'))), prepared.tls, 'Test TLS identity changed before readiness');
  const { Client } = await import('pg');
  const client = new Client({ connectionString: TEMPLATE_DATABASE.replace('/bb_m4_core', '/postgres') });
  let postgresVersion;
  await client.connect();
  try {
    postgresVersion = Number((await client.query('SHOW server_version_num')).rows[0].server_version_num);
    assert.ok(postgresVersion >= 160000 && postgresVersion < 170000);
    // Every shard owns a fresh PostgreSQL container. A collision fails closed;
    // never adopt/drop an existing database or attach to a user's service.
    await client.query(`CREATE DATABASE "${CAPABILITY_DATABASE}" TEMPLATE "bb_m4_core"`);
  } finally { await client.end(); }
  const { BlobServiceClient } = await import('@azure/storage-blob');
  const service = BlobServiceClient.fromConnectionString(HTTPS_BLOB);
  const cors = [{ allowedOrigins: 'https://bondbuddy.test', allowedMethods: 'PUT,OPTIONS', allowedHeaders: 'content-type,x-ms-blob-type,if-none-match', exposedHeaders: 'etag', maxAgeInSeconds: 30 }];
  for (let attempt = 0; ; attempt++) {
    try { await service.setProperties({ cors }); break; }
    catch { if (attempt === 29) throw new Error('Isolated HTTPS Blob readiness failed'); await new Promise(done => setTimeout(done, 1000)); }
  }
  const container = service.getContainerClient('bb-capability-' + randomUUID()), data = Buffer.from('synthetic-pr-gate-https-readiness');
  try {
    await container.create(); const blob = container.getBlockBlobClient('probe'); await blob.uploadData(data);
    assert.deepEqual(await blob.downloadToBuffer(), data);
    const preflight = await fetch(blob.url, { method: 'OPTIONS', headers: { Origin: 'https://bondbuddy.test', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type,x-ms-blob-type,if-none-match' } });
    assert.equal(preflight.status, 200); assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://bondbuddy.test');
  } finally { await container.deleteIfExists(); }
  const record = { status: 'passed', shard, commit: prepared.commit, tree: prepared.tree, preparation_sha256: capabilityHash(prepared), postgres_version: postgresVersion,
    database: CAPABILITY_DATABASE, https_endpoint: prepared.tls.endpoint, blob_roundtrip_sha256: capabilityHash(data), cors_origin: 'https://bondbuddy.test', completed_at: new Date().toISOString() };
  writeFileSync(output, JSON.stringify(record, null, 2) + '\n'); return record;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, shard, output] = process.argv.slice(2);
  if (mode === 'prepare' && !shard) prepareCapabilities();
  else if (mode === 'services' && shard && output) await prepareCapabilityServices(shard, output);
  else throw new Error('Usage: capability-runtime.mjs prepare | services <shard> <output>');
}
