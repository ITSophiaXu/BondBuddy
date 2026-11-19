// Synthetic source/model content; actual uploads, Word extraction, per-file
// reservations, delivery gates, version registration and Word patching.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Pool} from 'pg';
import {ZipFile} from 'yazl';
import {createServer} from '@bondbuddy/api';
import {digest,transaction,type PrivateBlobs} from '@bondbuddy/api/data';
import {advanceWorkpaperBatch} from '@bondbuddy/api/workpapers';
import {advanceProjectFileUpdates} from '@bondbuddy/api/project-file-consistency';
import {WORKPAPER_PRICE,AUTOMATIC_TASK_TARIFF,type WorkpaperEntry} from '@bondbuddy/contracts';
import {grantCredits,creditBalance} from '../../api/dist/billing.js';
import {makeSyntheticDocxFixture} from '../../api/dist/docx-fixtures.js';
import {readBoundedOfficeParts} from '../../api/dist/docx-inspector.js';
import {catalogueXlsx} from '../../api/dist/workpaper-catalogue.test.js';
import {isolatedTestDatabase} from './test-database.js';
import {inputLockStage,materialsReadyStage,runPipelineOnce,type codexModelStage,type RunStage} from './run-pipeline.js';
import {workpaperAssessmentStage,workpaperAssessmentDelivery} from './workpaper-assessment-stage.js';
import {m4DocumentDeliveryStage} from './m4-document-stage.js';
import {projectFileModelStage,projectFileDeliveryStage} from './project-file-stage.js';
import {loadCodexAdapterConfig} from './codex-adapter.js';
import{repairDeliveredWorkpaperLayout}from'./workpaper-layout-revision.js';
const database=await isolatedTestDatabase(undefined,'workpaper-layout-revision');
async function withHeader(bytes:Buffer,image=false){
  const parts=new Map(readBoundedOfficeParts(bytes)),zip=new ZipFile(),chunks:Buffer[]=[];
  parts.set('word/header1.xml',Buffer.from('<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Synthetic workpaper header</w:t></w:r></w:p></w:hdr>'));
  parts.set('word/document.xml',Buffer.from(parts.get('word/document.xml')!.toString().replace('<w:sectPr/>','<w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:p><w:r><w:t>现金</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>123.45</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:headerReference w:type="default" r:id="syntheticHeader"/></w:sectPr>')));
  parts.set('word/_rels/document.xml.rels',Buffer.from(parts.get('word/_rels/document.xml.rels')!.toString().replace('</Relationships>','<Relationship Id="syntheticHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>')));
  parts.set('[Content_Types].xml',Buffer.from(parts.get('[Content_Types].xml')!.toString().replace('</Types>','<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'+(image?'<Default Extension="png" ContentType="image/png"/>':'')+'</Types>')));
  if(image)parts.set('word/media/synthetic.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHpsAAAAASUVORK5CYII=','base64'));
  const done=new Promise<Buffer>((resolve,reject)=>{zip.outputStream.on('data',chunk=>chunks.push(chunk));zip.outputStream.on('end',()=>resolve(Buffer.concat(chunks)));zip.outputStream.on('error',reject);});
  for(const [name,part] of parts)zip.addBuffer(part,name);zip.end();return done;
}

