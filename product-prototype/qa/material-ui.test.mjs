import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadMultipart } from '../public/upload.js';
import { materialStudio } from '../public/material-studio.js';
import { projectWorkspace } from '../public/project-workspace.js';
import { authoringUI } from '../public/authoring.js';
import { GENERATION_TYPES } from '../public/generation-catalog.js';
const esc=value=>String(value??'').replaceAll('<','&lt;').replaceAll('"','&quot;');
test('upload progress is driven by transport events, distinguishes saved response and reports failures',async()=>{
  let xhr;class XHR{constructor(){xhr=this;this.upload={};}open(method,url){this.method=method;this.url=url;}send(body){this.body=body;}abort(){this.onabort();}}
  const progress=[],pending=uploadMultipart('/upload',new FormData(),{XMLHttpRequest:XHR,onProgress:p=>progress.push(p)});
  xhr.upload.onprogress({lengthComputable:true,loaded:40,total:100});assert.equal(progress.at(-1).percent,40);
  xhr.upload.onload();assert.equal(progress.at(-1).transferred,true);xhr.status=201;xhr.responseText='{"file":{"key":"saved"}}';xhr.onload();assert.equal((await pending).file.key,'saved');
  const failed=uploadMultipart('/upload',new FormData(),{XMLHttpRequest:XHR});xhr.status=400;xhr.responseText='{"error":"文件无效"}';xhr.onload();await assert.rejects(failed,/文件无效/);
});
test('update and review use fixed upload sections, optional peer uploads and real retry states',async()=>{
  const state={route:'update',step:2,accountEpoch:0,health:{authoringVersion:2,projectInputVersion:3},files:{update:[],review:[]},drafts:{update:{projectId:'p',authoringMode:'reference',exchange:'sse',offering:'private',updateMode:'full',issuer:'测试',title:'测试'},review:{projectId:'r',updateMode:'full',exchange:'sse',offering:'private'}},connectors:[],billing:null};
  const rendered=[],draft=kind=>state.drafts[kind],shared={state,esc,icon:()=>'',bytes:n=>n+'B',head:()=>'',draft,reportingPreview:()=>''};
  let fail=true;const workspace=projectWorkspace({...shared,authoring:authoringUI(shared),api:async()=>({}),post:async()=>({}),toast:()=>{},saveDraft:()=>{},render:async()=>rendered.push(workspace.page(state.route)),refreshJobs:async()=>{},upload:async(path,body,{onProgress})=>{onProgress({percent:50});assert(rendered.at(-1).includes('50%'));if(fail)throw new Error('连接中断');return {file:{key:'saved-key'}};}});
  let html=workspace.page('update');assert(!html.includes('id="upload-role"'));assert(!html.includes('aria-label="材料类型"'));assert(html.includes('相似募集书'));assert(!html.includes('上传本发行人历史募集书'));assert(html.includes('基金备案许可'));assert(html.includes('建设许可证'));
  await workspace.addFiles([new File(['审计内容'],'报告.txt')],'audit');assert.equal(state.files.update[0].uploadStatus,'error');assert(workspace.page('update').includes('retry-project-upload'));
  fail=false;await workspace.click('retry-project-upload','0');assert.equal(state.files.update[0].stored,true);assert(workspace.page('update').includes('已上传并保存'));
  state.drafts.update.authoringMode='historical';html=workspace.page('update');assert(html.includes('本发行人历史募集书'));assert(!html.includes('相似募集书'));
  state.route='review';html=workspace.page('review');for(const text of ['财务数据核对','合规与格式检查','公开信息核验','待复核募集书','审计报告 / 财务报表及附注'])assert(html.includes(text));assert(!html.includes('募投项目与权证材料'));
});
test('material studio prompts for a source, offers five templates and submits the selected kind with supporting files',async()=>{
  const state={route:'generate',accountEpoch:0,user:{id:'test'},health:{materialStudioVersion:1,oneClickExecution:true},jobs:[]},location={hash:''},requests=[];
  const studio=materialStudio({state,location,esc,icon:()=>'',bytes:n=>n+'B',head:()=>'',api:async()=>({templates:[]}),upload:async(path,body,{onProgress})=>{requests.push({path,body});onProgress({percent:25});assert(studio.page().includes('25%'));return {job:{id:'generated'}};},render:async()=>{},toast:()=>{},refreshJobs:async()=>{}});
  let html=studio.page();for(const type of GENERATION_TYPES)assert(html.includes(type.title));assert(html.includes('立项券商全称'));assert(html.includes('立项相关规则'));assert(html.includes('上传最新版募集书'));assert.equal(state.materialDraft.sourceMode,'upload');assert(html.indexOf('value="upload"')<html.indexOf('value="project"'));assert(html.includes('data-studio-upload="prospectus"'));assert(html.includes('材料生成要求与说明'));assert(!html.includes('studio-cowork'));assert(html.includes('data-studio-field="market"'));assert(!html.includes('用自然语言补充写作要求'));
  await studio.change({dataset:{studioField:'type'},value:'summary'});
  assert(!studio.page().includes('立项券商全称'));assert(studio.page().includes('公募债摘要'));
  await assert.rejects(studio.submit({id:'material-studio-form',reportValidity:()=>true}),/最新版募集书/);
  studio.addFiles([new File(['募集书'],'latest.docx')],'prospectus');studio.input({dataset:{studioField:'instructionDraft'},value:'请保留风险提示'});
  await studio.submit({id:'material-studio-form',reportValidity:()=>true});assert.equal(requests[0].path,'/api/generation/tasks');assert.equal(requests[0].body.get('materialType'),'summary');assert.equal(requests[0].body.get('instructions'),'请保留风险提示');assert(requests[0].body.has('prospectus'));assert(!requests[0].body.has('projectId'));assert.equal(location.hash,'task/generated');
});

