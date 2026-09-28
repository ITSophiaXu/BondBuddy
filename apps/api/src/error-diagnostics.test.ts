import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorDiagnostic, normalizedStackFrames, truncateUtf8 } from './error-diagnostics.js';

test('root-cause fingerprint ignores job IDs, paths, line numbers and timestamps', () => {
  const common = { code: 'DELIVERY_FAILED' as const, category: 'delivery' as const, stage: 'word_delivery' };
  const first = errorDiagnostic({ ...common, stack: 'Error: private prompt\n    at exportJob123 (/users/a/secret/42.ts:10:2)\n    at finish (/x/2026-09-28/file.ts:3:1)' });
  const second = errorDiagnostic({ ...common, stack: 'Error: another private prompt\n    at exportJob987 (/users/b/secret/93.ts:456:9)\n    at finish (/x/2027-02-01/file.ts:99:1)' });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.safeStack, second.safeStack);
  assert.equal(first.safeMessage, 'Error DELIVERY_FAILED');
  assert.ok(!JSON.stringify(first).includes('private prompt'));
  assert.notEqual(first.fingerprint, errorDiagnostic({ ...common, code: 'DATA_UNAVAILABLE' }).fingerprint);
  assert.notEqual(first.fingerprint, errorDiagnostic({ ...common, stage: 'model_generation' }).fingerprint);
});

test('stack sanitization discards unrecognized frames and sensitive source material', () => {
  const raw = 'Error: prompt body user@example.com +8613912345678 token\n    at run (/home/user@example.com/material.txt:10:2)\n    at /home/customer/material-content.txt:11:9';
  assert.match(normalizedStackFrames(raw), /^[a-f0-9]{64}$/);
  const diagnostic = errorDiagnostic({ code: 'MODEL_TIMEOUT', category: 'model_provider', stage: 'model_generation', stack: raw });
  for (const text of ['prompt body', 'user@example.com', '13912345678', '/home/', 'token']) assert.ok(!JSON.stringify(diagnostic).includes(text));
  assert.equal(Buffer.byteLength(truncateUtf8('中'.repeat(800), 1024)), 1023);
});
