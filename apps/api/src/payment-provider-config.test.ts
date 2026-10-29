import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { paymentProvidersFromEnv } from './payment-provider-config.js';
import { syntheticWechatFixture } from './test-wechat-pay-fixtures.js';
import {syntheticAlipayFixture} from './test-alipay-pay-fixtures.js';

const f = syntheticWechatFixture();
const env = (): NodeJS.ProcessEnv => ({ BB_WECHAT_PAY_ENABLED: '1', BB_WECHAT_PAY_MERCHANT_ID: f.options.merchantId,
  BB_WECHAT_PAY_APP_ID: f.options.appId, BB_WECHAT_PAY_MERCHANT_CERT_SERIAL: f.options.merchantCertificateSerial,
  BB_WECHAT_PAY_PRIVATE_KEY: f.options.merchantPrivateKeyPem, BB_WECHAT_PAY_API_V3_KEY: f.options.apiV3Key,
  BB_WECHAT_PAY_NOTIFY_URL: f.options.notifyUrl, BB_WECHAT_PAY_PLATFORM_SERIAL: f.platformSerial,
  BB_WECHAT_PAY_PLATFORM_PUBLIC_KEY: f.options.platformKeys[0].publicKeyPem });
const dependencies = { now: () => f.now };

test('factory disables absent/disabled config without reading files; invalid config exposes no payable channel or secrets', () => {
  const noRead = { readSecretFile: () => { throw new Error('must not read disabled credentials'); } };
  assert.deepEqual(paymentProvidersFromEnv({}, noRead), { providers: [], status: 'disabled' });
  assert.deepEqual(paymentProvidersFromEnv({ ...env(), BB_WECHAT_PAY_ENABLED: '0' }, noRead), { providers: [], status: 'disabled' });
  for (const changes of [{ BB_WECHAT_PAY_ENABLED: 'true' }, { BB_WECHAT_PAY_APP_ID: undefined }, { BB_WECHAT_PAY_PRIVATE_KEY: 'synthetic secret that must not leak' },
    { BB_WECHAT_PAY_API_V3_KEY: 'too-short' }, { BB_WECHAT_PAY_TIMEOUT_MS: '-1' }, { BB_WECHAT_PAY_TIMEOUT_MS: '30001' },
    { BB_WECHAT_PAY_NOTIFY_URL: 'http://example.test/notify' }, { BB_WECHAT_PAY_PRIVATE_KEY_FILE: resolve('ambiguous-key.pem') },
    { BB_WECHAT_PAY_PLATFORM_PUBLIC_KEY: undefined }, { BB_WECHAT_PAY_PLATFORM_CERT: 'invalid cert alongside key' }]) {
    const result = paymentProvidersFromEnv({ ...env(), ...changes }, dependencies);
    assert.deepEqual(result, { providers: [], status: 'invalid' });
    assert.equal(JSON.stringify(result).includes('secret'), false); assert.equal(JSON.stringify(result).includes('BEGIN'), false);
  }
  const configured = paymentProvidersFromEnv(env(), dependencies);
  assert.equal(configured.status, 'ready'); assert.deepEqual(configured.providers.map(p => p.name), ['wechat']);
  assert.equal(JSON.stringify(configured).includes(f.options.apiV3Key), false);
  assert.equal(JSON.stringify(configured).includes(f.options.merchantPrivateKeyPem), false);
});

test('factory permits injected absolute secret files and an explicit platform rotation pin file', () => {
  const paths = { private: resolve('synthetic-private.pem'), api: resolve('synthetic-api-key.txt'), platform: resolve('synthetic-platform.pem'), rotation: resolve('synthetic-platform-pins.json') };
  const files = new Map([[paths.private, f.options.merchantPrivateKeyPem], [paths.api, f.options.apiV3Key + '\n'], [paths.platform, f.options.platformKeys[0].publicKeyPem!],
    [paths.rotation, JSON.stringify([{ serial: f.platformSerial, certificatePem: f.certificatePem }, { serial: 'PUB_KEY_ID_SYNTHETIC_2', publicKeyPem: f.options.platformKeys[0].publicKeyPem }])]]);
  const fileEnv = { ...env(), BB_WECHAT_PAY_PRIVATE_KEY: undefined, BB_WECHAT_PAY_PRIVATE_KEY_FILE: paths.private, BB_WECHAT_PAY_API_V3_KEY: undefined, BB_WECHAT_PAY_API_V3_KEY_FILE: paths.api,
    BB_WECHAT_PAY_PLATFORM_PUBLIC_KEY: undefined, BB_WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE: paths.platform };
  const readSecretFile = (path: string) => { const value = files.get(path); assert.ok(value); return value; };
  assert.equal(paymentProvidersFromEnv(fileEnv, { ...dependencies, readSecretFile }).status, 'ready');
  const rotationEnv = { ...fileEnv, BB_WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE: undefined, BB_WECHAT_PAY_PLATFORM_SERIAL: undefined, BB_WECHAT_PAY_PLATFORM_KEYS_FILE: paths.rotation };
  assert.equal(paymentProvidersFromEnv(rotationEnv, { ...dependencies, readSecretFile }).status, 'ready');
  assert.equal(paymentProvidersFromEnv({ ...rotationEnv, BB_WECHAT_PAY_PLATFORM_SERIAL: f.platformSerial }, { ...dependencies, readSecretFile }).status, 'invalid');
  assert.equal(paymentProvidersFromEnv({ ...fileEnv, BB_WECHAT_PAY_PRIVATE_KEY_FILE: 'relative.pem' }, { ...dependencies, readSecretFile }).status, 'invalid');
  assert.equal(paymentProvidersFromEnv(fileEnv, { ...dependencies, readSecretFile: () => { throw new Error('sensitive filesystem detail'); } }).status, 'invalid');
  assert.equal(paymentProvidersFromEnv(rotationEnv, { ...dependencies, readSecretFile: path => path === paths.rotation ? 'null' : readSecretFile(path) }).status, 'invalid');
});

