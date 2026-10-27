import {test,expect,type Page} from '@playwright/test';
import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Value} from '@sinclair/typebox/value';
import {schemas,emptyUpdateDetails,M4DraftRequestSchema,M4ExecuteRequestSchema,AssistantCardRequestSchema} from '@bondbuddy/contracts';
import type {Dto} from '../src/api';
import '../src/schema-formats';
import {docx} from './word-roundtrip-fixtures';

const now='2026-10-26T08:00:00Z',hash='a'.repeat(64),otherHash='b'.repeat(64);
const prior={source_project_id:'project',artifact_id:'prior-clean',artifact_version:2,sha256:otherHash};
const original={source_project_id:'project',artifact_id:'original-clean',artifact_version:1,sha256:hash};
const word='application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function setup(page:Page,{linkedProject='project',generation=false}={}){
  const w:any={topic:{topic_id:'topic',project_id:'scope',source_project_id:'project',name:'合成续改对话',surface:'assistant',created_at:now,updated_at:now},
    project:{project_id:'scope',kind:'qa',name:'合成续改对话',draft_revision:1},materials:[],material_details:[],drafts:{},templates:[],messages:[],tasks:[],artifacts:[],pending_requirements:[],active_run:null,
    view:{version:0,selected_document_type:null,open_tabs:[],active_tab:null,unsent_content:'保留原来的未发送说明',unsent_context:{document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:prior},
      assistant:{project_id:linkedProject,action:{business:'update',requirements:'保留原草稿的补充要求',fields:{issuer_name:'合成发行人'}}}}};
  const data:any={project:{project_id:'project',kind:'update',name:'合成募集书项目',issuer_name:'合成发行人',market:'sse',offering:'private',draft_revision:1,update_details:{reporting_cutoff:'2026-06-30'}},materials:[],results:[
    {pin:original,run_id:'original-run',filename:'原任务清洁版.docx',label:'原任务清洁版 · V1',created_at:now},
    {pin:prior,run_id:'prior-run',filename:'此前选择的另一份成果.docx',label:'此前选择的另一份成果 · V2',created_at:now}]};
  const cards:any[]=['original','second'].map((id,i)=>({card_id:id+'-card',operation:'update',project_id:'project',execution_request_id:id+'-request',draft_token:id+'-draft',target:{issuer_name:'合成发行人',market:'sse',offering:'private',reporting_cutoff:'2026-06-30'},
    created_at:now,project_name:i?'另一项合成任务':'要继续修改的原任务',requirements:'原任务已固定的要求',material_names:['合成原稿.docx'],baseline:null,quote:{points:4500},balance:{available:100000,frozen:0},
    run:{run_id:i?'second-run':'original-run',project_id:'project',state:'succeeded',stage:'word_delivery_pair',input_revision:1,artifact_id:null,updated_at:now}}));
  const otherData:any={project:{...structuredClone(data.project),project_id:'review-project',kind:'review',name:'另一复核项目'},materials:[],results:[structuredClone(data.results[1])]};
  if(linkedProject==='review-project'){
    const source=(material_id:string)=>({material_id,material_version:1,sha256:hash,issuer_name:'合成原发行人',relation:'same_issuer',market:'sse',offering:'private',status:'user_asserted',
      reporting_periods:[{start:'2025-01-01',end:'2025-12-31',period_kind:'annual',scope:'consolidated',status:'user_asserted',evidence_refs:[]}]});
    data.project.update_details={...emptyUpdateDetails(),reporting_cutoff:'2026-06-30',source_prospectuses:[source('source-A')]};
    data.materials=[{material_id:'source-A',material_version:1,upload_id:'upload-A',filename:'A项目原募集书.docx',media_type:word,byte_size:100,sha256:hash,role:'historical',state:'persisted',persisted_at:now,error:null}];
    expect(Value.Check(schemas.MaterialResponse,data.materials[0])).toBe(true);
    otherData.project.update_details={...emptyUpdateDetails(),reporting_cutoff:'2026-06-30',source_prospectuses:[source('source-B')]};
    w.view.assistant.source_prospectuses=structuredClone(otherData.project.update_details.source_prospectuses);
    w.view.unsent_context.source_material={source_project_id:'review-project',material_id:'source-B',material_version:1,sha256:hash};
  }
  const metadata:Dto<'ArtifactResponse'>={artifact_id:original.artifact_id,run_id:'original-run',version:1,media_type:word,sha256:hash,quality_status:'passed',delivery_status:'available',download_url:'/api/v1/artifacts/original-clean/download',expires_at:'2099-01-01T00:00:00Z',
    word_delivery:{variant:'clean',clean_artifact_id:original.artifact_id,revision_artifact_id:'original-revision',writer_version:'bondbuddy-unified-word-1.0.0',
      source_sha256:null,baseline_hash:null,effective_baseline_sha256:null,plan_hash:null,replacements:0,columns:0,pending_review_count:0,pending_review:[]}};
  expect(Value.Check(schemas.ArtifactResponse,metadata)).toBe(true);
  if(generation){
    cards[0].operation='generation';cards[0].project_id='scope';cards[0].document_type='private_summary';cards[0].run.project_id='scope';
    delete metadata.word_delivery;
    w.drafts.private_summary={document_type:'private_summary',version:0,sha256:hash,updated_at:null,source_material:null,materials:[],template:null,edit_base:null,scope:'whole',fields:{},requirements:[]};
    expect(Value.Check(schemas.ArtifactResponse,metadata)).toBe(true);
  }
  const bytes=docx('合成材料续改后的 Word 正文；不代表真实模型生成。'),bytesHash=createHash('sha256').update(bytes).digest('hex');
  const delivered:Dto<'ArtifactResponse'>={artifact_id:'continued-document',run_id:'continued-run',version:1,filename:'合成募集书摘要_续改_V2.docx',media_type:word,sha256:bytesHash,quality_status:'passed',delivery_status:'available',download_url:'/api/v1/artifacts/continued-document/download',expires_at:'2099-01-01T00:00:00Z'};
  expect(Value.Check(schemas.ArtifactResponse,delivered)).toBe(true);
  const writes:{path:string;body:any}[]=[];let projectReads=0,failProject=false,failMetadata=false,holdRead=false,release:(()=>void)|undefined,heldResolve:(()=>void)|undefined;
  const held=new Promise<void>(resolve=>heldResolve=resolve);
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname.replace('/api/v1','');let body:unknown={},status=200;
    if(req.method()!=='GET')writes.push({path,body:req.postDataJSON()});
    if(path==='/me')body={user_id:'synthetic-continuation-owner',session_status:'active'};
    else if(path==='/account')body={user_id:'synthetic-continuation-owner',username:'synthetic'};
    else if(path==='/credits/balance')body={enabled:true,available:100000,frozen:0};
    else if(path==='/projects')body={items:[],page:{has_more:false,next_cursor:null}};
    else if(path==='/m4/topics')body={topics:[w.topic]};
    else if(path==='/m4/topics/topic/workspace')body=w;
    else if(path==='/assistant/topics/topic/cards'){
      if(req.method()==='GET')body={cards};
      else{const input=req.postDataJSON();expect(Value.Check(AssistantCardRequestSchema,input)).toBe(true);
        if(input.operation==='generation'?input.project_id!==w.topic.project_id:input.project_id!==w.view.assistant.project_id){status=409;body={code:'INPUT_REVISION_CONFLICT'};}
        else{const card={...input,draft_token:w.view.assistant.draft_token,target:cards[0].target,created_at:'2026-10-26T08:01:00Z',project_name:'合成续改确认卡',requirements:w.view.assistant.action?.requirements??'',material_names:[],baseline:w.view.unsent_context.reading_artifact,quote:{points:4500},balance:{available:100000,frozen:0},run:null};cards.push(card);body={card};}}
    }
    else if(path==='/assistant/projects/project'){
      projectReads++;
      if(holdRead){heldResolve?.();await new Promise<void>(resolve=>release=resolve);holdRead=false;}
      if(failProject){status=503;body={code:'DATA_UNAVAILABLE'};}else body=data;
    }else if(path==='/assistant/projects/review-project')body=otherData;
    else if(path==='/assistant/projects/scope')body={project:{...w.project,market:'sse',offering:'private'},materials:[],results:[{...data.results[0],pin:{...original,source_project_id:'scope'}}]};
    else if(path==='/artifacts/original-clean'){if(failMetadata){status=503;body={code:'DATA_UNAVAILABLE'};}else body=metadata;}
    else if(path==='/projects/project'&&req.method()==='PATCH'){data.project={...data.project,...req.postDataJSON(),draft_revision:data.project.draft_revision+1};body=data.project;}
    else if(path==='/projects/project/messages')body={project_message_set_ref:{version:1,content_sha256:hash,message_ids:[]}};
    else if(path==='/projects/project/input-revisions')body={project_id:'project',input_revision:2,input_hash:hash};
    else if(path==='/projects/project/credit-quote')body={enabled:true,quote:{quote_id:'continued-update-quote',points:4500},balance:{available:100000,frozen:0}};
    else if(path==='/m4/topics/topic/drafts/private_summary'){const input=req.postDataJSON();expect(Value.Check(M4DraftRequestSchema,input)).toBe(true);w.drafts.private_summary={...input.input,version:w.drafts.private_summary.version+1,sha256:hash,updated_at:now};body={draft:w.drafts.private_summary};}
    else if(path==='/m4/topics/topic/quote')body={quote:{quote_id:'continued-document-quote',topic_id:'topic',input_hash:hash,points:4500,task_type:'m4_G05',billing_method:'fixed',amount_semantics:'fixed_price'},balance:{available:100000,frozen:0},shortage:0};
    else if(path==='/m4/topics/topic/execute'){const input=req.postDataJSON();expect(Value.Check(M4ExecuteRequestSchema,input)).toBe(true);const card=cards.find(card=>card.execution_request_id===input.execution_request_id);expect(card).toBeTruthy();card.run={run_id:'continued-run',project_id:'scope',state:'queued',stage:'queued',input_revision:1,artifact_id:null,updated_at:now};body={run:card.run};}
    else if(path==='/artifacts/continued-document')body=delivered;
    else if(path==='/artifacts/continued-document/download'){await route.fulfill({contentType:word,body:bytes});return;}
    else if(path==='/m4/topics/topic/view'){const input=req.postDataJSON();expect(input.expected_version).toBe(w.view.version);w.view={...input.view,version:w.view.version+1};body={view:w.view};}
    else{status=404;body={code:'NOT_FOUND'};}
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('/#tasks');await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();
  await expect(page.locator('[data-card=original-card]')).toBeVisible();await expect(page.locator('[data-baseline]')).toHaveValue(prior.artifact_id);
  return {w,data,otherData,cards,metadata,delivered,bytes,writes,projectReads:()=>projectReads,fail:()=>failProject=true,failArtifact:()=>failMetadata=true,hold:()=>holdRead=true,held,release:()=>release?.()};
}
const continueOriginal=(page:Page)=>page.locator('[data-card=original-card]').getByRole('button',{name:'继续修改',exact:true}).click();
async function retained(page:Page,s:Awaited<ReturnType<typeof setup>>){
  await expect(page.locator('.ba-form')).toHaveCount(0);await expect(page.locator('[data-composer]')).toHaveValue('保留原来的未发送说明');
  await expect(page.locator('[data-baseline]')).toHaveValue(prior.artifact_id);
  expect(s.w.view.unsent_context.reading_artifact).toEqual(prior);expect(s.w.view.assistant.action.requirements).toBe('保留原草稿的补充要求');
  expect(s.writes).toEqual([]);
}
async function capture(page:Page,name:string){const dir=process.env.BB_UX_COVERAGE_EVIDENCE_DIR;if(dir){await mkdir(dir,{recursive:true});await page.screenshot({path:join(dir,name+'.png'),fullPage:true});}}

