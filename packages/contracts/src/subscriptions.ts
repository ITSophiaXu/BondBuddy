import {Type,type Static,type TSchema} from '@sinclair/typebox';
import {billingSchemas} from './billing.js';
import {AUTOMATIC_PRICE_VERSION} from './automatic-pricing.js';

export const SUBSCRIPTION_CATALOG_VERSION='bb-subscriptions-20261030-v2';
export const SUBSCRIPTION_TASK_PRICE_VERSION=AUTOMATIC_PRICE_VERSION;
export const SUBSCRIPTION_PLANS=[
  {id:'light',label:'轻量',amount_fen:19900,annual_amount_fen:214920,points:21000,period_months:1,credit_valid_days:90},
  {id:'professional',label:'专业',amount_fen:49900,annual_amount_fen:538920,points:55000,period_months:1,credit_valid_days:90},
  {id:'intensive',label:'密集',amount_fen:99900,annual_amount_fen:1078920,points:114000,period_months:1,credit_valid_days:90},
] as const;
export type SubscriptionPlan=typeof SUBSCRIPTION_PLANS[number];
const obj=<T extends Record<string,TSchema>>(p:T)=>Type.Object(p,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:128});
const amount=Type.Integer({minimum:0,maximum:Number.MAX_SAFE_INTEGER});
const nullableDate=Type.Union([Type.String(),Type.Null()]);
const provider=Type.Union([Type.Literal('wechat'),Type.Literal('alipay')]);
const planId=Type.Union(SUBSCRIPTION_PLANS.map(p=>Type.Literal(p.id)));
export const BillingCycleSchema=Type.Union([Type.Literal('monthly'),Type.Literal('annual')]);
export type BillingCycle=Static<typeof BillingCycleSchema>;
export const SubscriptionSchema=obj({id,plan_id:planId,
  status:Type.Union(['pending','active','cancelled','expired','past_due'].map(x=>Type.Literal(x))),
  auto_renew:Type.Boolean(),mandate_status:Type.Union(['none','pending','active','cancel_pending','cancelled'].map(x=>Type.Literal(x))),
  current_period_start:nullableDate,current_period_end:nullableDate,task_price_version:id,
  billing_cycle:Type.Optional(BillingCycleSchema),next_charge_at:Type.Optional(nullableDate),next_charge_amount_fen:Type.Optional(Type.Union([amount,Type.Null()]))});
export const SubscriptionPeriodSchema=obj({id,order_id:id,plan_id:planId,
  status:Type.Union(['pending','active','refunded','failed'].map(x=>Type.Literal(x))),amount_fen:amount,points:amount,
  available_points:amount,held_points:amount,task_held_points:amount,refund_held_points:amount,starts_at:nullableDate,ends_at:nullableDate,credits_expires_at:nullableDate,refundable_until:nullableDate,
  billing_cycle:Type.Optional(BillingCycleSchema),monthly_points:Type.Optional(amount),release_count:Type.Optional(Type.Integer({minimum:1,maximum:12})),
  released_count:Type.Optional(Type.Integer({minimum:0,maximum:12})),next_release_at:Type.Optional(nullableDate)});
export const subscriptionSchemas={
  SubscriptionCatalogResponse:obj({enabled:Type.Boolean(),version:id,
    plans:Type.Array(obj({id:planId,label:Type.String(),amount_fen:amount,annual_amount_fen:Type.Optional(amount),points:amount,period_months:Type.Literal(1),credit_valid_days:Type.Literal(90)})),
    providers:Type.Array(provider),auto_renew_available:Type.Boolean()}),
  SubscriptionAccountResponse:obj({subscription:Type.Union([SubscriptionSchema,Type.Null()]),available_points:amount,held_points:amount,task_held_points:amount,refund_held_points:amount,
    subscription_available_points:amount,topup_available_points:amount,other_available_points:amount,periods:Type.Array(SubscriptionPeriodSchema)}),
  SubscriptionCheckoutRequest:obj({request_id:id,plan_id:planId,provider,billing_cycle:Type.Optional(BillingCycleSchema)}),
  SubscriptionCheckoutResponse:obj({subscription:SubscriptionSchema,order:billingSchemas.RechargeOrderResponse}),
  SubscriptionResponse:SubscriptionSchema,
  SubscriptionCancelRequest:obj({request_id:id}),
  SubscriptionAutoRenewRequest:obj({request_id:id,enabled:Type.Boolean()}),
  SubscriptionAutoRenewResponse:obj({subscription:SubscriptionSchema,authorization_url:Type.Union([Type.String(),Type.Null()])}),
};
export type Subscription=Static<typeof SubscriptionSchema>;
export type SubscriptionPeriod=Static<typeof SubscriptionPeriodSchema>;
export type SubscriptionCatalog=Static<typeof subscriptionSchemas.SubscriptionCatalogResponse>;
export type SubscriptionAccount=Static<typeof subscriptionSchemas.SubscriptionAccountResponse>;
export type SubscriptionCheckoutRequest=Static<typeof subscriptionSchemas.SubscriptionCheckoutRequest>;
export type SubscriptionCheckout=Static<typeof subscriptionSchemas.SubscriptionCheckoutResponse>;
export type SubscriptionAutoRenewRequest=Static<typeof subscriptionSchemas.SubscriptionAutoRenewRequest>;
export type SubscriptionAutoRenew=Static<typeof subscriptionSchemas.SubscriptionAutoRenewResponse>;
