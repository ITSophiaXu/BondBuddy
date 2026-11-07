import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type {Pool} from 'pg';
import {registerWorkpapers} from './workpapers.js';
import {digest,Problem,type PrivateBlobs} from './data.js';
import {inflateRawSync,crc32} from 'node:zlib';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';

// Decode the actual ZIP central directory and verify every member independently
// of the writer. The Office XML reader intentionally ignores DOCX members.
function zipParts(bytes:Buffer):Map<string,Buffer>{
  const end=bytes.lastIndexOf(Buffer.from('504b0506','hex'));assert.equal(end,bytes.length-22);
  const count=bytes.readUInt16LE(end+10),parts=new Map<string,Buffer>();let offset=bytes.readUInt32LE(end+16);
  for(let i=0;i<count;i++){
    assert.equal(bytes.readUInt32LE(offset),0x02014b50);
    const nameSize=bytes.readUInt16LE(offset+28),extraSize=bytes.readUInt16LE(offset+30),commentSize=bytes.readUInt16LE(offset+32);
    const name=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(offset+46,offset+46+nameSize));
    const local=bytes.readUInt32LE(offset+42);assert.equal(bytes.readUInt32LE(local),0x04034b50);
    const data=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
    const compressed=bytes.subarray(data,data+bytes.readUInt32LE(offset+20));
    const content=bytes.readUInt16LE(offset+10)===0?compressed:inflateRawSync(compressed);
    assert.equal(content.length,bytes.readUInt32LE(offset+24));assert.equal(crc32(content),bytes.readUInt32LE(offset+16));
    assert.ok(!parts.has(name),'duplicate ZIP member');parts.set(name,content);offset+=46+nameSize+extraSize+commentSize;
  }
  assert.equal(offset,end);return parts;
}

/** Actual HTTP handlers and ZIP streaming, with explicit in-memory DB/Blob
 * fixtures. No model, production database, regeneration or billing call. */
