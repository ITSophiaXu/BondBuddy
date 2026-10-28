/** Synthetic test-only PKI. Generated in memory; no merchant credentials or real payment requests. */
import { createCipheriv, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { PaymentOrder } from './payments.js';
import type { WechatPayOptions } from './wechat-pay.js';

const der = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts), hex = body.length.toString(16).padStart(body.length.toString(16).length + body.length.toString(16).length % 2, '0');
  const length = body.length < 128 ? Buffer.from([body.length]) : Buffer.concat([Buffer.from([128 + hex.length / 2]), Buffer.from(hex, 'hex')]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
};
function certificate(privateKey: KeyObject, publicDer: Buffer, serial: string): string {
  const algorithm = der(0x30, Buffer.from('06092a864886f70d01010b0500', 'hex'));
  const name = der(0x30, der(0x31, der(0x30, Buffer.from('0603550403', 'hex'), der(0x0c, Buffer.from('Synthetic WeChat Test')))));
  const tbs = der(0x30, der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from('00' + serial, 'hex')), algorithm, name,
    der(0x30, der(0x17, Buffer.from('260101000000Z')), der(0x17, Buffer.from('280101000000Z'))), name, publicDer);
  const encoded = der(0x30, tbs, algorithm, der(3, Buffer.concat([Buffer.from([0]), sign('RSA-SHA256', tbs, privateKey)])));
  return `-----BEGIN CERTIFICATE-----\n${encoded.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`;
}
export function syntheticWechatFixture(now = Date.parse('2026-10-28T10:00:00Z')) {
  const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 }), platform = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const platformSerial = 'ABCDEF1234567890';
  const options: WechatPayOptions = { merchantId: '1900000001', appId: 'wx1234567890abcdef', merchantCertificateSerial: 'ABCDEF0000000001',
    merchantPrivateKeyPem: merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), apiV3Key: 'SyntheticApiV3Key012345678901234',
    notifyUrl: 'https://bondbuddy.example/api/v1/payments/wechat/callback',
    platformKeys: [{ serial: platformSerial, publicKeyPem: platform.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] };
  const order: PaymentOrder = { id: 'synthetic_order_1', merchant_id: options.merchantId, amount_fen: 10000, currency: 'CNY', expires_at: new Date(now + 1800000).toISOString() };
  const paid = { appid: options.appId, mchid: options.merchantId, out_trade_no: order.id, transaction_id: 'synthetic_transaction_1', trade_state: 'SUCCESS', trade_type: 'NATIVE', amount: { total: order.amount_fen, currency: 'CNY', payer_total: 1, payer_currency: 'CNY' } };
  function signed(raw: string, changes: { timestamp?: number; serial?: string; key?: KeyObject } = {}): FastifyRequest['headers'] {
    const timestamp = String(changes.timestamp ?? Math.floor(now / 1000)), nonce = 'synthetic-response-nonce';
    return { 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce, 'wechatpay-serial': changes.serial ?? platformSerial,
      'wechatpay-signature': sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`), changes.key ?? platform.privateKey).toString('base64') };
  }
  function envelope(payment: unknown = paid, eventChanges: Record<string, unknown> = {}, resourceChanges: Record<string, unknown> = {}) {
    const nonce = '012345678901', associated = 'transaction', cipher = createCipheriv('aes-256-gcm', Buffer.from(options.apiV3Key), Buffer.from(nonce));
    cipher.setAAD(Buffer.from(associated));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payment), 'utf8'), cipher.final(), cipher.getAuthTag()]);
    const raw = JSON.stringify({ id: 'synthetic_notification_1', create_time: new Date(now).toISOString(), event_type: 'TRANSACTION.SUCCESS', resource_type: 'encrypt-resource',
      ...eventChanges, resource: { algorithm: 'AEAD_AES_256_GCM', original_type: 'transaction', ciphertext: encrypted.toString('base64'), associated_data: associated, nonce, ...resourceChanges } });
    return { raw, headers: signed(raw) };
  }
  const response = (value: unknown, changes: Parameters<typeof signed>[1] = {}) => {
    const raw = JSON.stringify(value);
    return new Response(raw, { headers: { 'content-type': 'application/json', ...signed(raw, changes) as Record<string, string> } });
  };
  return { merchant, platform, now, platformSerial, options, order, paid, signed, envelope, response,
    certificatePem: certificate(platform.privateKey, platform.publicKey.export({ format: 'der', type: 'spki' }), platformSerial) };
}
