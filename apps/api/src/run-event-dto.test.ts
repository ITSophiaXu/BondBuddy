import assert from 'node:assert/strict';
import test from 'node:test';
import { runEventPayloadDto } from './run-event-dto.js';

test('run event DTO allows only declared safe public fields', () => {
  const payload = { reason: 'claimed', channel: 'production', unexpected_internal_value: 'must remain visible to validation' };
  assert.deepEqual(runEventPayloadDto(payload), {
    reason: 'claimed',
  });
  assert.equal(payload.channel, 'production', 'projection does not mutate the persisted payload');
});
test('raw output, hidden prompts, malformed safe fields and scalar payloads never leak', () => {
  assert.deepEqual(runEventPayloadDto({ reason: 'raw CLI output: secret', error_code: 'private-provider-value',
    prompt: 'hidden prompt', stdout: 'raw output', token: 'secret', completed_items: -1,
    required_fields: ['safe_field', '/private/path'], artifact_id: 'a-real-artifact' }), { artifact_id: 'a-real-artifact' });
  for (const payload of [null, 'private raw text', ['secret'], 3]) assert.deepEqual(runEventPayloadDto(payload), {});
});
test('known adapter failures retain a safe reason without provider output', () => {
  assert.deepEqual(runEventPayloadDto({ error_code: 'MODEL_STREAM_BROKEN', stdout: 'private output',
    provider_error_message: 'private supplier payload', prompt: 'hidden instructions' }), { error_code: 'MODEL_STREAM_BROKEN' });
});
