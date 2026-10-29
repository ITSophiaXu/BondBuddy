import {Type,type Static,type TSchema} from '@sinclair/typebox';
import {Int64Schema} from './billing-integers.js';

const obj=<T extends Record<string,TSchema>>(p:T)=>Type.Object(p,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:128});
// Money is transported as decimal integer strings, including zero.
const points=Int64Schema;
const text=Type.String({minLength:1,maxLength:2000});
const items=Type.Array(id,{minItems:1,maxItems:200,uniqueItems:true});
const state=Type.Union(['requested','approved','partially_approved','rejected'].map(v=>Type.Literal(v)));
export const TaskRefundUnitSchema=obj({item_id:id,source_item_key:Type.String({maxLength:500}),label:Type.String({maxLength:500}),
  charged_points:points,refunded_points:points,available_points:points,pending:Type.Boolean(),
  evidence_kind:Type.Union(['automatic_scope','priced_scope','legacy_scope','legacy_task'].map(v=>Type.Literal(v)))});
export const TaskRefundRecordSchema=obj({refund_request_id:id,request_id:id,run_id:id,reason:text,state,created_at:Type.String(),
  decided_at:Type.Union([Type.String(),Type.Null()]),decision_reason:Type.Union([Type.String(),Type.Null()]),requested_points:points,refunded_points:points,
  items:Type.Array(obj({item_id:id,label:Type.String({maxLength:500}),points,approved:Type.Boolean()}),{maxItems:200})});
export const taskRefundSchemas={
  TaskRefundCreateRequest:obj({request_id:id,item_ids:items,reason:text}),
  TaskRefundDecisionRequest:obj({request_id:id,item_ids:Type.Array(id,{maxItems:200,uniqueItems:true}),reason:text}),
  TaskRefundRecordResponse:TaskRefundRecordSchema,
  TaskRefundEligibilityResponse:obj({run_id:id,reservation_id:id,enabled:Type.Boolean(),reason:Type.String({maxLength:2000}),
    charged_points:points,refunded_points:points,units:Type.Array(TaskRefundUnitSchema,{maxItems:200}),requests:Type.Array(TaskRefundRecordSchema,{maxItems:200})}),
  TaskRefundAdminListResponse:obj({items:Type.Array(TaskRefundRecordSchema,{maxItems:100}),next_cursor:Type.Union([id,Type.Null()])}),
  TaskRefundAdminQuery:obj({cursor:Type.Optional(id),state:Type.Optional(state)}),
};
export type TaskRefundCreate=Static<typeof taskRefundSchemas.TaskRefundCreateRequest>;
export type TaskRefundDecision=Static<typeof taskRefundSchemas.TaskRefundDecisionRequest>;
export type TaskRefundRecord=Static<typeof TaskRefundRecordSchema>;
export type TaskRefundEligibility=Static<typeof taskRefundSchemas.TaskRefundEligibilityResponse>;
export type TaskRefundAdminList=Static<typeof taskRefundSchemas.TaskRefundAdminListResponse>;
export function taskRefundOpenApiPaths(){
  const ref=(name:string)=>({$ref:`#/components/schemas/${name}`});
  const operation=(summary:string,response:string,body?:string)=>({summary,security:[{sessionCookie:[]}],
    ...(body?{requestBody:{required:true,content:{'application/json':{schema:ref(body)}}}}:{}),
    responses:{200:{description:'Task quality credit return; no cash payment is initiated',content:{'application/json':{schema:ref(response)}}}}});
  const run=[{name:'run_id',in:'path',required:true,schema:{type:'string'}}],request=[{name:'request_id',in:'path',required:true,schema:{type:'string'}}];
  return{
    '/tasks/{run_id}/refund-eligibility':{parameters:run,get:operation('查看原任务可售后条目和申请进度','TaskRefundEligibilityResponse')},
    '/tasks/{run_id}/refund-requests':{parameters:run,post:operation('申请任务质量退积分','TaskRefundRecordResponse','TaskRefundCreateRequest')},
    '/admin/task-refunds':{get:operation('独立售后权限查看申请列表','TaskRefundAdminListResponse')},
    '/admin/task-refunds/{request_id}':{parameters:request,get:operation('查看任务售后申请','TaskRefundRecordResponse')},
    '/admin/task-refunds/{request_id}/approve':{parameters:request,post:operation('批准全部或部分原条目并返还积分；空条目拒绝申请','TaskRefundRecordResponse','TaskRefundDecisionRequest')},
  };
}