test.use({viewport:{width:1440,height:960}});
test('continuing a successful card selects its exact original clean result and saves only a draft',async({page})=>{
  const s=await setup(page);await continueOriginal(page);
  await expect(page.locator('.ba-form')).toBeVisible();await expect(page.locator('[data-baseline]')).toHaveValue(original.artifact_id);
  await expect(page.locator('[data-status]')).toContainText('已选中这项任务的原成果');
  expect(s.w.view.unsent_context.reading_artifact).toEqual(original);expect(s.w.view.unsent_content).toBe('保留原来的未发送说明');
  expect(s.writes.length).toBeGreaterThan(0);expect(s.writes.every(write=>write.path==='/m4/topics/topic/view')).toBe(true);
  await capture(page,'assistant-continuation-original-1440');
});

for(const invalid of ['missing','ambiguous','invalid-version','foreign-project','shared-artifact'] as const)test('original result '+invalid+' never reuses an earlier selected baseline',async({page})=>{
  const s=await setup(page);
  if(invalid==='missing')s.data.results=s.data.results.slice(1);
  else if(invalid==='ambiguous')s.data.results.push({...s.data.results[0],pin:{...original,artifact_id:'another-clean'}});
  else if(invalid==='invalid-version')s.data.results[0].pin={...original,artifact_version:0};
  else if(invalid==='foreign-project')s.data.results[0].pin={...original,source_project_id:'other-project'};
  else s.data.results.push({...s.data.results[0],run_id:'other-run'});
  await continueOriginal(page);await expect(page.locator('[data-status]')).toContainText('无法唯一确认这项任务的原成果');await retained(page,s);
  if(invalid==='missing')await capture(page,'assistant-continuation-missing-1440');
});

