import {Type,type Static} from '@sinclair/typebox';
import {Int64Schema} from './billing-integers.js';
import {SubscriptionPeriodSchema} from './subscriptions.js';

// This new endpoint has one wire format: exact decimal integer strings.
export const SubscriptionOrderPeriodSchema=Type.Object({...SubscriptionPeriodSchema.properties,
  amount_fen:Int64Schema,points:Int64Schema,available_points:Int64Schema,held_points:Int64Schema,
  task_held_points:Int64Schema,refund_held_points:Int64Schema},{additionalProperties:false});
export const subscriptionOrderDetailSchemas={
  SubscriptionOrderPeriodResponse:Type.Object({order_id:SubscriptionPeriodSchema.properties.order_id,
    period:Type.Union([SubscriptionOrderPeriodSchema,Type.Null()])},{additionalProperties:false}),
};
export type SubscriptionOrderPeriod=Static<typeof SubscriptionOrderPeriodSchema>;
export type SubscriptionOrderPeriodDetail=Static<typeof subscriptionOrderDetailSchemas.SubscriptionOrderPeriodResponse>;
export function subscriptionOrderDetailOpenApiPaths(){
  return{'/subscriptions/orders/{order_id}/period':{
    parameters:[{name:'order_id',in:'path',required:true,schema:{type:'string'}}],
    get:{summary:'读取本人原支付订单的订阅周期；仅经核实的充值单返回 null',security:[{sessionCookie:[]}],responses:{
      200:{description:'原订阅周期及精确积分金额，或已确认充值单的 period:null',content:{'application/json':{schema:{$ref:'#/components/schemas/SubscriptionOrderPeriodResponse'}}}},
      404:{description:'订单不存在或不属于本人'},503:{description:'原订单类型或周期数据暂无法可靠核实'},
    }},
  }};
}
