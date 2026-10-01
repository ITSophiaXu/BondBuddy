import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DataPolicy } from '@bondbuddy/contracts';
import { dataPolicyCopy } from './data-policy-copy.js';

const configured: DataPolicy = { policy_version: 'data_policy_m1_v1', storage_location: 'platform_private_cloud', server_side_processing: true, model_provider_processing: true, active_retention: 'until_user_deletes', purge_enabled: true, deleted_content_purge_days: 30, orphan_upload_purge_hours: 24, log_content_retention_days: 180, backup_retention_days: 14, pinned_by_active_run: 'retained_until_run_ends', purged_content: [], retained_metadata: [] };

test('policy copy renders the server numbers and states cloud processing', () => {
  const copy = dataPolicyCopy(configured);
  assert.match(copy.processing, /传到平台服务器/);
  assert.match(copy.processing, /模型服务商/);
  assert.match(copy.deletion, /30 天内/);
  assert.match(copy.retention, /24 小时/);
  assert.match(copy.retention, /180 天/);
  assert.match(copy.backup, /14 天/);
  assert.match(copy.deletion, /删除项目/);
  for (const text of Object.values(copy)) assert.doesNotMatch(text, /只(保存|存储|存在)(在)?(你的)?本机|不会上传/);
});

test('unconfigured windows are stated as unconfigured, not as zero', () => {
  const copy = dataPolicyCopy({ ...configured, purge_enabled: false, deleted_content_purge_days: null, orphan_upload_purge_hours: null, backup_retention_days: null });
  assert.match(copy.deletion, /尚未配置/);
  assert.match(copy.backup, /尚未配置/);
  for (const text of Object.values(copy)) assert.doesNotMatch(text, /\b0 天|null/);
});
