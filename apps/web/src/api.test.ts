import assert from 'node:assert/strict';
import { test } from 'node:test';
import { friendlyError, parseApiError } from './api.js';
import { uploadErrorMessage } from './upload-error.js';

test('public inspection detail is carried from Error.field_errors to the upload row', () => {
  const error = parseApiError(422, {
    code: 'MATERIAL_UNREADABLE', retryable: false, correlation_id: 'synthetic-upload-1',
    field_errors: [{ field: 'material_upload', code: 'external_link_invalid', message: 'opaque' }],
  });
  assert.equal(error.details.uploadReason, 'external_link_invalid');
  assert.match(uploadErrorMessage(error), /外部工作簿引用/);
  assert.match(uploadErrorMessage(error), /保留原文件/);
  assert.match(uploadErrorMessage(error), /错误编号：synthetic-upload-1/);
  assert.doesNotMatch(uploadErrorMessage(error), /文件.*损坏|重新导出/);
});

test('timeout is a temporary inspection failure; missing and untrusted details never imply corruption', () => {
  const timeout = parseApiError(422, {
    code: 'MATERIAL_UNREADABLE', retryable: true, correlation_id: 'synthetic-timeout',
    field_errors: [{ field: 'material_upload', code: 'inspection_timeout', message: 'opaque' }],
  });
  assert.match(uploadErrorMessage(timeout), /稍后重试此文件/);
  for (const payload of [
    { code: 'MATERIAL_UNREADABLE', correlation_id: 'synthetic-unknown' },
    { code: 'MATERIAL_UNREADABLE', correlation_id: '<script>', field_errors: [{ field: 'material_upload', code: '<script>' }] },
  ]) {
    const message = uploadErrorMessage(parseApiError(422, payload));
    assert.match(message, /保留原文件/);
    assert.doesNotMatch(message, /损坏|重新导出|<script>/);
  }
  const unrelated = parseApiError(409, {
    code: 'MATERIAL_UNREADABLE', correlation_id: 'synthetic-run',
    field_errors: [{ field: 'material', code: 'external_link_invalid' }],
  });
  assert.equal(unrelated.details.uploadReason, undefined);
  assert.match(friendlyError(unrelated), /核对材料状态/);
});

test('unknown start failures retain reference and distinguish transient from permanent', () => {
  const temporary = friendlyError(parseApiError(503, {
    code: 'DATA_UNAVAILABLE', retryable: true, correlation_id: 'synthetic-start-503',
  }));
  assert.match(temporary, /刷新项目状态/);
  assert.match(temporary, /错误编号：synthetic-start-503/);
  assert.doesNotMatch(temporary, /填写内容/);
  const permanent = friendlyError(parseApiError(409, { code: 'INPUT_REQUIRED', correlation_id: 'synthetic-start-409' }));
  assert.match(permanent, /尚未满足执行条件/);
  assert.match(permanent, /错误编号：synthetic-start-409/);
  assert.doesNotMatch(permanent, /稍后重试/);
});
