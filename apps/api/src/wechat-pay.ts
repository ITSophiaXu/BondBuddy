import { createDecipheriv, createPrivateKey, createPublicKey, randomBytes, sign, verify, X509Certificate, type KeyObject } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { PaymentOrder, PaymentProvider, VerifiedPayment } from './payments.js';

const API_ORIGIN = 'https://api.mch.weixin.qq.com';
const MAX_BODY_BYTES = 65536;
const MAX_CLOCK_SKEW_SECONDS = 300;
const orderIdPattern = /^[A-Za-z0-9_-]{1,32}$/;
type JsonObject = Record<string, unknown>;
export type WechatPayPlatformKey = { serial: string; publicKeyPem?: string; certificatePem?: string };
export type WechatPayOptions = {
  merchantId: string;
  appId: string;
  merchantCertificateSerial: string;
  merchantPrivateKeyPem: string;
  apiV3Key: string;
  notifyUrl: string;
  /** Out-of-band trusted pins, never loaded from a callback or response URL. */
  platformKeys: readonly WechatPayPlatformKey[];
  timeoutMs?: number;
};
export type WechatPayDependencies = {
  /** Test seam; the production default always uses the fixed WeChat HTTPS origin. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};
type FailureCode = 'CONFIG_INVALID' | 'ORDER_INVALID' | 'SIGNATURE_INVALID' | 'PAYLOAD_INVALID' | 'RECEIPT_INVALID' | 'HTTP_ERROR' | 'TIMEOUT' | 'TRANSPORT_ERROR';
/** Messages/codes contain no request body, provider error body, key material or credentials. */
export class WechatPayError extends Error {
  constructor(readonly code: FailureCode) { super(`WeChat Pay ${code}`); this.name = 'WechatPayError'; }
}
const fail = (code: FailureCode): never => { throw new WechatPayError(code); };
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('PAYLOAD_INVALID');
  return value as JsonObject;
}
function json(raw: string): JsonObject {
  try { return object(JSON.parse(raw)); } catch { return fail('PAYLOAD_INVALID'); }
}
function text(value: unknown, max = 128): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\r\n\0]/.test(value)) return fail('PAYLOAD_INVALID');
  return value;
}
function base64(value: unknown, maxBytes: number): Buffer {
  const encoded = text(value, Math.ceil(maxBytes / 3) * 4);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return fail('PAYLOAD_INVALID');
  const decoded = Buffer.from(encoded, 'base64');
  if (!decoded.length || decoded.length > maxBytes || decoded.toString('base64') !== encoded) return fail('PAYLOAD_INVALID');
  return decoded;
}
function rsa(key: KeyObject): KeyObject {
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 2048) return fail('CONFIG_INVALID');
  return key;
}
function serial(value: string): string {
  if (!/^[A-Za-z0-9_]{8,128}$/.test(value)) return fail('CONFIG_INVALID');
  return value.toUpperCase();
}
type Pin = { key: KeyObject; certificate?: X509Certificate };
function pin(value: WechatPayPlatformKey, now: number): [string, Pin] {
  const id = serial(value.serial);
  if (Boolean(value.publicKeyPem) === Boolean(value.certificatePem)) return fail('CONFIG_INVALID');
  if (value.certificatePem) {
    const certificate = new X509Certificate(value.certificatePem);
    if (certificate.serialNumber.replaceAll(':', '').toUpperCase() !== id) return fail('CONFIG_INVALID');
    const result = { key: rsa(certificate.publicKey), certificate };
    validCertificate(result, now);
    return [id, result];
  }
  return [id, { key: rsa(createPublicKey(value.publicKeyPem!)) }];
}
function validCertificate(pin: Pin, now: number) {
  if (pin.certificate && (now < Date.parse(pin.certificate.validFrom) || now > Date.parse(pin.certificate.validTo))) return fail('SIGNATURE_INVALID');
}
function header(headers: FastifyRequest['headers'] | Headers, name: string): string {
  const value = headers instanceof Headers ? headers.get(name) : headers[name];
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || /[\r\n\0]/.test(value)) return fail('SIGNATURE_INVALID');
  return value;
}
async function boundedBody(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_BODY_BYTES) return fail('PAYLOAD_INVALID');
  if (!response.body) return fail('PAYLOAD_INVALID');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) { await reader.cancel(); return fail('PAYLOAD_INVALID'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

/** Direct-merchant API V3 Native. Does not grant credits, mutate orders or infer refunds. */
export function createWechatPayProvider(options: WechatPayOptions, dependencies: WechatPayDependencies = {}): PaymentProvider {
  let merchantKey: KeyObject, pins: Map<string, Pin>, apiV3Key: Buffer;
  const now = dependencies.now ?? Date.now, fetcher = dependencies.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10000;
  try {
    const notify = new URL(options.notifyUrl);
    if (!/^[0-9]{6,32}$/.test(options.merchantId) || !/^wx[A-Za-z0-9]{16}$/.test(options.appId) ||
        !/^[A-Fa-f0-9]{8,128}$/.test(options.merchantCertificateSerial) ||
        Buffer.byteLength(options.apiV3Key, 'utf8') !== 32 || /[\r\n\0]/.test(options.apiV3Key) || notify.protocol !== 'https:' || !notify.hostname ||
        notify.username || notify.password || notify.hash || notify.search || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000 ||
        !Array.isArray(options.platformKeys) || options.platformKeys.length < 1 || options.platformKeys.length > 8 || typeof fetcher !== 'function') return fail('CONFIG_INVALID');
    merchantKey = rsa(createPrivateKey(options.merchantPrivateKeyPem));
    pins = new Map(options.platformKeys.map(value => pin(value, now())));
    if (pins.size !== options.platformKeys.length) return fail('CONFIG_INVALID');
    apiV3Key = Buffer.from(options.apiV3Key, 'utf8');
  } catch { return fail('CONFIG_INVALID'); }
  // Capture primitive configuration; later mutation of an injected options object cannot change the merchant.
  const merchantId = options.merchantId, appId = options.appId, merchantSerial = options.merchantCertificateSerial.toUpperCase(), notifyUrl = options.notifyUrl;
  function verifyMessage(headers: FastifyRequest['headers'] | Headers, rawBody: string) {
    if (typeof rawBody !== 'string' || Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) return fail('SIGNATURE_INVALID');
    const timestamp = header(headers, 'wechatpay-timestamp'), nonce = header(headers, 'wechatpay-nonce');
    const signingSerial = header(headers, 'wechatpay-serial'), encodedSignature = header(headers, 'wechatpay-signature');
    if (!/^[0-9]{10}$/.test(timestamp) || Math.abs(Math.floor(now() / 1000) - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS || nonce.length > 128) return fail('SIGNATURE_INVALID');
    const trusted = pins.get(signingSerial.toUpperCase());
    if (!trusted) return fail('SIGNATURE_INVALID');
    validCertificate(trusted, now());
    try {
      if (!verify('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${rawBody}\n`), trusted.key, base64(encodedSignature, 256))) return fail('SIGNATURE_INVALID');
    } catch { return fail('SIGNATURE_INVALID'); }
  }
  function assertOrder(order: PaymentOrder) {
    if (!orderIdPattern.test(order.id) || order.merchant_id !== merchantId || order.currency !== 'CNY' ||
        !Number.isSafeInteger(order.amount_fen) || order.amount_fen <= 0 || !Number.isFinite(Date.parse(order.expires_at))) return fail('ORDER_INVALID');
  }
  function receipt(value: JsonObject, expected?: PaymentOrder): VerifiedPayment {
    const amount = object(value.amount), orderId = text(value.out_trade_no, 32);
    if (value.mchid !== merchantId || value.appid !== appId || value.trade_type !== 'NATIVE' || !orderIdPattern.test(orderId) ||
        amount.currency !== 'CNY' || !Number.isSafeInteger(amount.total) || Number(amount.total) <= 0) return fail('RECEIPT_INVALID');
    const states: Record<string, VerifiedPayment['state'] | undefined> = { SUCCESS: 'paid', NOTPAY: 'pending', USERPAYING: 'pending', CLOSED: 'expired', REVOKED: 'failed', PAYERROR: 'failed' };
    const state = typeof value.trade_state === 'string' && Object.hasOwn(states, value.trade_state) ? states[value.trade_state] : undefined;
    // REFUND requires its own money/credit reversal workflow; never reinterpret it as a new paid receipt.
    if (!state) return fail('RECEIPT_INVALID');
    const transactionId = state === 'paid' ? text(value.transaction_id) : null;
    if (transactionId && !/^[A-Za-z0-9_-]{1,128}$/.test(transactionId)) return fail('RECEIPT_INVALID');
    if (expected && (expected.id !== orderId || expected.merchant_id !== value.mchid || expected.amount_fen !== amount.total || expected.currency !== amount.currency)) return fail('RECEIPT_INVALID');
    return { orderId, merchantId, amountFen: Number(amount.total), currency: 'CNY', transactionId, state };
  }
  async function request(method: 'POST' | 'GET', path: string, payload?: JsonObject): Promise<JsonObject> {
    const body = payload ? JSON.stringify(payload) : '', timestamp = String(Math.floor(now() / 1000)), nonce = randomBytes(16).toString('hex');
    const signature = sign('RSA-SHA256', Buffer.from(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`), merchantKey).toString('base64');
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${merchantId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${merchantSerial}",signature="${signature}"`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new WechatPayError('TIMEOUT')); }, timeoutMs); });
    const perform = async () => {
      const response = await fetcher(API_ORIGIN + path, { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: authorization, 'User-Agent': 'BondBuddy-WechatPay/1' }, body: method === 'POST' ? body : undefined, redirect: 'error', signal: controller.signal });
      if (response.status !== 200) { await response.body?.cancel(); return fail('HTTP_ERROR'); }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) return fail('PAYLOAD_INVALID');
      const raw = await boundedBody(response);
      verifyMessage(response.headers, raw);
      return json(raw);
    };
    try { return await Promise.race([perform(), timeout]); }
    catch (error) { if (error instanceof WechatPayError) throw error; return fail(controller.signal.aborted ? 'TIMEOUT' : 'TRANSPORT_ERROR'); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  return {
    name: 'wechat', merchantId, acknowledgement: { code: 'SUCCESS', message: '成功' },
    async create(order) {
      assertOrder(order);
      if (Date.parse(order.expires_at) <= now()) return fail('ORDER_INVALID');
      const result = await request('POST', '/v3/pay/transactions/native', { appid: appId, mchid: merchantId, description: 'BondBuddy充值', out_trade_no: order.id,
        time_expire: new Date(order.expires_at).toISOString(), notify_url: notifyUrl, amount: { total: order.amount_fen, currency: 'CNY' } });
      const checkoutUrl = text(result.code_url, 4096);
      let parsed: URL;
      try { parsed = new URL(checkoutUrl); } catch { return fail('PAYLOAD_INVALID'); }
      if (parsed.protocol !== 'weixin:' || parsed.host !== 'wxpay' || parsed.pathname !== '/bizpayurl' || parsed.username || parsed.password || parsed.hash || !parsed.searchParams.get('pr') || /\s/.test(checkoutUrl)) return fail('PAYLOAD_INVALID');
      return { checkoutUrl };
    },
    async query(order) {
      assertOrder(order);
      return receipt(await request('GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(order.id)}?mchid=${encodeURIComponent(merchantId)}`), order);
    },
    async verifyCallback(headers, rawBody) {
      verifyMessage(headers, rawBody);
      const event = json(rawBody), resource = object(event.resource);
      if (event.event_type !== 'TRANSACTION.SUCCESS' || event.resource_type !== 'encrypt-resource' || resource.algorithm !== 'AEAD_AES_256_GCM' || resource.original_type !== 'transaction') return fail('PAYLOAD_INVALID');
      const nonce = text(resource.nonce, 12), associated = resource.associated_data ?? '';
      if (Buffer.byteLength(nonce, 'utf8') !== 12 || typeof associated !== 'string' || Buffer.byteLength(associated) > 256) return fail('PAYLOAD_INVALID');
      const encrypted = base64(resource.ciphertext, MAX_BODY_BYTES);
      if (encrypted.length <= 16) return fail('PAYLOAD_INVALID');
      let plaintext: string;
      try {
        const decipher = createDecipheriv('aes-256-gcm', apiV3Key, Buffer.from(nonce));
        decipher.setAuthTag(encrypted.subarray(-16));
        decipher.setAAD(Buffer.from(associated));
        plaintext = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]));
      } catch { return fail('PAYLOAD_INVALID'); }
      const result = receipt(json(plaintext));
      if (result.state !== 'paid') return fail('RECEIPT_INVALID');
      // Deterministic receipt on repeated signed delivery. Durable replay/amount/order checks belong to applyVerifiedPayment.
      return result;
    }
  };
}
