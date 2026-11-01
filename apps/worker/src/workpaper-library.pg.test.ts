import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createServer} from '@bondbuddy/api';
import {digest,transaction,type PrivateBlobs} from '@bondbuddy/api/data';
import {advanceWorkpaperBatch} from '@bondbuddy/api/workpapers';
import {WORKPAPER_PRICE,type WorkpaperEntry,type WorkpaperLibrary} from '@bondbuddy/contracts';
import {grantCredits} from '../../api/dist/billing.js';
import {makeSyntheticDocxFixture} from '../../api/dist/docx-fixtures.js';
import {catalogueXlsx} from '../../api/dist/workpaper-catalogue.test.js';
import {isolatedTestDatabase} from './test-database.js';
import {inputLockStage,materialsReadyStage,runPipelineOnce,type codexModelStage,type RunStage} from './run-pipeline.js';
import {workpaperAssessmentStage,workpaperAssessmentDelivery} from './workpaper-assessment-stage.js';
import {workpaperChangeStage,workpaperChangeDelivery} from './workpaper-change-stage.js';
import {m4DocumentDeliveryStage} from './m4-document-stage.js';
import {loadCodexAdapterConfig} from './codex-adapter.js';
const database=await isolatedTestDatabase(undefined,'workpaper-library');
test('real API/PG: generation → library/preview/ZIP → changed prospectus → mapped impact, stale check and owner isolation (synthetic model)',{skip:!database,timeout:240000},async()=>{
  const pool=new Pool({connectionString:database}),user=randomUUID();let actor=user;
  const store=new Map<string,Buffer>();const blobs:PrivateBlobs={put:async(k,b)=>{store.set(k,Buffer.from(b));},get:async k=>Buffer.from(store.get(k)!),getIfExists:async k=>store.get(k)??null,
    getIfExistsBounded:async(k,max)=>{const b=store.get(k);if(b&&b.length>max)throw Error('too large');return b??null;},exists:async k=>store.has(k),delete:async k=>{store.delete(k);}};
  const origin='http://workpaper.test',app=createServer({pool,blobs,allowedOrigin:origin,enableRunRuntime:true,principal:async()=>({userId:actor,csrfVerified:true})});
  const send=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url,payload,headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});
  const ok=async(method:string,url:string,payload?:any)=>{const r=await send(method,url,payload);assert.ok(r.statusCode<300,`${r.statusCode} ${r.body}`);return r.json();};
  const upload=async(id:string,name:string,bytes:Buffer,media_type:string,role='other')=>{
    const base='/api/v1/projects/'+id,declaration={byte_size:bytes.length,sha256:digest(bytes)},u=await ok('POST',base+'/materials/uploads',{...declaration,filename:name,media_type,role});
    assert.equal((await send('PUT',u.upload_url,bytes)).statusCode,204);const m=await ok('POST',base+'/materials/uploads/'+u.upload_id+'/complete',declaration);
    return {source_project_id:id,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256};
  };
  const execute=(stages:RunStage[])=>runPipelineOnce({pool,blobs,runKinds:['generation'],leaseSeconds:120,stages:[inputLockStage,materialsReadyStage,...stages],onUnexpectedError:e=>assert.fail(JSON.stringify(e))});
  const text='合成发行人总资产100万元，不涉及境外投资。',document=makeSyntheticDocxFixture({text});
  const model:typeof codexModelStage=options=>({name:options.name,run:async ctx=>{
    const prompt=await options.buildPrompt(ctx),data=JSON.parse(prompt.split('ref=workpaper-assessment\n')[1].split('\nBB-DATA-')[0]);
    return {kind:'done',value:{decisions:data.entries.map((e:WorkpaperEntry,i:number)=>({item_id:e.id,status:i?'not_applicable':'generate',reason:i?'本项目不涉及境外投资。':'总资产披露可形成分析。',missing_materials:[],citations:[{span_id:'p0',quote:text}]}))}};
  }});
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[user,'trace_'+user.slice(0,8)]);
    await transaction(pool,c=>grantCredits(c,{owner:user,source:'purchase',key:randomUUID(),points:10000,expiresAt:null,actor:'synthetic',reason:'isolated test'}));
    const p=await ok('POST','/api/v1/projects',{kind:'generation',name:'合成底稿关联测试',issuer_name:'合成发行人',market:'sse',offering:'public'}),id=p.project_id,base='/api/v1/projects/'+id,wp=base+'/workpapers';
    const docx='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const original=await upload(id,'synthetic-v1.docx',document,docx,'historical');
    let versions=await ok('GET',base+'/prospectus-versions');let source=await ok('POST',base+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:0,version_id:versions.versions[0].version_id});
    const material=await upload(id,'catalogue.xlsx',await catalogueXlsx(2),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const cat=await ok('POST',wp+'/catalogues',{request_id:randomUUID(),material});
    const request={request_id:randomUUID(),catalogue_id:cat.catalogue_id,catalogue_sha256:cat.sha256,item_ids:cat.entries.map((e:any)=>e.id),source_version_id:source.current_version_id,source_selection_revision:source.selection_revision,requirements:''};
    await ok('POST',wp+'/assessments',request);
    assert.equal(await execute([workpaperAssessmentStage({model,config:()=>loadCodexAdapterConfig({})}),workpaperAssessmentDelivery()]),'succeeded');
    const assessment=(await ok('GET',wp)).assessments[0];
    const batch=await ok('POST',wp+'/batches',{...request,request_id:randomUUID(),assessment_id:assessment.assessment_id,assessment_hash:assessment.result_hash,price_version:WORKPAPER_PRICE.version,expected_points:String(WORKPAPER_PRICE.points)});
    await advanceWorkpaperBatch(pool);
    assert.equal(await execute([{name:'model_generation',run:async ctx=>{
      const files:Record<string,{key:string;sha256:string;byte_size:number}>={};
      for(const [name,bytes] of [['document.docx',document],['preparation-note.docx',makeSyntheticDocxFixture({text:'内部记录'})]] as const){
        const sha256=digest(bytes),key=`owners/${user}/projects/${ctx.run.project_id}/runs/${ctx.run.id}/m4-documents/synthetic/${sha256}/${name}`;
        await blobs.put(key,bytes,docx);files[name]={key,sha256,byte_size:bytes.length};
      }
      return {kind:'done',value:{version:'codex-m4-document-v1',input_hash:ctx.run.input_hash.trim(),skill_sha256:'a'.repeat(64),method_hash:'b'.repeat(64),internal_note:true,files,
        project_file_links:{source_sha256:original.sha256,target_sha256:digest(document),warnings:[],links:[{source_span_id:'p0',source_quote:text,target_span_id:'p0',target_quote:text,field:'总资产',period:'2025年末',unit:'万元',source_location:'段落1',target_location:'资产表第1行',source_sha256:original.sha256,target_sha256:digest(document)}]}}};
    }},m4DocumentDeliveryStage()]),'succeeded');await advanceWorkpaperBatch(pool);
    const workspace=await ok('GET',`/api/v1/m4/topics/${batch.topic_id}/workspace`);
    assert.equal(workspace.artifacts.length,1);assert.equal(workspace.artifacts[0].kind,'document');
    const internal=(await pool.query('SELECT kind FROM bb_m4_artifacts WHERE topic_id=$1 ORDER BY kind',[batch.topic_id])).rows;
    assert.deepEqual(internal.map(a=>a.kind),['document','preparation_note'],'settlement retains both verified files while the public workspace exposes only the workpaper');
    let library=await ok('GET',wp+'/library?limit=1') as WorkpaperLibrary;assert.equal(library.total,2);assert.equal(library.items.length,1);assert.equal(library.items[0]!.links_count,1);
    assert.equal((await ok('GET',wp+`/batches/${batch.batch_id}`)).batch_id,batch.batch_id);
    assert.equal((await ok('GET',wp+`/catalogues/${cat.catalogue_id}`)).catalogue_id,cat.catalogue_id);
    assert.ok((await ok('GET',wp+'/library?limit=1&offset=1')).items[0].explanation);
    assert.equal((await send('GET',wp+'/library?limit=101')).statusCode,422);
    assert.equal((await ok('GET',wp+'/library?history=true&search=不存在')).total,0);
    const preview=await ok('GET',wp+`/batches/${batch.batch_id}/items/${cat.entries[0].id}/preview`);assert.match(preview.text,/总资产100万元/);
    assert.equal((await ok('GET',wp+'/library?category=explanation')).total,1);
    let zip=await send('GET',wp+`/batches/${batch.batch_id}/download`);
    for(let polls=0;zip.statusCode===202&&polls<60;polls++){
      assert.equal(zip.json().status,'preparing');
      await delay(100);zip=await send('GET',wp+`/batches/${batch.batch_id}/download`);
    }
    assert.equal(zip.statusCode,200,zip.body);assert.equal(zip.headers['content-type'],'application/zip');
    assert.equal(zip.rawPayload.readUInt16LE(zip.rawPayload.length-12),2);
    const newPin=await upload(id,'synthetic-v2.docx',makeSyntheticDocxFixture({text:text.replace('100','200')}),docx,'historical');
    versions=await ok('GET',base+'/prospectus-versions');const next=versions.versions.find((v:any)=>v.sha256===newPin.sha256||v.material_id===newPin.material_id)??versions.versions[0];
    source=await ok('POST',base+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:source.selection_revision,version_id:next.version_id});
    assert.equal((await ok('GET',wp+'/library?status=stale')).total,2);
    const body={request_id:randomUUID(),source_version_id:source.current_version_id,source_selection_revision:source.selection_revision},check=await ok('POST',wp+`/batches/${batch.batch_id}/checks`,body);
    assert.deepEqual(await ok('POST',wp+`/batches/${batch.batch_id}/checks`,body),check);
    assert.equal(await execute([workpaperChangeStage(),workpaperChangeDelivery()]),'succeeded');
    library=await ok('GET',wp+'/library?status=needs_update');assert.equal(library.total,2);assert.match(library.items[0]!.impact!.changes[0]!.after,/200万元/);assert.deepEqual(library.items[0]!.impact!.changes[0]!.target_locations,['资产表第1行']);
    await assert.rejects(pool.query("UPDATE bb_workpaper_checks SET result='{}' WHERE run_id=$1",[check.run_id]),/immutable/);
    actor=randomUUID();for(const url of [wp+'/library',wp+'/checks',wp+`/batches/${batch.batch_id}`,wp+`/catalogues/${cat.catalogue_id}`,wp+`/batches/${batch.batch_id}/items/${cat.entries[0].id}/preview`])assert.equal((await send('GET',url)).statusCode,404);actor=user;
    await ok('POST',base+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:source.selection_revision,version_id:request.source_version_id});
    assert.equal((await ok('GET',wp+'/library?status=stale')).total,2);
    assert.equal((await send('POST',wp+`/batches/${batch.batch_id}/checks`,{...body,request_id:randomUUID()})).statusCode,409);
  }finally{await app.close();await pool.end();}
});