for(const invalid of ['wrong-run','wrong-version','wrong-hash','unavailable','wrong-media','revision-instead-of-clean'] as const)test('unverified original artifact '+invalid+' keeps the complete prior draft',async({page})=>{
  const s=await setup(page);
  if(invalid==='wrong-run')s.metadata.run_id='other-run';
  if(invalid==='wrong-version')s.metadata.version=2;
  if(invalid==='wrong-hash')s.metadata.sha256=otherHash;
  if(invalid==='unavailable')s.metadata.delivery_status='test_only';
  if(invalid==='wrong-media')s.metadata.media_type='text/plain';
  if(invalid==='revision-instead-of-clean')s.metadata.word_delivery!.variant='revision';
  await continueOriginal(page);await expect(page.locator('[data-status]')).toContainText('原成果版本或下载状态无法核实');await retained(page,s);
});

test('a failed original project read keeps the complete prior draft and does not prepare another task',async({page})=>{
  const s=await setup(page);s.fail();await continueOriginal(page);await expect(page.locator('[data-status]')).toContainText('服务暂时无法完成操作');await retained(page,s);
});

test('a failed original artifact read keeps the complete prior draft and does not prepare another task',async({page})=>{
  const s=await setup(page);s.failArtifact();await continueOriginal(page);await expect(page.locator('[data-status]')).toContainText('服务暂时无法完成操作');await retained(page,s);
});

