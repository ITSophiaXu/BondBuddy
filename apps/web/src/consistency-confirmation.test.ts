import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PROJECT_FILE_UPDATE_PRICE,type ProjectFileAsset,type ProjectFileCheck,type ProjectFileFinding,type ProjectFileVersion} from '@bondbuddy/contracts';
import {createConfirmationSnapshot,restoreConfirmationSnapshot,type ConfirmationBinding,type ConfirmationSnapshot} from './consistency-confirmation.js';

const sha='a'.repeat(64),name='同名关联文件.docx';
const material=(id:string,project='project'):ProjectFileAsset=>({kind:'material',pin:{source_project_id:project,material_id:id,material_version:2,sha256:sha}});
const finding=(id:string,kind:'conflict'|'manual'='conflict',replacement:string|null='自动建议'):ProjectFileFinding=>({
  id,kind,replacement,target_span_id:'target-'+id,original:'本轮原文',source_span_id:'source-'+id,source_quote:'固定来源原文',
  source_location:'募集书第3页',target_location:'关联文件第2页',reason:'合成核对说明',field:'金额',period:'2025年度',unit:'万元'});
function fixture(){
  const registry:ProjectFileVersion[]=[['issuer',3],['financial',7]].map(([type,sequence])=>({
    version_id:type+'-version',file_id:type+'-family',document_type:type as ProjectFileVersion['document_type'],filename:name,sequence:sequence as number,
    asset:type==='issuer'?material(type+'-material'):{kind:'artifact',pin:{source_project_id:'retained-generation-project',artifact_id:'financial-artifact',artifact_version:4,sha256:sha}},
    revision_asset:null,source_version_id:'source-v4',template_id:null,template_version:null,source_name:'原募集书.docx',source_sequence:4,
    created_at:'2026-10-25T04:00:00Z',run_id:null,links:[],latest:true,version_count:sequence as number,
    consistency:{status:'conflict',count:2,check_run_id:'check'}}));
  const check:ProjectFileCheck={run_id:'check',state:'succeeded',stage:'completed',created_at:'2026-10-25T04:00:00Z',
    source:{project_id:'retained-source-project',version_id:'source-v4',selection_revision:9,filename:'原募集书.docx',sequence:4,
      asset:material('original-prospectus','retained-source-project')},stale:false,sha256:sha,
    files:registry.map(file=>({file_id:file.file_id,file_version_id:file.version_id,filename:file.filename,sequence:file.sequence})),
    updates:[{file_version_id:'financial-version',issue_ids:['financial-first'],run_id:'accepted-run',state:'succeeded',new_version_id:'financial-next'}],
    result:{version:'project-file-check-v1',files:[
      {file_version_id:'issuer-version',status:'conflict',coverage:'原检查范围',links:[],
        findings:[finding('issuer-first'),finding('issuer-second'),finding('issuer-third'),finding('issuer-manual','manual',null)]},
      {file_version_id:'financial-version',status:'conflict',coverage:'原检查范围',links:[],
        findings:[finding('financial-first'),finding('financial-second'),finding('financial-no-replacement','conflict',null),finding('financial-manual-with-text','manual','仍需人工判断')]},
    ]}};
  const binding:ConfirmationBinding={owner:'owner',project:'project',checkId:'check',body:{request_id:'original-request',expected_check_sha256:sha,
    price_version:PROJECT_FILE_UPDATE_PRICE.version,expected_points:9000,files:[{file_version_id:'financial-version'},{file_version_id:'issuer-version'}]},filenames:[name,name]};
  return {binding,check,registry,automatic:[1,2],projectName:'冻结时的项目名称'};
}
function create(input=fixture()){
  const snapshot=createConfirmationSnapshot(input.binding,input.check,input.registry,input.automatic,input.projectName);
  assert.ok(snapshot);return snapshot;
}
const roundTrip=(snapshot:ConfirmationSnapshot)=>JSON.parse(JSON.stringify(snapshot)) as ConfirmationSnapshot;