test('retained 248-file batch: normalized names across ZIP, explanations, batch and library; original bytes and inputs survive',async()=>{
  const bytes=makeSyntheticDocxFixture({text:'Synthetic retained workpaper content.'}),sha=digest(bytes);
  const source={project_id:'project',version_id:'source',selection_revision:1,sequence:1,filename:'合成募集书.docx',asset:{kind:'artifact',pin:{source_project_id:'project',artifact_id:'source',artifact_version:1,sha256:sha}}};
  const items=Array.from({length:248},(_,i)=>{
    const entry={id:'item-'+i,code:i<2?'1-1':'1-'+i,title:i<2?'资产说明（包括附注'+i+'）':'财务状况'.repeat(32)+'核查记录（含附表）',folder:'原始目录（含操作说明）',kind:'file',row:i+2,sheet:'1 尽职调查文件',instructions:'保留全部编制要求',path:'原始目录/'+(i<2?'资产说明及附注'+i:'财务状况'.repeat(32)+'核查记录及附表')+'.docx'};
    const explanation=i<124?{filename:'旧说明名称.docx',sha256:sha,key:'blob'}:null;
    return {item_id:entry.id,ordinal:i,manifest:{input:{workpaper:{entry}}},run_id:'run-'+i,run_state:'succeeded',state:'succeeded',delivered_explanation:explanation,explanation,attempt:1,stage:null,error:null};
  });
  const saved=JSON.stringify(items);
  const artifacts=items.slice(124).map(i=>({run_id:i.run_id,kind:'document',filename:'旧名称.docx',project_id:'project',artifact_id:i.item_id,artifact_version:1,sha256:sha}));
  const batch={id:'batch',topic_id:'topic',catalogue_id:'catalogue',state:'complete',revision:1,source,total_points:0,created_at:'2026-10-29T00:00:00Z',error:null,start_mode:'direct'};
  const sql:string[]=[];let actor='owner',corrupt=false,reads=0,active=0,peak=0;
  const db={query:async(statement:string,params:any[])=>{
    sql.push(statement);assert.ok(/^\s*(SELECT|WITH)\b/i.test(statement),'downloads must never mutate state');
    if(params[0]!=='owner')return {rows:[]};
    let rows:any[];
    if(statement.includes('SELECT p.*,i.input_hash'))rows=params[1]==='project'?[{id:'project'}]:[];
    else if(statement.startsWith('SELECT * FROM bb_workpaper_batches'))rows=params[2]==='batch'?[batch]:[];
    else if(statement.startsWith('SELECT i.item_id,i.run_id,i.state'))rows=items.map(i=>({...i,entry:i.manifest.input.workpaper.entry,has_template:false}));
    else if(statement.includes('coalesce(sum(CASE'))rows=[{amount:0}];
    else if(statement.startsWith('SELECT coalesce(i.explanation'))rows=items.filter(i=>i.item_id===params[2]);
    else if(statement.startsWith('SELECT i.item_id,coalesce'))rows=items;
    else if(statement.includes('FROM jsonb_to_recordset'))rows=JSON.parse(params[1]).map((pin:any)=>({...pin,object_key:'blob'}));
    else if(statement.includes('FROM bb_artifact_versions a JOIN'))rows=[{sha256:sha,object_key:'blob'}];
    else if(statement.includes('SELECT a.*,v.sha256'))rows=artifacts;
    else if(statement.startsWith('SELECT update_project_id')||statement.includes('SELECT v.*,s.revision')||statement.includes('SELECT c.*,r.state'))rows=[];
    else if(statement.includes('FROM bb_project_file_operations o JOIN')||statement.startsWith('SELECT a.*,r.state,v.id')||statement.startsWith('SELECT v.id,v.file_id')||statement.startsWith('WITH RECURSIVE descendants'))rows=[];
    else if(statement.startsWith('SELECT * FROM bb_workpaper_paid_check_batches'))rows=[];
    else if(statement.includes('FROM bb_workpaper_paid_check_items i'))rows=[];
    else if(statement.startsWith('WITH ranked'))rows=items.map(i=>({...i,task:i.manifest.input.workpaper,batch_id:'batch',catalogue_id:'catalogue',created_at:batch.created_at,source,position:1,version_count:1}));
    else if(statement.startsWith('SELECT id,state,stage'))rows=items.map(i=>({id:i.run_id,state:i.run_state,stage:null}));
    else if(statement.includes('jsonb_array_length'))rows=[];
    else throw Error('Unexpected fixture query: '+statement);
    return {rows,rowCount:rows.length};
  }} as unknown as Pool;
  let release!:()=>void;const storageGate=new Promise<void>(r=>release=r);
  const blobs={getIfExistsBounded:async(_key:string,max:number)=>{reads++;active++;peak=Math.max(peak,active);await storageGate;await new Promise(r=>setTimeout(r,2));active--;assert.ok(bytes.length<=max);return corrupt?Buffer.from('corrupt'):bytes;}} as PrivateBlobs;
  const app=Fastify();app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof Problem?error.status:500).send({message:error instanceof Error?error.message:String(error)}));
  registerWorkpapers(app,()=>db,async()=>actor,()=>blobs);
  const base='/api/v1/projects/project/workpapers';
  try{
    const preparing=await app.inject({url:base+'/batches/batch/download',headers:{prefer:'respond-async'}});
    assert.equal(preparing.statusCode,202);assert.deepEqual(preparing.json(),{status:'preparing',progress:{phase:'retrieving',completed_files:0,total_files:248}});
    assert.equal(preparing.headers['retry-after'],'2');assert.equal(preparing.headers['cache-control'],'private, no-store');
    actor='other';assert.equal((await app.inject({url:base+'/batches/batch/download',headers:{prefer:'respond-async'}})).statusCode,404);actor='owner';
    assert.equal((await app.inject({url:base+'/batches/batch/download',headers:{prefer:'respond-async'}})).statusCode,202);
    release();sql.length=0;
    const response=await app.inject(base+'/batches/batch/download');assert.equal(response.statusCode,200,response.body);
    assert.equal(Number(response.headers['content-length']),response.rawPayload.length);
    assert.equal(reads,248);assert.equal(peak,4);assert.ok(sql.length<25,'query count must not grow with each file');
    const warm=await app.inject({url:base+'/batches/batch/download',headers:{prefer:'respond-async'}});assert.equal(warm.statusCode,200);
    assert.deepEqual(warm.rawPayload,response.rawPayload);assert.equal(reads,248,'unchanged download reuses the verified ZIP');
    const parts=zipParts(response.rawPayload);
    assert.equal(parts.size,248);assert.equal([...parts.keys()].filter(n=>n.startsWith('不适用说明/')).length,124);
    assert.ok([...parts.keys()].every(n=>Buffer.byteLength(n)<=240&&!n.includes('附注')&&!n.includes('附表')&&!n.includes('操作说明')));
    assert.ok([...parts.keys()].some(n=>n.endsWith(' (2).docx')));
    for(const part of parts.values())assert.equal(digest(part),sha);
    const one=await app.inject(base+'/batches/batch/explanations/item-0');assert.equal(one.statusCode,200);
    assert.equal(digest(one.rawPayload),sha);assert.ok(decodeURIComponent(String(one.headers['content-disposition'])).includes('1-1 资产说明-不适用说明.docx'));
    const detail=(await app.inject(base+'/batches/batch')).json();
    assert.equal(detail.items[0].explanation.filename,'1-1 资产说明-不适用说明.docx');
    assert.ok(!detail.items[124].artifacts[0].filename.includes('附表'));
    const libraryResponse=await app.inject(base+'/library?offset=0&limit=100&search=&category=all&status=all&history=false');
    assert.equal(libraryResponse.statusCode,200,libraryResponse.body);
    const library=libraryResponse.json();assert.equal(library.total,248);
    assert.equal(library.items[0].explanation.filename,'1-1 资产说明-不适用说明.docx');
    assert.equal(JSON.stringify(items),saved);
    corrupt=true;assert.equal((await app.inject(base+'/batches/batch/explanations/item-0')).statusCode,503);corrupt=false;
    actor='other';assert.equal((await app.inject(base+'/batches/batch/download')).statusCode,404);
    assert.equal((await app.inject(base+'/batches/batch/explanations/item-0')).statusCode,404);
    assert.equal(JSON.stringify(items),saved);
  }finally{release();await app.close();}
});