test('continuing an old project A card replaces project B source context durably and prepares only the A confirmation',async({page})=>{
  const s=await setup(page,{linkedProject:'review-project'});
  expect(s.w.view.assistant.project_id).toBe('review-project');expect(s.w.view.assistant.source_prospectuses[0].material_id).toBe('source-B');
  await continueOriginal(page);await expect(page.locator('[data-status]')).toContainText('已选中这项任务的原成果');
  expect(s.w.view.assistant.project_id).toBe('project');expect(s.w.view.assistant.source_prospectuses).toEqual(s.data.project.update_details.source_prospectuses);
  expect(s.w.view.unsent_context.source_material).toBeNull();expect(s.w.view.assistant.copy_source_project_id).toBeUndefined();expect(s.w.view.assistant.project_creation_request_id).toBeUndefined();
  await page.reload();await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();
  await expect(page.locator('.ba-project-button')).toContainText('合成募集书项目');await expect(page.locator('[data-baseline]')).toHaveValue(original.artifact_id);
  await continueOriginal(page);await page.locator('[data-requirements]').fill('只修改A项目原成果的偿债说明');await page.getByRole('button',{name:'核对本次任务',exact:true}).click();
  const confirmation=page.locator('.ba-task').filter({hasText:'只修改A项目原成果的偿债说明'});await expect(confirmation.getByRole('button',{name:'开始更新',exact:true})).toBeVisible();
  const input=s.writes.find(write=>write.path==='/projects/project/input-revisions')!.body;
  expect(input.material_versions).toEqual([{material_id:'source-A',material_version:1}]);expect(input.edit_base).toEqual({artifact_id:original.artifact_id,artifact_version:1,sha256:hash});
  expect(s.writes.some(write=>write.path==='/runs/execute'||write.path.endsWith('/execute')||write.path==='/projects')).toBe(false);
  expect(s.writes.filter(write=>write.path==='/assistant/topics/topic/cards')).toHaveLength(1);
});

test('same-project continuation preserves saved assistant source information until preparation',async({page})=>{
  const s=await setup(page,{linkedProject:'review-project'});
  const serverSource=structuredClone(s.data.project.update_details.source_prospectuses[0]);
  const savedSource={...serverSource,issuer_name:'已保存的原发行人修订名称',relation:'parent',market:'szse',offering:'private',
    reporting_periods:[{start:'2024-01-01',end:'2024-12-31',period_kind:'annual',scope:'parent',status:'user_asserted',evidence_refs:[]}]};
  // This is a saved assistant draft; preparing it has not yet patched the business project.
  s.w.view={...s.w.view,version:s.w.view.version+1,assistant:{...s.w.view.assistant,project_id:'project',source_prospectuses:[savedSource]}};
  await page.reload();await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();
  await expect(page.locator('.ba-project-button')).toContainText('合成募集书项目');
  expect(s.w.view.assistant.source_prospectuses).toEqual([savedSource]);
  expect(s.data.project.update_details.source_prospectuses).toEqual([serverSource]);
  await continueOriginal(page);await expect(page.locator('[data-status]')).toContainText('已选中这项任务的原成果');
  expect(s.w.view.assistant.source_prospectuses).toEqual([savedSource]);
  expect(s.data.project.update_details.source_prospectuses).toEqual([serverSource]);
  expect(s.writes.every(write=>write.path==='/m4/topics/topic/view')).toBe(true);
});