test('assessment locks edits, ignores duplicate submission and refreshes material keys after parsing failure',async()=>{
  const state={route:'update',step:2,accountEpoch:0,health:{authoringVersion:2,projectInputVersion:3},files:{update:[{stored:true,key:'before',role:'audit',file:{name:'audit.txt',size:10}}],review:[]},drafts:{update:{projectId:'p',authoringMode:'reference',exchange:'sse',offering:'private',updateMode:'full',issuer:'测试',title:'测试'}},connectors:[],billing:null};
  const draft=kind=>state.drafts[kind],shared={state,esc,icon:()=>'',bytes:n=>n+'B',head:()=>'',draft,reportingPreview:()=>''},requests=[];
  let rejectUpload,entered;const started=new Promise(resolve=>{entered=resolve;});
  const workspace=projectWorkspace({...shared,authoring:authoringUI(shared),api:async(path,options)=>{requests.push({path,options});return {job:{files:[{key:'after',role:'audit',filename:'audit.txt',size:10}]}};},post:async()=>({}),toast:()=>{},saveDraft:()=>{},render:async()=>{},refreshJobs:async()=>{},upload:async()=>{entered();return new Promise((resolve,reject)=>{rejectUpload=reject;});}});
  const form={id:'workflow-form',reportValidity:()=>true},operation=workspace.submit(form);
  await started;assert.match(workspace.page('update'),/workspace-controls" disabled aria-busy="true"/);
  await assert.rejects(workspace.addFiles([new File(['新资料'],'new.txt')],'audit'),/正在处理当前材料/);
  await workspace.submit(form);await workspace.click('remove-file','0');assert.equal(requests.length,0);assert.equal(state.files.update.length,1);
  rejectUpload(new Error('部分文件未提取到文字'));await assert.rejects(operation,/未提取到文字/);
  assert.equal(state.files.update[0].key,'after');assert.equal(state.step,2);assert(!workspace.page('update').includes('disabled aria-busy="true"'));
  await workspace.click('remove-file','0');assert.equal(requests.at(-1).path,'/api/projects/p/materials/after');assert.equal(state.files.update.length,0);
});

test('material source defaults to upload even with an old empty project choice, while an explicitly linked draft remains linked',()=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  let saved={sourceMode:'project',projectId:''};
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>JSON.stringify(saved),setItem:()=>{}}});
  try{
    const make=()=>{
      const state={route:'generate',accountEpoch:0,user:{id:'test'},health:{materialStudioVersion:1,oneClickExecution:true},jobs:[{id:'existing',title:'已选项目',kind:'update',status:'complete'}]};
      const studio=materialStudio({state,esc,icon:()=>'',bytes:()=>'',head:()=>'',api:async()=>({}),upload:async()=>({}),render:async()=>{},toast:()=>{},refreshJobs:async()=>{}});
      const html=studio.page();return {state,html};
    };
    let result=make();assert.equal(result.state.materialDraft.sourceMode,'upload');assert(result.html.includes('data-studio-upload="prospectus"'));
    saved={sourceMode:'project',projectId:'existing'};result=make();assert.equal(result.state.materialDraft.sourceMode,'project');assert(result.html.includes('value="existing" selected'));assert(result.html.indexOf('value="upload"')<result.html.indexOf('value="project"'));
  }finally{if(original)Object.defineProperty(globalThis,'localStorage',original);else delete globalThis.localStorage;}
});

