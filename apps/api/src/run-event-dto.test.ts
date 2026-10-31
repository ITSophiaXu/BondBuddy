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

test('missing controlled Word operations retains its exact safe failure code',()=>{
  assert.deepEqual(runEventPayloadDto({reason:'processor_failed',error_code:'WORD_FORMAT_OPERATIONS_MISSING',
    diagnostic:{command:'private command',last_message:'private prose'}}),
    {reason:'processor_failed',error_code:'WORD_FORMAT_OPERATIONS_MISSING'});
});

test('review action projection accepts only the exact versioned enums and drops nested private fields', () => {
  const action={version:'review-action-v1',action_id:'a'.repeat(64),code:'read_materials',state:'started'};
  assert.deepEqual(runEventPayloadDto({reason:'review_action',action,stdout:'private'}),{reason:'review_action',action});
  for(const invalid of [{...action,code:'private CLI output'},{...action,state:'passed'},{...action,version:'future'},
    {...action,action_id:'/private/path'},{...action,prompt:'hidden reasoning'}, {...action,result:{token:'secret'}},null,'raw text']){
    assert.deepEqual(runEventPayloadDto({reason:'review_action',action:invalid}),{reason:'review_action'});
  }
});