test('confirmation snapshot follows the complete request order and distinguishes same-name files by original family, version and type',()=>{
  const input=fixture(),before=structuredClone(input),snapshot=create(input);
  assert.deepEqual(snapshot.files.map(file=>[file.fileId,file.versionId,file.filename,file.sequence,file.documentType]),[
    ['financial-family','financial-version',name,7,'financial'],['issuer-family','issuer-version',name,3,'issuer']]);
  assert.deepEqual(snapshot.binding,input.binding);assert.deepEqual(input,before);
  assert.equal(snapshot.source.project_id,'retained-source-project');assert.equal(snapshot.binding.project,'project');
  assert.equal(snapshot.files[0].asset?.kind,'artifact');assert.equal(snapshot.source.selection_revision,9);
  assert.equal(snapshot.projectName,input.projectName);assert.equal(new Date(snapshot.createdAt).toISOString(),snapshot.createdAt);
  assert.equal('findings' in snapshot.files[0],false);assert.equal('coverage' in snapshot.files[0],false);
});

test('confirmation snapshot retains supplied remaining counts instead of recounting accepted or all automatic findings',()=>{
  const input=fixture(),snapshot=create(input);
  assert.deepEqual(snapshot.files.map(file=>file.automatic),[1,2]);
  input.check.updates=[];input.automatic=[0,1];
  assert.deepEqual(create(input).files.map(file=>file.automatic),[0,1]);
  assert.deepEqual(snapshot.files.map(file=>file.automatic),[1,2]);
});

test('confirmation snapshot counts both manual kinds and null replacements, and preserves missing manual detail',()=>{
  const input=fixture();assert.deepEqual(create(input).files.map(file=>[file.manual,file.manualUnlisted]),[[2,false],[1,false]]);
  const financial=input.check.result!.files[1];financial.status='manual';financial.findings=[finding('only-automatic')];input.automatic[0]=1;
  assert.deepEqual(create(input).files.map(file=>[file.manual,file.manualUnlisted]),[[0,true],[1,false]]);
});

test('confirmation snapshot marks type and asset unknown when the exact registry version cannot be confirmed',()=>{
  const changes:Array<(registry:ProjectFileVersion[])=>void>=[
    registry=>registry.shift(),registry=>registry.push(structuredClone(registry[0])),
    registry=>{registry[0].file_id='different-family';},registry=>{registry[0].sequence++;},
    registry=>{registry[0].filename='现在的同名替换稿.docx';},registry=>{registry[0].asset.pin.sha256='invalid';},
    registry=>{registry[0].document_type='unknown' as never;},registry=>{(registry[0] as unknown as Record<string,unknown>).extra=true;},
  ];
  for(const change of changes){const input=fixture();change(input.registry);const snapshot=create(input);
    assert.equal(snapshot.files[1].documentType,null);assert.equal(snapshot.files[1].asset,null);
    assert.equal(snapshot.files[0].documentType,'financial');assert.equal(snapshot.files[1].sequence,3);}
  const input=fixture();input.registry[0].latest=false;input.registry.push({...structuredClone(input.registry[0]),version_id:'issuer-new',sequence:4,filename:'最新稿.docx',latest:true});
  assert.equal(create(input).files[1].documentType,'issuer');
});

test('confirmation snapshot refuses an ambiguous checked version, result, family, source or report identity',()=>{
  const changes:Array<(input:ReturnType<typeof fixture>)=>void>=[
    input=>{input.check.run_id='another-check';},input=>{input.check.sha256='b'.repeat(64);},
    input=>{input.check.source.project_id='another-source-project';},input=>{input.check.source.asset.pin.sha256='invalid';},
    input=>{input.check.source.selection_revision=Number.MAX_SAFE_INTEGER+1;},input=>{input.check.files.shift();},
    input=>{input.check.files.push(structuredClone(input.check.files[0]));},input=>{input.check.result!.files.shift();},
    input=>{input.check.result!.files.push(structuredClone(input.check.result!.files[0]));},input=>{input.check.result=null;},
    input=>{input.check.files[0].filename='不同原文件名.docx';},input=>{input.check.files[0].file_id=input.check.files[1].file_id;},
    input=>{input.binding.body.files[1].file_version_id=input.binding.body.files[0].file_version_id;},
  ];
  for(const change of changes){const input=fixture();change(input);assert.equal(createConfirmationSnapshot(input.binding,input.check,input.registry,input.automatic,input.projectName),undefined);}
});

