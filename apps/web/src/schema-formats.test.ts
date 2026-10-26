import test from 'node:test';
import assert from 'node:assert/strict';
import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import { isDateTime } from './schema-formats.js';

test('public date-time formats accept API UTC timestamps and explicit offsets', () => {
  for (const value of ['2026-10-25T08:00:00Z', '2026-10-25T08:00:00.123Z', '2024-02-29T08:00:00+08:00', '2026-10-25t08:00:00z', '2016-12-31T23:59:60Z', '2017-01-01T07:59:60+08:00']) {
    assert.equal(isDateTime(value), true, value);
    assert.equal(Value.Check(Type.String({ format: 'date-time' }), value), true, value);
  }
});
test('public date-time formats reject impossible dates and missing timezone', () => {
  for (const value of ['2026-02-29T08:00:00Z', '2026-04-31T08:00:00Z', '2026-00-25T08:00:00Z', '2026-10-25T24:00:00Z', '2026-10-25T08:60:00Z', '2026-10-25T08:00:60Z', '2026-10-25T08:00:00+24:00', '2026-10-25T08:00:00', '2026-10-25']) assert.equal(isDateTime(value), false, value);
});
