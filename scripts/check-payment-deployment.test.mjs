import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { checkPaymentDeployment } from './check-payment-deployment.mjs';

function config({ enabled = false } = {}) {
  const services = Object.fromEntries(['api', 'worker', 'worker-review', 'worker-parse', 'ops'].map(
    name => [name, { environment: { BB_SUBSCRIPTION_BILLING_ENABLED: enabled ? '1' : '0' } }],
  ));
  Object.assign(services.api, { networks: { backend: null }, depends_on: { egress: { condition: 'service_started' } } });
  Object.assign(services.api.environment, {
    BB_WECHAT_PAY_ENABLED: enabled ? '1' : '0', NODE_USE_ENV_PROXY: '1',
    HTTPS_PROXY: 'http://egress:3128', https_proxy: 'http://egress:3128',
    NO_PROXY: 'postgres,api,localhost,127.0.0.1', no_proxy: 'postgres,api,localhost,127.0.0.1',
  });
  services.postgres = {};
  services.egress = { environment: { BB_EGRESS_ALLOW: enabled
    ? 'api.deepseek.com,synthetic.blob.core.windows.net,api.mch.weixin.qq.com' : 'api.deepseek.com' } };
  return { services, networks: { backend: { internal: true } } };
}

const failed = (value, name) => assert.equal(checkPaymentDeployment(value).checks.find(check => check.name === name)?.passed, false);

test('disabled default and explicit merchant configuration pass without credentials', () => {
  assert.equal(checkPaymentDeployment(config()).passed, true);
  assert.equal(checkPaymentDeployment(config({ enabled: true })).passed, true);
});

test('a worker missing the billing switch cannot pass the release check', () => {
  const value = config();
  delete value.services['worker-review'].environment.BB_SUBSCRIPTION_BILLING_ENABLED;
  failed(value, 'subscription_switch_shared');
});

test('HTTPS_PROXY alone is insufficient for Node fetch', () => {
  const value = config();
  delete value.services.api.environment.NODE_USE_ENV_PROXY;
  failed(value, 'api_environment_proxy');
});

test('production case mismatch and merchant proxy bypass fail', () => {
  const value = config();
  value.services.api.environment.no_proxy += ',azurite';
  failed(value, 'api_internal_proxy_bypass');
  value.services.api.environment.NO_PROXY += ',api.mch.weixin.qq.com';
  value.services.api.environment.no_proxy = value.services.api.environment.NO_PROXY;
  failed(value, 'api_internal_proxy_bypass');
});

test('merchant enabled without its exact allowed hostname fails', () => {
  const value = config({ enabled: true });
  value.services.egress.environment.BB_EGRESS_ALLOW = 'api.deepseek.com,weixin.qq.com';
  failed(value, 'wechat_host_when_enabled');
});

test('wildcard, suffix and URL allow-list entries fail', () => {
  for (const host of ['*', '*.weixin.qq.com', '.weixin.qq.com', 'https://api.mch.weixin.qq.com']) {
    const value = config();
    value.services.egress.environment.BB_EGRESS_ALLOW += `,${host}`;
    failed(value, 'egress_exact_hostnames');
  }
});

test('API cannot acquire an internet network or lose its egress dependency', () => {
  const value = config();
  value.services.api.networks.edge = null;
  failed(value, 'api_private_network');
  delete value.services.api.depends_on.egress;
  failed(value, 'api_egress_dependency');
});

test('checker output contains no other resolved configuration values', () => {
  const value = config();
  value.services.api.environment.SYNTHETIC_PRIVATE_VALUE = 'must-not-print-this-synthetic-value';
  assert.equal(JSON.stringify(checkPaymentDeployment(value)).includes('must-not-print'), false);
});

test('malformed Compose JSON produces a redacted CLI failure', () => {
  const result = spawnSync(process.execPath, ['scripts/check-payment-deployment.mjs'], {
    input: '{"syntheticSecret":"must-not-print-this-synthetic-value",', encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim(), '{"passed":false,"error":"COMPOSE_CONFIG_JSON_INVALID"}');
  assert.equal(result.stderr, '');
});

test('statement enablement requires the merchant channel and an explicit supported account list',()=>{
  const value=config();value.services.api.environment.BB_WECHAT_PAY_STATEMENTS_ENABLED='1';
  failed(value,'wechat_statement_configuration');
  value.services.api.environment.BB_WECHAT_PAY_ENABLED='1';
  value.services.api.environment.BB_WECHAT_PAY_STATEMENT_ACCOUNTS='BASIC,UNKNOWN';
  failed(value,'wechat_statement_configuration');
});