test('host layout revision: real paid batch, atomic readback failure, original preservation, concurrent idempotency, exact links and owned download successors',
 {skip:!database,timeout:300000},async()=>{
  const pool=new Pool({connectionString:database}),user=randomUUID();let actor=user;
  const store=new Map<string,Buffer>(),blobs:PrivateBlobs={put:async(k,b)=>{store.set(k,Buffer.from(b));},get:async k=>Buffer.from(store.get(k)!),getIfExists:async k=>store.get(k)??null,
    getIfExistsBounded:async(k,max)=>{const b=store.get(k);if(b&&b.length>max)throw Error('too large');return b??null;},exists:async k=>store.has(k),delete:async k=>{store.delete(k);}};
  const origin='http://synthetic-workpaper.test';
  const server=(automatic:boolean)=>createServer({pool,blobs,allowedOrigin:origin,enableRunRuntime:true,enableSubscriptionBilling:automatic,enableOutcomePricing:automatic,principal:async()=>({userId:actor,csrfVerified:true})});
  let app=server(false);
  const send=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url,payload,headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});
  const ok=async(method:string,url:string,payload?:any)=>{const r=await send(method,url,payload);assert.ok(r.statusCode<300,`${r.statusCode} ${r.body}`);return r.json();};
  const upload=async(id:string,name:string,bytes:Buffer,media_type:string,role='other')=>{
    const base='/api/v1/projects/'+id,declaration={byte_size:bytes.length,sha256:digest(bytes)},u=await ok('POST',base+'/materials/uploads',{...declaration,filename:name,media_type,role});
    assert.equal((await send('PUT',u.upload_url,bytes)).statusCode,204);const m=await ok('POST',base+'/materials/uploads/'+u.upload_id+'/complete',declaration);
    return {source_project_id:id,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256};
  };
  const execute=(stages:RunStage[])=>runPipelineOnce({pool,blobs,runKinds:['generation'],leaseSeconds:120,stages:[inputLockStage,materialsReadyStage,...stages],onUnexpectedError:e=>assert.fail(JSON.stringify(e))});
  const docx='application/vnd.openxmlformats-officedocument.wordprocessingml.document',text='合成发行人总资产100万元，不涉及境外投资。',document=await withHeader(makeSyntheticDocxFixture({text}));
  const fund=(points:number)=>transaction(pool,c=>grantCredits(c,{owner:user,source:'purchase',key:randomUUID(),points,expiresAt:null,actor:'synthetic',reason:'Synthetic workpaper paid check only'}));
  let incomplete=false,checkModelCalls=0;
  const checkModel:typeof codexModelStage=options=>({name:options.name,run:async()=>{
    checkModelCalls++;
    const cwd=await mkdtemp(join(tmpdir(),'bb-synthetic-workpaper-check-'));
    try{
      await options.fileWorkspace!.prepare(cwd);
      const source=JSON.parse(await readFile(join(cwd,'source-spans.json'),'utf8')),target=JSON.parse(await readFile(join(cwd,'target-spans.json'),'utf8'));
      assert.ok(target.spans.some((p:any)=>p.id==='header1-p0'&&p.text==='Synthetic workpaper header'),'full extraction includes the real Word header');
      const sp=source.spans.find((p:any)=>p.text.includes('总资产')),tp=target.spans.find((p:any)=>p.text.includes('总资产'));
      const findings=tp.text.includes('100万元')&&sp.text.includes('200万元')?[{kind:'conflict',target_span_id:tp.id,original:'100万元',replacement:'200万元',source_span_id:sp.id,source_quote:'200万元',reason:'Synthetic amount changed',field:'总资产',period:'2026',unit:'万元'}]:[];
      await writeFile(join(cwd,'output/check.json'),JSON.stringify({coverage:'Synthetic whole-file comparison using host-verified anchors',checked_span_ids:incomplete?[]:target.spans.map((p:any)=>p.id),findings,
        links:[{source_span_id:sp.id,source_quote:'合成发行人',target_span_id:tp.id,target_quote:'合成发行人',field:'主体',period:'',unit:''}]}));
      return {kind:'done',value:await options.fileWorkspace!.collect(cwd,{} as any,{text:'Synthetic model; no supplier call'})};
    }finally{await rm(cwd,{recursive:true,force:true});}
  }});
  const checks=()=>execute([projectFileModelStage({model:checkModel}),projectFileDeliveryStage()]);
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[user,'paid_wp_'+user.slice(0,8)]);await fund(WORKPAPER_PRICE.points*2+2*AUTOMATIC_TASK_TARIFF.check.points-1);
    const p=await ok('POST','/api/v1/projects',{kind:'generation',name:'Synthetic paid workpapers',issuer_name:'Synthetic issuer',market:'sse',offering:'public'}),id=p.project_id,base='/api/v1/projects/'+id,wp=base+'/workpapers';
    const original=await upload(id,'synthetic-v1.docx',document,docx,'historical');
    let versions=await ok('GET',base+'/prospectus-versions'),source=await ok('POST',base+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:0,version_id:versions.versions[0].version_id});
    const material=await upload(id,'synthetic-catalogue.xlsx',await catalogueXlsx(3),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),cat=await ok('POST',wp+'/catalogues',{request_id:randomUUID(),material});
    const request={request_id:randomUUID(),catalogue_id:cat.catalogue_id,catalogue_sha256:cat.sha256,item_ids:cat.entries.map((e:any)=>e.id),source_version_id:source.current_version_id,source_selection_revision:source.selection_revision,requirements:'Synthetic only'};
    const assessor:typeof codexModelStage=options=>({name:options.name,run:async ctx=>{
      const prompt=await options.buildPrompt(ctx),data=JSON.parse(prompt.split('ref=workpaper-assessment\n')[1].split('\nBB-DATA-')[0]);
      return {kind:'done',value:{decisions:data.entries.map((e:WorkpaperEntry,i:number)=>({item_id:e.id,status:i===2?'not_applicable':'generate',reason:i===2?'本项目不涉及境外投资。':'总资产可形成分析。',missing_materials:[],citations:[{span_id:'p0',quote:text}]}))}};
    }});
    await ok('POST',wp+'/assessments',request);assert.equal(await execute([workpaperAssessmentStage({model:assessor,config:()=>loadCodexAdapterConfig({})}),workpaperAssessmentDelivery()]),'succeeded');
    const assessment=(await ok('GET',wp)).assessments[0],generationRequest={...request,request_id:randomUUID(),assessment_id:assessment.assessment_id,assessment_hash:assessment.result_hash,price_version:WORKPAPER_PRICE.version,expected_points:String(WORKPAPER_PRICE.points*2)};
    const batch=await ok('POST',wp+'/batches',generationRequest);
    const generate=()=>execute([{name:'model_generation',run:async ctx=>{
      const files:Record<string,{key:string;sha256:string;byte_size:number}>={};
      for(const [name,bytes] of [['document.docx',document],['preparation-note.docx',makeSyntheticDocxFixture({text:'Synthetic internal note'})]] as const){const sha256=digest(bytes),key=`owners/${user}/projects/${ctx.run.project_id}/runs/${ctx.run.id}/m4-documents/synthetic/${sha256}/${name}`;await blobs.put(key,bytes,docx);files[name]={key,sha256,byte_size:bytes.length};}
      return {kind:'done',value:{version:'codex-m4-document-v1',input_hash:ctx.run.input_hash.trim(),skill_sha256:'a'.repeat(64),method_hash:'b'.repeat(64),internal_note:true,files,
        project_file_links:{source_sha256:original.sha256,target_sha256:digest(document),warnings:[],links:[{source_span_id:'p0',source_quote:text,target_span_id:'p0',target_quote:text,field:'总资产',period:'2025',unit:'万元',source_location:'段落 1',target_location:'段落 1',source_sha256:original.sha256,target_sha256:digest(document)}]}}};
    }},m4DocumentDeliveryStage()]);
    for(let n=0;n<2;n++){await advanceWorkpaperBatch(pool);assert.equal(await generate(),'succeeded');}await advanceWorkpaperBatch(pool);
    const generated=(await ok('GET',wp+'/library')).items,first=generated[0],second=generated[1];
    assert.ok(first.file&&second.file);assert.equal(generated[2].file,undefined,'object-only explanation never receives a fake Word version');
    assert.equal(first.file.original.version_id,first.file.current.version_id);
    assert.equal(first.links_count,1,'library summaries expose the retained source-link count');
    assert.equal((await pool.query('SELECT jsonb_array_length(links) AS n FROM bb_project_file_versions WHERE owner_user_id=$1 AND id=$2',[user,first.file.current.version_id])).rows[0].n,1,'full evidence stays in the owned stored version');
    const old=first.file.current,opts={owner:user,versionId:old.version_id,expectedSha256:old.asset.pin.sha256,actor:'synthetic-layout-operator'};
    const count=async(table:string)=>(await pool.query('SELECT count(*)::int n FROM '+table+' WHERE owner_user_id=$1',[user])).rows[0].n;
    const unchanged=async()=>({runs:(await pool.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 ORDER BY id',[user])).rows,
      ledger:(await pool.query('SELECT * FROM bb_credit_ledger WHERE owner_user_id=$1 ORDER BY id',[user])).rows,
      reservations:(await pool.query('SELECT * FROM bb_credit_reservations WHERE owner_user_id=$1 ORDER BY id',[user])).rows,
      original:(await pool.query('SELECT * FROM bb_project_file_versions WHERE id=$1',[old.version_id])).rows,
      artifacts:(await pool.query('SELECT * FROM bb_artifact_versions WHERE owner_user_id=$1 AND id=ANY($2::text[]) ORDER BY id',[user,[first.file.current.asset.pin.artifact_id,second.file.current.asset.pin.artifact_id]])).rows});
    const snapshot=await unchanged(),baseline=await count('bb_project_file_versions'),artifactCount=await count('bb_artifact_versions'),evidenceCount=await count('bb_word_delivery_evidence');
    for(const input of [{...opts,owner:randomUUID()},{...opts,expectedSha256:'0'.repeat(64)},{...opts,actor:''}])await assert.rejects(repairDeliveredWorkpaperLayout(pool,blobs,input),/WORKPAPER_LAYOUT_REVISION_CONFLICT/);
    const broken={...blobs,getIfExistsBounded:async(k:string,max:number)=>k.includes('/layout-revisions/')?Buffer.from('bad'):blobs.getIfExistsBounded(k,max)};
    await assert.rejects(repairDeliveredWorkpaperLayout(pool,broken,opts),/WORKPAPER_LAYOUT_REVISION_CONFLICT/);
    assert.equal(await count('bb_workpaper_layout_revisions'),0);assert.equal(await count('bb_project_file_versions'),baseline);assert.equal(await count('bb_artifact_versions'),artifactCount);assert.equal(await count('bb_word_delivery_evidence'),evidenceCount);
    assert.deepEqual(await unchanged(),snapshot);
    const repaired=await Promise.all([repairDeliveredWorkpaperLayout(pool,blobs,opts),repairDeliveredWorkpaperLayout(pool,blobs,opts)]);
    assert.equal(new Set(repaired.map(r=>r.version_id)).size,1);assert.equal(repaired.filter(r=>!r.reused).length,1);assert.equal(await count('bb_workpaper_layout_revisions'),1);
    assert.equal(await count('bb_project_file_versions'),baseline+1);assert.equal(await count('bb_artifact_versions'),artifactCount+1);assert.equal(await count('bb_word_delivery_evidence'),evidenceCount+1);assert.deepEqual(await unchanged(),snapshot);
    const receipt=(await pool.query('SELECT * FROM bb_workpaper_layout_revisions WHERE owner_user_id=$1',[user])).rows[0];
    assert.equal(receipt.receipt.billing_action,'none');assert.equal(receipt.receipt.model_action,'none');
    await assert.rejects(pool.query("UPDATE bb_workpaper_layout_revisions SET actor='forged' WHERE id=$1",[receipt.id]),/immutable/);
    await assert.rejects(pool.query('DELETE FROM bb_workpaper_layout_revisions WHERE id=$1',[receipt.id]),/immutable/);
    const current=(await ok('GET',wp+'/library')).items.find((i:any)=>i.entry.id===first.entry.id).file;
    assert.equal(current.original.version_id,old.version_id);assert.equal(current.original.asset.pin.sha256,old.asset.pin.sha256);assert.equal(current.current.version_id,repaired[0].version_id);
    assert.notEqual(current.current.asset.pin.sha256,old.asset.pin.sha256);assert.equal(current.current.run_id,null);
    const newRow=(await pool.query('SELECT * FROM bb_project_file_versions WHERE id=$1',[repaired[0].version_id])).rows[0];
    assert.equal(newRow.links.length,1);assert.equal(newRow.links[0].target_sha256,repaired[0].sha256);
    const artifact=(await pool.query('SELECT * FROM bb_artifact_versions WHERE id=$1',[newRow.asset.pin.artifact_id])).rows[0];
    assert.equal(digest(store.get(artifact.object_key)!),repaired[0].sha256);assert.deepEqual(await unchanged(),snapshot);
    actor=randomUUID();assert.equal((await send('GET',wp+'/batches/'+batch.batch_id)).statusCode,404);actor=user;
  }finally{await app.close();await pool.end();}
});
