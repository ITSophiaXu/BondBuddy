import assert from 'node:assert/strict';
import test from 'node:test';
import { runEventPayloadDto } from './run-event-dto.js';

test('run event DTO removes only the internal channel field', () => {
  const payload = { reason: 'claimed', channel: 'production', unexpected_internal_value: 'must remain visible to validation' };
  assert.deepEqual(runEventPayloadDto(payload), {
    reason: 'claimed', unexpected_internal_value: 'must remain visible to validation',
  });
  assert.equal(payload.channel, 'production', 'projection does not mutate the persisted payload');
});
