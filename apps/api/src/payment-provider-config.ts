import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { PaymentProvider } from './payments.js';
import { createWechatPayProvider, type WechatPayDependencies, type WechatPayPlatformKey } from './wechat-pay.js';

export type PaymentProviderConfiguration = { providers: readonly PaymentProvider[]; status: 'disabled' | 'ready' | 'invalid' };
export type PaymentProviderConfigDependencies = WechatPayDependencies & { readSecretFile?: (path: string) => string };
function readProtectedFile(path: string): string {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 65536) throw new Error('Invalid protected payment file');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 65536) throw new Error('Invalid protected payment file');
    if (process.platform !== 'win32') {
      const owner = process.getuid?.();
      if ((info.mode & 0o077) !== 0 || (info.uid !== 0 && info.uid !== owner)) throw new Error('Invalid protected payment file permissions');
    }
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
/** No merchant config or invalid config yields no payable channel. Never includes secret values/errors in the result. */
export function paymentProvidersFromEnv(env: NodeJS.ProcessEnv = process.env, dependencies: PaymentProviderConfigDependencies = {}): PaymentProviderConfiguration {
  if (env.BB_WECHAT_PAY_ENABLED === undefined || env.BB_WECHAT_PAY_ENABLED === '0') return { providers: [], status: 'disabled' };
  if (env.BB_WECHAT_PAY_ENABLED !== '1') return { providers: [], status: 'invalid' };
  try {
    const required = (key: string) => { const value = env[key]?.trim(); if (!value) throw new Error('Incomplete payment configuration'); return value; };
    const read = dependencies.readSecretFile ?? readProtectedFile;
    const fromFile = (key: string) => { const path = required(key); if (!isAbsolute(path)) throw new Error('Absolute payment file required'); const value = read(path); if (Buffer.byteLength(value) > 65536) throw new Error('Payment file too large'); return value.trim(); };
    const secret = (key: string) => {
      if (Boolean(env[key]) === Boolean(env[`${key}_FILE`])) throw new Error('One payment secret source required');
      return env[key] ? required(key) : fromFile(`${key}_FILE`);
    };
    let platformKeys: WechatPayPlatformKey[];
    if (env.BB_WECHAT_PAY_PLATFORM_KEYS_FILE) {
      if (['BB_WECHAT_PAY_PLATFORM_SERIAL', 'BB_WECHAT_PAY_PLATFORM_PUBLIC_KEY', 'BB_WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE', 'BB_WECHAT_PAY_PLATFORM_CERT', 'BB_WECHAT_PAY_PLATFORM_CERT_FILE'].some(key => env[key])) throw new Error('Ambiguous platform key configuration');
      platformKeys = JSON.parse(fromFile('BB_WECHAT_PAY_PLATFORM_KEYS_FILE'));
    } else {
      const hasPublic = Boolean(env.BB_WECHAT_PAY_PLATFORM_PUBLIC_KEY || env.BB_WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE), hasCert = Boolean(env.BB_WECHAT_PAY_PLATFORM_CERT || env.BB_WECHAT_PAY_PLATFORM_CERT_FILE);
      if (hasPublic === hasCert) throw new Error('One platform key or certificate required');
      platformKeys = [{ serial: required('BB_WECHAT_PAY_PLATFORM_SERIAL'), ...(hasPublic ? { publicKeyPem: secret('BB_WECHAT_PAY_PLATFORM_PUBLIC_KEY') } : { certificatePem: secret('BB_WECHAT_PAY_PLATFORM_CERT') }) }];
    }
    const timeoutText = env.BB_WECHAT_PAY_TIMEOUT_MS;
    if (timeoutText !== undefined && !/^[0-9]{1,5}$/.test(timeoutText)) throw new Error('Invalid payment timeout');
    if(env.BB_WECHAT_PAY_REFUND_ENABLED!==undefined&&!['0','1'].includes(env.BB_WECHAT_PAY_REFUND_ENABLED))throw new Error('Invalid refund setting');
    if(env.BB_WECHAT_PAY_STATEMENTS_ENABLED!==undefined&&!['0','1'].includes(env.BB_WECHAT_PAY_STATEMENTS_ENABLED))throw new Error('Invalid statement setting');
    const provider = createWechatPayProvider({ merchantId: required('BB_WECHAT_PAY_MERCHANT_ID'), appId: required('BB_WECHAT_PAY_APP_ID'),
      merchantCertificateSerial: required('BB_WECHAT_PAY_MERCHANT_CERT_SERIAL'), merchantPrivateKeyPem: secret('BB_WECHAT_PAY_PRIVATE_KEY'),
      apiV3Key: secret('BB_WECHAT_PAY_API_V3_KEY'), notifyUrl: required('BB_WECHAT_PAY_NOTIFY_URL'), platformKeys,
      refundNotifyUrl:env.BB_WECHAT_PAY_REFUND_ENABLED==='1'?required('BB_WECHAT_PAY_REFUND_NOTIFY_URL'):undefined,
      statementsEnabled:env.BB_WECHAT_PAY_STATEMENTS_ENABLED==='1',
      statementAccounts:(env.BB_WECHAT_PAY_STATEMENT_ACCOUNTS??'BASIC').split(',').map(value=>value.trim()) as ('BASIC'|'OPERATION'|'FEES')[],
      timeoutMs: timeoutText === undefined ? undefined : Number(timeoutText) }, dependencies);
    return { providers: [provider], status: 'ready' };
  } catch { return { providers: [], status: 'invalid' }; }
}