test('confirmation snapshot rejects invalid counts and counts exceeding the original automatic findings',()=>{
  for(const automatic of [[],[1],[1,2,3],[-1,2],[0.5,2],[NaN,2],[Infinity,2],[2001,2],[3,2]]){
    const input=fixture();assert.equal(createConfirmationSnapshot(input.binding,input.check,input.registry,automatic,input.projectName),undefined);
  }
});

test('confirmation recovery requires the complete original binding including same-name file order',()=>{
  const input=fixture(),snapshot=create(input);
  const changes:Array<(binding:ConfirmationBinding)=>void>=[
    binding=>{binding.owner='other-owner';},binding=>{delete binding.owner;},binding=>{binding.project='other-project';},
    binding=>{binding.checkId='other-check';},binding=>{binding.body.request_id='another-request';},
    binding=>{binding.body.expected_check_sha256='b'.repeat(64);},binding=>{binding.body.price_version='unknown' as never;},
    binding=>{binding.body.expected_points=4500;},binding=>{binding.body.files.reverse();},
    binding=>{binding.body.files[0].file_version_id='another-version';},binding=>{binding.filenames[0]='another.docx';},
    binding=>{binding.filenames.pop();},binding=>{(binding.body as unknown as Record<string,unknown>).extra=true;},
  ];
  for(const change of changes){const binding=structuredClone(input.binding);change(binding);
    assert.equal(restoreConfirmationSnapshot(snapshot,binding),undefined);
    const stored=roundTrip(snapshot);stored.binding=binding;assert.equal(restoreConfirmationSnapshot(stored,input.binding),undefined);}
});

test('confirmation recovery keeps the frozen project name and tolerates JSON property ordering and absent owner',()=>{
  const input=fixture(),snapshot=create(input),binding=input.binding;
  const reordered:ConfirmationBinding={filenames:[...binding.filenames],body:{files:binding.body.files,expected_points:binding.body.expected_points,
    price_version:binding.body.price_version,expected_check_sha256:binding.body.expected_check_sha256,request_id:binding.body.request_id},
    checkId:binding.checkId,project:binding.project,owner:binding.owner};
  assert.deepEqual(restoreConfirmationSnapshot(roundTrip(snapshot),reordered),snapshot);
  input.projectName='之后改名的项目';assert.equal(restoreConfirmationSnapshot(snapshot,binding)?.projectName,'冻结时的项目名称');
  delete input.binding.owner;const anonymous=create(input);assert.equal(restoreConfirmationSnapshot(roundTrip(anonymous),input.binding)?.binding.owner,undefined);
});

test('confirmation recovery rejects legacy records, extra metadata, file reordering and malformed source or counts',()=>{
  const input=fixture(),snapshot=create(input);
  for(const value of [undefined,null,[],{},input.binding,{...input.binding,attempted:true},JSON.stringify(snapshot)])assert.equal(restoreConfirmationSnapshot(value,input.binding),undefined);
  const changes:Array<(snapshot:ConfirmationSnapshot)=>void>=[
    value=>{value.version=2 as never;},value=>{(value as unknown as Record<string,unknown>).findings=[];},
    value=>{value.projectName='x'.repeat(201);},value=>{value.createdAt='2026-02-30T04:00:00.000Z';},
    value=>{value.createdAt='2026-10-25T04:00:00';},value=>{value.createdAt='not a date';},
    value=>{value.source.sequence=Number.MAX_SAFE_INTEGER+1;},value=>{value.source.asset.pin.sha256='invalid';},
    value=>{value.source.project_id='different-source';},value=>{value.files.reverse();},value=>{value.files.pop();},
    value=>{value.files[0].fileId=value.files[1].fileId;},value=>{value.files[0].filename='changed.docx';},
    value=>{value.files[0].documentType='unknown' as never;},value=>{value.files[0].asset=null;},
    value=>{value.files[0].asset!.pin.sha256='invalid';},value=>{value.files[0].sequence=0;},
    value=>{value.files[0].sequence=Number.MAX_SAFE_INTEGER+1;},value=>{value.files[0].automatic=2001;},
    value=>{value.files[0].manual=-1;},value=>{value.files[0].manual=0.5;},value=>{value.files[0].automatic=NaN;},
    value=>{value.files[0].automatic=1999;value.files[0].manual=2;},value=>{value.files[0].manualUnlisted=true;},
    value=>{(value.files[0] as unknown as Record<string,unknown>).coverage='Unexpected retained text';},
  ];
  for(const change of changes){const stored=roundTrip(snapshot);change(stored);assert.equal(restoreConfirmationSnapshot(stored,input.binding),undefined);}
});

