import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
import {Value} from '@sinclair/typebox/value';
import {BILLING_WIRE_HEADER,BILLING_WIRE_VERSION,LEGACY_BILLING_WIRE_VERSION,BILLING_WIRE_DTOS,Int64Schema,billingDtoSchema,billingWireRoute,
 decodeLegacyBillingRequest,encodeBillingDto,transformBillingDto,validateBillingDto,safeBillingNumber,type BillingReplayKind} from '@bondbuddy/contracts';
import {executionKeyStorage,missing,Problem,project,transaction} from './data.js';
import {lockCreditAccountForControl} from './billing.js';
import {inputManifestHash} from './production-rule-pin.js';
import {readBillingRequestRejection,recordBillingRequestRejection,billingRequestRejectedProblem,refundRequestHash} from './billing-request-rejections.js';

const invalid=()=>new Problem(422,'VALIDATION_FAILED','积分、金额和累计数量必须使用 int64 十进制整数字符串。');
export function billingWireVersion(r:Pick<FastifyRequest,'headers'>){
 const v=r.headers[BILLING_WIRE_HEADER];
 if(v===undefined||v===BILLING_WIRE_VERSION)return BILLING_WIRE_VERSION;
 if(v===LEGACY_BILLING_WIRE_VERSION)return LEGACY_BILLING_WIRE_VERSION;
 throw invalid();
}

/** A legacy transport may replay only an already persisted owner/resource/request tuple.
 * The original handler still verifies the full immutable request hash before returning it. */
export async function legacyBillingReplayExists(db:Pool,owner:string,kind:BillingReplayKind,r:Pick<FastifyRequest,'params'|'body'>):Promise<boolean>{
 const b=r.body as Record<string,unknown>|undefined,p=(r.params??{}) as Record<string,string>;
 if(!b)return false;
 const key=b.request_id??b.execution_request_id??b.submission_request_id;
 if(typeof key!=='string'||!key||key.length>128)return false;
 let sql='',values:unknown[]=[];
 const run=(requestKey:string,resource=p.project_id??b.project_id)=>{
  sql='SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2 AND project_id=$3';values=[owner,requestKey,resource];
 };
 switch(kind){
  case 'run':run(executionKeyStorage(key));break;
  case 'qa':run('qa-answer:'+key);break;
  case 'integrity':run('integrity:'+key);break;
  case 'fileCheck':run('file-check:'+key);break;
  case 'm4Run':sql=`SELECT 1 FROM bb_runs r JOIN bb_m4_executions e ON e.run_id=r.id AND e.owner_user_id=r.owner_user_id
    WHERE r.owner_user_id=$1 AND r.execution_request_id=$2 AND e.topic_id=$3`;values=[owner,executionKeyStorage(key),p.topic_id];break;
  case 'm4Message':sql='SELECT 1 FROM bb_m4_messages WHERE owner_user_id=$1 AND submission_request_id=$2 AND topic_id=$3';values=[owner,key,p.topic_id];break;
  case 'topup':sql=`SELECT 1 FROM bb_recharge_orders WHERE owner_user_id=$1 AND request_id=$2 AND order_kind='recharge'`;values=[owner,key];break;
  case 'subscription':sql=`SELECT 1 FROM bb_recharge_orders o JOIN bb_subscription_periods p ON p.order_id=o.id AND p.owner_user_id=o.owner_user_id
    WHERE o.owner_user_id=$1 AND o.request_id=$2 AND o.order_kind='subscription' AND ($3::text IS NULL OR p.subscription_id=$3)
    UNION ALL SELECT 1 FROM bb_subscription_checkout_rejections WHERE owner_user_id=$1 AND request_id=$2`;
    // A durable rejection is an existing request too. It may reach only the
    // original handler, whose immutable hash also binds plan, cycle and endpoint.
    // No new legacy checkout is admitted by this owner/key-only lookup.
    values=[owner,key,p.subscription_id??null];break;
  case 'refund':sql='SELECT 1 FROM bb_payment_refunds WHERE owner_user_id=$1 AND request_id=$2 AND order_id=$3';values=[owner,key,p.order_id];break;
  case 'fileBatch':sql='SELECT 1 FROM bb_project_file_batches WHERE owner_user_id=$1 AND request_id=$2 AND project_id=$3';values=[owner,key,p.project_id];break;
  case 'fileGeneration':sql='SELECT 1 FROM bb_file_generation_batches WHERE owner_user_id=$1 AND request_id=$2 AND project_id=$3';values=[owner,key,p.project_id];break;
  case 'fileUpdate':sql='SELECT 1 FROM bb_project_file_update_batches WHERE owner_user_id=$1 AND request_id=$2 AND project_id=$3 AND check_run_id=$4';values=[owner,key,p.project_id,p.run_id];break;
  case 'workpaper':sql='SELECT 1 FROM bb_workpaper_batches WHERE owner_user_id=$1 AND request_id=$2 AND project_id=$3';values=[owner,key,p.project_id];break;
  case 'workpaperCheck':sql='SELECT 1 FROM bb_workpaper_paid_check_batches WHERE owner_user_id=$1 AND request_id=$2 AND project_id=$3';values=[owner,key,p.project_id];break;
  case 'workpaperResume':sql=`SELECT 1 FROM bb_workpaper_billing_resumes r JOIN bb_workpaper_batches b ON b.id=r.batch_id AND b.owner_user_id=r.owner_user_id
    WHERE r.owner_user_id=$1 AND r.request_id=$2 AND r.batch_id=$3 AND b.project_id=$4`;values=[owner,key,p.batch_id,p.project_id];break;
 }
 return !!(await db.query(sql,values)).rowCount;
}

