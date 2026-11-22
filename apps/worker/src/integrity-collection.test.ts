import test from 'node:test';
import assert from 'node:assert/strict';
import { INTEGRITY_SITES } from '@bondbuddy/contracts';
import { collectIntegritySite } from './integrity-browser-stage.js';
import {
  integrityBrowserOperation,
  integrityBrowserFailure,
} from './integrity-browser-boundary.js';
const site = INTEGRITY_SITES.find((s) => s.id === 'emergency')!;
const subject = { name: '合成企业', kind: 'company' as const, province: '河南', city: '' };
test('site-local browser failure becomes an incomplete record; cancellation still stops collection', async () => {
  const r = await collectIntegritySite(
    async () => {
      throw Error('INTEGRITY_NATIVE_PANEL_UNAVAILABLE');
    },
    site,
    subject,
    new AbortController().signal,
  );
  assert.equal(r.outcome, 'failed');
  assert.equal(r.search_performed, false);
  assert.deepEqual(r.captures, []);
  assert.equal(r.diagnostic?.detail, 'INTEGRITY_NATIVE_PANEL_UNAVAILABLE');
  const privateError = await collectIntegritySite(
    async () => {
      throw Error('browser failed: secret/path?token=private');
    },
    site,
    subject,
    new AbortController().signal,
  );
  assert.equal(privateError.diagnostic?.detail, 'INTEGRITY_BROWSER_RUNTIME_FAILED');
  assert.doesNotMatch(JSON.stringify(privateError), /secret|token|private/);
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    collectIntegritySite(
      async () => {
        throw Error('closed');
      },
      site,
      subject,
      c.signal,
    ),
    { name: 'AbortError' },
  );
});

test('browser failure codes only admit known errno values', () => {
  assert.equal(
    integrityBrowserFailure(Object.assign(Error('private'), { code: 'ENOMEM' })).kind,
    'resource_limit',
  );
  assert.equal(
    integrityBrowserFailure(Object.assign(Error('private'), { code: 'E_PRIVATE_CUSTOMER_TOKEN' }))
      .code,
    undefined,
  );
});

test('phase diagnostics preserve the existing public native failure code', async () => {
  const r = await collectIntegritySite(
    async () =>
      integrityBrowserOperation('desktop', async () => {
        throw Error('INTEGRITY_NATIVE_PANEL_UNAVAILABLE');
      }),
    site,
    subject,
    new AbortController().signal,
  );
  assert.equal(r.diagnostic?.detail, 'INTEGRITY_NATIVE_PANEL_UNAVAILABLE');
  assert.equal(r.runtime_failure?.phase, 'desktop');
});

test('private browser diagnostics retain phase and dependency frames without leaking message contents', async () => {
  const r = await collectIntegritySite(
    async () =>
      integrityBrowserOperation('launch', async () => {
        const error = new Error('browserType.launch secret/path?token=private');
        error.stack =
          'Error: secret/path?token=private\n at assert (/app/node_modules/playwright-core/lib/coreBundle.js:838:11)\n at _CRSession._onMessage (/app/node_modules/playwright-core/lib/coreBundle.js:35014:11)\n at CRConnection._onMessage (/app/node_modules/playwright-core/lib/coreBundle.js:34951:20)';
        throw error;
      }),
    site,
    subject,
    new AbortController().signal,
  );
  assert.equal(r.runtime_failure?.phase, 'launch');
  assert.equal(r.runtime_failure?.kind, 'cdp_protocol');
  assert.ok(r.runtime_failure?.frames.includes('coreBundle.js:35014:11'));
  assert.match(r.runtime_failure!.fingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(r.runtime_failure), /secret|token|private|\/app/);
});
