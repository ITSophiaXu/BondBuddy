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
import {AUTOMATIC_PRICE_VERSION,AUTOMATIC_TASK_TARIFF} from '@bondbuddy/contracts';
import {grantCredits,creditBalance} from '../../api/dist/billing.js';
import {makeSyntheticDocxFixture} from '../../api/dist/docx-fixtures.js';
import {readBoundedOfficeParts} from '../../api/dist/docx-inspector.js';
import {catalogueXlsx} from '../../api/dist/workpaper-catalogue.test.js';
import {isolatedTestDatabase} from './test-database.js';
import {inputLockStage,materialsReadyStage,runPipelineOnce,type codexModelStage,type RunStage} from './run-pipeline.js';
import {m4DocumentDeliveryStage} from './m4-document-stage.js';
import {projectFileModelStage,projectFileDeliveryStage} from './project-file-stage.js';
const database=await isolatedTestDatabase(undefined,'workpaper-paid-checks');
async function withHeader(bytes:Buffer,image=false){
  const parts=new Map(readBoundedOfficeParts(bytes)),zip=new ZipFile(),chunks:Buffer[]=[];
  parts.set('word/header1.xml',Buffer.from('<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Synthetic workpaper header</w:t></w:r></w:p></w:hdr>'));
  parts.set('word/document.xml',Buffer.from(parts.get('word/document.xml')!.toString().replace('<w:sectPr/>','<w:sectPr><w:headerReference w:type="default" r:id="syntheticHeader"/></w:sectPr>')));
  parts.set('word/_rels/document.xml.rels',Buffer.from(parts.get('word/_rels/document.xml.rels')!.toString().replace('</Relationships>','<Relationship Id="syntheticHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>')));
  parts.set('[Content_Types].xml',Buffer.from(parts.get('[Content_Types].xml')!.toString().replace('</Types>','<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'+(image?'<Default Extension="png" ContentType="image/png"/>':'')+'</Types>')));
  if(image)parts.set('word/media/synthetic.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHpsAAAAASUVORK5CYII=','base64'));
  const done=new Promise<Buffer>((resolve,reject)=>{zip.outputStream.on('data',chunk=>chunks.push(chunk));zip.outputStream.on('end',()=>resolve(Buffer.concat(chunks)));zip.outputStream.on('error',reject);});
  for(const [name,part] of parts)zip.addBuffer(part,name);zip.end();return done;
}