const prepend=(existing:any,hook:any)=>[hook,...(Array.isArray(existing)?existing:existing?[existing]:[])];

/** Only these endpoints have a durable rejection protocol. A plain missing
 * receipt from the generic legacy lookup is never a financial confirmation. */
async function rejectUnacceptedLegacyRequest(db:Pool,owner:string,kind:'integrity'|'refund',r:Pick<FastifyRequest,'params'|'body'>,schema:any){
 const body=r.body as any,p=r.params as Record<string,string>;
 if(!schema||!Value.Check(schema,body))throw invalid();
 return transaction(db,async c=>{
  let resourceId:string,hash:string;
  if(kind==='integrity'){
   resourceId=p.project_id;await project(c,owner,resourceId,true);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[owner+':integrity:'+body.request_id]);
   if((await c.query('SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[owner,'integrity:'+body.request_id])).rowCount)return undefined;
   hash=inputManifestHash({id:resourceId,...body});
  }else{
   resourceId=p.order_id;
   if(!(await c.query('SELECT 1 FROM bb_recharge_orders WHERE owner_user_id=$1 AND id=$2',[owner,resourceId])).rowCount)throw missing();
   await lockCreditAccountForControl(c,owner);
   if(!(await c.query('SELECT 1 FROM bb_recharge_orders WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[owner,resourceId])).rowCount)throw missing();
   if((await c.query('SELECT 1 FROM bb_payment_refunds WHERE owner_user_id=$1 AND request_id=$2',[owner,body.request_id])).rowCount)return undefined;
   hash=refundRequestHash(resourceId,body);
  }
  const key={owner,kind,requestId:body.request_id,resourceId,hash};
  return await readBillingRequestRejection(c,key)??await recordBillingRequestRejection(c,key,{reason_code:'BILLING_PROTOCOL_REPLAY_ONLY',message:'旧计费协议的原请求尚未受理，已停止后续提交。'});
 });
}
/** Install before registering routes. Signed payment callbacks do not match the explicit registry. */
export function installBillingWire(app:FastifyInstance,{db,owner}:{db:()=>Pool;owner:(r:FastifyRequest)=>Promise<string>}){
 app.addHook('onRoute',route=>{
  const method=Array.isArray(route.method)?route.method[0]:route.method,descriptor=billingWireRoute(method,route.url);
  if(!descriptor)return;
  const {request:input,response:output,replay}=descriptor;
  const originalBodySchema=route.schema?.body;
  const originalResponseSchemas=(route.schema?.response??{}) as Record<string,unknown>;
  if(input&&route.schema?.body)route.schema={...route.schema,body:billingDtoSchema(route.schema.body,input,Int64Schema)};
  if(output&&route.schema?.response)route.schema={...route.schema,response:Object.fromEntries(Object.entries(route.schema.response).map(([status,schema])=>
    [status,/^2/.test(status)?billingDtoSchema(schema,output,Int64Schema):schema]))};
  route.preValidation=prepend(route.preValidation,async(r:FastifyRequest)=>{
   const version=billingWireVersion(r);
   if(version===LEGACY_BILLING_WIRE_VERSION&&replay){
    // Non-billing pause/cancel workpaper actions have no amount and are unaffected.
    const row=r.body as any,requiresReplay=replay!=='workpaperResume'||row?.billing_resume===true;
    if(requiresReplay){
     const user=await owner(r);
     if(replay==='integrity'||replay==='refund'){
      const rejected=await rejectUnacceptedLegacyRequest(db(),user,replay,r,originalBodySchema);
      if(rejected)throw billingRequestRejectedProblem(rejected);
     }else if(!await legacyBillingReplayExists(db(),user,replay,r))throw new Problem(409,'BILLING_PROTOCOL_REPLAY_ONLY','旧计费协议仅可查询或重放已有请求，请刷新页面后发起新任务。');
    }
   }
   if(input&&r.body!==undefined){
    try{
     if(version===LEGACY_BILLING_WIRE_VERSION)r.body=encodeBillingDto(input,transformBillingDto(r.body,BILLING_WIRE_DTOS[input],safeBillingNumber));
     else validateBillingDto(input,r.body);
    }catch{throw invalid();}
   }
  }) as any;
  if(input)route.preHandler=prepend(route.preHandler,async(r:FastifyRequest)=>{
   if(r.body!==undefined)try{r.body=decodeLegacyBillingRequest(input,r.body);}catch{throw invalid();}
  }) as any;
  if(output)route.preSerialization=prepend(route.preSerialization,async(r:FastifyRequest,reply:any,payload:unknown)=>{
   if(reply.statusCode<200||reply.statusCode>=300)return payload;
   try{
    const encoded=encodeBillingDto(output,payload);
    reply.header(BILLING_WIRE_HEADER,BILLING_WIRE_VERSION);
    if(billingWireVersion(r)===LEGACY_BILLING_WIRE_VERSION){
     // Deliberately checked narrowing. Large accounts require the current protocol.
     const numeric=transformBillingDto(encoded,BILLING_WIRE_DTOS[output],safeBillingNumber);
     const schema=originalResponseSchemas[reply.statusCode]??originalResponseSchemas['2xx']??originalResponseSchemas.default;
     reply.header(BILLING_WIRE_HEADER,LEGACY_BILLING_WIRE_VERSION);
     if(schema)reply.serializer(reply.compileSerializationSchema(schema));
     return numeric;
    }
    return encoded;
   }catch{throw new Problem(503,'DATA_UNAVAILABLE','账本数值无法按请求的计费协议精确表示，请刷新后重试。');}
  }) as any;
 });
}