function studioFixture(options={}){
  const requests=[],state={route:'generate',accountEpoch:0,user:{id:'studio-conversation-test'},health:{materialStudioVersion:1,oneClickExecution:true},jobs:[]};
  const studio=materialStudio({state,location:{hash:''},document:{querySelector:()=>({focus(){}})},esc,icon:()=>'',bytes:n=>n+'B',head:()=>'',api:async(path)=>{requests.push({path});return {templates:[]};},upload:async(path,body)=>{requests.push({path,body});return {job:{id:'generated'}};},render:async()=>{},toast:()=>{},refreshJobs:async()=>{},...options});
  const write=text=>studio.input({dataset:{studioField:'instructionDraft'},value:text});
  const add=()=>studio.submit({id:'studio-message-form'});
  const generate=()=>studio.submit({id:'material-studio-form',reportValidity:()=>true});
  const source=async()=>{await studio.change({dataset:{studioField:'type'},value:'summary'});studio.addFiles([new File(['募集书'],'latest.docx')],'prospectus');};
  return {state,studio,requests,write,add,generate,source};
}

test('material conversation is a separate right-side form with one composer and template structure on the left',async()=>{
  const {studio,state,source}=studioFixture();await source();
  let html=studio.page(),aside=html.indexOf('<aside'),left=html.slice(0,aside),right=html.slice(aside);
  assert(left.includes('studio-template-details'));assert(left.includes('data-studio-upload="prospectus"'));assert(!left.includes('<textarea'));
  assert(left.includes('</form>'));assert(!right.includes('studio-template-details'));assert(right.includes('id="studio-message-form"'));assert(right.includes('latest.docx'));assert(right.includes('募集说明书摘要'));
  assert.equal((html.match(/<textarea\b/g)||[]).length,1);assert(!html.includes('data-studio-field="instructions"'));
  let formDepth=0;for(const token of html.matchAll(/<\/?form\b[^>]*>/g)){formDepth+=token[0].startsWith('</')?-1:1;assert(formDepth>=0&&formDepth<=1,'forms must not be nested');}assert.equal(formDepth,0);
  state.jobs.push({id:'linked',title:'关联的募集书项目',kind:'update',status:'complete'});
  await studio.change({dataset:{studioField:'sourceMode'},value:'project'});await studio.change({dataset:{studioField:'projectId'},value:'linked'});
  right=studio.page().split('<aside')[1];assert(right.includes('关联的募集书项目'));assert(!right.includes('latest.docx'));
});

test('requirements can be added, edited and removed without requests, and generation includes the latest notes and pending draft once',async()=>{
  const {studio,state,requests,write,add,generate,source}=studioFixture();await source();
  write('  请重点介绍原来的用途。  ');await add();write('这条之后移除。');await add();
  await studio.click('studio-instruction-edit','0');assert.equal(state.materialDraft.instructionDraft,'请重点介绍原来的用途。');
  write('请重点介绍最新的偿债安排。');await add();await studio.click('studio-instruction-remove','1');
  write('金额单位统一为万元。');assert.equal(requests.length,0);assert.equal(state.materialDraft.instructionMessages.length,1);
  await generate();assert.equal(requests.length,1);assert.equal(requests[0].body.get('instructions'),'请重点介绍最新的偿债安排。\n\n金额单位统一为万元。');assert.equal(state.materialDraft.instructionDraft,'');
  assert.equal(state.materialDraft.instructionMessages.length,2);
});

test('writing shortcuts preserve entered text and beginning an edit preserves unfinished extra information',async()=>{
  const {studio,state,requests,write,add}=studioFixture();studio.page();
  write('已有一条要求。');await add();write('授信总额为20亿元。');await studio.click('studio-writing-prompt','format');
  assert(state.materialDraft.instructionDraft.startsWith('授信总额为20亿元。\n'));assert(state.materialDraft.instructionDraft.includes('金额单位'));
  const pending=state.materialDraft.instructionDraft;await studio.click('studio-instruction-edit','0');
  assert.equal(state.materialDraft.instructionMessages[1].text,pending);assert.equal(state.materialDraft.instructionDraft,'已有一条要求。');
  write('取消后不采用的修改');await studio.click('studio-instruction-cancel');assert.equal(state.materialDraft.instructionMessages[0].text,'已有一条要求。');assert.equal(state.materialDraft.instructionDraft,'');assert.equal(requests.length,0);
});

