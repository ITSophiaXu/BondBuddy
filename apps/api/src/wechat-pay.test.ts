import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { createWechatPayProvider, WechatPayError } from './wechat-pay.js';
import { syntheticWechatFixture } from './test-wechat-pay-fixtures.js';

const f = syntheticWechatFixture();
const dependencies = { now: () => f.now };
const rejected = (code: string) => (error: unknown) => error instanceof WechatPayError && error.code === code;

test('synthetic Native mock HTTP: signs exact request bytes and verifies signed create/query responses', async () => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8'), auth = String(req.headers.authorization);
      assert.match(auth, /^WECHATPAY2-SHA256-RSA2048 /);
      const values = Object.fromEntries([...auth.matchAll(/([a-z_]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
      assert.equal(values.mchid, f.options.merchantId); assert.equal(values.serial_no, f.options.merchantCertificateSerial);
      assert.equal(verify('RSA-SHA256', Buffer.from(`${req.method}\n${req.url}\n${values.timestamp}\n${values.nonce_str}\n${body}\n`), f.merchant.publicKey, Buffer.from(values.signature, 'base64')), true);
      requests++;
      let payload: unknown;
      if (req.method === 'POST') {
        assert.equal(req.url, '/v3/pay/transactions/native');
        const order = JSON.parse(body); assert.equal(order.appid, f.options.appId); assert.equal(order.out_trade_no, f.order.id);
        assert.deepEqual(order.amount, { total: 10000, currency: 'CNY' }); assert.equal(order.notify_url, f.options.notifyUrl);
        assert.equal(order.time_expire, f.order.expires_at); payload = { code_url: 'weixin://wxpay/bizpayurl?pr=synthetic123' };
      } else {
        assert.equal(req.url, `/v3/pay/transactions/out-trade-no/${f.order.id}?mchid=${f.options.merchantId}`); assert.equal(body, ''); payload = f.paid;
      }
      const raw = JSON.stringify(payload); res.writeHead(200, { 'content-type': 'application/json', ...f.signed(raw) as Record<string, string> }); res.end(raw);
    } catch { res.statusCode = 500; res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const fetcher: typeof fetch = (input, init) => { assert.match(String(input), /^https:\/\/api\.mch\.weixin\.qq\.com\//); return fetch(`http://127.0.0.1:${port}${new URL(String(input)).pathname}${new URL(String(input)).search}`, init); };
  try {
    const provider = createWechatPayProvider(f.options, { ...dependencies, fetch: fetcher });
    assert.deepEqual(await provider.create(f.order), { checkoutUrl: 'weixin://wxpay/bizpayurl?pr=synthetic123' });
    assert.deepEqual(await provider.query(f.order), { orderId: f.order.id, merchantId: f.options.merchantId, amountFen: 10000, currency: 'CNY', transactionId: 'synthetic_transaction_1', state: 'paid',payerCash:{amountFen:1,currency:'CNY'} });
    assert.equal(requests, 2);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('valid signed AES-GCM callback is deterministic on repeat and performs no network lookup', async () => {
  const provider = createWechatPayProvider(f.options, { ...dependencies, fetch: async () => { throw new Error('Unexpected request'); } });
  const callback = f.envelope(), first = await provider.verifyCallback(callback.headers, callback.raw);
  assert.equal(first.amountFen, 10000); assert.equal(first.transactionId, 'synthetic_transaction_1');
  assert.deepEqual(await provider.verifyCallback(callback.headers, callback.raw), first);
  assert.deepEqual(provider.acknowledgement, { code: 'SUCCESS', message: '成功' });
});

test('rejects forged, stale, future, unknown-serial, duplicate-header and altered callbacks', async () => {
  const p = createWechatPayProvider(f.options, dependencies), callback = f.envelope();
  const headers = [
    {}, { ...callback.headers, 'wechatpay-signature': 'not-base64' },
    f.signed(callback.raw, { timestamp: Math.floor(f.now / 1000) - 301 }),
    f.signed(callback.raw, { timestamp: Math.floor(f.now / 1000) + 301 }),
    f.signed(callback.raw, { serial: 'UNKNOWN_SERIAL_123' }),
    f.signed(callback.raw, { key: f.merchant.privateKey }),
    { ...callback.headers, 'wechatpay-serial': [f.platformSerial, f.platformSerial] },
    { ...callback.headers, 'wechatpay-timestamp': '1e100' },
  ];
  for (const h of headers) await assert.rejects(() => p.verifyCallback(h, callback.raw), rejected('SIGNATURE_INVALID'));
  await assert.rejects(() => p.verifyCallback(callback.headers, callback.raw + ' '), rejected('SIGNATURE_INVALID'));
  await assert.rejects(() => p.verifyCallback(f.signed('{'), '{'), rejected('PAYLOAD_INVALID'));
  const large = 'x'.repeat(65537); await assert.rejects(() => p.verifyCallback(f.signed(large), large), rejected('SIGNATURE_INVALID'));
});

test('rejects signed but invalid AEAD event/resource and receipts, including merchant/app/currency', async () => {
  const p = createWechatPayProvider(f.options, dependencies);
  const malformed = [
    f.envelope(f.paid, { event_type: 'REFUND.SUCCESS' }), f.envelope(f.paid, { resource_type: 'plaintext' }),
    f.envelope(f.paid, {}, { algorithm: 'AES-ECB' }), f.envelope(f.paid, {}, { original_type: 'refund' }),
    f.envelope(f.paid, {}, { nonce: 'short' }), f.envelope(f.paid, {}, { associated_data: 'altered' }),
    f.envelope(f.paid, {}, { ciphertext: Buffer.alloc(17).toString('base64') }),
  ];
  for (const v of malformed) await assert.rejects(() => p.verifyCallback(v.headers, v.raw), rejected('PAYLOAD_INVALID'));
  for (const payment of [
    { ...f.paid, mchid: '1900000002' }, { ...f.paid, appid: 'wx0000000000000000' }, { ...f.paid, trade_type: 'JSAPI' },
    { ...f.paid, amount: { total: 10000, currency: 'USD' } }, { ...f.paid, amount: { total: '10000', currency: 'CNY' } },
    { ...f.paid, amount: { total: 1.5, currency: 'CNY' } }, { ...f.paid, amount: { total: 0, currency: 'CNY' } },
    { ...f.paid, transaction_id: '' }, { ...f.paid, out_trade_no: '../another-order' }, { ...f.paid, trade_state: 'NOTPAY' }, { ...f.paid, trade_state: 'REFUND' }, { ...f.paid, trade_state: 'constructor' },
  ]) {
    const v = f.envelope(payment);
    await assert.rejects(() => p.verifyCallback(v.headers, v.raw), error => error instanceof WechatPayError && ['PAYLOAD_INVALID', 'RECEIPT_INVALID'].includes(error.code));
  }
});

test('authenticated queries match locked order/amount/currency and preserve pending/terminal states', async () => {
  for (const [trade_state, state] of [['NOTPAY', 'pending'], ['USERPAYING', 'pending'], ['CLOSED', 'expired'], ['REVOKED', 'failed'], ['PAYERROR', 'failed']]) {
    const p = createWechatPayProvider(f.options, { ...dependencies, fetch: async () => f.response({ ...f.paid, trade_state }) });
    assert.equal((await p.query(f.order)).state, state);
  }
  for (const payment of [{ ...f.paid, out_trade_no: 'another_order' }, { ...f.paid, amount: { total: 9999, currency: 'CNY' } }, { ...f.paid, amount: { total: 10000, currency: 'USD' } }]) {
    const p = createWechatPayProvider(f.options, { ...dependencies, fetch: async () => f.response(payment) });
    await assert.rejects(() => p.query(f.order), rejected('RECEIPT_INVALID'));
  }
  const p = createWechatPayProvider(f.options, { ...dependencies, fetch: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(() => p.create({ ...f.order, merchant_id: '1900000002' }), rejected('ORDER_INVALID'));
  await assert.rejects(() => p.create({ ...f.order, amount_fen: 1.5 }), rejected('ORDER_INVALID'));
  await assert.rejects(() => p.create({ ...f.order, expires_at: new Date(f.now).toISOString() }), rejected('ORDER_INVALID'));
});

test('rejects HTTP errors, unsigned/tampered responses, unsafe checkout, excess bodies and timeouts', async () => {
  const badResponses = [
    () => new Response('provider detail must not leak', { status: 500 }),
    () => new Response('{}', { status: 201 }),
    () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{"code_url":"weixin://wxpay/bizpayurl?pr=altered"}', { headers: f.response({ code_url: 'weixin://wxpay/bizpayurl?pr=original' }).headers }),
    () => f.response({ code_url: 'https://foreign.example/pay' }),
    () => f.response({ code_url: 'weixin://foreign/bizpayurl?pr=1' }),
    () => f.response({ code_url: 'weixin://wxpay/bizpayurl?pr=1#fragment' }),
    () => f.response({ code_url: 'weixin://wxpay/bizpayurl?pr=1' }, { serial: 'UNTRUSTED_1234' }),
    () => new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } }),
  ];
  for (const response of badResponses) {
    const p = createWechatPayProvider(f.options, { ...dependencies, fetch: async () => response() });
    await assert.rejects(() => p.create(f.order), error => error instanceof WechatPayError && !error.message.includes('provider detail'));
  }
  let signal: AbortSignal | undefined;
  const p = createWechatPayProvider({ ...f.options, timeoutMs: 20 }, { ...dependencies, fetch: async (_url, init) => { signal = init?.signal as AbortSignal; return new Promise(() => {}); } });
  await assert.rejects(() => p.create(f.order), rejected('TIMEOUT')); assert.equal(signal?.aborted, true);
  const slowBody = createWechatPayProvider({ ...f.options, timeoutMs: 20 }, { ...dependencies, fetch: async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(() => slowBody.create(f.order), rejected('TIMEOUT'));
});

test('configuration fails closed and supports pinned certificate validity/serial and controlled rotation', async () => {
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  for (const changes of [{ apiV3Key: 'short' }, { merchantId: 'bad' }, { notifyUrl: 'http://example.test/notify' }, { platformKeys: [] }, { merchantPrivateKeyPem: weak }, { timeoutMs: 0 }, { platformKeys: [f.options.platformKeys[0], f.options.platformKeys[0]] }]) {
    assert.throws(() => createWechatPayProvider({ ...f.options, ...changes }, dependencies), rejected('CONFIG_INVALID'));
  }
  const options = { ...f.options, platformKeys: [{ serial: f.platformSerial, certificatePem: f.certificatePem }] };
  const p = createWechatPayProvider(options, dependencies), v = f.envelope();
  assert.equal((await p.verifyCallback(v.headers, v.raw)).state, 'paid');
  assert.throws(() => createWechatPayProvider({ ...options, platformKeys: [{ serial: '0000000000000000', certificatePem: f.certificatePem }] }, dependencies), rejected('CONFIG_INVALID'));
  assert.throws(() => createWechatPayProvider(options, { now: () => Date.parse('2029-01-01T00:00:00Z') }), rejected('CONFIG_INVALID'));
  let time = f.now;
  const expiring = createWechatPayProvider(options, { now: () => time });
  time = Date.parse('2029-01-01T00:00:00Z');
  await assert.rejects(() => expiring.verifyCallback(f.signed(v.raw, { timestamp: Math.floor(time / 1000) }), v.raw), rejected('SIGNATURE_INVALID'));
  const rotated = createWechatPayProvider({ ...options, platformKeys: [...options.platformKeys, { serial: 'PUB_KEY_ID_SYNTHETIC_2', publicKeyPem: f.options.platformKeys[0].publicKeyPem }] }, dependencies);
  assert.equal((await rotated.verifyCallback(f.signed(v.raw, { serial: 'PUB_KEY_ID_SYNTHETIC_2' }), v.raw)).state, 'paid');
});
