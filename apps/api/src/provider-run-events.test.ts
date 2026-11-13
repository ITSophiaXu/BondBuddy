import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelAdapterErrorCode } from '@bondbuddy/contracts';
import { providerRunEventPayload } from './provider-results.js';

test('provider retry and failure events retain the known model format code',()=>{
  for(const reason of ['provider_call_retrying','provider_call_failed'])assert.deepEqual(providerRunEventPayload(reason,'MODEL_OUTPUT_SCHEMA_INVALID'),{reason,error_code:'MODEL_OUTPUT_SCHEMA_INVALID'});
});

test('known provider pause codes remain public without changing their safe reason',()=>{
  assert.deepEqual(providerRunEventPayload('provider_auth_failed','MODEL_PROVIDER_AUTH_FAILED'),{reason:'provider_auth_failed',error_code:'MODEL_PROVIDER_AUTH_FAILED'});
  assert.deepEqual(providerRunEventPayload('provider_result_pending'),{reason:'provider_result_pending'});
});

test('output-limit recovery retains its distinct public reason and known error identity',()=>{
  for(const reason of ['file_authoring_output_limit_recovery_pending','file_authoring_output_limit_retry_scheduled',
    'file_authoring_output_limit_recovery_unavailable','file_authoring_output_limit_retries_exhausted'])
    assert.deepEqual(providerRunEventPayload(reason,'MODEL_OUTPUT_TOO_LARGE'),{reason,error_code:'MODEL_OUTPUT_TOO_LARGE'});
});

test('unrecognized provider values cannot enter run or outbox task payloads',()=>{
  assert.deepEqual(providerRunEventPayload('provider_call_failed','PRIVATE_PROVIDER_VALUE' as ModelAdapterErrorCode),{reason:'provider_call_failed'});
  assert.deepEqual(providerRunEventPayload('raw output: hidden prompt','MODEL_PROVIDER_AUTH_FAILED'),{error_code:'MODEL_PROVIDER_AUTH_FAILED'});
});
