import assert from 'node:assert/strict';
import test from 'node:test';
import {uncertainServerAccepted} from './assistant-uncertainty.js';

test('a changed server identity proves the uncertain write was accepted', () => {
  assert.equal(uncertainServerAccepted({messages: []}, {messages: [{id: 'accepted'}]}), true);
});

test('an unchanged server identity stays uncertain', () => {
  assert.equal(uncertainServerAccepted({messages: []}, {messages: []}), false);
});

test('a missing saved identity never clears the local uncertainty', () => {
  assert.equal(uncertainServerAccepted(undefined, {messages: []}), false);
});
