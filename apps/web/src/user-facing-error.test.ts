import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, friendlyError, parseApiError } from './api.js';
import { UserFacingError, type ErrorOperation } from './user-facing-error.js';

const cases: [ErrorOperation, string][] = [
  ['read', '读取暂未成功，请稍后重新读取。'],
  ['save', '保存结果暂未确认，请重新读取当前记录后再继续。'],
  ['download', '文件暂时未能下载，请稍后重试下载。'],
  ['submit', '提交结果暂未确认，请先重新读取状态后再继续。'],
  ['action', '操作结果暂未确认，请先重新读取当前状态后再继续。'],
];

test('unknown exceptions use the requested operation without exposing native or arbitrary details', () => {
  const errors = [new TypeError('Failed to fetch'), new SyntaxError('private response body'),
    new DOMException('private browser detail', 'AbortError'), new Error('私有内部说明，不应直接展示'),
    { message: 'private object detail' }, 'private string', null, undefined];
  for (const [operation, expected] of cases) for (const error of errors) {
    assert.equal(friendlyError(error, operation), expected);
  }
  assert.equal(friendlyError(new Error('unknown')), cases[4][1]);
});

test('error name and message language cannot impersonate trusted local guidance', () => {
  for (const name of ['UserFacingError', 'AssistantTemplateUploadRecoveryError', 'UploadRecoveryNeedsFileError']) {
    const error = new Error('看起来像中文的任意内部报错'); error.name = name;
    assert.equal(friendlyError(error, 'read'), cases[0][1]);
  }
});

test('explicit business guidance keeps its exact identity and actionable message', () => {
  class RecoveryError extends UserFacingError { readonly operationId = 'synthetic-original'; }
  const error = new RecoveryError('请选择原文件，继续核对原上传。');
  for (const [operation] of cases) assert.equal(friendlyError(error, operation), error.message);
  assert.ok(error instanceof RecoveryError); assert.ok(error instanceof Error);
  assert.equal(error.operationId, 'synthetic-original');
});

test('controlled API messages and support references remain independent of operation context', () => {
  const denied = parseApiError(409, { code: 'INPUT_REVISION_CONFLICT', message: 'private server body' });
  const unavailable = parseApiError(503, { code: 'DATA_UNAVAILABLE', correlation_id: 'synthetic-ref-40', message: 'private provider error' });
  for (const [operation] of cases) {
    assert.equal(friendlyError(denied, operation), friendlyError(denied));
    assert.match(friendlyError(unavailable, operation), /synthetic-ref-40/);
    assert.doesNotMatch(friendlyError(unavailable, operation), /private|provider/);
  }
  assert.ok(denied instanceof ApiError); assert.equal(denied.status, 409);
});
