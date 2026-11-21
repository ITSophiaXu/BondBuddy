import test from 'node:test';
import assert from 'node:assert/strict';
import {needsLeaseRelease} from './lease-outcome.js';

test('retry, phase handoff and pending pause retain the original lease receipt',()=>{
  for(const outcome of ['retry','handoff_pending','pause_pending'])assert.equal(needsLeaseRelease(outcome),true);
  for(const outcome of ['completed','failed','lost',null,undefined])assert.equal(needsLeaseRelease(outcome),false);
});