test('generation applies an unfinished edit as a replacement and removing an earlier note keeps the edit attached to its note',async()=>{
  const {studio,state,requests,write,add,generate,source}=studioFixture();await source();
  write('删除的说明');await add();write('需要更改的说明');await add();
  await studio.click('studio-instruction-edit','1');write('这条说明的最终版本');await studio.click('studio-instruction-remove','0');
  assert.equal(state.materialDraft.instructionEditIndex,0);assert.equal(state.materialDraft.instructionDraft,'这条说明的最终版本');
  await generate();assert.equal(requests[0].body.get('instructions'),'这条说明的最终版本');
});

test('legacy writing instructions migrate once and notes plus an unfinished edit survive a new studio instance',async()=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),key='bondbuddy-material-studio-conversation-test',storage=new Map([[key,JSON.stringify({instructions:'旧版填写的写作要求'})]]);
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)}});
  try{
    let fixture=studioFixture();fixture.studio.page();assert.deepEqual(fixture.state.materialDraft.instructionMessages,[{text:'旧版填写的写作要求'}]);assert.equal(fixture.state.materialDraft.instructions,undefined);
    fixture.write('新增说明');await fixture.add();await fixture.studio.click('studio-instruction-edit','0');fixture.write('尚未保存的修改');
    fixture=studioFixture();fixture.studio.page();assert.deepEqual(fixture.state.materialDraft.instructionMessages,[{text:'旧版填写的写作要求'},{text:'新增说明'}]);assert.equal(fixture.state.materialDraft.instructionDraft,'尚未保存的修改');assert.equal(fixture.state.materialDraft.instructionEditIndex,0);
    await fixture.add();assert.deepEqual(JSON.parse(storage.get(key)).instructionMessages,[{text:'尚未保存的修改'},{text:'新增说明'}]);assert.equal(JSON.parse(storage.get(key)).instructions,undefined);
  }finally{if(original)Object.defineProperty(globalThis,'localStorage',original);else delete globalThis.localStorage;}
});

test('combined writing requirements are checked before uploading and an over-limit draft stays editable',async()=>{
  const {state,requests,write,add,generate,source}=studioFixture();await source();
  write('甲'.repeat(11998));await add();write('乙');
  await assert.rejects(add(),/12000/);await assert.rejects(generate(),/12000/);
  assert.equal(requests.length,0);assert.equal(state.materialDraft.instructionMessages.length,1);assert.equal(state.materialDraft.instructionDraft,'乙');assert.equal(state.materialDraft.busy,false);
});

test('upload locks the conversation and a failed upload retains instructions for a retry without duplicating them',async()=>{
  let rejectUpload,entered;const started=new Promise(resolve=>{entered=resolve;}),bodies=[];
  const {studio,state,write,add,generate,source}=studioFixture({upload:async(path,body)=>{bodies.push(body);if(bodies.length===1){entered();return new Promise((resolve,reject)=>{rejectUpload=reject;});}return {job:{id:'retry'}};}});await source();
  write('请保留这条生成要求');const operation=generate();await started;
  assert(studio.page().includes('<fieldset disabled>'));assert(!studio.page().includes('<aside'));
  write('上传时不应该被改写');await studio.change({dataset:{studioField:'type'},value:'opinion'});await studio.click('studio-instruction-remove','0');await studio.click('studio-writing-prompt','extra');await add();await generate();
  assert.equal(state.materialDraft.type,'summary');assert.equal(state.materialDraft.instructionMessages[0].text,'请保留这条生成要求');assert.equal(state.materialDraft.instructionDraft,'');assert.equal(bodies.length,1);
  rejectUpload(new Error('连接中断'));await assert.rejects(operation,/连接中断/);assert.equal(state.materialDraft.busy,false);assert.equal(state.materialDraft.files.length,1);
  await generate();assert.equal(bodies.length,2);assert.equal(bodies[1].get('instructions'),'请保留这条生成要求');
});
