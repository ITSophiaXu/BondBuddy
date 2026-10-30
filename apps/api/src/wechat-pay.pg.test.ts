import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { creditBalance } from './billing.js';
import { createWechatPayProvider } from './wechat-pay.js';
import { syntheticWechatFixture } from './test-wechat-pay-fixtures.js';

const connection = await isolatedTestDatabase(undefined, 'wechat-native-payments');
test('synthetic WeChat RSA/AES notifications reject locked-order mismatch; duplicates credit the original ledger once', { skip: !connection, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString: connection }), f = syntheticWechatFixture(Date.now()), owner = 'synthetic-wechat-payment-owner';
  const provider = createWechatPayProvider(f.options, { now: () => f.now, fetch: async () => f.response({ code_url: 'weixin://wxpay/bizpayurl?pr=synthetic123' }) });
  const app = createServer({ pool, enablePaidAuthoring: true, enableOutcomePricing: true, paymentProviders: [provider], allowedOrigin: 'http://bondbuddy.test', principal: async () => ({ userId: owner, csrfVerified: true }) });
  const callback = (payment: Record<string, unknown>, forged = false) => {
    const v = f.envelope(payment);
    return app.inject({ method: 'POST', url: '/api/v1/payments/wechat/callback', payload: v.raw,
      headers: { 'content-type': 'application/json', ...v.headers as Record<string, string>, ...(forged ? { 'wechatpay-signature': 'invalid' } : {}) } });
  };
  try {
    await pool.query("INSERT INTO bb_users(id,username) VALUES($1,'synthetic_wechat_payments')", [owner]);
    const created = await app.inject({ method: 'POST', url: '/api/v1/commerce/topups', headers: { origin: 'http://bondbuddy.test' }, payload: { request_id: 'synthetic-wechat-native', provider: 'wechat', amount_fen: '980' } });
    assert.equal(created.statusCode, 201, created.body);
    const order = created.json(); assert.equal(order.amount_fen, '980'); assert.equal(order.points, '980');
    // The provider's native payment notification uses numeric minor units.
    const paid = { ...f.paid, out_trade_no: order.order_id, amount: { total: 980, currency: 'CNY' } };
    assert.equal((await callback(paid, true)).statusCode, 401);
    assert.equal((await callback({ ...paid, amount: { total: 979, currency: 'CNY' } })).statusCode, 422);
    assert.equal((await callback({ ...paid, amount: { total: 980, currency: 'USD' } })).statusCode, 401);
    assert.equal((await callback({ ...paid, mchid: '1900000002' })).statusCode, 401);
    assert.equal((await callback({ ...paid, out_trade_no: 'unrelated_order' })).statusCode, 404);
    assert.deepEqual(await creditBalance(pool, owner), { available: 0, frozen: 0 });
    const repeated = await Promise.all([callback(paid), callback(paid), callback(paid)]);
    repeated.forEach(response => assert.equal(response.statusCode, 200, response.body));
    assert.deepEqual(await creditBalance(pool, owner), { available: Number(order.points), frozen: 0 });
    assert.equal(Number((await pool.query("SELECT count(*) n FROM bb_credit_lots WHERE owner_user_id=$1 AND source='purchase'", [owner])).rows[0].n), 1);
    assert.equal((await pool.query('SELECT state,provider_txn_id FROM bb_recharge_orders WHERE id=$1', [order.order_id])).rows[0].state, 'paid');
    const topup = await app.inject({ method: 'POST', url: '/api/v1/commerce/topups', headers: { origin: 'http://bondbuddy.test' }, payload: { request_id: 'synthetic-wechat-payg', provider: 'wechat', amount_fen: '1990' } });
    assert.equal(topup.statusCode, 201, topup.body);
    const exact = topup.json(); assert.equal(exact.amount_fen, '1990'); assert.equal(exact.points, '1990');
    const exactPaid = { ...f.paid, transaction_id: 'synthetic_payg_transaction_2', out_trade_no: exact.order_id, amount: { total: 1990, currency: 'CNY' } };
    const exactRepeated = await Promise.all([callback(exactPaid), callback(exactPaid)]);
    exactRepeated.forEach(response => assert.equal(response.statusCode, 200, response.body));
    assert.deepEqual(await creditBalance(pool, owner), { available: Number(order.points) + 1990, frozen: 0 });
    assert.equal(Number((await pool.query("SELECT count(*) n FROM bb_credit_lots WHERE owner_user_id=$1 AND source='purchase'", [owner])).rows[0].n), 2);
    assert.equal(Number((await pool.query('SELECT count(*) n FROM bb_runs')).rows[0].n), 0);
  } finally { await app.close(); await pool.end(); }
});