test('confirmation snapshots are independent deeply frozen metadata and survive later source, registry and accepted-update changes',()=>{
  const input=fixture(),snapshot=create(input),saved=roundTrip(snapshot),binding=structuredClone(input.binding);
  input.binding.body.request_id='later-request';input.binding.body.files.reverse();input.binding.filenames[0]='later.docx';
  input.check.source.sequence=20;input.check.source.asset.pin.sha256='b'.repeat(64);input.check.result!.files[0].findings=[];
  input.registry[0].asset.pin.sha256='c'.repeat(64);input.check.updates=[];input.automatic[0]=0;
  assert.deepEqual(snapshot,saved);const restored=restoreConfirmationSnapshot(saved,binding);assert.ok(restored);
  assert.deepEqual(restored,snapshot);assert.notEqual(restored,snapshot);assert.notEqual(restored.source.asset,saved.source.asset);
  for(const value of [restored,restored.binding,restored.binding.body,restored.binding.body.files,restored.binding.body.files[0],
    restored.binding.filenames,restored.source,restored.source.asset.pin,restored.files,restored.files[0],restored.files[0].asset!.pin])assert.equal(Object.isFrozen(value),true);
  assert.equal(Reflect.set(restored.files[0],'automatic',0),false);assert.equal(Reflect.set(restored.binding.body,'request_id','changed'),false);
  saved.files[0].automatic=0;assert.equal(restored.files[0].automatic,1);
});

test('confirmation metadata accepts 200 selected files but refuses empty, over-limit and oversized records',()=>{
  const input=fixture(),template=input.registry[0],result=input.check.result!.files[0];
  input.registry=Array.from({length:200},(_,index)=>({...structuredClone(template),file_id:'family-'+index,version_id:'version-'+index,filename:'文件'+index+'.docx'}));
  input.check.files=input.registry.map(file=>({file_id:file.file_id,file_version_id:file.version_id,filename:file.filename,sequence:file.sequence}));
  input.check.result!.files=input.registry.map(file=>({...structuredClone(result),file_version_id:file.version_id,findings:[finding('automatic-'+file.version_id)]}));
  input.binding.body.files=input.registry.map(file=>({file_version_id:file.version_id}));input.binding.body.expected_points=900000;
  input.binding.filenames=input.registry.map(file=>file.filename);input.automatic=Array(200).fill(1);
  const snapshot=create(input);assert.equal(snapshot.files.length,200);assert.equal(restoreConfirmationSnapshot(roundTrip(snapshot),input.binding)?.files.length,200);
  const tooMany=roundTrip(snapshot);tooMany.files.push(structuredClone(tooMany.files[0]));assert.equal(restoreConfirmationSnapshot(tooMany,input.binding),undefined);
  input.binding.body.files.push({file_version_id:'version-201'});input.binding.filenames.push('文件201.docx');input.automatic.push(1);
  assert.equal(createConfirmationSnapshot(input.binding,input.check,input.registry,input.automatic,input.projectName),undefined);
  const empty=fixture();empty.binding.body.files=[];empty.binding.filenames=[];empty.automatic=[];
  assert.equal(createConfirmationSnapshot(empty.binding,empty.check,empty.registry,empty.automatic,empty.projectName),undefined);
  const oversized=fixture();oversized.binding.filenames[0]='x'.repeat(201);
  assert.equal(createConfirmationSnapshot(oversized.binding,oversized.check,oversized.registry,oversized.automatic,oversized.projectName),undefined);
});