test('workpapers: real per-file paid batch, atomic shortage, partial delivery, maintenance, version identity and isolation',
 {skip:!database,timeout:300000},async()=>{
  const pool=new Pool({connectionString:database}),user=randomUUID();let actor=user;
  const store=new Map<string,Buffer>(),blobs:PrivateBlobs={put:async(k,b)=>{store.set(k,Buffer.from(b));},get:async k=>Buffer.from(store.get(k)!),getIfExists:async k=>store.get(k)??null,
    getIfExistsBounded:async(k,max)=>{const b=store.get(k);if(b&&b.length>max)throw Error('too large');return b??null;},exists:async k=>store.has(k),delete:async k=>{store.delete(k);}};
  const origin='http://synthetic-workpaper.test';
  const server=(automatic:boolean)=>createServer({pool,blobs,allowedOrigin:origin,enableRunRuntime:true,enableSubscriptionBilling:automatic,enableOutcomePricing:automatic,historicalBillingFixture:!automatic,principal:async()=>({userId:actor,csrfVerified:true})});
  let app=server(true);
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
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[user,'paid_wp_'+user.slice(0,8)]);await fund(2*AUTOMATIC_TASK_TARIFF.workpaper.points+2*AUTOMATIC_TASK_TARIFF.check.points-1);
    const p=await ok('POST','/api/v1/projects',{kind:'generation',name:'Synthetic paid workpapers',issuer_name:'Synthetic issuer',market:'sse',offering:'public'}),id=p.project_id,base='/api/v1/projects/'+id,wp=base+'/workpapers';
    const original=await upload(id,'synthetic-v1.docx',document,docx,'historical');
    let versions=await ok('GET',base+'/prospectus-versions'),source=await ok('POST',base+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:0,version_id:versions.versions[0].version_id});
    const material=await upload(id,'synthetic-catalogue.xlsx',await catalogueXlsx(2),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),cat=await ok('POST',wp+'/catalogues',{request_id:randomUUID(),material});
    const request={start_mode:'direct' as const,request_id:randomUUID(),catalogue_id:cat.catalogue_id,catalogue_sha256:cat.sha256,item_ids:cat.entries.map((e:any)=>e.id),source_version_id:source.current_version_id,source_selection_revision:source.selection_revision,requirements:'Synthetic only',price_version:AUTOMATIC_PRICE_VERSION,expected_points:String(2*AUTOMATIC_TASK_TARIFF.workpaper.points)};
    const batch=await ok('POST',wp+'/batches',request);
    const generate=()=>execute([{name:'model_generation',run:async ctx=>{
      const files:Record<string,{key:string;sha256:string;byte_size:number}>={};
      for(const [name,bytes] of [['document.docx',document],['preparation-note.docx',makeSyntheticDocxFixture({text:'Synthetic internal note'})]] as const){const sha256=digest(bytes),key=`owners/${user}/projects/${ctx.run.project_id}/runs/${ctx.run.id}/m4-documents/synthetic/${sha256}/${name}`;await blobs.put(key,bytes,docx);files[name]={key,sha256,byte_size:bytes.length};}
      const task=(await pool.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',[ctx.run.project_id,ctx.run.input_revision])).rows[0].manifest.input.workpaper;
      return {kind:'done',value:{version:'codex-m4-document-v1',input_hash:ctx.run.input_hash.trim(),skill_sha256:'a'.repeat(64),method_hash:'b'.repeat(64),internal_note:true,files,
        workpaper_decision:{item_id:task.entry.id,status:'generate',reason:'合成材料支持生成。',missing_materials:[],citations:[]},
        project_file_links:{source_sha256:original.sha256,target_sha256:digest(document),warnings:[],links:[{source_span_id:'p0',source_quote:text,target_span_id:'p0',target_quote:text,field:'总资产',period:'2025',unit:'万元',source_location:'段落1',target_location:'段落1',source_sha256:original.sha256,target_sha256:digest(document)}]}}};
    }},m4DocumentDeliveryStage()]);
    for(let n=0;n<2;n++){await advanceWorkpaperBatch(pool);assert.equal(await generate(),'succeeded');}await advanceWorkpaperBatch(pool);
    const generated=(await ok('GET',wp+'/library')).items,first=generated[0],second=generated[1];
    assert.ok(first.file&&second.file);assert.equal(generated.length,2);
    assert.equal(first.file.original.version_id,first.file.current.version_id);
    assert.equal(first.links_count,1,'library summaries expose the retained source-link count');
    assert.equal((await pool.query('SELECT jsonb_array_length(links) AS n FROM bb_project_file_versions WHERE owner_user_id=$1 AND id=$2',[user,first.file.current.version_id])).rows[0].n,1,'full evidence stays in the owned stored version');
    const next=await upload(id,'synthetic-v2.docx',makeSyntheticDocxFixture({text:text.replace('100','200')}),docx,'historical');versions=await ok('GET',base+'/prospectus-versions');
    source=await ok('POST',base+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:source.selection_revision,version_id:versions.versions.find((v:any)=>v.material_id===next.material_id).version_id});
    await app.close();app=server(true);
    const quoteRequest={request_id:randomUUID(),workpaper_batch_id:batch.batch_id,source_version_id:source.current_version_id,source_selection_revision:source.selection_revision};
    const quote=await ok('POST',wp+'/check-batches/quote',quoteRequest);assert.equal(quote.items.length,2);assert.equal(quote.excluded.length,0);assert.equal(quote.points,String(2*AUTOMATIC_TASK_TARIFF.check.points));
    const start={...quoteRequest,file_version_ids:quote.items.map((i:any)=>i.file_version_id),price_version:quote.price_version,expected_points:quote.points,scopes:quote.items.map((i:any)=>({file_version_id:i.file_version_id,scope_quote_id:i.scope_quote_id}))};
    const before=await creditBalance(pool,user);assert.equal(before.available,2*AUTOMATIC_TASK_TARIFF.check.points-1);
    const shortage=await send('POST',wp+'/check-batches',start);assert.equal(shortage.statusCode,402,shortage.body);assert.match(shortage.body,new RegExp((2*AUTOMATIC_TASK_TARIFF.check.points).toLocaleString('zh-CN')));
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_workpaper_paid_check_batches WHERE owner_user_id=$1',[user])).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_project_file_check_quotes WHERE owner_user_id=$1',[user])).rows[0].n,0);
    await fund(1);const funded=before.available+1;
    const accepted=await ok('POST',wp+'/check-batches',start),again=await ok('POST',wp+'/check-batches',start);assert.equal(again.batch_id,accepted.batch_id);assert.equal(accepted.items.length,2);
    assert.deepEqual(await creditBalance(pool,user),{available:funded-2*AUTOMATIC_TASK_TARIFF.check.points,frozen:2*AUTOMATIC_TASK_TARIFF.check.points});
    const allocations=(await pool.query(`SELECT a.reservation_id,a.lot_id,a.points FROM bb_credit_allocations a JOIN bb_credit_reservations r ON r.id=a.reservation_id WHERE r.run_id=ANY($1::text[]) ORDER BY a.reservation_id,a.lot_id`,[accepted.items.map((i:any)=>i.run_id)])).rows;
    assert.equal(new Set(allocations.map(a=>a.reservation_id)).size,2);
    assert.equal(await checks(),'succeeded');incomplete=true;assert.equal(await checks(),'failed');incomplete=false;
    const read=await ok('GET',wp+'/check-batches/'+accepted.batch_id);assert.equal(read.state,'partial');assert.equal(read.items.filter((i:any)=>i.state==='succeeded').length,1);
    assert.deepEqual(await creditBalance(pool,user),{available:funded-AUTOMATIC_TASK_TARIFF.check.points,frozen:0});
    const paid=read.items.find((i:any)=>i.state==='succeeded'),failed=read.items.find((i:any)=>i.state==='failed');
    assert.equal((await pool.query('SELECT total_spans FROM bb_workpaper_check_evidence WHERE run_id=$1',[paid.run_id])).rows[0].total_spans,2,'both body and header were actually covered');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_workpaper_check_evidence WHERE run_id=$1',[failed.run_id])).rows[0].n,0);
    assert.equal((await pool.query('SELECT state FROM bb_credit_reservations WHERE run_id=$1',[failed.run_id])).rows[0].state,'released');
    const check=(await ok('GET',base+'/project-files/checks/'+paid.run_id)).check,patchRequest={expected_check_sha256:check.sha256,files:[{file_version_id:paid.file_version_id}]};
    const patchQuote=await ok('POST',base+'/project-files/checks/'+paid.run_id+'/updates/quote',patchRequest);assert.equal(patchQuote.points,'0');
    const update=await ok('POST',base+'/project-files/checks/'+paid.run_id+'/updates',{...patchRequest,request_id:randomUUID(),price_version:patchQuote.price_version,expected_points:'0',files:patchQuote.items.map((i:any)=>({file_version_id:i.file_version_id,scope_quote_id:i.scope_quote_id}))});
    await advanceProjectFileUpdates(pool);assert.equal(await checks(),'succeeded');await advanceProjectFileUpdates(pool);
    const maintained=(await ok('GET',wp+'/library')).items.find((i:any)=>i.file?.original.version_id===paid.file_version_id);
    assert.notEqual(maintained.file.current.version_id,paid.file_version_id);assert.equal(maintained.file.original.version_id,paid.file_version_id);
    assert.equal(maintained.artifacts[0].pin.sha256,maintained.file.current.asset.pin.sha256);
    const batchRead=await ok('GET',wp+'/batches/'+batch.batch_id),batchItem=batchRead.items.find((i:any)=>i.entry.id===maintained.entry.id);assert.equal(batchItem.artifacts[0].pin.sha256,maintained.file.current.asset.pin.sha256);
    assert.match((await ok('GET',wp+`/batches/${batch.batch_id}/items/${maintained.entry.id}/preview`)).text,/200万元/);
    // Reproduce a source-CAS non-promotion: a retained historical patch must not
    // silently replace the family's adopted original in the library/downloads.
    await pool.query('UPDATE bb_project_files SET latest_version_id=$2 WHERE id=$1',[maintained.file.current.file_id,paid.file_version_id]);
    const unpromoted=(await ok('GET',wp+'/library')).items.find((i:any)=>i.entry.id===maintained.entry.id);
    assert.equal(unpromoted.file.current.version_id,paid.file_version_id);
    await pool.query('UPDATE bb_project_files SET latest_version_id=$2 WHERE id=$1',[maintained.file.current.file_id,maintained.file.current.version_id]);
    const covered=await ok('POST',wp+'/check-batches/quote',{...quoteRequest,request_id:randomUUID(),file_version_ids:[maintained.file.current.version_id]});assert.equal(covered.points,'0','platform repair descendants retain paid maintenance');
    actor=randomUUID();assert.equal((await send('GET',wp+'/check-batches/'+accepted.batch_id)).statusCode,404);assert.equal((await send('POST',wp+'/check-batches/quote',quoteRequest)).statusCode,404);actor=user;
    await assert.rejects(pool.query('UPDATE bb_workpaper_file_bindings SET original_version_id=$2 WHERE original_version_id=$1',[paid.file_version_id,maintained.file.current.version_id]),/immutable/);
    // A later business source is a new paid scope even for the repaired target.
    const third=await upload(id,'synthetic-v3.docx',makeSyntheticDocxFixture({text:text.replace('100','300')}),docx,'historical');versions=await ok('GET',base+'/prospectus-versions');
    const thirdSelected=await ok('POST',base+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:source.selection_revision,version_id:versions.versions.find((v:any)=>v.material_id===third.material_id).version_id});
    const newQuote=await ok('POST',wp+'/check-batches/quote',{...quoteRequest,request_id:randomUUID(),source_version_id:thirdSelected.current_version_id,source_selection_revision:thirdSelected.selection_revision,file_version_ids:[maintained.file.current.version_id]});assert.equal(newQuote.points,String(AUTOMATIC_TASK_TARIFF.check.points));
    const replay=await ok('POST',wp+'/check-batches',start);assert.equal(replay.batch_id,accepted.batch_id,'source changes never change the accepted original request');
    const changed=await send('POST',wp+'/check-batches',{...start,expected_points:'1'});assert.equal(changed.statusCode,409);assert.equal(changed.json().code,'IDEMPOTENCY_CONFLICT');
    assert.equal(update.batch_id.length>0,true);
    // Real image bytes trigger the complete inspector's unread-content warning.
    // The accepted per-file hold releases without treating a text-only report as a
    // complete result or calling the synthetic model.
    const imagePin=await upload(id,'synthetic-unread-image.docx',await withHeader(makeSyntheticDocxFixture({text:text.replace('100','400')}),true),docx,'historical');
    versions=await ok('GET',base+'/prospectus-versions');
    const imageSource=await ok('POST',base+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:thirdSelected.selection_revision,version_id:versions.versions.find((v:any)=>v.material_id===imagePin.material_id).version_id});
    const imageRequest={...quoteRequest,request_id:randomUUID(),source_version_id:imageSource.current_version_id,source_selection_revision:imageSource.selection_revision,file_version_ids:[maintained.file.current.version_id]};
    const imageQuote=await ok('POST',wp+'/check-batches/quote',imageRequest),imageBatch=await ok('POST',wp+'/check-batches',{...imageRequest,price_version:imageQuote.price_version,expected_points:imageQuote.points,scopes:imageQuote.items.map((i:any)=>({file_version_id:i.file_version_id,scope_quote_id:i.scope_quote_id}))}),callsBeforeImage=checkModelCalls;
    assert.equal(await checks(),'failed');assert.equal(checkModelCalls,callsBeforeImage);
    assert.equal((await pool.query('SELECT state FROM bb_credit_reservations WHERE run_id=$1',[imageBatch.items[0].run_id])).rows[0].state,'released');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_workpaper_check_evidence WHERE run_id=$1',[imageBatch.items[0].run_id])).rows[0].n,0);
    // Regenerating the exact logical catalogue item appends a new family version;
    // the previous batch retains both its original and its maintenance descendant.
    await app.close();app=server(true);await fund(AUTOMATIC_TASK_TARIFF.workpaper.points);
    const adopted=await ok('POST',base+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:imageSource.selection_revision,version_id:request.source_version_id});
    const nextRequest={...request,request_id:randomUUID(),item_ids:[maintained.entry.id],source_selection_revision:adopted.selection_revision};
    const generation2=await ok('POST',wp+'/batches',{...nextRequest,expected_points:String(AUTOMATIC_TASK_TARIFF.workpaper.points)});
    await advanceWorkpaperBatch(pool);assert.equal(await generate(),'succeeded');await advanceWorkpaperBatch(pool);
    const history=(await ok('GET',wp+'/library?history=true')).items,newItem=history.find((i:any)=>i.batch_id===generation2.batch_id),oldItem=history.find((i:any)=>i.batch_id===batch.batch_id&&i.entry.id===maintained.entry.id);
    assert.equal(newItem.file.current.file_id,oldItem.file.current.file_id);assert.notEqual(newItem.file.original.version_id,oldItem.file.original.version_id);
    assert.equal(oldItem.file.original.version_id,paid.file_version_id);assert.equal(oldItem.file.current.version_id,maintained.file.current.version_id);assert.equal(oldItem.file.current.latest,false);
    assert.equal(newItem.file.current.latest,true);assert.ok(newItem.file.current.sequence>oldItem.file.current.sequence);
  }finally{await app.close();await pool.end();}
});
