import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { syntheticAlipayFixture } from '../apps/api/dist/test-alipay-pay-fixtures.js';
import { paymentProvidersFromEnv } from '../apps/api/dist/payment-provider-config.js';
import { checkAlipayProduction } from '../apps/api/dist/alipay-production-check.js';
import { checkPaymentDeployment } from './check-payment-deployment.mjs';

const root = fileURLToPath(new URL('../deploy/m1/', import.meta.url));
const fixture = syntheticAlipayFixture();
function render(file, changes = {}) {
  // Do not inherit any actual application, merchant or Compose configuration.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BB_|POSTGRES_|DATABASE_URL$|AZURE_|COMPOSE_)/.test(key)));
  return JSON.parse(execFileSync('docker', ['compose', '--project-directory', root, '--env-file', `${root}.env.example`,
    '-f', `${root}${file}`, 'config', '--format', 'json'], { timeout: 30000, encoding: 'utf8', env: {
    ...environment, COMPOSE_PROJECT_NAME: 'synthetic-alipay-config', POSTGRES_PASSWORD: 'synthetic',
    BB_MAIN_DATABASE_URL: 'postgresql://bondbuddy:synthetic@postgres:5432/bondbuddy',
    AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true', BB_TRIAL_SOURCE_SALT: 'synthetic',
    BB_PUBLIC_ORIGIN: 'https://merchant.example.test', BB_TERMS_VERSION: 'synthetic', BB_IMAGE_TAG: 'synthetic',
    BB_PARSE_CACHE_OCR_VERSION: 'synthetic', BB_PARSE_CACHE_BASIS_VERSION: 'synthetic',
    BB_FILE_TEMPLATE_HOST_DIR: root, BB_PAYMENT_SECRETS_DIR: root,
    BB_SUBSCRIPTION_BILLING_ENABLED: '1', BB_ALIPAY_PAY_ENABLED: '1', BB_ALIPAY_WEB_PRODUCT: 'page',
    BB_ALIPAY_APP_ID: fixture.options.appId, BB_ALIPAY_SELLER_ID: fixture.options.merchantId,
    BB_ALIPAY_APP_PRIVATE_KEY_FILE: '/run/bondbuddy-payments/app.key', BB_ALIPAY_PUBLIC_KEY_FILE: '/run/bondbuddy-payments/alipay.key',
    BB_ALIPAY_NOTIFY_URL: 'https://merchant.example.test/api/v1/payments/alipay/callback',
    BB_ALIPAY_RETURN_URL: 'https://merchant.example.test/payment/alipay/return.html',
    BB_EGRESS_ALLOW: 'openapi.alipay.com', BB_NO_PROXY: 'postgres,api,localhost,127.0.0.1', ...changes,
  }, stdio: ['ignore', 'pipe', 'pipe'] }));
}

test('effective monolithic and split main deployment load raw PKCS1 and existing PEM through the real factory', async () => {
  for (const file of ['compose.yaml', 'compose.main.yaml']) for (const keyType of ['', 'PKCS1']) {
    const config = render(file, { BB_ALIPAY_APP_PRIVATE_KEY_TYPE: keyType });
    const env = config.services.api.environment;
    assert.equal(env.BB_ALIPAY_ENVIRONMENT, 'production');
    assert.equal(env.BB_ALIPAY_APP_PRIVATE_KEY_TYPE, keyType);
    const readSecretFile = path => {
      assert.ok(['/run/bondbuddy-payments/app.key', '/run/bondbuddy-payments/alipay.key'].includes(path));
      return path.endsWith('/app.key')
        ? keyType ? fixture.app.privateKey.export({ type: 'pkcs1', format: 'der' }).toString('base64') : fixture.options.appPrivateKeyPem
        : keyType ? fixture.platform.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') : fixture.options.alipayPublicKeyPem;
    };
    assert.equal(checkAlipayProduction(env, { readSecretFile }).configuration_valid, true);
    const provider = paymentProvidersFromEnv(env, { readSecretFile, now: () => fixture.now }).providers[0];
    const url = new URL((await provider.create(fixture.order)).checkoutUrl);
    assert.equal(url.origin, 'https://openapi.alipay.com');
    assert.equal(fixture.request(url.searchParams.toString()).fields.method, 'alipay.trade.page.pay');
    assert.equal(config.services.api.volumes.find(volume => volume.target === '/run/bondbuddy-payments').read_only, true);
    if (file === 'compose.yaml') assert.equal(checkPaymentDeployment(config).passed, true, JSON.stringify(checkPaymentDeployment(config).checks.filter(check => !check.passed)));
  }
});

test('a configured sandbox environment is visible to release checks instead of silently falling back to production', () => {
  const config = render('compose.yaml', { BB_ALIPAY_ENVIRONMENT: 'sandbox' });
  assert.equal(config.services.api.environment.BB_ALIPAY_ENVIRONMENT, 'sandbox');
  assert.equal(checkPaymentDeployment(config).passed, false);
  assert.equal(checkAlipayProduction(config.services.api.environment).configuration_valid, false);
});
