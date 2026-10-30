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

test('Alipay deployment needs its exact gateway, one explicit Web product and an enabled parent for refunds',()=>{
  const value=config();Object.assign(value.services.api.environment,{BB_ALIPAY_PAY_ENABLED:'1',BB_ALIPAY_WEB_PRODUCT:'page',BB_ALIPAY_REFUND_ENABLED:'0'});
  failed(value,'alipay_host_when_enabled');value.services.egress.environment.BB_EGRESS_ALLOW+=',openapi.alipay.com';
  assert.equal(checkPaymentDeployment(value).passed,true);
  value.services.api.environment.BB_ALIPAY_WEB_PRODUCT='wap';assert.equal(checkPaymentDeployment(value).passed,true);
  value.services.api.environment.BB_ALIPAY_WEB_PRODUCT='app';failed(value,'alipay_web_product');
  value.services.api.environment.BB_ALIPAY_WEB_PRODUCT='page';value.services.api.environment.BB_ALIPAY_REFUND_ENABLED='1';value.services.api.environment.BB_ALIPAY_PAY_ENABLED='0';
  failed(value,'alipay_refund_configuration');
  value.services.api.environment.BB_ALIPAY_PAY_ENABLED='true';failed(value,'alipay_switch_explicit');
});

test('Alipay daily statements remain off by default and cannot bypass a disabled merchant or invalid switch',()=>{
  const value=config();
  assert.equal(checkPaymentDeployment(value).passed,true);
  for(const enabled of ['true','yes','2','',' 1']){
    value.services.api.environment.BB_ALIPAY_PAY_STATEMENTS_ENABLED=enabled;
    failed(value,'alipay_statement_configuration');
  }
  value.services.api.environment.BB_ALIPAY_PAY_STATEMENTS_ENABLED='1';
  failed(value,'alipay_statement_configuration');
  value.services.api.environment.BB_ALIPAY_PAY_ENABLED='0';
  failed(value,'alipay_statement_configuration');
  value.services.api.environment.BB_ALIPAY_PAY_STATEMENTS_ENABLED='0';
  assert.equal(checkPaymentDeployment(value).passed,true);
});

test('Alipay statement downloads require the exact official host through the enforced proxy',()=>{
  const value=config();
  Object.assign(value.services.api.environment,{BB_ALIPAY_PAY_ENABLED:'1',BB_ALIPAY_WEB_PRODUCT:'page',BB_ALIPAY_PAY_STATEMENTS_ENABLED:'1'});
  const baseline='api.deepseek.com,openapi.alipay.com';
  value.services.egress.environment.BB_EGRESS_ALLOW=baseline;
  failed(value,'alipay_statement_host_when_enabled');
  for(const host of ['alipay.com','*.alipay.com','.alipay.com','dwbillcenter.alipay.com.attacker.test','https://dwbillcenter.alipay.com']){
    value.services.egress.environment.BB_EGRESS_ALLOW=`${baseline},${host}`;
    failed(value,'alipay_statement_host_when_enabled');
  }
  value.services.egress.environment.BB_EGRESS_ALLOW=`${baseline},dwbillcenter.alipay.com`;
  assert.equal(checkPaymentDeployment(value).passed,true);
  value.services.api.environment.NO_PROXY+=',dwbillcenter.alipay.com';
  value.services.api.environment.no_proxy=value.services.api.environment.NO_PROXY;
  failed(value,'api_internal_proxy_bypass');
});
