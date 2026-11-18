import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextProviderReconcileUnknown,
  PROVIDER_RECONCILE_UNKNOWN_GRACE_MS
} from './provider-reconcile-unknown.js';

const start = Date.parse('2026-11-18T00:00:00Z');

test('unknown reconciliation starts bounded evidence and does not exhaust before the grace window', () => {
  const first = nextProviderReconcileUnknown(undefined, start, 'codex_no_lookup');
  assert.equal(first.first, true);
  assert.equal(first.exhausted, false);
  assert.equal(first.state.queries, 1);
  assert.equal(first.state.first_at, '2026-11-18T00:00:00.000Z');

  const repeated = nextProviderReconcileUnknown(first.state, start + 10 * 60_000, 'codex_no_lookup');
  assert.equal(repeated.first, false);
  assert.equal(repeated.exhausted, false);
  assert.equal(repeated.state.queries, 2);
  assert.equal(repeated.state.first_at, first.state.first_at);
});

test('unknown reconciliation becomes exhausted after the grace window and remains exhausted', () => {
  const first = nextProviderReconcileUnknown(undefined, start, 'codex_no_lookup');
  const exhausted = nextProviderReconcileUnknown(
    first.state,
    start + PROVIDER_RECONCILE_UNKNOWN_GRACE_MS,
    'codex_no_lookup'
  );
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.previousExhausted, false);
  assert.equal(exhausted.state.queries, 2);

  const after = nextProviderReconcileUnknown(
    exhausted.state,
    start + PROVIDER_RECONCILE_UNKNOWN_GRACE_MS + 60_000,
    'codex_no_lookup'
  );
  assert.equal(after.exhausted, true);
  assert.equal(after.previousExhausted, true);
});

test('malformed prior state is replaced rather than extending an unbounded loop', () => {
  for (const prior of [null, 'synthetic', [], { first_at: 'not-a-time' }, { first_at: start, queries: -1 }]) {
    const next = nextProviderReconcileUnknown(prior, start, 'codex_no_lookup');
    assert.equal(next.first, true);
    assert.equal(next.state.queries, 1);
    assert.equal(next.state.exhausted, false);
  }
});


test('a delayed first sweep uses the original pause deadline instead of granting another hour',()=>{
  const delayed=nextProviderReconcileUnknown(undefined,start+2*PROVIDER_RECONCILE_UNKNOWN_GRACE_MS,'codex_no_lookup',PROVIDER_RECONCILE_UNKNOWN_GRACE_MS,start);
  assert.equal(delayed.exhausted,true);
  assert.equal(delayed.state.first_at,new Date(start).toISOString());
  const next=nextProviderReconcileUnknown(undefined,start,'codex_no_lookup');
  assert.equal(next.state.next_check_ms,start+60_000);
});
