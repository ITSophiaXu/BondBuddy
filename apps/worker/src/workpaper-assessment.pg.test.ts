import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createServer} from '@bondbuddy/api';
import type {PrivateBlobs} from '@bondbuddy/api/data';
import type {WorkpaperEntry,WorkpaperDecision} from '@bondbuddy/contracts';
import {isolatedTestDatabase} from './test-database.js';
import {groundWorkpaperDecision,workpaperAssessmentModelSchema} from './workpaper-assessment-stage.js';

const database=await isolatedTestDatabase(undefined,'workpaper-assessment');

test('assessment model schema uses strict required properties and server-resolved citation locations',()=>{
 const schema=workpaperAssessmentModelSchema(4);
 const visit=(node:any)=>{if(!node||typeof node!=='object')return;if(node.properties){assert.deepEqual(new Set(node.required),new Set(Object.keys(node.properties)));assert.equal(node.additionalProperties,false);}for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else visit(value);};
 visit(schema);
 assert.equal('location' in schema.properties.decisions.items.properties.citations.items.properties,false);
 const entry={id:'a',title:'财务分析'} as WorkpaperEntry;
 const decision=groundWorkpaperDecision({item_id:'a',status:'generate',reason:'披露充分',missing_materials:[],citations:[{span_id:'p1',quote:'总资产100万元'}]},entry,[{id:'p1',text:'总资产100万元',location:'第二节段落3',sha256:'a'.repeat(64)}]);
 assert.equal(decision.citations[0].location,'第二节段落3');
});

test('unsupported applicability claims and originals cannot become generated workpapers',()=>{
 const entry={id:'a',title:'财务分析'} as WorkpaperEntry,base:WorkpaperDecision={item_id:'a',status:'not_applicable',reason:'无该业务',missing_materials:[],citations:[]};
 assert.equal(groundWorkpaperDecision(base,entry,[]).status,'missing_information');
 assert.equal(groundWorkpaperDecision({...base,status:'generate',citations:[{span_id:'p0',quote:'伪造'}]},entry,[{id:'p0',text:'发行人信息',location:'第一节',sha256:'a'.repeat(64)}]).status,'missing_information');
 assert.equal(groundWorkpaperDecision({...base,status:'generate'}, {...entry,title:'营业执照原件'},[]).status,'external_evidence');
});

test('new standalone assessments are retired without creating a run; historical reads remain separate',{skip:!database},async()=>{
 const pool=new Pool({connectionString:database}),user=randomUUID();let actor=user;
 const objects=new Map<string,Buffer>();
 const blobs:PrivateBlobs={put:async(k,b)=>{objects.set(k,Buffer.from(b));},get:async k=>Buffer.from(objects.get(k)!),getIfExists:async k=>objects.get(k)??null,
  getIfExistsBounded:async(k,max)=>{const b=objects.get(k);return b&&b.length<=max?b:null;},exists:async k=>objects.has(k),delete:async k=>{objects.delete(k);}};
 const app=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',enableRunRuntime:true,principal:async()=>({userId:actor,csrfVerified:true})});
 const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,payload:payload as any,headers:{origin:'http://bondbuddy.test'}});
 try{
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[user,'assess_'+user.slice(0,8)]);
  const created=await send('POST','/api/v1/projects',{kind:'generation',name:'合成范围判断测试',issuer_name:'合成发行人',market:'sse',offering:'public'});
  assert.equal(created.statusCode,201,created.body);const project=created.json().project_id;
  const body={request_id:randomUUID(),catalogue_id:'synthetic-catalogue',catalogue_sha256:'a'.repeat(64),item_ids:['synthetic-item'],source_version_id:'synthetic-source',source_selection_revision:0,requirements:'合成测试'};
  const path=`/api/v1/projects/${project}/workpapers/assessments`;
  for(let i=0;i<2;i++){const response=await send('POST',path,body);assert.equal(response.statusCode,409,response.body);assert.equal(response.json().code,'BILLING_NOT_READY');}
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_workpaper_assessments WHERE project_id=$1',[project])).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1',[project])).rows[0].n,0);
  actor=randomUUID();assert.equal((await send('POST',path,body)).statusCode,404);
 }finally{await app.close();await pool.end();}
});
