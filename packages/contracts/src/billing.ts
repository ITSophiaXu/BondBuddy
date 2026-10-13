import { Type, type Static } from '@sinclair/typebox';
import { AuthoringProgressSchema } from './authoring-progress.js';

export const AUTHORING_BILLING_TASKS = {
  interim: '一期更新', annual: '年度更新', two_years: '两年补更', three_years: '三年补更',
  migration: '模板／市场迁移', migration_two_years: '迁移＋补两年',
  migration_three_years: '迁移＋补三年', new_authoring: '新项目编制'
} as const;
export const REVIEW_BILLING_TASKS = { full_review: '完整三维复核', differential_review: '差异复核', review_revision: '根据复核结果修订' } as const;
// New review executions share the existing capped dynamic policy. Revision fees stay unchanged.
export const DYNAMIC_REVIEW_BILLING_TASKS = { full_review: REVIEW_BILLING_TASKS.full_review, differential_review: REVIEW_BILLING_TASKS.differential_review } as const;
export const BILLING_TASKS = {...AUTHORING_BILLING_TASKS, ...REVIEW_BILLING_TASKS} as const;
export type BillingTask = keyof typeof BILLING_TASKS;
export const INITIAL_FIXED_PRICES: Record<keyof typeof AUTHORING_BILLING_TASKS, number> = {
  interim: 17900, annual: 27900, two_years: 48900, three_years: 68900,
  migration: 64900, migration_two_years: 85900, migration_three_years: 105900, new_authoring: 159900
};
export const RECHARGE_PACKS = [
  { id: 'cny200', amount_fen: 20000, points: 20000 },
  { id: 'cny500', amount_fen: 50000, points: 52500 },
  { id: 'cny2000', amount_fen: 200000, points: 220000 },
  { id: 'cny10000', amount_fen: 1000000, points: 1150000 }
] as const;
export const RECHARGE_PACK_VERSION = 'recharge-20261006-v2';
const obj = <T extends Record<string, any>>(fields: T) => Type.Object(fields, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 128 });
const points = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const utc = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' });
const nullable = <T extends ReturnType<typeof Type.String>>(schema: T) => Type.Union([schema, Type.Null()]);
export const CreditBalanceSchema = obj({ available: points, frozen: points });
export const FixedQuoteSchema = obj({
  quote_id: id, project_id: id, input_revision: Type.Integer({ minimum: 1 }),
  input_hash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  task_type: Type.Union(Object.keys(BILLING_TASKS).map(k => Type.Literal(k as BillingTask))),
  points: Type.Integer({ minimum: 1, maximum: 1000000000 }), price_version: id,
  reason: Type.String({ maxLength: 1000 }), created_at: utc
});
export const billingSchemas = {
  CreditBalanceResponse: obj({ enabled: Type.Boolean(), ...CreditBalanceSchema.properties }),
  FixedQuoteRequest: obj({ input_revision: Type.Integer({ minimum: 1 }), input_hash: Type.String({ pattern: '^[a-f0-9]{64}$' }) }),
  FixedQuoteResponse: obj({ enabled: Type.Boolean(), quote: Type.Union([FixedQuoteSchema, Type.Null()]),
    balance: CreditBalanceSchema, shortage: points, reason: nullable(Type.String({ maxLength: 1000 })) }),
  RunCreditChargeResponse: obj({ progress: Type.Optional(AuthoringProgressSchema), quote: Type.Union([FixedQuoteSchema, Type.Null()]),
    state: Type.Union([Type.Literal('held'),Type.Literal('settled'),Type.Literal('released'),Type.Null()]) }),
  RechargeOrderRequest: obj({ request_id: id, pack_id: Type.Union(RECHARGE_PACKS.map(p => Type.Literal(p.id))),
    provider: Type.Union([Type.Literal('wechat'), Type.Literal('alipay')]), project_id: Type.Optional(id) }),
  RechargeOrderResponse: obj({ order_id: id, provider: Type.Union([Type.Literal('wechat'), Type.Literal('alipay')]),
    state: Type.Union((['pending', 'paid', 'expired', 'failed'] as const).map(s => Type.Literal(s))),
    amount_fen: points, points, currency: Type.Literal('CNY'),
    checkout_url: nullable(Type.String({ maxLength: 4096 })), project_id: nullable(id),
    expires_at: utc, credited_at: nullable(utc) }),
  RechargeConfigResponse: obj({ enabled: Type.Boolean(),
    providers: Type.Array(Type.Union([Type.Literal('wechat'), Type.Literal('alipay')])),
    packs: Type.Array(obj({ id, amount_fen: points, points })), pack_version: id })
};
export type FixedQuote = Static<typeof FixedQuoteSchema>;
export type CreditBalance = Static<typeof CreditBalanceSchema>;

// Account history is read-only. Amounts are ledger points or CNY fen, never model cost.
const historyPage = obj({ next_cursor: nullable(Type.String({ maxLength: 1024 })), has_more: Type.Boolean() });
export const creditHistorySchemas = {
  CreditHistoryQuery: obj({ cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })), limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-4][0-9]|50)$', default: '20' })) }),
  CreditConsumptionHistoryResponse: obj({ items: Type.Array(obj({
    reservation_id: id, run_id: id, project_id: nullable(id), project_name: Type.String({ maxLength: 200 }),
    task_name: Type.String({ maxLength: 200 }), created_at: utc, finalized_at: nullable(utc),
    state: Type.Union(['held','settled','released'].map(s=>Type.Literal(s))),
    billing_policy: Type.Optional(Type.Union([Type.Literal('on_delivery'),Type.Literal('authoring_progress_v1'),Type.Literal('authoring_balance_v2')])),
    reserved_points: points, charged_points: points, released_points: points, corrected_points: points,
  })), page: historyPage }),
  RechargeHistoryResponse: obj({ items: Type.Array(obj({
    order_id: id, provider: Type.Union([Type.Literal('wechat'),Type.Literal('alipay')]),
    state: Type.Union(['pending','paid','expired','failed'].map(s=>Type.Literal(s))),
    amount_fen: points, points, created_at: utc, credited_at: nullable(utc),
  })), page: historyPage }),
};