test('factory reads bounded regular files; on POSIX rejects loose permissions and symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bondbuddy-synthetic-payment-')), key = join(dir, 'key.pem'), api = join(dir, 'api.txt'), platform = join(dir, 'platform.pem'), link = join(dir, 'key-link.pem');
  const fileEnv = { ...env(), BB_WECHAT_PAY_PRIVATE_KEY: undefined, BB_WECHAT_PAY_PRIVATE_KEY_FILE: key, BB_WECHAT_PAY_API_V3_KEY: undefined, BB_WECHAT_PAY_API_V3_KEY_FILE: api,
    BB_WECHAT_PAY_PLATFORM_PUBLIC_KEY: undefined, BB_WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE: platform };
  let linked = false;
  try {
    writeFileSync(key, f.options.merchantPrivateKeyPem, { mode: 0o600 }); writeFileSync(api, f.options.apiV3Key, { mode: 0o600 }); writeFileSync(platform, f.options.platformKeys[0].publicKeyPem!, { mode: 0o600 });
    assert.equal(paymentProvidersFromEnv(fileEnv, dependencies).status, 'ready');
    if (process.platform !== 'win32') {
      chmodSync(key, 0o644); assert.equal(paymentProvidersFromEnv(fileEnv, dependencies).status, 'invalid'); chmodSync(key, 0o600);
      symlinkSync(key, link); linked = true; assert.equal(paymentProvidersFromEnv({ ...fileEnv, BB_WECHAT_PAY_PRIVATE_KEY_FILE: link }, dependencies).status, 'invalid');
    }
    writeFileSync(key, 'x'.repeat(65537)); assert.equal(paymentProvidersFromEnv(fileEnv, dependencies).status, 'invalid');
    assert.equal(paymentProvidersFromEnv({ ...fileEnv, BB_WECHAT_PAY_PRIVATE_KEY_FILE: dir }, dependencies).status, 'invalid');
  } finally { if (linked) unlinkSync(link); for (const path of [key, api, platform]) unlinkSync(path); rmdirSync(dir); }
});

test('Alipay is independently disabled, requires an explicit contracted Web product and never exposes a mandate',()=>{
  const a=syntheticAlipayFixture(),alipayEnv:NodeJS.ProcessEnv={BB_ALIPAY_PAY_ENABLED:'1',BB_ALIPAY_APP_ID:a.options.appId,BB_ALIPAY_SELLER_ID:a.options.merchantId,
    BB_ALIPAY_WEB_PRODUCT:'page',BB_ALIPAY_APP_PRIVATE_KEY:a.options.appPrivateKeyPem,BB_ALIPAY_PUBLIC_KEY:a.options.alipayPublicKeyPem,
    BB_ALIPAY_NOTIFY_URL:a.options.notifyUrl,BB_ALIPAY_RETURN_URL:a.options.returnUrl};
  for(const webProduct of ['page','wap']){
    const result=paymentProvidersFromEnv({...alipayEnv,BB_ALIPAY_WEB_PRODUCT:webProduct},{now:()=>a.now});
    assert.equal(result.status,'ready');assert.deepEqual(result.providers.map(p=>p.name),['alipay']);assert.equal(result.providers[0].recurring,undefined);assert.equal(result.providers[0].refunds,undefined);
    assert.equal(JSON.stringify(result).includes('BEGIN'),false);
  }
  const combined=paymentProvidersFromEnv({...env(),...alipayEnv},dependencies);assert.equal(combined.status,'ready');assert.deepEqual(combined.providers.map(p=>p.name),['wechat','alipay']);
  for(const changes of [{BB_ALIPAY_WEB_PRODUCT:undefined},{BB_ALIPAY_WEB_PRODUCT:'app'},{BB_ALIPAY_PAY_ENABLED:'true'},{BB_ALIPAY_APP_ID:undefined},
    {BB_ALIPAY_SELLER_ID:undefined},{BB_ALIPAY_PUBLIC_KEY:undefined},{BB_ALIPAY_APP_PRIVATE_KEY_FILE:resolve('ambiguous-alipay.pem')},
    {BB_ALIPAY_REFUND_ENABLED:'yes'},{BB_ALIPAY_PAY_TIMEOUT_MS:'30001'},{BB_ALIPAY_NOTIFY_URL:'https://synthetic.test/incorrect-callback'}])
    assert.deepEqual(paymentProvidersFromEnv({...alipayEnv,...changes},{now:()=>a.now}),{providers:[],status:'invalid'});
  assert.deepEqual(paymentProvidersFromEnv({...alipayEnv,BB_ALIPAY_PAY_ENABLED:'0'},{readSecretFile:()=>{throw Error('Do not read disabled Alipay files');}}),{providers:[],status:'disabled'});
  assert.ok(paymentProvidersFromEnv({...alipayEnv,BB_ALIPAY_REFUND_ENABLED:'1'},{now:()=>a.now}).providers[0].refunds);
});
