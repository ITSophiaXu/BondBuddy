import assert from 'node:assert/strict';
import test from 'node:test';
import { checkAlipayProduction } from './alipay-production-check.js';
import { syntheticAlipayFixture } from './test-alipay-pay-fixtures.js';

const fixture = syntheticAlipayFixture();
const env = (): NodeJS.ProcessEnv => ({
  BB_ALIPAY_PAY_ENABLED: '1', BB_ALIPAY_ENVIRONMENT: 'production', BB_SUBSCRIPTION_BILLING_ENABLED: '1',
  BB_ALIPAY_WEB_PRODUCT: 'page', BB_ALIPAY_APP_ID: fixture.options.appId, BB_ALIPAY_SELLER_ID: fixture.options.merchantId,
  BB_ALIPAY_APP_PRIVATE_KEY: fixture.options.appPrivateKeyPem, BB_ALIPAY_PUBLIC_KEY: fixture.options.alipayPublicKeyPem,
  BB_ALLOWED_ORIGIN: 'https://merchant.example.test',
  BB_ALIPAY_NOTIFY_URL: 'https://merchant.example.test/api/v1/payments/alipay/callback',
  BB_ALIPAY_RETURN_URL: 'https://merchant.example.test/payment/alipay/return.html',
});

test('production configuration check uses the real factory without requesting payment or claiming merchant approval', () => {
  let requests = 0;
  const result = checkAlipayProduction(env(), { fetch: async () => { requests++; throw Error('No network allowed'); } });
  assert.equal(result.configuration_valid, true);
  assert.equal(requests, 0);
  assert.ok(result.external_verification_required.includes('merchant_contract'));
  assert.ok(result.external_verification_required.includes('public_callback'));
  const text = JSON.stringify(result);
  for (const secret of [fixture.options.appPrivateKeyPem, fixture.options.alipayPublicKeyPem, fixture.options.appId, fixture.options.merchantId]) assert.equal(text.includes(secret), false);
});

test('production check rejects missing credentials, disabled sales and wrong public routes', () => {
  for (const changes of [
    { BB_ALIPAY_APP_ID: undefined }, { BB_ALIPAY_PAY_ENABLED: '0' }, { BB_SUBSCRIPTION_BILLING_ENABLED: '0' },
    { BB_ALIPAY_APP_PRIVATE_KEY: 'synthetic-sensitive-input' }, { BB_ALIPAY_WEB_PRODUCT: 'app' },
    { BB_ALLOWED_ORIGIN: 'https://merchant.example.test/path' },
    { BB_ALIPAY_NOTIFY_URL: 'https://other.example.test/api/v1/payments/alipay/callback' },
    { BB_ALIPAY_RETURN_URL: 'https://merchant.example.test/#/account' },
    { BB_ALIPAY_RETURN_URL: 'http://merchant.example.test/payment/alipay/return.html' },
    { BB_ALIPAY_NOTIFY_URL: 'https://merchant.example.test/api/v1/payments/alipay/callback?token=synthetic-secret' },
  ]) {
    const result = checkAlipayProduction({ ...env(), ...changes });
    assert.equal(result.configuration_valid, false);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-sensitive-input|synthetic-secret/);
  }
});

test('sandbox and unknown environment never read credentials during a production check', () => {
  for (const environment of ['sandbox', '', 'unknown']) {
    let reads = 0;
    const result = checkAlipayProduction({ ...env(), BB_ALIPAY_ENVIRONMENT: environment }, { readSecretFile: () => { reads++; throw Error('Do not read'); } });
    assert.equal(result.configuration_valid, false);
    assert.equal(reads, 0);
  }
});
