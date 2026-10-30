import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type {Pool} from 'pg';
import {Type} from '@sinclair/typebox';
import {BILLING_WIRE_HEADER,BILLING_WIRE_VERSION,LEGACY_BILLING_WIRE_VERSION,openApiDocument} from '@bondbuddy/contracts';
import {installBillingWire} from './billing-wire.js';
import {Problem} from './data.js';

function fixture(){
 const app=Fastify(),seen:any[]=[];let persisted=false,owner='synthetic-owner';
 const db={query:async(sql:string,args:unknown[])=>{seen.push({sql,args});return{rows:persisted?[{}]:[],rowCount:persisted?1:0};}} as unknown as Pool;
 installBillingWire(app,{db:()=>db,owner:async()=>owner});
 app.setErrorHandler((error:any,_r,reply)=>reply.code(error.status??error.statusCode??500).send({code:error.code??'ERROR'}));
 app.get('/api/v1/credits/balance',{schema:{response:{200:Type.Object({available:Type.Integer(),frozen:Type.Integer()})}}},async()=>({available:9007199254740993n,frozen:2n}));
 app.get('/api/v1/commerce/account',{schema:{response:{200:Type.Object({available_fen:Type.Integer(),held_fen:Type.Integer()},{additionalProperties:false})}}},async()=>({available_fen:2,held_fen:0,internal_private:'must-not-leak'}));
 app.post('/api/v1/projects/:project_id/qa/runs',{schema:{body:Type.Object({request_id:Type.String(),expected_points:Type.Integer({minimum:0})},{additionalProperties:false})}},async r=>{
  const b=r.body as {request_id:string;expected_points:number};assert.equal(typeof b.expected_points,'number');
  if(persisted&&b.expected_points!==2)throw new Problem(409,'IDEMPOTENCY_CONFLICT','Original amount changed');
  seen.push({domain:{...b}});persisted=true;return{run_id:'original-run'};
 });
 app.post('/api/v1/payments/synthetic/callback',async r=>r.body);
 return{app,seen,setPersisted:(value:boolean)=>{persisted=value;},setOwner:(value:string)=>{owner=value;}};
}
test('default HTTP balance preserves MAX_SAFE+1 and zero/holds as strings through the response schema',async()=>{
 const {app}=fixture();try{
  const response=await app.inject({url:'/api/v1/credits/balance'});assert.equal(response.statusCode,200);assert.equal(response.headers[BILLING_WIRE_HEADER],BILLING_WIRE_VERSION);
  assert.deepEqual(response.json(),{available:'9007199254740993',frozen:'2'});
  const legacy=await app.inject({url:'/api/v1/credits/balance',headers:{[BILLING_WIRE_HEADER]:LEGACY_BILLING_WIRE_VERSION}});assert.equal(legacy.statusCode,503);
 }finally{await app.close();}
});
test('raw JSON number/fraction/negative/overflow are rejected before AJV coercion or financial handler',async()=>{
 const {app,seen}=fixture();try{
  for(const expected_points of [2,0,1.5,-1,'-1','01','1.5','9223372036854775808']){
   const result=await app.inject({method:'POST',url:'/api/v1/projects/p1/qa/runs',payload:{request_id:'same',expected_points}});
   assert.equal(result.statusCode,422,String(expected_points));
  }
  assert.equal(seen.length,0);
  const accepted=await app.inject({method:'POST',url:'/api/v1/projects/p1/qa/runs',payload:{request_id:'same',expected_points:'2'}});
  assert.equal(accepted.statusCode,200);assert.deepEqual(seen.at(-1),{domain:{request_id:'same',expected_points:2}});
 }finally{await app.close();}
});
test('numeric-v1 only replays persisted owner/resource/request and original handler still rejects changed amount',async()=>{
 const {app,seen,setPersisted}=fixture();const headers={[BILLING_WIRE_HEADER]:LEGACY_BILLING_WIRE_VERSION};try{
  const initial=await app.inject({method:'POST',url:'/api/v1/projects/p1/qa/runs',headers,payload:{request_id:'original',expected_points:2}});
  assert.equal(initial.statusCode,409);assert.equal(initial.json().code,'BILLING_PROTOCOL_REPLAY_ONLY');assert.equal(seen.some(x=>x.domain),false);
  setPersisted(true);const replay=await app.inject({method:'POST',url:'/api/v1/projects/p1/qa/runs',headers,payload:{request_id:'original',expected_points:2}});
  assert.equal(replay.statusCode,200);assert.deepEqual(seen.find(x=>x.sql)?.args,['synthetic-owner','qa-answer:original','p1']);
  const altered=await app.inject({method:'POST',url:'/api/v1/projects/p1/qa/runs',headers,payload:{request_id:'original',expected_points:3}});
  assert.equal(altered.statusCode,409);assert.equal(altered.json().code,'IDEMPOTENCY_CONFLICT');
 }finally{await app.close();}
});
test('legacy responses preserve the original response schema field filtering',async()=>{
 const {app}=fixture();try{const result=await app.inject({url:'/api/v1/commerce/account',headers:{[BILLING_WIRE_HEADER]:LEGACY_BILLING_WIRE_VERSION}});assert.equal(result.statusCode,200);assert.deepEqual(result.json(),{available_fen:2,held_fen:0});}finally{await app.close();}
});
test('callback bodies are excluded from billing transforms and unauthenticated replay does not open the DB',async()=>{
 const {app}=fixture();try{const raw={amount_fen:22,points:'not-a-billing-field',signed:'unaltered'};const result=await app.inject({method:'POST',url:'/api/v1/payments/synthetic/callback',payload:raw});assert.deepEqual(result.json(),raw);}finally{await app.close();}
 const unauth=Fastify();let touched=false;installBillingWire(unauth,{db:()=>{touched=true;throw Error('DB unavailable');},owner:async()=>{throw new Problem(401,'UNAUTHENTICATED','Sign in');}});
 unauth.setErrorHandler((error:any,_r,reply)=>reply.code(error.status??500).send({code:error.code}));
 unauth.post('/api/v1/projects/:project_id/qa/runs',async()=>({run_id:'never'}));
 try{const response=await unauth.inject({method:'POST',url:'/api/v1/projects/p1/qa/runs',headers:{[BILLING_WIRE_HEADER]:LEGACY_BILLING_WIRE_VERSION},payload:{request_id:'old',expected_points:1}});assert.equal(response.statusCode,401);assert.equal(touched,false);}finally{await unauth.close();}
});
test('OpenAPI distinguishes modern wire components from original domain schemas',()=>{
 const document=openApiDocument() as any,operation=document.paths['/api/v1/credits/balance'].get,ref=operation.responses['200'].content['application/json'].schema.$ref;
 assert.match(ref,/BillingInt64_/);const schema=document.components.schemas[ref.split('/').at(-1)];assert.equal(schema.properties.available.type,'string');
 assert.equal(document.components.schemas.CreditBalanceResponse.properties.available.type,'integer');
 assert.equal(operation.parameters.find((p:any)=>p.name===BILLING_WIRE_HEADER).schema.default,BILLING_WIRE_VERSION);
});
