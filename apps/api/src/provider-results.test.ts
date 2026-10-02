import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, type PrivateBlobs } from './data.js';
import { persistProviderResultObject, type ProviderCallIntent } from './provider-results.js';

const intent: ProviderCallIntent = {
  owner_user_id: 'synthetic-owner', project_id: 'synthetic-project', job_id: 'synthetic-job',
  run_id: 'synthetic-run', trace_id: 'synthetic-run', logical_call_id: 'synthetic-call', call_id: 'synthetic-attempt',
  attempt_no: 1, model_id: 'gpt-6.1-sol', model_config_version: 'synthetic-v1', prompt_snapshot_ref: 'synthetic-prompt',
};
const bytes = Buffer.from('{"synthetic":true}');
function fixture() {
  const objects = new Map<string, Buffer>();
  const blobs: PrivateBlobs = {
    async put(key, value) { objects.set(key, Buffer.from(value)); },
    async get(key) { const value = objects.get(key); assert.ok(value); return value; },
    async getIfExists(key) { return objects.get(key) ?? null; },
    async getIfExistsBounded(key, limit) { const value = objects.get(key); if (value) assert.ok(value.length <= limit); return value ?? null; },
    async exists(key) { return objects.has(key); },
    async delete(key) { objects.delete(key); },
  };
  const persist = (value: ProviderCallIntent) => persistProviderResultObject({ blobs, intent: value, bytes,
    resultSchemaVersion: 'synthetic-v1', validate: value => typeof value === 'object' && value !== null && 'synthetic' in value && value.synthetic === true });
  return { objects, persist };
}

test('provider result persistence accepts dotted model IDs from the adapter contract and verifies stored bytes', async () => {
  for (const model_id of ['gpt-6.1-sol', 'gpt-5.5', 'deepseek-flash']) {
    const f = fixture();
    const result = await f.persist({ ...intent, model_id });
    assert.equal(f.objects.size, 1);
    assert.equal(result.result_ref, `users/synthetic-owner/projects/synthetic-project/provider-results/synthetic-attempt-${digest(bytes)}.json`);
    assert.equal(result.result_sha256, digest(bytes));
    assert.equal(result.result_byte_size, bytes.length);
    assert.deepEqual(f.objects.get(result.result_ref), bytes);
  }
});

test('invalid model IDs are rejected before any result object is written', async () => {
  for (const model_id of ['', 'x'.repeat(129), '../gpt-6.1-sol', '..\\gpt-6.1-sol', 'provider/model',
    'provider:model', 'gpt 6.1', 'gpt-6.1\nsol']) {
    const f = fixture();
    await assert.rejects(f.persist({ ...intent, model_id }), /Invalid provider call identity/);
    assert.equal(f.objects.size, 0);
  }
});

test('dotted model support does not widen resource, trace or prompt identities', async () => {
  const fields = ['owner_user_id', 'project_id', 'job_id', 'run_id', 'trace_id', 'logical_call_id', 'call_id', 'prompt_snapshot_ref'] as const;
  for (const field of fields) {
    const f = fixture();
    await assert.rejects(f.persist({ ...intent, [field]: 'synthetic.invalid' }), /Invalid provider call identity/);
    assert.equal(f.objects.size, 0);
  }
});
