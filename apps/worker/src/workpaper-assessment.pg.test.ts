import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import {Pool} from 'pg';
import {createServer} from '@bondbuddy/api';
import {digest,transaction,type PrivateBlobs} from '@bondbuddy/api/data';
import {advanceWorkpaperBatch} from '@bondbuddy/api/workpapers';
import {WORKPAPER_PRICE,type WorkpaperEntry,type WorkpaperDecision} from '@bondbuddy/contracts';
import {grantCredits} from '../../api/dist/billing.js';
import {makeSyntheticDocxFixture} from '../../api/dist/docx-fixtures.js';
import {catalogueXlsx} from '../../api/dist/workpaper-catalogue.test.js';
import {isolatedTestDatabase} from './test-database.js';
import {inputLockStage,materialsReadyStage,runPipelineOnce,type codexModelStage} from './run-pipeline.js';
import {workpaperAssessmentStage,workpaperAssessmentDelivery,groundWorkpaperDecision,workpaperAssessmentModelSchema} from './workpaper-assessment-stage.js';
import {loadCodexAdapterConfig} from './codex-adapter.js';
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
test('assessment and confirmation: mixed/all-excluded packages, evidence and immutable binding',{skip:!database,timeout:180000},async()=>{
 const pool=new Pool({connectionString:database}),user=randomUUID();let actor=user;
 const store=new Map<string,Buffer>();const blobs:PrivateBlobs={put:async(k,b)=>{store.set(k,Buffer.from(b));},get:async k=>Buffer.from(store.get(k)!),getIfExists:async k=>store.get(k)??null,
  getIfExistsBounded:async(k,max)=>{const b=store.get(k);if(b&&b.length>max)throw Error('too large');return b??null;},exists:async k=>store.has(k),delete:async k=>{store.delete(k);}};
 const origin='http://bondbuddy.test',app=createServer({pool,blobs,allowedOrigin:origin,enableRunRuntime:true,principal:async()=>({userId:actor,csrfVerified:true})});
 const send=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url,payload,headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});
 const ok=async(method:string,url:string,payload?:any)=>{const r=await send(method,url,payload);assert.ok(r.statusCode<300,r.statusCode+': '+r.body);return r.json();};
 const upload=async(id:string,name:string,bytes:Buffer,media_type:string,role='other')=>{
  const base='/api/v1/projects/'+id,declaration={byte_size:bytes.length,sha256:digest(bytes)};
  const u=await ok('POST',base+'/materials/uploads',{...declaration,filename:name,media_type,role});assert.equal((await send('PUT',u.upload_url,bytes)).statusCode,204);
  const m=await ok('POST',base+'/materials/uploads/'+u.upload_id+'/complete',declaration);
  return {source_project_id:id,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256};
 };
 let modelCalls=0,allExcluded=false;
 const model:typeof codexModelStage=options=>({name:options.name,run:async ctx=>{
  modelCalls++;const prompt=await options.buildPrompt(ctx),data=JSON.parse(prompt.split('ref=workpaper-assessment\n')[1].split('\nBB-DATA-')[0]);
  assert.match(prompt,/不涉及境外投资/);assert.match(prompt,/不能因为没有搜到/);
  const decisions=data.entries.map((e:WorkpaperEntry,i:number)=>({item_id:e.id,status:allExcluded?'missing_information':(['generate','not_applicable','external_evidence','generate'] as const)[i],
   reason:['募集书包含资产信息，可形成分析草稿。','募集书明确不涉及境外投资。','需要经签章的原始证据。','募集书未提供充分依据。'][i]??'缺少资料',
   missing_materials:allExcluded||i===2?['请补充该项支持材料。']:[],citations:allExcluded||i===2?[]:[{span_id:data.spans[0].id,quote:i===3?'不存在的引文':data.spans[0].text}]}));
  assert.ok(options.validate({decisions}));return {kind:'done',value:{decisions}};
 }});
 const execute=()=>runPipelineOnce({pool,blobs,runKinds:['generation'],leaseSeconds:120,stages:[inputLockStage,materialsReadyStage,workpaperAssessmentStage({model,config:()=>loadCodexAdapterConfig({})}),workpaperAssessmentDelivery()],onUnexpectedError:e=>assert.fail(JSON.stringify(e))});
 try{
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[user,'assess_'+user.slice(0,8)]);
  await transaction(pool,c=>grantCredits(c,{owner:user,source:'purchase',key:randomUUID(),points:10000,expiresAt:null,actor:'synthetic',reason:'assessment isolated test'}));
  const p=await ok('POST','/api/v1/projects',{kind:'generation',name:'合成范围判断测试',issuer_name:'合成发行人',market:'sse',offering:'public'}),id=p.project_id,path='/api/v1/projects/'+id,base=path+'/workpapers';
  const DOCX='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  await upload(id,'synthetic.docx',makeSyntheticDocxFixture({text:'合成募集书：发行人总资产100万元，不涉及境外投资。'}),DOCX,'historical');
  const versions=await ok('GET',path+'/prospectus-versions'),adopted=await ok('POST',path+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:0,version_id:versions.versions[0].version_id});
  const material=await upload(id,'catalogue.xlsx',await catalogueXlsx(4),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),cat=await ok('POST',base+'/catalogues',{request_id:randomUUID(),material});
  const body={request_id:randomUUID(),catalogue_id:cat.catalogue_id,catalogue_sha256:cat.sha256,item_ids:cat.entries.map((e:any)=>e.id),source_version_id:adopted.current_version_id,source_selection_revision:adopted.selection_revision,requirements:'按募集书判断，不造原始证据'};
  const started=await ok('POST',base+'/assessments',body);assert.equal(started.state,'queued');assert.deepEqual(await ok('POST',base+'/assessments',body),started);
  const start={...body,request_id:randomUUID(),assessment_id:started.assessment_id,assessment_hash:'a'.repeat(64),price_version:WORKPAPER_PRICE.version,expected_points:String(WORKPAPER_PRICE.points)};
  assert.equal((await send('POST',base+'/batches',start)).statusCode,409);
  assert.equal((await pool.query('SELECT count(*) n FROM bb_workpaper_batches')).rows[0].n,'0');
  await ok('POST','/api/v1/runs/'+started.assessment_id+'/pause',{reason:'synthetic_pause'});
  const paused=(await ok('GET',base)).assessments[0];
  assert.equal(paused.assessment_id,started.assessment_id);assert.equal(paused.state,'paused');
  assert.deepEqual(paused.pause,{stage:'user_paused',reason:'user_paused',error_code:null});
  actor=randomUUID();assert.equal((await send('POST','/api/v1/runs/'+started.assessment_id+'/resume',{reason:'synthetic_resume'})).statusCode,404);actor=user;
  await ok('POST','/api/v1/runs/'+started.assessment_id+'/resume',{reason:'synthetic_resume'});
  const resumed=(await ok('GET',base)).assessments[0];assert.equal(resumed.assessment_id,started.assessment_id);assert.equal(resumed.state,'queued');assert.equal(resumed.pause,null);
  assert.equal(await execute(),'succeeded');const a=(await ok('GET',base)).assessments[0];
  assert.deepEqual(a.decisions.map((d:any)=>d.status),['generate','not_applicable','external_evidence','missing_information']);
  assert.match(a.decisions[0].citations[0].location,/段落/);assert.equal(modelCalls,1);assert.equal(a.completed_items,4);
  assert.equal(a.pause,null);assert.equal((await pool.query('SELECT count(*) n FROM bb_workpaper_assessments')).rows[0].n,'1');
  assert.equal((await pool.query('SELECT count(*) n FROM bb_credit_reservations')).rows[0].n,'0');
  const confirmed={...start,assessment_hash:a.result_hash};
  assert.equal((await send('POST',base+'/batches',{...confirmed,requirements:'变更要求'})).statusCode,409);
  assert.equal((await send('POST',base+'/batches',{...confirmed,expected_points:'18000'})).statusCode,409);
  actor=randomUUID();assert.equal((await send('POST',base+'/batches',confirmed)).statusCode,404);actor=user;
  const [batch,duplicate]=await Promise.all([ok('POST',base+'/batches',confirmed),ok('POST',base+'/batches',confirmed)]);assert.equal(batch.batch_id,duplicate.batch_id);assert.equal(batch.items.filter((i:any)=>i.explanation).length,3);assert.equal(batch.total_points,'4500');
  assert.equal((await ok('POST',base+'/batches',confirmed)).batch_id,batch.batch_id);
  await assert.rejects(pool.query("UPDATE bb_workpaper_assessments SET result=result||'{\"warnings\":[]}' WHERE run_id=$1",[a.assessment_id]),/immutable/);
  await assert.rejects(pool.query('UPDATE bb_workpaper_batches SET assessment_hash=$2 WHERE id=$1',[batch.batch_id,'b'.repeat(64)]),/immutable/);
  const explanationUrl=base+'/batches/'+batch.batch_id+'/explanations/'+batch.items[3].entry.id,explanation=await send('GET',explanationUrl);
  assert.equal(explanation.statusCode,200);assert.equal(digest(explanation.rawPayload),batch.items[3].explanation.sha256);
  const {readBoundedOfficeParts}=await import('../../api/dist/docx-inspector.js');
  const parts=readBoundedOfficeParts(explanation.rawPayload);
  assert.match(parts.get('word/document.xml')!.toString(),/不足以确认该事项不适用/);
  assert.doesNotMatch(parts.get('word/document.xml')!.toString(),/判断版本|SHA-256|募集书依据|来源：/);
  let zip=await send('GET',base+'/batches/'+batch.batch_id+'/download');
  for(let polls=0;zip.statusCode===202&&polls<60;polls++){
   assert.equal(zip.json().status,'preparing');
   await delay(100);zip=await send('GET',base+'/batches/'+batch.batch_id+'/download');
  }
  assert.equal(zip.statusCode,200,zip.body);assert.equal(zip.headers['content-type'],'application/zip');
  assert.equal(zip.rawPayload.readUInt16LE(zip.rawPayload.length-12),3);
  actor=randomUUID();assert.equal((await send('GET',explanationUrl)).statusCode,404);actor=user;
  await mkdir('test-evidence/workpaper-assessment',{recursive:true});await writeFile('test-evidence/workpaper-assessment/资料不足说明.docx',explanation.rawPayload);
  await ok('POST',base+'/batches/'+batch.batch_id+'/actions',{action:'cancel',expected_revision:batch.revision});
  allExcluded=true;const next=await ok('POST',base+'/assessments',{...body,request_id:randomUUID()});assert.equal(await execute(),'succeeded');
  const assessed=(await ok('GET',base)).assessments.find((x:any)=>x.assessment_id===next.assessment_id);
  const excluded=await ok('POST',base+'/batches',{...confirmed,request_id:randomUUID(),assessment_id:next.assessment_id,assessment_hash:assessed.result_hash,expected_points:'0'});
  assert.equal(excluded.state,'complete');assert.equal(excluded.items.filter((i:any)=>i.explanation).length,4);assert.equal(await advanceWorkpaperBatch(pool),false);
  assert.equal((await pool.query('SELECT count(*) n FROM bb_workpaper_attempts')).rows[0].n,'0');assert.equal((await pool.query('SELECT count(*) n FROM bb_credit_reservations')).rows[0].n,'0');
  await upload(id,'new.docx',makeSyntheticDocxFixture({text:'新的募集说明书'}),DOCX,'historical');
  const current=await ok('GET',path+'/prospectus-versions');
  await ok('POST',path+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:adopted.selection_revision,version_id:current.versions.find((v:any)=>v.version_id!==adopted.current_version_id).version_id});
  assert.equal((await send('POST',base+'/batches',{...confirmed,request_id:randomUUID()})).json().code,'PROJECT_FILE_BATCH_INPUT_EXPIRED');
  assert.equal((await ok('POST',base+'/batches',confirmed)).batch_id,batch.batch_id);
 }finally{await app.close();await pool.end();}
});
