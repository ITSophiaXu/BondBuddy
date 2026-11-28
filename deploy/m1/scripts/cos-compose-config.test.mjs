import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const project = resolve(root, 'deploy/m1');
const env = { ...process.env,
  BB_IMAGE_TAG: 'synthetic', POSTGRES_PASSWORD: 'synthetic',
  BB_MAIN_DATABASE_URL: 'postgresql://bondbuddy:synthetic@postgres:5432/bondbuddy',
  BB_EXECUTION_DATABASE_URL: 'postgresql://bondbuddy:synthetic@pg-tunnel:5432/bondbuddy',
  BB_WORKER_HOST_ID: 'synthetic-host',
  BB_PG_SSH_HOST: 'synthetic.test', BB_PG_SSH_USER: 'synthetic',
  BB_PG_SSH_KEY_FILE: '/synthetic/key', BB_PG_SSH_KNOWN_HOSTS_FILE: '/synthetic/hosts',
  BB_FILE_TEMPLATE_HOST_DIR: '/synthetic/templates', BB_PAYMENT_SECRETS_DIR: '/synthetic/payments',
  BB_PUBLIC_ORIGIN: 'https://bondbuddy.test', BB_TERMS_VERSION: 'synthetic',
  BB_TRIAL_SOURCE_SALT: 'synthetic', BB_PARSE_CACHE_OCR_VERSION: 'synthetic',
  BB_PARSE_CACHE_BASIS_VERSION: 'synthetic', BB_STORAGE_PROVIDER: 'cos',
  AZURE_STORAGE_CONNECTION_STRING: '', BB_COS_SECRET_ID: 'synthetic-id',
  BB_COS_SECRET_KEY: 'synthetic-key', BB_COS_BUCKET: 'app-123', BB_COS_REGION: 'ap-beijing',
  BB_COS_BACKUP_SECRET_ID: 'synthetic-backup-id', BB_COS_BACKUP_SECRET_KEY: 'synthetic-backup-key',
  BB_COS_BACKUP_BUCKET: 'backup-123', BB_COS_BACKUP_REGION: 'ap-beijing',
};
function config(file, overrides = {}) {
  const args = ['compose', '--project-directory', project];
  args.push('-f', resolve(project, file));
  args.push('--profile', '*', 'config', '--format', 'json');
  return JSON.parse(execFileSync('docker', args, { cwd: root, env: { ...env, ...overrides },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

test('COS configuration reaches every runtime without requiring Azure credentials', () => {
  const main = config('compose.main.yaml');
  const execution = config('compose.execution.yaml');
  for (const service of [main.services.api, main.services.ops,
    main.services['worker-parse'], execution.services.worker,
    execution.services['worker-review'], execution.services['worker-parse']]) {
    assert.equal(service.environment.BB_STORAGE_PROVIDER, 'cos');
    assert.equal(service.environment.AZURE_STORAGE_CONNECTION_STRING, '');
    assert.equal(service.environment.BB_COS_BUCKET, 'app-123');
    assert.equal(service.environment.BB_COS_REGION, 'ap-beijing');
    assert.equal(service.environment.BB_COS_SECRET_ID, 'synthetic-id');
    assert.equal(service.environment.BB_COS_SECRET_KEY, 'synthetic-key');
  }
  assert.equal(main.services.ops.environment.BB_COS_BACKUP_BUCKET, 'backup-123');
  assert.equal(main.services.ops.environment.BB_COS_BACKUP_SECRET_ID, 'synthetic-backup-id');
});

test('Azure remains the default provider in existing Compose configurations', () => {
  const main = config('compose.main.yaml', { BB_STORAGE_PROVIDER: '', AZURE_STORAGE_CONNECTION_STRING: 'synthetic-azure' });
  const execution = config('compose.execution.yaml', { BB_STORAGE_PROVIDER: '', AZURE_STORAGE_CONNECTION_STRING: 'synthetic-azure' });
  for (const service of [main.services.api, main.services.ops, main.services['worker-parse'],
    execution.services.worker, execution.services['worker-review'], execution.services['worker-parse']]) {
    assert.equal(service.environment.BB_STORAGE_PROVIDER, 'azure');
    assert.equal(service.environment.AZURE_STORAGE_CONNECTION_STRING, 'synthetic-azure');
  }
});
