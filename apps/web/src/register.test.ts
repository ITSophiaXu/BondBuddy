import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.js';
import { agreementHref, registerErrorMessage, validateRegister } from './register.js';

const valid = { username: 'Synthetic_user1', password: 'Synthetic-password-1', confirm: 'Synthetic-password-1', agreed: true };

test('register form checks mirror the RegisterRequest contract', () => {
  assert.equal(validateRegister(valid), '');
  for (const username of ['ab', '1abc', 'a-b-c', 'a'.repeat(33), '用户名abc']) assert.match(validateRegister({ ...valid, username }), /用户名格式/);
  assert.equal(validateRegister({ ...valid, username: 'a'.repeat(32) }), '');
  assert.match(validateRegister({ ...valid, password: 'short', confirm: 'short' }), /12–128/);
  const long = 'x'.repeat(129);
  assert.match(validateRegister({ ...valid, password: long, confirm: long }), /12–128/);
  assert.match(validateRegister({ ...valid, confirm: 'Synthetic-password-2' }), /不一致/);
  assert.match(validateRegister({ ...valid, agreed: false }), /勾选/);
});

test('register errors are friendly and only 409 says the username is taken', () => {
  assert.match(registerErrorMessage(new ApiError(409, 'IDEMPOTENCY_CONFLICT')), /已被使用/);
  assert.match(registerErrorMessage(new ApiError(422, 'AGREEMENT_REQUIRED')), /协议已更新/);
  assert.match(registerErrorMessage(new ApiError(422, 'VALIDATION_FAILED')), /不符合要求/);
  assert.match(registerErrorMessage(new ApiError(429, 'RATE_LIMITED')), /稍后再试/);
  assert.match(registerErrorMessage(new ApiError(503, 'CAPABILITY_NOT_READY')), /暂未开放/);
  assert.match(registerErrorMessage(new TypeError('Failed to fetch')), /网络连接中断/);
  for (const error of [new ApiError(422, 'VALIDATION_FAILED'), new ApiError(429, 'RATE_LIMITED'), new ApiError(500, 'DATA_UNAVAILABLE'), new TypeError('x')])
    assert.doesNotMatch(registerErrorMessage(error), /该用户名已被使用/);
});

test('agreement link accepts same-origin paths and https only', () => {
  assert.equal(agreementHref('/#/data-policy'), '/#/data-policy');
  assert.equal(agreementHref('https://example.invalid/terms'), 'https://example.invalid/terms');
  for (const bad of ['javascript:alert(1)', '//evil.example/x', 'http://example.invalid/terms', 'nonsense']) assert.equal(agreementHref(bad), '/#/data-policy');
});
