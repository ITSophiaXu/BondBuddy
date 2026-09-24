import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MARKETS, type Run } from '@bondbuddy/contracts';
import { createServer } from './server.js';

const market: typeof MARKETS[number] = 'nafmii';
const runState: Run['state'] = 'queued';
assert.equal(market, 'nafmii');
assert.equal(runState, 'queued');

test('health is live and contract paths are not silently advertised as implemented', async () => {
  const app = createServer();
  try {
    const health = await app.inject('/health');
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().implementation, 'health-and-contract-only');
    const spec = await app.inject('/openapi.json');
    assert.equal(spec.statusCode, 200);
    assert.equal(spec.json().paths['/api/v1/runs/execute'].post['x-implementation-status'], 'contract-only');
    assert.equal(spec.json().components.schemas.InternalObservabilityEvent, undefined);
    const run = await app.inject({ method: 'POST', url: '/api/v1/runs/execute', payload: {} });
    assert.equal(run.statusCode, 404);
  } finally { await app.close(); }
});
