import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertProbeDatabase, validateProbeConfiguration } from './reference-library-probe-safety.mjs';

const env = {
  BB_REFERENCE_PROBE_ENV: 'isolated', BB_REFERENCE_PROBE_DB_HOST: 'bbprobe-pg',
  DATABASE_URL: 'postgresql://test:synthetic@bbprobe-pg:5432/bb_ref_probe_acceptance',
  AZURE_STORAGE_CONNECTION_STRING: 'DefaultEndpointsProtocol=http;AccountName=bbprobe;AccountKey=synthetic;BlobEndpoint=http://bbprobe-azurite:10000/bbprobe;',
  BB_REFERENCE_PROBE_RECOVER: 'synthetic_uncommitted_blob_fault',
};

test('probe requires explicit isolated mode, dedicated database name and Azurite endpoint', () => {
  assert.equal(validateProbeConfiguration(env, 'live').database, 'bb_ref_probe_acceptance');
  assert.throws(() => validateProbeConfiguration({ ...env, BB_REFERENCE_PROBE_ENV: '' }, 'live'), /PROBE_ISOLATION_REQUIRED/);
  assert.throws(() => validateProbeConfiguration({ ...env, DATABASE_URL: 'postgresql://test:synthetic@bbprobe-pg:5432/bondbuddy' }, 'live'), /PROBE_DATABASE_REJECTED/);
  assert.throws(() => validateProbeConfiguration({ ...env, BB_REFERENCE_PROBE_DB_HOST: 'other-pg' }, 'live'), /PROBE_DATABASE_REJECTED/);
  assert.throws(() => validateProbeConfiguration({ ...env, AZURE_STORAGE_CONNECTION_STRING: 'AccountName=production;BlobEndpoint=https://storage.example.test/container;' }, 'live'), /PROBE_BLOB_REJECTED/);
  assert.throws(() => validateProbeConfiguration({ ...env, BB_REFERENCE_PROBE_RECOVER: '' }, 'recover'), /PROBE_RECOVERY_NOT_SELECTED/);
});

test('probe refuses a database containing project data or unrelated library state', async () => {
  const empty = { database: 'bb_ref_probe_acceptance', projects: 0, users: 0, runs: 0, foreign_sources: 0,
    foreign_documents: 0, foreign_jobs: 0, published_versions: 0, sources: 0, documents: 0, library_jobs: 0 };
  await assertProbeDatabase({ query: async () => ({ rows: [empty] }) }, empty.database);
  await assert.rejects(assertProbeDatabase({ query: async () => ({ rows: [{ ...empty, projects: 1 }] }) }, empty.database), /PROBE_DATABASE_NOT_DEDICATED/);
  await assert.rejects(assertProbeDatabase({ query: async () => ({ rows: [{ ...empty, foreign_sources: 1 }] }) }, empty.database), /PROBE_DATABASE_NOT_DEDICATED/);
  await assert.rejects(assertProbeDatabase({ query: async () => ({ rows: [{ ...empty, sources: 1 }] }) }, empty.database, 'live'), /PROBE_DATABASE_NOT_EMPTY/);
  await assert.rejects(assertProbeDatabase({ query: async () => ({ rows: [empty] }) }, 'bb_ref_probe_other'), /PROBE_DATABASE_NOT_DEDICATED/);
});
