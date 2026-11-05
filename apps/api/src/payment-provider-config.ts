import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PaymentProvider } from './payments.js';
import { createWechatPayProvider, type WechatPayDependencies, type WechatPayPlatformKey } from './wechat-pay.js';
import {createAlipayPayProvider,type AlipayWebProduct,type AlipayPayOptions} from './alipay-pay.js';

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
// Anchored to this checkout, independent of the shell's working directory.
export const alipaySandboxConfigPath=fileURLToPath(new URL('../../../.alipay-sandbox.json',import.meta.url));
const productionAlipayFields=['BB_ALIPAY_APP_ID','BB_ALIPAY_SELLER_ID','BB_ALIPAY_APP_PRIVATE_KEY','BB_ALIPAY_APP_PRIVATE_KEY_FILE','BB_ALIPAY_PUBLIC_KEY','BB_ALIPAY_PUBLIC_KEY_FILE'];
/** The Skill owns this file. Read the verified original values without copying keys into env or logs. */
export function alipaySandboxOptions(env:NodeJS.ProcessEnv,read:(path:string)=>string=readProtectedFile):AlipayPayOptions{
  if(env.NODE_ENV!=='test'||env.BB_ALIPAY_ENVIRONMENT!=='sandbox'||productionAlipayFields.some(key=>env[key])
    ||env.BB_ALIPAY_WEB_PRODUCT&&env.BB_ALIPAY_WEB_PRODUCT!=='page'||env.BB_ALIPAY_PAY_STATEMENTS_ENABLED==='1')throw new Error('Invalid sandbox configuration');
  try{
    const text=read(alipaySandboxConfigPath);if(Buffer.byteLength(text)>65536)throw new Error();
    const config=JSON.parse(text),app=config.appIds?.[0],seller=config.sandboxAccounts?.partner;
    if(!app||typeof app.appId!=='string'||typeof app.pid!=='string'||app.pid!==seller?.userId
      ||typeof app.appPrivatePkcsKey!=='string'||typeof app.alipayPublicKey!=='string'
      ||!env.BB_ALIPAY_RETURN_URL)throw new Error();
    return {environment:'sandbox',webProduct:'page',appId:app.appId,merchantId:app.pid,
      appPrivateKeyPem:app.appPrivatePkcsKey,appPrivateKeyType:'PKCS1',alipayPublicKeyPem:app.alipayPublicKey,
      returnUrl:env.BB_ALIPAY_RETURN_URL,...(env.BB_ALIPAY_NOTIFY_URL?{notifyUrl:env.BB_ALIPAY_NOTIFY_URL}:{}),
      refundsEnabled:env.BB_ALIPAY_REFUND_ENABLED==='1',statementsEnabled:false};
  }catch{throw new Error('Invalid sandbox configuration');}
}
/** No merchant config or invalid config yields no payable channel. Never includes secret values/errors in the result. */
export function paymentProvidersFromEnv(env: NodeJS.ProcessEnv = process.env, dependencies: PaymentProviderConfigDependencies = {}): PaymentProviderConfiguration {
  const wechat=env.BB_WECHAT_PAY_ENABLED??'0',alipay=env.BB_ALIPAY_PAY_ENABLED??'0',alipayStatements=env.BB_ALIPAY_PAY_STATEMENTS_ENABLED??'0';
  if(!['0','1'].includes(wechat)||!['0','1'].includes(alipay)||!['0','1'].includes(alipayStatements)
    ||alipayStatements==='1'&&alipay!=='1')return {providers:[],status:'invalid'};
  if(wechat==='0'&&alipay==='0')return {providers:[],status:'disabled'};
  try {
    const required = (key: string) => { const value = env[key]?.trim(); if (!value) throw new Error('Incomplete payment configuration'); return value; };
    const read = dependencies.readSecretFile ?? readProtectedFile;
    const fromFile = (key: string) => { const path = required(key); if (!isAbsolute(path)) throw new Error('Absolute payment file required'); const value = read(path); if (Buffer.byteLength(value) > 65536) throw new Error('Payment file too large'); return value.trim(); };
    const secret = (key: string) => {
      if (Boolean(env[key]) === Boolean(env[`${key}_FILE`])) throw new Error('One payment secret source required');
      return env[key] ? required(key) : fromFile(`${key}_FILE`);
    };
    const providers:PaymentProvider[]=[];
    if(wechat==='1'){
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
    providers.push(provider);
    }
    if(alipay==='1'){
      const environment=env.BB_ALIPAY_ENVIRONMENT??'production';
      if(!['production','sandbox'].includes(environment))throw new Error('Invalid payment environment');
      const timeoutText=env.BB_ALIPAY_PAY_TIMEOUT_MS;
      if(timeoutText!==undefined&&!/^[0-9]{1,5}$/.test(timeoutText))throw new Error('Invalid payment timeout');
      if(env.BB_ALIPAY_REFUND_ENABLED!==undefined&&!['0','1'].includes(env.BB_ALIPAY_REFUND_ENABLED))throw new Error('Invalid refund setting');
      providers.push(createAlipayPayProvider(environment==='sandbox'?alipaySandboxOptions(env,read):{appId:required('BB_ALIPAY_APP_ID'),merchantId:required('BB_ALIPAY_SELLER_ID'),
        webProduct:required('BB_ALIPAY_WEB_PRODUCT') as AlipayWebProduct,appPrivateKeyPem:secret('BB_ALIPAY_APP_PRIVATE_KEY'),alipayPublicKeyPem:secret('BB_ALIPAY_PUBLIC_KEY'),
        appPrivateKeyType:env.BB_ALIPAY_APP_PRIVATE_KEY_TYPE as AlipayPayOptions['appPrivateKeyType'],
        notifyUrl:required('BB_ALIPAY_NOTIFY_URL'),returnUrl:required('BB_ALIPAY_RETURN_URL'),refundsEnabled:env.BB_ALIPAY_REFUND_ENABLED==='1',
        statementsEnabled:alipayStatements==='1',
        timeoutMs:timeoutText===undefined?undefined:Number(timeoutText)},dependencies));
    }
    return { providers, status: 'ready' };
  } catch { return { providers: [], status: 'invalid' }; }
}