test('generation continues the exact document through confirmation, explicit execution, the same completed run and a verified Word download',async({page})=>{
  const s=await setup(page,{generation:true});await continueOriginal(page);
  await expect(page.locator('.ba-form')).toBeVisible();await expect(page.locator('[data-field=document_type]')).toHaveValue('private_summary');
  expect(s.w.view.assistant.project_id).toBe('project');expect(s.w.view.unsent_context.reading_artifact).toEqual({...original,source_project_id:'scope'});
  await page.locator('[data-requirements]').fill('只修改本份摘要，保留其他正文');await page.getByRole('button',{name:'核对本次任务',exact:true}).click();
  const confirmation=page.locator('.ba-task').filter({hasText:'只修改本份摘要，保留其他正文'});
  await expect(confirmation.getByRole('button',{name:'确认并开始',exact:true})).toBeVisible();
  expect(s.writes.filter(write=>write.path.endsWith('/execute'))).toHaveLength(0);
  expect(s.w.drafts.private_summary.edit_base).toEqual({...original,source_project_id:'scope'});
  await confirmation.getByRole('button',{name:'确认并开始',exact:true}).click();
  await expect(confirmation).toContainText('排队等待处理');
  const card=s.cards.find(card=>card.card_id!== 'original-card'&&card.card_id!== 'second-card')!;
  expect(card.run.run_id).toBe('continued-run');card.run={...card.run,state:'succeeded',stage:'word_delivery',artifact_id:s.delivered.artifact_id};
  await expect(confirmation.getByRole('button',{name:'下载成果',exact:true})).toBeVisible({timeout:12000});
  const downloaded=page.waitForEvent('download');await confirmation.getByRole('button',{name:'下载成果',exact:true}).click();const download=await downloaded;
  expect(download.suggestedFilename()).toBe(s.delivered.filename);const actual=await readFile((await download.path())!);
  expect(actual.equals(s.bytes)).toBe(true);expect(createHash('sha256').update(actual).digest('hex')).toBe(s.delivered.sha256);expect(actual.subarray(0,2).toString()).toBe('PK');
  const executions=s.writes.filter(write=>write.path==='/m4/topics/topic/execute');expect(executions).toHaveLength(1);expect(executions[0].body.execution_request_id).toBe(card.execution_request_id);
  expect(card.run.run_id).toBe('continued-run');expect(s.writes.some(write=>write.path==='/runs/execute')).toBe(false);
});

for(const intent of ['another-card','new-conversation','new-draft'] as const)test('a late original result cannot replace '+intent,async({page})=>{
  const s=await setup(page);s.hold();await continueOriginal(page);await s.held;
  if(intent==='another-card')await page.locator('[data-card=second-card] [data-a=continue]').click();
  else if(intent==='new-conversation')await page.locator('[data-a=new]').click();
  else await page.locator('[data-composer]').evaluate((el:HTMLTextAreaElement)=>{el.value='用户刚写下的新草稿';el.dispatchEvent(new Event('input',{bubbles:true}));});
  s.release();await expect(page.locator('[data-status]')).toContainText('当前选择或草稿已变化');
  await expect(page.locator('.ba-form')).toHaveCount(0);await expect(page.locator('[data-baseline]')).toHaveValue(prior.artifact_id);
  await expect(page.locator('[data-composer]')).toHaveValue(intent==='new-draft'?'用户刚写下的新草稿':'保留原来的未发送说明');
  expect(s.w.view.unsent_context.reading_artifact).toEqual(prior);expect(s.writes.every(write=>write.path==='/m4/topics/topic/view')).toBe(true);
});

test('successful review cards keep the existing review preparation flow without requiring a Word edit base',async({page})=>{
  const s=await setup(page);s.cards[0].operation='review';s.data.results=s.data.results.slice(1);
  // Reload the persisted card so the UI receives the updated operation through the normal read.
  await page.reload();await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();await continueOriginal(page);
  await expect(page.locator('.ba-form')).toBeVisible();await expect(page.locator('[data-status]')).toContainText('已打开复核准备');
  expect(s.w.view.assistant.action.business).toBe('review');expect(s.writes.every(write=>write.path==='/m4/topics/topic/view')).toBe(true);
});
