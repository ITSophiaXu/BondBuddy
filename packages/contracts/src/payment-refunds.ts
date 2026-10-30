import {Type,type Static,type TSchema} from '@sinclair/typebox';

const obj=<T extends Record<string,TSchema>>(p:T)=>Type.Object(p,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:128});
const amount=Type.Integer({minimum:0,maximum:Number.MAX_SAFE_INTEGER});
const nullableText=Type.Union([Type.String({maxLength:200}),Type.Null()]);
export const PaymentRefundSchema=obj({
  refund_id:id,order_id:id,currency:Type.Literal('CNY'),amount_fen:Type.Integer({minimum:1,maximum:1078920}),credit_points:Type.Integer({minimum:1,maximum:1150000}),
  state:Type.Union([Type.Literal('requested'),Type.Literal('processing'),Type.Literal('succeeded'),Type.Literal('failed')]),
  created_at:Type.String(),updated_at:Type.String(),completed_at:Type.Union([Type.String(),Type.Null()]),failure_code:nullableText,
});
export type PaymentRefund=Static<typeof PaymentRefundSchema>;
export const paymentRefundSchemas={
  PaymentRefundRequest:Type.Union([
    obj({request_id:id,amount_fen:Type.Integer({minimum:1,maximum:1078920})}),
    obj({request_id:id,points:Type.Integer({minimum:1,maximum:1150000}),expected_amount_fen:Type.Optional(Type.Integer({minimum:1,maximum:1078920}))}),
  ]),
  PaymentRefundResponse:PaymentRefundSchema,
  PaymentRefundEligibilityResponse:obj({order_id:id,currency:Type.Literal('CNY'),order_amount_fen:amount,original_points:amount,
    paid_amount_fen:Type.Union([amount,Type.Null()]),refundable_fen:amount,held_refund_fen:amount,refunded_fen:amount,
    request_unit:Type.Union([Type.Literal('amount_fen'),Type.Literal('points')]),refundable_points:amount,refunded_points:amount,
    enabled:Type.Boolean(),reason:Type.String({maxLength:2000}),refunds:Type.Array(PaymentRefundSchema,{maxItems:100})}),
};
export type PaymentRefundRequest=Static<typeof paymentRefundSchemas.PaymentRefundRequest>;
export type PaymentRefundEligibility=Static<typeof paymentRefundSchemas.PaymentRefundEligibilityResponse>;

export function paymentRefundOpenApiPaths(){
  const ref=(name:string)=>({$ref:`#/components/schemas/${name}`});
  const operation=(summary:string,response:string,body?:string)=>({summary,security:[{sessionCookie:[]}],
    ...(body?{requestBody:{required:true,content:{'application/json':{schema:ref(body)}}}}:{}),
    responses:{[body==='PaymentRefundRequest'?202:200]:{description:'Owner-scoped original-payment refund',content:{'application/json':{schema:ref(response)}}},404:{description:'Unknown or foreign resource'}}});
  return {
    '/api/v1/commerce/topups/{order_id}/refund-eligibility':{get:operation('Read cash evidence and unused balance of this original payment','PaymentRefundEligibilityResponse')},
    '/api/v1/commerce/topups/{order_id}/refunds':{post:operation('Freeze unused original-payment balance and request an idempotent cash refund','PaymentRefundResponse','PaymentRefundRequest')},
    '/api/v1/commerce/refunds/{refund_id}':{get:operation('Read the original refund request','PaymentRefundResponse')},
    '/api/v1/commerce/refunds/{refund_id}/refresh':{post:operation('Reconcile the same refund number without another refund request','PaymentRefundResponse')},
  };
}
