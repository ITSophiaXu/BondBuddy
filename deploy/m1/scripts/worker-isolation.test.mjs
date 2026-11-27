import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('effective production compose reserves three contained worker services with two authoring replicas', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const value = execFileSync('docker', ['compose', '--project-directory', root, '--env-file', `${root}.env.example`,
    '-f', `${root}compose.yaml`, '-f', `${root}compose.prod.yaml`, 'config', '--format', 'json'], {
    encoding: 'utf8', env: { ...process.env, COMPOSE_PROJECT_NAME: 'synthetic-isolation', COMPOSE_PROFILES: '',
      POSTGRES_PASSWORD: 'synthetic', AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true', BB_TRIAL_SOURCE_SALT: 'synthetic',
      BB_PUBLIC_ORIGIN: 'http://synthetic.invalid', BB_TERMS_VERSION: 'synthetic', BB_IMAGE_TAG: 'synthetic',
      BB_PARSE_CACHE_OCR_VERSION: 'synthetic', BB_PARSE_CACHE_BASIS_VERSION: 'synthetic' }
  });
  const { services } = JSON.parse(value);
  const workers = ['worker', 'worker-review', 'worker-parse'].map(name => services[name]);
  assert.deepEqual(workers.map(w => w.environment.BB_WORKER_GROUP), ['authoring', 'review', 'parse']);
  assert.deepEqual(workers.map(w => w.environment.BB_WORKER_JOB_KINDS), ['run', 'run', 'parse']);
  assert.equal(workers[0].environment.BB_WORKER_RUN_KINDS, 'update,generation,qa');
  assert.equal(workers[1].environment.BB_WORKER_RUN_KINDS, 'review');
  assert.deepEqual(workers.map(w => w.environment.BB_WORKER_INTERACTIVE_SLOTS), ['1', '0', '0']);
  assert.equal(new Set(workers.map(w => w.volumes.find(v => v.target.includes('parse-staging')).source)).size, 3);
  assert.equal(workers[0].deploy.replicas, 2, 'two authoring workers claim from the same queue');
  assert.equal(workers[1].deploy.replicas, 1, 'review stays a separate capacity pool');
  assert.equal(workers[2].deploy.replicas, 1, 'parse stays a separate capacity pool');
  for (const w of workers) {
    assert.equal(w.environment.BB_WORKER_CONCURRENCY, '1');
    assert.equal(w.environment.BB_WORKER_PARSE_SLOTS, '0');
    assert.equal(w.image, 'bondbuddy-m1-worker:synthetic');
    assert.equal(w.read_only, true);
    assert.deepEqual(w.cap_drop, ['ALL']);
    assert.ok(w.security_opt.some(v => v.includes('apparmor=bondbuddy-codex-v1')));
    assert.ok(w.security_opt.some(v => v.includes('codex-seccomp.json')));
    assert.equal(w.environment.HTTPS_PROXY, 'http://egress:3128');
    assert.ok(w.volumes.find(v => v.target === '/run/secrets/bb-copilot-oauth').read_only);
  }
  assert.equal(services.api.environment.BB_READY_WORKER_GROUPS, 'authoring,review,parse');
  assert.equal(services.ops.environment.BB_READY_WORKER_GROUPS, 'authoring,review,parse');
});
