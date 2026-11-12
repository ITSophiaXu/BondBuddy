import {test} from 'node:test';
import assert from 'node:assert/strict';
import {confirmQaProspectus,matchingQaProspectus} from './qa-prospectus.mjs';

const expected={filename:'东营募集说明书.docx',byte_size:723353,sha256:'a'.repeat(64)};
const projectURL='http://localhost:5288/#qa?project=qa-project';
const workspace=()=>({prospectus:{project_id:'qa-project',version_id:'prospectus-v1',selection_revision:1,sequence:1,filename:expected.filename,asset:{kind:'material',pin:{source_project_id:'qa-project',material_id:'material-1',material_version:1,sha256:expected.sha256}}}});
const material=()=>({material_id:'material-1',material_version:1,...expected,persisted_at:'2026-11-12T00:00:00.000Z'});
const ready='募集说明书已就绪 '+expected.filename+' 采用版本 V1 · 已纳入本轮材料';
const response=(body,status=200)=>({status:()=>status,json:async()=>structuredClone(body)});

// Model the public page/API boundary, including the absent post-upload modal.
// Unsupported selectors/actions fail, so the former modal wait cannot pass here.
function pageFor({readWorkspace=()=>workspace(),readMaterial=()=>response(material()),text=()=>ready}={}){
 const events=[];let phase=0,reads=0,materialReads=0;
 const page={events,request:{async get(url){
  if(url==='/api/v1/projects/qa-project/qa'){events.push('qa:'+phase);return response(readWorkspace(phase,++reads));}
  assert.equal(url,'/api/v1/projects/qa-project/materials/material-1?version=1');events.push('material:'+phase);return readMaterial(phase,++materialReads);
 }},locator(selector){
  if(selector==='.qa-project-materials')return {innerText:async()=>text(phase)};
  if(selector==='#qa-prospectus-panel')return {};
  if(selector==='dialog[open]')return {filter:()=>({count:async()=>0})};
  if(selector==='#qa-refresh-materials')return {click:async()=>{events.push('refresh');phase=1;}};
  throw Error('Unexpected selector: '+selector);
 },async reload(){events.push('reload');phase=2;},async waitForTimeout(ms){events.push('wait');await new Promise(r=>setTimeout(r,ms));}};
 return page;
}

test('auto-adoption succeeds after the modal disappears and verifies refresh plus reload',async()=>{
 const page=pageFor();const proof=await confirmQaProspectus(page,{projectURL,expected});
 assert.deepEqual(proof,{project_id:'qa-project',version_id:'prospectus-v1',selection_revision:1,sequence:1,material_id:'material-1',material_version:1,...expected,persisted_at:material().persisted_at});
 assert.deepEqual(page.events,['qa:0','material:0','refresh','qa:1','material:1','reload','qa:2','material:2']);
});

test('queued upload and delayed adoption wait for a final HTTP 200 persisted material',async()=>{
 const page=pageFor({readWorkspace:(_phase,n)=>n===1?{prospectus:null}:workspace(),readMaterial:(_phase,n)=>n===1?response({status:'pending'},202):response(material())});
 await confirmQaProspectus(page,{projectURL,expected},{timeoutMs:1000,pollMs:1});
 assert.equal(page.events.filter(x=>x==='wait').length,2);
 assert.ok(page.events.indexOf('refresh')>page.events.lastIndexOf('wait'));
});

test('a closed modal or ready label alone cannot pass without the exact adopted source',async()=>{
 for(const options of [{readWorkspace:()=>({prospectus:null})},{text:()=>ready.replace('已纳入本轮材料','回答前需选入本轮材料')},{readMaterial:()=>response({...material(),sha256:'b'.repeat(64)})}]){
  const page=pageFor(options);
  await assert.rejects(confirmQaProspectus(page,{projectURL,expected},{timeoutMs:15,pollMs:1}),/not adopted/);
  assert.ok(!page.events.includes('refresh'));assert.ok(!page.events.includes('reload'));
 }
});

test('source identity and persisted original bytes reject wrong project, version, name, hash, size or timestamp',()=>{
 const mutations=[
  w=>{w.prospectus.project_id='other';},w=>{w.prospectus.version_id='';},w=>{w.prospectus.selection_revision=-1;},w=>{delete w.prospectus.asset;},
  w=>{w.prospectus.asset.pin.source_project_id='other';},w=>{w.prospectus.asset.pin.material_id='other';},w=>{w.prospectus.asset.pin.material_version=2;},w=>{w.prospectus.asset.pin.sha256='b'.repeat(64);},w=>{w.prospectus.filename='other.docx';}
 ];
 for(const mutate of mutations){const w=workspace();mutate(w);assert.equal(matchingQaProspectus(w,material(),expected,'qa-project'),null);}
 for(const patch of [{material_id:'other'},{material_version:2},{filename:'other.docx'},{sha256:'b'.repeat(64)},{byte_size:0},{byte_size:expected.byte_size+1},{persisted_at:null},{persisted_at:'invalid'}])assert.equal(matchingQaProspectus(workspace(),{...material(),...patch},expected,'qa-project'),null);
});

test('refresh and reload must retain the original accepted version and selection revision',async()=>{
 for(const changeAt of [1,2]){
  const page=pageFor({readWorkspace:phase=>{const w=workspace();if(phase>=changeAt){w.prospectus.version_id='different-version';w.prospectus.selection_revision=2;}return w;}});
  await assert.rejects(confirmQaProspectus(page,{projectURL,expected}),changeAt===1?/changed after material refresh/:/changed after page reload/);
 }
});

test('material HTTP failures are surfaced and never become a ready-source success',async()=>{
 const page=pageFor({readMaterial:()=>response({error:'not available'},403)});
 await assert.rejects(confirmQaProspectus(page,{projectURL,expected}),/HTTP 403/);
 assert.ok(!page.events.includes('refresh'));
});
