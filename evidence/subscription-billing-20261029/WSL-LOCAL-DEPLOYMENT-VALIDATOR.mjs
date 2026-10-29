import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkPaymentDeployment } from '../../scripts/check-payment-deployment.mjs';

const root = resolve(import.meta.dirname, '../..');
const scratch = resolve(root, '.tmp/billing-deployment-validation');
const evidence = resolve(root, 'evidence/subscription-billing-20261029/WSL-LOCAL-DEPLOYMENT-VALIDATION.log');
mkdirSync(scratch, { recursive: true });
mkdirSync(resolve(scratch, 'empty-docker-config'), { recursive: true });
writeFileSync(resolve(scratch, 'synthetic.env'), '# Deliberately empty; required values are synthetic process settings.\n');
const output = [];
const record = value => { const line = JSON.stringify(value); output.push(line); process.stdout.write(`${line}\n`); };
const cleanEnv = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  DOCKER_HOST: 'unix:///var/run/docker.sock',
  DOCKER_CONFIG: resolve(scratch, 'empty-docker-config'),
  COMPOSE_DISABLE_ENV_FILE: '1',
  POSTGRES_PASSWORD: 'synthetic-only-no-real-password',
  AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
  BB_TRIAL_SOURCE_SALT: 'synthetic-only-no-real-salt',
  BB_PUBLIC_ORIGIN: 'https://synthetic.invalid',
  BB_IMAGE_TAG: 'synthetic-never-launched',
  BB_TERMS_VERSION: 'synthetic-terms-v1',
  BB_PARSE_CACHE_OCR_VERSION: 'synthetic-ocr-v1',
  BB_PARSE_CACHE_BASIS_VERSION: 'synthetic-basis-v1',
  COMPOSE_PROJECT_NAME: 'bb-synthetic-config-20261029',
  BB_INTEGRITY_SSH_DIR: '/tmp/bb-synthetic-no-keys',
  BB_INTEGRITY_BEIJING_HOST: '192.0.2.1',
};
function command(executable, args, extraEnv = {}, timeout = 30000) {
  return spawnSync(executable, args, { cwd: root, env: { ...cleanEnv, ...extraEnv }, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
}
function inventoryHash() {
  const inventories = [
    ['container', 'ls', '-a', '--format', '{{.ID}} {{.Names}} {{.State}}'],
    ['image', 'ls', '--format', '{{.ID}} {{.Repository}}:{{.Tag}}'],
    ['volume', 'ls', '--format', '{{.Name}}'],
    ['network', 'ls', '--format', '{{.ID}} {{.Name}}'],
  ].map(args => {
    const result = command('/usr/bin/docker', ['--host', cleanEnv.DOCKER_HOST, ...args]);
    assert.equal(result.status, 0, 'local inventory query failed');
    return result.stdout.trim().split('\n').sort().join('\n');
  });
  return createHash('sha256').update(inventories.join('\n---\n')).digest('hex');
}
try {
  const before = inventoryHash();
  record({ kind: 'runtime', node: process.version, dockerEndpoint: cleanEnv.DOCKER_HOST, scope: 'local_synthetic_only', inventoryBefore: before });
  const variants = [
    ['base', ['compose.yaml']],
    ['prod', ['compose.yaml', 'compose.prod.yaml']],
    ['integrity-browser', ['compose.yaml', 'compose.prod.yaml', 'compose.integrity-browser.yaml']],
    ['integrity-beijing', ['compose.yaml', 'compose.prod.yaml', 'compose.integrity-beijing.yaml']],
  ];
  const scenarios = [
    ['disabled', { BB_SUBSCRIPTION_BILLING_ENABLED: '0', BB_WECHAT_PAY_ENABLED: '0', BB_ALIPAY_PAY_ENABLED: '0' }, null],
    ['wechat', { BB_SUBSCRIPTION_BILLING_ENABLED: '1', BB_WECHAT_PAY_ENABLED: '1', BB_EGRESS_ALLOW: 'api.deepseek.com,synthetic.blob.core.windows.net,api.mch.weixin.qq.com' }, null],
    ['wechat-and-alipay', { BB_SUBSCRIPTION_BILLING_ENABLED: '1', BB_WECHAT_PAY_ENABLED: '1', BB_WECHAT_PAY_STATEMENTS_ENABLED: '1', BB_WECHAT_PAY_STATEMENT_ACCOUNTS: 'BASIC,OPERATION,FEES', BB_ALIPAY_PAY_ENABLED: '1', BB_ALIPAY_WEB_PRODUCT: 'page', BB_ALIPAY_REFUND_ENABLED: '1', BB_EGRESS_ALLOW: 'api.deepseek.com,synthetic.blob.core.windows.net,api.mch.weixin.qq.com,openapi.alipay.com' }, null],
    ['missing-wechat-host', { BB_SUBSCRIPTION_BILLING_ENABLED: '1', BB_WECHAT_PAY_ENABLED: '1', BB_EGRESS_ALLOW: 'api.deepseek.com' }, 'wechat_host_when_enabled'],
    ['missing-alipay-host', { BB_SUBSCRIPTION_BILLING_ENABLED: '1', BB_ALIPAY_PAY_ENABLED: '1', BB_ALIPAY_WEB_PRODUCT: 'wap', BB_EGRESS_ALLOW: 'api.deepseek.com' }, 'alipay_host_when_enabled'],
    ['merchant-proxy-bypass', { BB_NO_PROXY: 'postgres,api,localhost,127.0.0.1,api.mch.weixin.qq.com' }, 'api_internal_proxy_bypass'],
  ];
  let count = 0;
  for (const [variant, files] of variants) {
    const args = ['--host', cleanEnv.DOCKER_HOST, 'compose', '--env-file', resolve(scratch, 'synthetic.env'), ...(variant === 'base' ? ['--profile', 'staging-blob'] : []), ...files.flatMap(file => ['-f', resolve(root, 'deploy/m1', file)]), 'config', '--format', 'json'];
    for (const [scenario, settings, expectedFailure] of scenarios) {
      const result = command('/usr/bin/docker', args, settings);
      assert.equal(result.status, 0, `Compose parse failed: ${variant}/${scenario}; source JSON and stderr withheld`);
      const report = checkPaymentDeployment(JSON.parse(result.stdout));
      const failures = report.checks.filter(check => !check.passed).map(check => check.name);
      assert.deepEqual(failures, expectedFailure ? [expectedFailure] : [], `${variant}/${scenario}`);
      record({ kind: 'compose', variant, scenario, expected: expectedFailure ? 'reject' : 'pass', checks: report.checks.length, failures, passed: true });
      count++;
    }
  }
  record({ kind: 'compose_summary', cases: count, passed: count, composeExecution: 'real Docker Compose, config only; no up/build/pull', rawConfigurationRecorded: false });
  const keyFile = resolve(scratch, 'synthetic-local-key.pem');
  const certFile = resolve(scratch, 'synthetic-local-cert.pem');
  const certificate = command('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-days', '1']);
  assert.equal(certificate.status, 0, 'synthetic certificate generation failed');
  const probe = command(process.execPath, [resolve(root, 'evidence/subscription-billing-20261029/WSL-LOCAL-PROXY-PROBE.mjs'), keyFile, certFile], {}, 30000);
  record({ kind: 'native_proxy_probe', node: process.version, exitCode: probe.status, timedOut: probe.error?.code === 'ETIMEDOUT', output: probe.stdout, stderr: probe.stderr, releaseImage: false });
  assert.equal(probe.status, 0, 'native WSL Node local proxy probe failed');
  const after = inventoryHash();
  record({ kind: 'inventory', inventoryAfter: after, unchanged: before === after });
  assert.equal(after, before, 'Docker inventory changed during config-only checks');
  record({ kind: 'summary', passed: true, exactReleaseImageProbe: 'not_run_no_cached_release_image', merchantRequests: 0 });
} catch (error) {
  record({ kind: 'failure', message: error instanceof Error ? error.message : 'unknown failure' });
  process.exitCode = 1;
} finally {
  writeFileSync(evidence, `${output.join('\n')}\n`);
}
