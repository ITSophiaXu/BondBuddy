import { taskPage } from './collection-fixtures';
import { test,expect,type Page,type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { duplicateUploadFixture } from './duplicate-upload-fixture';
import { Value } from '@sinclair/typebox/value';
import { M4_DOCUMENT_TYPES,M4_DOCUMENT_BILLING_TASKS,M4DraftRequestSchema,M4ViewRequestSchema,M4MessageRequestSchema,M4ExecuteRequestSchema,
  type M4Workspace,type M4DocumentType,type M4Draft,type M4Artifact,type M4Task,type M4MessageRequest,type M4ExecuteRequest,type M4QuoteRequest,type Run } from '@bondbuddy/contracts';

// Owner-scoped synthetic HTTP fixtures. These verify browser behavior, not model or DOCX quality.
test('SSE opinion template exposes recovered headings and is pinned in the submitted draft',async({page})=>{
  const s=fixture();s.workspace.drafts.underwriter.materials=[s.workspace.materials[0]];
  await mount(page,s);await choose(page,'underwriter');
  await page.locator('#m4-case-template').selectOption('sse-private-underwriter');
  await page.getByText('查看模板结构',{exact:true}).click();
  await expect(page.locator('.studio-template-details')).toContainText('内核关注的主要问题及解决情况');
  await expect(page.locator('#m4-case-template option[value="szse-private-underwriter"]')).toHaveCount(0);
  await page.getByRole('button',{name:'生成主承销商核查意见',exact:true}).click();
  await expect.poll(()=>s.executions.length).toBe(1);
  expect(s.workspace.drafts.underwriter.fields.case_template_id).toBe('sse-private-underwriter');
  expect(s.executions[0].document_type).toBe('underwriter');
});
for(const width of [1440,390])test(`case template application and recommendation selectors preserve scope and drafts at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:960});
  const s=fixture();s.workspace.drafts.application.materials=[s.workspace.materials[0]];s.workspace.drafts.recommendation.materials=[s.workspace.materials[0]];
  await mount(page,s);await choose(page,'application');
  await expect(page.locator('[data-m4-type]')).toHaveCount(M4_DOCUMENT_TYPES.length);
  await expect(page.locator('#m4-case-template')).toBeVisible();
  await page.locator('#m4-market').selectOption('szse');await page.locator('#m4-case-template').selectOption('szse-private-application-alt');
  await page.getByText('查看模板结构',{exact:true}).click();await expect(page.locator('.studio-template-details')).toContainText('一、发行人概况');
  const dir=resolve('test-evidence/case-templates-20261015');await mkdir(dir,{recursive:true});
  await page.screenshot({path:resolve(dir,`application-${width}.png`),fullPage:true});
  await choose(page,'recommendation');await page.getByRole('button',{name:'生成推荐函',exact:true}).click();
  await expect(page.getByRole('alert',{name:'需要补充的信息'})).toContainText('请选择推荐函对应的品种');expect(s.executions).toHaveLength(0);
  await page.locator('#m4-market').selectOption('nafmii');await page.locator('#m4-offering').selectOption('mtn');
  await expect(page.locator('#m4-market option[value="sse"]')).toHaveCount(0);
  await page.locator('#m4-case-template').selectOption('nafmii-mtn-recommendation-alt');
  await page.locator('#m4-offering').selectOption('ppn');await expect(page.locator('#m4-case-template')).toHaveValue('');
  await expect(page.locator('#m4-case-template option[value="nafmii-mtn-recommendation-alt"]')).toHaveCount(0);
  await page.screenshot({path:resolve(dir,`recommendation-${width}.png`),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.getByRole('button',{name:'生成推荐函',exact:true}).click();await expect.poll(()=>s.executions.length).toBe(1);
  expect(s.executions[0].document_type).toBe('recommendation');expect(s.workspace.drafts.recommendation.fields.offering).toBe('ppn');
  expect(s.workspace.drafts.application.fields.case_template_id).toBe('szse-private-application-alt');
});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
test('case template prototype and implementation expose the same six materials and scoped market controls',async({page})=>{
  const s=fixture();await mount(page,s);await choose(page,'application');
  const prototype=await page.context().newPage(),dir=resolve('test-evidence/case-templates-20261015');
  await prototype.route('http://prototype.test/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    const allowed=['/product-prototype/public/material-case-templates.html','/product-prototype/public/styles.css','/product-prototype/public/project-workspace.css','/product-prototype/public/material-results.css','/apps/web/src/m4-workspace.css','/apps/web/src/m4-prototype.css'];
    if(!allowed.includes(path))return route.fulfill({status:404,body:''});
    return route.fulfill({contentType:path.endsWith('.css')?'text/css':'text/html',body:await readFile(resolve('../..'+path))});
  });
  await prototype.goto('http://prototype.test/product-prototype/public/material-case-templates.html');
  await expect(prototype.locator('.material-type')).toHaveCount(6);
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:960});await prototype.setViewportSize({width,height:960});
    for(const type of ['application','recommendation'] as const){
      await choose(page,type);await prototype.locator(`[name=type][value=${type}]`).check();
      await expect(prototype.locator('#generate')).toHaveText(type==='application'?'生成申请书':'生成推荐函');
      if(type==='recommendation')await expect(prototype.locator('#offering-label')).toBeVisible();
      else await expect(prototype.locator('#offering-label')).toBeHidden();
      for(const [name,target] of [['prototype',prototype],['implementation',page]] as const){
        expect(await target.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
        await target.evaluate(()=>scrollTo(0,0));await target.screenshot({path:resolve(dir,`${name}-${type}-${width}.png`)});
      }
    }
  }
  await prototype.close();
});
const now='2026-10-06T00:00:00Z',mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const reply=(route:Route,body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
function fixture(dynamic=false){
  const source={source_project_id:'source-project',material_id:'source-doc',material_version:3,sha256:hash('source')};
  const draft=(type:M4DocumentType):M4Draft=>({document_type:type,version:1,sha256:hash(type),updated_at:now,source_material:type==='private_summary'?source:null,materials:[],template:null,edit_base:null,scope:'whole',fields:{issuer_name:'合成发行人',market:'sse',broker:'合成券商'},requirements:[{requirement_id:'req1',text:'保留已采纳要求',message_id:'m0',message_version:1}]});
  const artifact:M4Artifact={source_project_id:'m4-project',artifact_id:'old-artifact',artifact_version:1,sha256:hash('Synthetic DOCX bytes'),topic_id:'topic-a',run_id:'run-old',document_type:'private_summary',kind:'document',filename:'合成摘要.docx',mime_type:mime,byte_size:Buffer.byteLength('Synthetic DOCX bytes'),created_at:now,base_artifact:null,input_hash:hash('old-input'),revision_number:1};
  const run=(id:string,state:Run['state']='running'):Run=>({run_id:id,project_id:'m4-project',execution_request_id:'execution-'+id,input_revision:1,input_hash:hash(id),state,stage:'m4_document_prompt',channel:'production',test_grant_id:null,uncovered_items:[],event_cursor:0,billing_mode:'platform_trial',reservation_id:null,artifact_id:state==='succeeded'?artifact.artifact_id:null,prompt_snapshot_ref:null,updated_at:now});
  const workspace:M4Workspace={topic:{topic_id:'topic-a',project_id:'m4-project',source_project_id:'source-project',name:'合成材料工作区',created_at:now,updated_at:now},project:{project_id:'m4-project',draft_revision:1,input_revision:null,input_hash:null,name:'合成材料工作区',kind:'generation',issuer_name:'合成发行人',market:'sse',offering:'private',updated_at:now},drafts:{workpaper:draft('workpaper'),annual:draft('annual'),semiannual:draft('semiannual'),issuer:draft('issuer'),financial:draft('financial'),credit:draft('credit'),proceeds:draft('proceeds'),init:draft('init'),underwriter:draft('underwriter'),legal:draft('legal'),private_summary:draft('private_summary'),application:draft('application'),recommendation:draft('recommendation')},materials:[source],material_details:[{...source,filename:'来源募集书.docx',state:'persisted',media_type:mime}],templates:[],messages:[],tasks:[],pending_requirements:[],artifacts:[artifact],view:{selected_document_type:null,open_tabs:[],active_tab:null,unsent_content:'',unsent_context:{document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:null},version:0},active_run:null};
  workspace.messages.push({message_id:'m0',role:'assistant',content:'保留已采纳要求',version:1,context:{document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:null},created_at:now,reply_status:'completed',reply_to:null,run_id:null,reply:{content:'保留已采纳要求',citations:[],requirements:['保留已采纳要求'],fields:{},intent:'draft',document_type:null,target_business:null,retrieval:'not_performed'},error:null});
  const addDocumentTask=(id:string,type:M4DocumentType='private_summary',version=workspace.drafts[type].version)=>{const current=run(id);workspace.active_run=current;const task:M4Task={run:current,manifest:{version:'m4-document-input-v1',kind:'document',topic_id:'topic-a',execution_scope_project_id:'source-project',draft_version:version,input:structuredClone(workspace.drafts[type]),template_material:null,market:'sse',offering:'private',billing_task:M4_DOCUMENT_BILLING_TASKS[type]},created_at:now,events:[],artifacts:[]};workspace.tasks.push(task);return task;};
  return {dynamic,controls:[] as string[],workspace,artifact,run,addDocumentTask,messages:[] as M4MessageRequest[],executions:[] as M4ExecuteRequest[],quotes:[] as M4QuoteRequest[],startDocumentOnMessage:false,dropMessage:false,dropExecution:false,charged:0,balance:{available:10000,frozen:0},balanceReads:0};
}
async function mount(page:Page,state:ReturnType<typeof fixture>,mode:'generate'='generate',fresh=false,legacyComponent=false){
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;
    if(path==='/api/v1/me')return reply(route,{user_id:'owner-a'});
    if(path==='/api/v1/credits/balance'){state.balanceReads++;return reply(route,{enabled:true,...state.balance});}
    if(path==='/api/v1/m4/topics')return reply(route,req.method()==='POST'?{topic:state.workspace.topic}:{topics:[state.workspace.topic]});
    if(path==='/api/v1/projects/source-project')return reply(route,{...state.workspace.project,project_id:'source-project',name:'来源项目'});
    if(path.endsWith('/workspace'))return reply(route,state.workspace);
    if(path.includes('/drafts/')){
      const body=req.postDataJSON();expect(Value.Check(M4DraftRequestSchema,body)).toBe(true);const d=state.workspace.drafts[body.input.document_type as M4DocumentType];
      if(body.expected_version!==d.version)return reply(route,{code:'INPUT_REVISION_CONFLICT'},409);
      const input={...body.input,requirements:[...body.input.requirements,...state.workspace.pending_requirements.filter(pending=>!body.input.requirements.some((existing:{requirement_id:string})=>existing.requirement_id===pending.requirement_id))]};
      expect(Value.Check(M4DraftRequestSchema,{...body,input})).toBe(true);const {version:_version,sha256:_sha,updated_at:_updated,...previous}=d;
      const saved=d.version>0&&Value.Equal(previous,input)?d:{...input,version:d.version+1,sha256:hash(JSON.stringify(input)),updated_at:now};
      state.workspace.drafts[saved.document_type as M4DocumentType]=saved;state.workspace.pending_requirements=[];return reply(route,{draft:saved});
    }
    if(path.endsWith('/view')){const body=req.postDataJSON();expect(Value.Check(M4ViewRequestSchema,body)).toBe(true);if(body.expected_version!==state.workspace.view.version)return reply(route,{code:'INPUT_REVISION_CONFLICT'},409);state.workspace.view={...body.view,version:body.expected_version+1};return reply(route,{view:state.workspace.view});}
    if(state.dynamic&&/\/runs\/[^/]+\/(pause|resume|cancel)$/.test(path)){
      const action=path.split('/').at(-1)!,task=state.workspace.tasks.find(t=>path.includes(t.run.run_id))!;
      state.controls.push(action);const p=task.credit_charge!.progress!;
      if(action==='resume'&&!state.balance.available)return reply(route,{code:'CREDITS_INSUFFICIENT'},402);
      task.run.state=action==='pause'?'paused':action==='resume'?'running':'cancelled';
      task.run.stage=action==='pause'?'user_paused':'model_generation';p.pause_requested=action==='pause';p.credit_exhausted=false;p.clock_running=action==='resume';
      if(action==='cancel')state.workspace.active_run=null;
      return reply(route,task.run);
    }
    if(path.endsWith('/quote')){const body=req.postDataJSON(),fixed=body.kind==='document';state.quotes.push(body);return reply(route,{quote:{quote_id:'quote-a',topic_id:'topic-a',input_hash:hash('quote'),task_type:fixed?M4_DOCUMENT_BILLING_TASKS[body.document_type as M4DocumentType]:'m4_Q01',points:fixed?4500:20,price_version:'synthetic-v1',reason:fixed?'每份材料固定 4,500 积分，包含正文 Word 和编制说明；成功交付后扣款，失败或取消全额释放。':'合成问答报价，按用量结算',created_at:now,billing_policy:state.dynamic&&fixed?'authoring_balance_v2':'on_delivery',billing_method:fixed?'fixed':'metered_capped',amount_semantics:fixed?'fixed_price':'reservation_cap',multiplier:1,expires_at:'2099-01-01T00:00:00Z'},balance:state.balance,shortage:Math.max(0,(fixed?(state.dynamic?1:4500):20)-state.balance.available)});}
    if(path.endsWith('/messages')){const body=req.postDataJSON() as M4MessageRequest;expect(Value.Check(M4MessageRequestSchema,body)).toBe(true);state.messages.push(body);let message=state.workspace.messages.find(m=>m.message_id===body.submission_request_id);if(!message){state.charged++;message={message_id:body.submission_request_id,role:'user',content:body.content,context:body.context,version:1,created_at:now,reply_status:'completed',reply_to:null,run_id:'qa-run',reply:null,error:null};state.workspace.messages.push(message,{...message,message_id:'reply-'+message.message_id,role:'assistant',content:'合成接口回复：原文字与版本已保留。',reply_to:message.message_id});if(state.startDocumentOnMessage&&body.execute)state.addDocumentTask('assistant-document',body.context.document_type??'private_summary',body.context.draft_version);}if(state.dropMessage){state.dropMessage=false;return route.abort('connectionreset');}return reply(route,{message,run:state.run('qa-run','succeeded')});}
    if(path.endsWith('/execute')){const body=req.postDataJSON() as M4ExecuteRequest;expect(Value.Check(M4ExecuteRequestSchema,body)).toBe(true);state.executions.push(body);let task=state.workspace.tasks.find(t=>t.run.execution_request_id===body.execution_request_id);if(!task){task=state.addDocumentTask('new-run',body.document_type,body.expected_draft_version);task.run.execution_request_id=body.execution_request_id;if(state.dynamic){
      task.run.billing_mode='fixed_credits';task.credit_charge={quote:null,state:'held',progress:{policy:'authoring_balance_v2',accrued_points:0,charged_points:0,released_points:0,active_ms:0,credit_exhausted:false,available_points:state.balance.available,pause_requested:false,queued_at:now,sampled_at:now,last_activity_at:null,queue_ahead:0,clock_running:true}};
    }else{state.balance.available-=4500;state.balance.frozen+=4500;}}if(state.dropExecution){state.dropExecution=false;return route.abort('connectionreset');}return reply(route,{run:task.run});}
    if(path.endsWith('/preview')){const id=path.split('/')[5],a=state.workspace.artifacts.find(a=>a.artifact_id===id);return a?reply(route,{artifact:a,content:'合成正文第一段：原准确版本。\n\n合成正文第二段。'}):reply(route,{code:'NOT_FOUND'},404);}
    if(path.endsWith('/bytes'))return route.fulfill({status:200,contentType:mime,body:'Synthetic DOCX bytes'});
    return reply(route,{code:'NOT_FOUND'},404);
  });
  if(legacyComponent){
    // The current no-topic generate route uses FileWorkspace. This explicitly tests the real legacy component, not that entry route.
    await page.route(new URL('/',process.env.BB_E2E_BASE_URL??'http://127.0.0.1:5173').href,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div class="prototype-app"><main class="shell"></main></div></body></html>'}));
  }
  await page.goto(`/#${mode}?${fresh?'new=synthetic':'topic=topic-a'}`);
  if(legacyComponent){
    await page.evaluate(async()=>{const componentPath='/src/material-workspace.ts',apiPath='/src/api.ts',{MaterialWorkspace}=await import(componentPath),{ApiClient}=await import(apiPath);const component=new MaterialWorkspace(new ApiClient(),'owner-a',(html:string)=>{document.querySelector('.shell')!.innerHTML=html;},()=>true,undefined,undefined,true);await component.render();});
    for(const path of ['src/style.css','../../product-prototype/public/styles.css','../../product-prototype/public/source-prospectus.css','../../product-prototype/public/project-workspace.css','src/prototype-adapter.css'])await page.addStyleTag({content:(await readFile(resolve(process.cwd(),path),'utf8')).replace(/@import\s+[^;]+;/g,'')});
  }
  await expect(page.getByRole('heading',{name:'文件生成',exact:true})).toBeVisible();
}

const choose=async(page:Page,type:M4DocumentType)=>page.locator(`[data-m4-type][value="${type}"]`).check();
const start=async(page:Page)=>{await page.getByRole('button',{name:'生成募集说明书摘要',exact:true}).click();await expect(page.getByRole('button',{name:'正在提交…',exact:true})).toHaveCount(0);};

for(const purpose of ['source','material'] as const)test(`duplicate feedback: material generation ${purpose} keeps the original and explains reuse`,async({page})=>{
  const s=fixture();await mount(page,s);await choose(page,'private_summary');
  const receipts=await duplicateUploadFixture(page,m=>{
    const pin={source_project_id:'m4-project',material_id:m.material_id,material_version:m.material_version,sha256:m.sha256};
    if(!s.workspace.materials.some(p=>p.material_id===m.material_id)){s.workspace.materials.push(pin);s.workspace.material_details!.push({...pin,filename:m.filename,state:m.state,media_type:m.media_type});}
  });
  const picker=page.locator(`[data-m4-upload="${purpose}"]`),file={name:'合成材料.docx',mimeType:mime,buffer:Buffer.from('Synthetic repeated material')};
  await picker.setInputFiles(file);await expect.poll(()=>s.workspace.materials.length).toBe(2);
  await expect(page.locator('.m4-status').filter({hasText:'正在'})).toHaveCount(0);
  await picker.setInputFiles({...file,name:'合成材料副本.docx'});
  const notice=page.locator('.duplicate-upload-notice');await expect(notice).toHaveCount(1);
  await expect(notice).toContainText('合成材料副本.docx：重复文件，已存在，未重复添加');await expect(notice).toContainText('已保留原文件“合成材料.docx”');
  expect(receipts.materials).toHaveLength(1);expect(s.workspace.materials).toHaveLength(2);
  if(purpose==='source')await expect(page.locator('.m4-source-file')).toContainText('合成材料.docx');
  else expect(s.workspace.drafts.private_summary.materials).toHaveLength(1);
  expect(s.executions).toHaveLength(0);expect(s.messages).toHaveLength(0);
  if(process.env.BB_DUPLICATE_EVIDENCE)await notice.screenshot({path:`${process.env.BB_DUPLICATE_EVIDENCE}/material-${purpose}.png`});
});

test('missing exchange lists the action, focuses the field and only starts after it is filled',async({page})=>{
  const s=fixture();s.workspace.drafts.private_summary.fields.market='';await mount(page,s);await choose(page,'private_summary');
  await start(page);const feedback=page.getByRole('alert',{name:'需要补充的信息'});
  await expect(feedback).toContainText('尚未选择交易所');await expect(feedback).toContainText('再点击“生成募集说明书摘要”');
  await expect(feedback).not.toContainText('错误编号');expect(s.quotes).toHaveLength(0);expect(s.executions).toHaveLength(0);
  await feedback.getByRole('button',{name:'选择交易所',exact:true}).click();await expect(page.locator('#m4-market')).toBeFocused();
  await expect(page.locator('#m4-market')).toHaveAttribute('aria-invalid','true');await page.locator('#m4-market').selectOption('sse');
  await expect(feedback).toHaveCount(0);await expect(page.locator('#m4-market')).not.toHaveAttribute('aria-invalid','true');
  await start(page);expect(s.executions).toHaveLength(1);
});

test('initiation lists all missing fields while switching types removes irrelevant template requirements',async({page})=>{
  const s=fixture();s.workspace.drafts.init.fields={};await mount(page,s);await choose(page,'init');
  await page.getByRole('button',{name:'生成立项报告',exact:true}).click();const feedback=page.getByRole('alert',{name:'需要补充的信息'});
  await expect(feedback.locator('li')).toHaveCount(4);await expect(feedback).toContainText('尚未填写立项券商全称');await expect(feedback).toContainText('尚未提供立项模板');
  await feedback.getByRole('button',{name:'填写券商全称'}).click();await expect(page.locator('#m4-broker')).toBeFocused();
  await page.locator('#m4-broker').fill('合成券商');await expect(feedback.locator('li')).toHaveCount(3);
  await choose(page,'legal');await page.getByRole('button',{name:'生成法律意见书',exact:true}).click();
  await expect(feedback.locator('li')).toHaveCount(1);await expect(feedback).toContainText('尚未选择本次生成使用的材料');
  await expect(feedback).not.toContainText('立项模板');expect(s.quotes).toHaveLength(0);expect(s.executions).toHaveLength(0);
});

test('supplemental-only legal drafts remain eligible',async({page})=>{
  const s=fixture();s.workspace.drafts.legal.materials=[s.workspace.materials[0]];await mount(page,s);await choose(page,'legal');
  await page.getByRole('button',{name:'生成法律意见书',exact:true}).click();await expect.poll(()=>s.executions.length).toBe(1);
});

test('whole-document edit bases remain eligible without re-uploading the source',async({page})=>{
  const other=fixture();other.workspace.drafts.private_summary.source_material=null;other.workspace.drafts.private_summary.edit_base={source_project_id:other.artifact.source_project_id,artifact_id:other.artifact.artifact_id,artifact_version:1,sha256:other.artifact.sha256};
  await mount(page,other);await choose(page,'private_summary');await start(page);expect(other.executions).toHaveLength(1);
});

test('server-reported missing input shows safe field guidance and preserves the draft',async({page})=>{
  const s=fixture();await mount(page,s);await choose(page,'private_summary');
  await page.route('**/quote',route=>reply(route,{code:'INPUT_REQUIRED',correlation_id:'private-id',field_errors:[{field:'market',code:'M4_MARKET_REQUIRED',message:'internal path must stay hidden'}]},422));
  await start(page);const feedback=page.getByRole('alert',{name:'需要补充的信息'});
  await expect(feedback).toContainText('尚未选择交易所');await expect(feedback).not.toContainText('private-id');await expect(feedback).not.toContainText('internal path');
  expect(s.executions).toHaveLength(0);await expect(page.locator('.m4-source-name')).toContainText('来源募集书.docx');
});

test('material input feedback matches the prototype on desktop and mobile',async({page})=>{
  const output=resolve('test-evidence/material-input-feedback-20261013');await mkdir(output,{recursive:true});
  const s=fixture();s.workspace.drafts.legal.fields.market='';s.workspace.drafts.legal.source_material=s.workspace.materials[0];
  await mount(page,s);await choose(page,'legal');await page.getByRole('button',{name:'生成法律意见书',exact:true}).click();
  const prototype=await page.context().newPage();
  await prototype.route('http://prototype.test/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    const allowed=['/product-prototype/public/material-input-feedback.html','/product-prototype/public/styles.css','/product-prototype/public/material-results.css','/apps/web/src/m4-workspace.css'];
    if(!allowed.includes(pathname))return route.fulfill({status:404,body:''});
    return route.fulfill({status:200,contentType:pathname.endsWith('.css')?'text/css':'text/html',body:await readFile(resolve('../..'+pathname))});
  });
  await prototype.goto('http://prototype.test/product-prototype/public/material-input-feedback.html');
  for(const [name,viewport] of [['desktop',{width:1440,height:960}],['mobile',{width:390,height:844}]] as const){
    await page.setViewportSize(viewport);await prototype.setViewportSize(viewport);
    await page.locator('#m4-submit-status').scrollIntoViewIfNeeded();await prototype.locator('.m4-input-feedback').scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:`${output}/implementation-${name}.png`});await prototype.screenshot({path:`${output}/prototype-${name}.png`});
    await expect(page.locator('#m4-submit-status')).not.toContainText('错误编号');
    await expect(page.getByText('材料已保存并加入当前草稿，不会自动开始制作。',{exact:true})).toHaveCount(0);
  }
  await prototype.close();
});

for(const viewport of [{width:1440,height:1100},{width:430,height:932}])test(`legacy quotation: one click starts and balance drops only after success at ${viewport.width}px`,async({page})=>{
  await page.setViewportSize(viewport);const s=fixture();await mount(page,s);await choose(page,'private_summary');
  const wallet=page.locator(viewport.width>760?'.credit-wallet .wallet-value strong':'.mobile-credit-wallet strong');
  await expect(wallet).toHaveText('10,000');
  await expect(page.locator('.m4-price')).toHaveCount(0);await expect(page.getByRole('button',{name:'确认并生成'})).toHaveCount(0);
  if(process.env.M4_UX_EVIDENCE){const dir=resolve(process.env.M4_UX_EVIDENCE_DIR || 'test-evidence/m4-one-click-20261008');await mkdir(dir,{recursive:true});await page.locator('.form-footer').scrollIntoViewIfNeeded();await page.screenshot({path:resolve(dir,`ready-${viewport.width}.png`)});}
  await start(page);await expect.poll(()=>s.executions.length).toBe(1);expect(s.quotes).toHaveLength(1);
  await expect(page.getByRole('tab',{name:'生成进度'})).toHaveAttribute('aria-selected','true');
  await expect(page.locator('.m4-price')).toHaveCount(0);await expect(wallet).toHaveText('10,000');
  await expect(page.locator('.wallet-note')).toContainText('任务已预留 4,500');
  const reads=s.balanceReads;s.balance.frozen=0;
  const fresh={...s.artifact,artifact_id:'new-artifact',revision_number:2,filename:'合成摘要新稿.docx',run_id:'new-run'};
  s.workspace.artifacts.push(fresh);s.workspace.tasks[0].run=s.run('new-run','succeeded');s.workspace.tasks[0].artifacts=[fresh];s.workspace.active_run=null;
  // The material poll, not the 30s wallet timer or a manual refresh, updates settlement.
  await expect(wallet).toHaveText('5,500',{timeout:10000});expect(s.balanceReads).toBeGreaterThan(reads);
  await expect(page.locator('#m4-status')).toContainText('本次制作已完成');
  await expect(page.locator('.wallet-note')).toContainText('暂无预留积分');
  if(process.env.M4_UX_EVIDENCE){await page.screenshot({path:resolve(process.env.M4_UX_EVIDENCE_DIR || 'test-evidence/m4-one-click-20261008',`success-${viewport.width}.png`)});}
});

test('insufficient credits show a recharge action, retain input and never auto-start',async({page})=>{
  const s=fixture();s.balance.available=1000;await mount(page,s);await choose(page,'private_summary');
  await page.locator('#m4-requirements').fill('积分不足时保留这份输入');await start(page);
  await expect(page.locator('#m4-submit-status [role=alert]')).toContainText('积分不足');
  const recharge=await page.locator('#m4-submit-status').getByRole('link',{name:'充值积分'}).getAttribute('href'),rechargeQuery=new URLSearchParams(recharge!.split('?')[1]);
  expect(rechargeQuery.get('project')).toBe(s.workspace.topic.project_id);
  expect(rechargeQuery.get('return_to')).toBe(await page.evaluate(()=>location.hash));
  expect(s.executions).toHaveLength(0);expect(s.balance.frozen).toBe(0);await expect(page.locator('.m4-price')).toHaveCount(0);
  s.balance.available=10000;await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await expect(page.locator('.wallet-value strong')).toHaveText('10,000');expect(s.executions).toHaveLength(0);
  await expect(page.locator('#m4-requirements')).toHaveValue('积分不足时保留这份输入');
  await start(page);expect(s.executions).toHaveLength(1);
});

test('a double click and a lost acknowledgement retry use the same execution and reserve once',async({page})=>{
  const s=fixture();s.dropExecution=true;await mount(page,s);await choose(page,'private_summary');
  let release!:()=>void,quotes=0;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/quote',async route=>{quotes++;await gate;return route.fallback();});
  await page.getByRole('button',{name:'生成募集说明书摘要',exact:true}).evaluate(el=>{(el as HTMLButtonElement).click();(el as HTMLButtonElement).click();});
  await expect.poll(()=>quotes).toBe(1);await expect(page.getByRole('button',{name:'正在提交…'})).toBeDisabled();release();
  await expect(page.getByRole('button',{name:'核对并重试原制作请求'})).toBeVisible();
  const first=structuredClone(s.executions[0]);expect(s.balance.frozen).toBe(4500);
  await page.reload();await page.getByRole('button',{name:'核对并重试原制作请求'}).click();
  await expect.poll(()=>s.executions.length).toBe(2);expect(s.executions[1]).toEqual(first);expect(quotes).toBe(1);expect(s.workspace.tasks).toHaveLength(1);
  expect(s.balance).toEqual({available:5500,frozen:4500});
});

test('an input edit while the internal quote is pending cannot submit a stale draft',async({page})=>{
  const s=fixture();await mount(page,s);await choose(page,'private_summary');
  let release!:()=>void,quotes=0;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/quote',async route=>{quotes++;await gate;return route.fallback();});
  await page.getByRole('button',{name:'生成募集说明书摘要',exact:true}).click();await expect.poll(()=>quotes).toBe(1);
  await page.locator('#m4-requirements').fill('报价等待期间的新要求');release();
  await expect(page.locator('#m4-submit-status [role=alert]')).toContainText('材料或要求已修改');
  expect(s.executions).toHaveLength(0);await expect(page.locator('#m4-requirements')).toHaveValue('报价等待期间的新要求');
  await start(page);expect(s.executions).toHaveLength(1);const input=s.workspace.tasks[0].manifest;expect(input.kind==='document'&&input.input.supplemental_requirements).toBe('报价等待期间的新要求');
});

for(const state of ['failed','cancelled'] as const)test(`a ${state} task releases the reservation without reducing balance`,async({page})=>{
  const s=fixture();await mount(page,s);await choose(page,'private_summary');await start(page);
  await expect(page.locator('.wallet-note')).toContainText('任务已预留 4,500');
  s.balance={available:10000,frozen:0};s.workspace.tasks[0].run=s.run('new-run',state);s.workspace.active_run=null;
  await expect(page.locator('.wallet-note')).toContainText('暂无预留积分',{timeout:10000});
  await expect(page.locator('.wallet-value strong')).toHaveText('10,000');expect(s.executions).toHaveLength(1);
});

test('legacy MaterialWorkspace component first save and concurrent upload share creation and retain entered requirements',async({page})=>{
  const s=fixture();for(const d of Object.values(s.workspace.drafts)){d.version=0;d.fields={};d.requirements=[];d.source_material=null;}
  await mount(page,s,'generate',true,true);let creates=0,uploads=0,release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/m4/topics',async route=>{if(route.request().method()!=='POST')return route.fallback();creates++;await gate;return reply(route,{topic:s.workspace.topic});});
  await page.route('**/materials/uploads',route=>{uploads++;return reply(route,{code:'DATA_UNAVAILABLE'},503);});
  await choose(page,'legal');await page.locator('#m4-market').selectOption('szse');
  await page.locator('#m4-requirements').fill('首次表单要求不能被新建工作区覆盖');await expect.poll(()=>creates).toBe(1);
  await page.getByLabel('上传最新版募集说明书',{exact:true}).setInputFiles({name:'合成募集书.docx',mimeType:mime,buffer:Buffer.from('Synthetic upload')});
  release();await expect.poll(()=>uploads).toBe(1);
  await expect.poll(()=>s.workspace.drafts.legal.supplemental_requirements).toBe('首次表单要求不能被新建工作区覆盖');
  expect(s.workspace.drafts.legal.fields.market).toBe('szse');expect(creates).toBe(1);expect(s.messages).toHaveLength(0);expect(s.executions).toHaveLength(0);
  await expect(page).toHaveURL(/topic=topic-a/);
});

test('prototype material navigation, cards, source modes and only one optional requirements box',async({page})=>{
  const s=fixture();await mount(page,s);
  await expect(page.locator('.sidebar').getByRole('link',{name:'文件生成',exact:true})).toHaveCount(1);
  await expect(page.locator('.sidebar').getByRole('link',{name:'项目问答',exact:true})).toHaveCount(1);
  await expect(page.locator('#m4-agent,#m4-message,[data-m4-action=discuss],#m4-topic,[data-m4-action=new-topic],#m4-source')).toHaveCount(0);
  await expect(page.locator('[data-m4-type]')).toHaveCount(M4_DOCUMENT_TYPES.length);await expect(page.getByText('推荐函',{exact:true})).toBeVisible();
  await choose(page,'legal');await expect(page.getByRole('heading',{name:'这份材料依据哪份募集书'})).toBeVisible();
  await expect(page.locator('#m4-content textarea')).toHaveCount(1);await expect(page.locator('#m4-requirements')).toBeVisible();
  await page.getByRole('radio',{name:'关联募集书项目',exact:true}).check();await expect(page.getByRole('button',{name:'选择募集书项目'})).toBeVisible();
  await expect(page.locator('[data-m4-upload=source]')).toHaveCount(0);await page.getByRole('radio',{name:'上传最新版募集书',exact:true}).check();
  await expect(page.locator('[data-m4-upload=source]')).toHaveCount(1);expect(s.executions).toHaveLength(0);expect(s.messages).toHaveLength(0);
  await page.route('**/projects/m4-project',route=>reply(route,s.workspace.project));
  await page.goto('/#/projects/m4-project');await expect(page.getByRole('heading',{name:'文件生成',exact:true})).toBeVisible();
});

test('direct requirements save without a message or charge, remain per type and survive reload',async({page})=>{
  const s=fixture();await mount(page,s);await choose(page,'legal');await page.locator('#m4-market').selectOption('szse');
  await page.locator('#m4-requirements').fill('请按深交所要求编写，重点说明担保与诉讼。');
  await expect.poll(()=>s.workspace.drafts.legal.supplemental_requirements).toContain('担保与诉讼');
  await choose(page,'underwriter');await expect(page.locator('#m4-requirements')).toHaveValue('');
  await page.locator('#m4-requirements').fill('重点说明募集资金用途');await expect.poll(()=>s.workspace.drafts.underwriter.supplemental_requirements).toBe('重点说明募集资金用途');
  await choose(page,'legal');await expect(page.locator('#m4-market')).toHaveValue('szse');await page.reload();
  await expect(page.locator('#m4-requirements')).toHaveValue('请按深交所要求编写，重点说明担保与诉讼。');
  expect(s.messages).toHaveLength(0);expect(s.executions).toHaveLength(0);expect(s.quotes).toHaveLength(0);
});

test('replacing the source adopts only saved bytes and restores that exact file without a version selector',async({page})=>{
  const s=fixture();await mount(page,s);await choose(page,'private_summary');
  const bytes=Buffer.from('Synthetic replacement source');
  const material={material_id:'replacement-doc',material_version:1,upload_id:'replacement-upload',role:'historical',filename:'替换后的募集书.docx',media_type:mime,byte_size:bytes.length,sha256:hash(bytes.toString()),state:'persisted',persisted_at:now,error:null};
  let fail=false;
  await page.route('**/materials/uploads',route=>fail?reply(route,{code:'DATA_UNAVAILABLE'},503):reply(route,{upload_id:material.upload_id,state:'uploading',upload_url:'/api/v1/synthetic-source-bytes',expires_at:'2099-01-01T00:00:00Z',max_bytes:10000}));
  await page.route('**/synthetic-source-bytes',route=>route.fulfill({status:204}));
  await page.route('**/materials/uploads/replacement-upload/complete',route=>reply(route,material));
  await page.route('**/m4/topics/topic-a/materials',route=>{const {material:pin}=route.request().postDataJSON();s.workspace.materials.push(pin);s.workspace.material_details!.push({...pin,filename:material.filename,state:'persisted',media_type:mime});return reply(route,{material:pin});});
  const file=page.getByLabel('上传最新版募集说明书',{exact:true});
  await file.setInputFiles({name:material.filename,mimeType:mime,buffer:bytes});
  await expect.poll(()=>s.workspace.drafts.private_summary.source_material?.material_id).toBe(material.material_id);
  await expect(page.locator('.m4-source-file')).toContainText(material.filename);
  await expect(page.locator('#m4-submit-status')).not.toContainText('材料已保存并加入当前草稿');
  await expect(page.locator('#m4-source')).toHaveCount(0);await expect(page.locator('.m4-source-file details')).toHaveCount(0);
  await page.reload();await expect(page.locator('.m4-source-file')).toContainText(material.filename);
  expect(s.workspace.drafts.private_summary.source_material?.sha256).toBe(material.sha256);
  fail=true;await file.setInputFiles({name:'未保存成功.docx',mimeType:mime,buffer:Buffer.from('Failed replacement')});
  await expect(page.locator('#m4-status')).toHaveClass(/error/);
  await expect(page.locator('.m4-source-file')).toContainText(material.filename);
  expect(s.workspace.drafts.private_summary.source_material?.material_id).toBe(material.material_id);
  expect(s.executions).toHaveLength(0);expect(s.quotes).toHaveLength(0);
});

test('generation pins direct requirements and progress is on the page; edits never change running input',async({page})=>{
  const s=fixture();await mount(page,s);await choose(page,'private_summary');await page.locator('#m4-requirements').fill('保留财务表格');
  await expect.poll(()=>s.workspace.drafts.private_summary.supplemental_requirements).toBe('保留财务表格');await start(page);
  await expect(page.getByRole('tab',{name:'生成进度'})).toHaveAttribute('aria-selected','true');await expect(page.locator('.task-progress')).toContainText('正在编制材料');
  await expect(page.locator('#m4-requirements,#m4-message')).toHaveCount(0);
  const fixed=structuredClone(s.workspace.tasks[0].manifest);expect(fixed.kind==='document'&&fixed.input.supplemental_requirements).toBe('保留财务表格');
  await page.getByRole('button',{name:'返回募集说明书摘要材料与要求',exact:true}).click();await expect(page.locator('[data-m4-type]:checked')).toHaveValue('private_summary');await page.locator('#m4-requirements').fill('下一版增加风险分析');
  await expect.poll(()=>s.workspace.drafts.private_summary.supplemental_requirements).toBe('下一版增加风险分析');expect(s.workspace.tasks[0].manifest).toEqual(fixed);expect(s.executions).toHaveLength(1);
});

test('completion keeps older reader, new real artifact appears once and preview failure still permits download',async({page})=>{
  const s=fixture();await mount(page,s);await choose(page,'private_summary');await start(page);await page.getByRole('button',{name:'返回募集说明书摘要材料与要求',exact:true}).click();await expect(page.locator('[data-m4-type]:checked')).toHaveValue('private_summary');
  await page.getByRole('button',{name:'合成摘要.docx · 第1稿',exact:true}).click();await page.getByText('查看正文预览',{exact:true}).click();await expect(page.locator('.m4-preview')).toContainText('合成正文');
  const fresh={...s.artifact,artifact_id:'new-artifact',revision_number:2,filename:'合成摘要新稿.docx',run_id:'new-run'};
  s.workspace.artifacts.push(fresh);s.workspace.tasks[0].run=s.run('new-run','succeeded');s.workspace.tasks[0].artifacts=[fresh];s.workspace.active_run=null;
  await page.getByRole('button',{name:'刷新状态'}).click();await expect(page.getByRole('tab',{name:'合成摘要.docx · 第1稿',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('tab',{name:'合成摘要新稿.docx · 第2稿'})).toHaveCount(1);
  await page.route('**/preview',route=>reply(route,{code:'DATA_UNAVAILABLE'},503));await page.getByRole('tab',{name:'合成摘要新稿.docx · 第2稿'}).click();
  await page.getByText('查看正文预览',{exact:true}).click();await expect(page.locator('.m4-preview')).toContainText('可下载原成果查看');await expect(page.getByRole('button',{name:'下载正文 Word',exact:true})).toBeEnabled();expect(s.executions).toHaveLength(1);
});

test('whole-document continuation keeps original source and requirements',async({page})=>{
  const s=fixture();await mount(page,s);await page.getByRole('button',{name:'合成摘要.docx · 第1稿',exact:true}).click();
  await page.getByRole('button',{name:'继续修改',exact:true}).click();
  await expect.poll(()=>s.workspace.drafts.private_summary.edit_base?.artifact_id).toBe('old-artifact');
  expect(s.workspace.drafts.private_summary.source_material?.material_version).toBe(3);expect(s.workspace.drafts.private_summary.requirements[0].text).toBe('保留已采纳要求');expect(s.executions).toHaveLength(0);
});

test('busy source project retains form and does not automatically execute when released',async({page})=>{
  const s=fixture();await mount(page,s);await choose(page,'private_summary');let blocked=true;
  await page.route('**/execute',route=>blocked?reply(route,{code:'PROJECT_RUN_ACTIVE'},409):route.fallback());
  await page.locator('#m4-requirements').fill('保留这份草稿');await expect.poll(()=>s.workspace.drafts.private_summary.supplemental_requirements).toBe('保留这份草稿');await start(page);
  await expect(page.locator('#m4-status')).toContainText('同一来源项目已有任务');blocked=false;await page.reload();await expect(page.locator('#m4-requirements')).toHaveValue('保留这份草稿');expect(s.executions).toHaveLength(0);
});

test('another page changing view state can be reconciled on the material form without chat or lost requirements',async({page})=>{
  const s=fixture();await mount(page,s);await choose(page,'private_summary');
  await expect.poll(()=>s.workspace.view.selected_document_type).toBe('private_summary');
  s.workspace.view={...s.workspace.view,selected_document_type:'legal',version:s.workspace.view.version+1};
  await page.locator('#m4-requirements').fill('多页面操作仍需保留的要求');
  await expect(page.getByRole('button',{name:'核对页面状态',exact:true})).toBeVisible();
  await expect.poll(()=>s.workspace.drafts.private_summary.supplemental_requirements).toBe('多页面操作仍需保留的要求');
  await page.getByRole('button',{name:'核对页面状态',exact:true}).click();await page.getByRole('button',{name:'保留本页显示',exact:true}).click();
  await expect(page.getByRole('button',{name:'核对页面状态',exact:true})).toHaveCount(0);await expect.poll(()=>s.workspace.view.selected_document_type).toBe('private_summary');
  await start(page);expect(s.executions).toHaveLength(1);expect(s.messages).toHaveLength(0);
  const input=s.workspace.tasks[0].manifest;expect(input.kind==='document'&&input.input.supplemental_requirements).toBe('多页面操作仍需保留的要求');
});

test('a draft save failure retains direct requirements and retry saves before execution',async({page})=>{
  const s=fixture();await mount(page,s);await choose(page,'private_summary');let fail=true;
  await page.route('**/drafts/private_summary',route=>fail?reply(route,{code:'DATA_UNAVAILABLE'},503):route.fallback());
  await page.locator('#m4-requirements').fill('保存失败也不能丢失');await expect(page.locator('#m4-status')).toContainText('本页草稿已保留');
  await expect(page.locator('#m4-submit-status [role=alert]')).toContainText('本页草稿已保留');
  await expect(page.getByRole('button',{name:'重试保存草稿',exact:true})).toBeVisible();
  await expect(page.locator('#m4-requirements')).toHaveValue('保存失败也不能丢失');expect(s.executions).toHaveLength(0);fail=false;
  await page.getByRole('button',{name:'生成募集说明书摘要',exact:true}).click();await expect.poll(()=>s.workspace.drafts.private_summary.supplemental_requirements).toBe('保存失败也不能丢失');
  await expect(page.getByRole('button',{name:'重试保存草稿',exact:true})).toHaveCount(0);
});

for(const [label,width] of [['desktop',1440],['mobile',390]] as const)test(`generation failure is visible beside the button without a false save retry on ${label}`,async({page})=>{
  const s=fixture();s.workspace.view.selected_document_type='underwriter';
  s.workspace.drafts.underwriter.source_material=s.workspace.materials[0];s.workspace.artifacts=[];
  await page.setViewportSize({width,height:844});await mount(page,s);
  await page.route('**/quote',route=>reply(route,{code:'BILLING_NOT_READY'},503));
  const input=structuredClone(s.workspace.drafts.underwriter);
  await page.getByRole('button',{name:'生成主承销商核查意见',exact:true}).click();
  const alert=page.locator('#m4-submit-status [role=alert]');
  await expect(alert).toContainText('积分价格尚未配置');await expect(alert).toContainText('本次未扣费');
  await expect(alert).toBeInViewport();await expect(page.locator('#m4-status')).not.toBeInViewport();
  await expect(page.getByRole('button',{name:'重试保存草稿',exact:true})).toHaveCount(0);
  expect(s.executions).toHaveLength(0);expect(s.charged).toBe(0);expect(s.workspace.drafts.underwriter).toEqual(input);
  if(process.env.M4_UX_EVIDENCE){const output=resolve(process.env.M4_UX_EVIDENCE_DIR || 'test-evidence/m4-one-click-20261008');await mkdir(output,{recursive:true});await page.screenshot({path:`${output}/implementation-error-${label}.png`});}
});

for(const width of [1440,390,320])test(`material fits viewport ${width}`,async({page})=>{
  const s=fixture();await page.setViewportSize({width,height:960});await mount(page,s);await choose(page,'private_summary');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);

});

test('template scope follows broker and exchange, and missing scope is explained before upload bytes',async({page})=>{
  const s=fixture();s.workspace.templates=['sse','szse'].map((market,index)=>({template_id:'t'+index,template_version:1,sha256:hash(market),name:market==='sse'?'合成上交所模板':'合成深交所模板',broker:'合成券商',document_type:'init',material:s.workspace.materials[0],owner_scope:'private',market:market as 'sse'|'szse',offering:'private',status:'active',created_at:now,retired_at:null}));
  await mount(page,s);await choose(page,'init');await expect(page.locator('#m4-template option')).toHaveCount(2);await expect(page.locator('#m4-template')).toContainText('合成上交所模板');
  await page.locator('#m4-market').selectOption('szse');await expect(page.locator('#m4-template')).toContainText('合成深交所模板');await expect(page.locator('#m4-template')).not.toContainText('合成上交所模板');
  let uploadRequests=0;page.on('request',request=>{if(request.url().includes('/materials/uploads'))uploadRequests++;});
  await page.locator('#m4-broker').fill('');await page.getByLabel('上传立项模板或已完成的立项报告',{exact:true}).setInputFiles({name:'合成模板.docx',mimeType:mime,buffer:Buffer.from('Synthetic template')});
  await expect(page.locator('#m4-status')).toContainText('请先填写立项券商全称并选择交易所，再上传对应的私有模板。');expect(uploadRequests).toBe(0);expect(s.executions).toHaveLength(0);
});


test('polling keeps a focused native file input connected',async({page})=>{
  const s=fixture();await mount(page,s);await choose(page,'private_summary');
  const input=page.getByLabel('上传最新版募集说明书',{exact:true});await input.evaluate(el=>el.setAttribute('data-identity','native-picker'));await input.focus();
  await page.getByRole('button',{name:'刷新状态'}).evaluate(el=>(el as HTMLButtonElement).click());
  await expect(input).toHaveAttribute('data-identity','native-picker');
});

test('same-size original prototype and material implementation screenshots',async({page})=>{
  test.setTimeout(120000);
  test.skip(!process.env.M4_UX_EVIDENCE,'Screenshots are captured explicitly for review.');
  const output=resolve(process.env.M4_UX_EVIDENCE_DIR || 'test-evidence/m4-one-click-20261008');await mkdir(output,{recursive:true});
  const s=fixture();s.workspace.materials=[];s.workspace.material_details=[];s.workspace.artifacts=[];
  for(const d of Object.values(s.workspace.drafts)){d.fields={};d.requirements=[];d.source_material=null;}
  await mount(page,s);
  const original=await page.context().newPage();
  await original.route('http://prototype.test/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.startsWith('/api/'))return reply(route,path==='/api/auth/session'?{user:{id:'synthetic',phoneMasked:'合成截图账号'}}:path==='/api/tasks'?{jobs:[]}:path==='/api/connectors'?{connectors:[]}:path==='/api/health'?{materialStudioVersion:1,oneClickExecution:true}:{available:1000,frozen:0,balance:1000});
    const name=path==='/'?'index.html':path.slice(1);if(!/^[a-z0-9-]+\.(html|css|js|svg)$/.test(name))return route.fulfill({status:404,body:''});
    return route.fulfill({status:200,contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/html',body:await readFile(resolve('../../product-prototype/public',name))});
  });
  await original.goto('http://prototype.test/#generate');await expect(original.getByRole('heading',{name:'要生成哪份材料'})).toBeVisible();
  for(const [label,viewport] of [['desktop',{width:1440,height:960}],['mobile',{width:390,height:844}]] as const){
    await page.setViewportSize(viewport);await original.setViewportSize(viewport);
    await page.bringToFront();await page.screenshot({path:`${output}/implementation-${label}.png`,fullPage:true});
    await original.bringToFront();await original.screenshot({path:`${output}/prototype-${label}.png`,fullPage:true});
    await page.bringToFront();await page.locator('.form-footer').scrollIntoViewIfNeeded();await page.screenshot({path:`${output}/implementation-footer-${label}.png`});
    await original.bringToFront();await original.locator('#material-studio-form .form-footer').scrollIntoViewIfNeeded();await original.screenshot({path:`${output}/prototype-footer-${label}.png`});
  }
  s.workspace.materials=[{source_project_id:'source-project',material_id:'source-doc',material_version:3,sha256:hash('source')}];
  s.workspace.material_details=[{...s.workspace.materials[0],filename:'合成发行人2026年面向专业投资者非公开发行公司债券募集说明书.docx',state:'persisted',media_type:mime}];
  s.workspace.drafts.private_summary.source_material=s.workspace.materials[0];
  await page.reload();await choose(page,'private_summary');
  await original.locator('input[name=type][value=summary]').check();
  for(const [label,viewport] of [['desktop',{width:1440,height:960}],['mobile',{width:390,height:844}]] as const){
    await page.setViewportSize(viewport);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const headings=await page.locator('.form-card>h2').evaluateAll(nodes=>nodes.map(node=>({size:getComputedStyle(node).fontSize,weight:getComputedStyle(node).fontWeight})));
    expect(new Set(headings.map(h=>`${h.size}:${h.weight}`)).size).toBe(1);
    await page.screenshot({path:`${output}/saved-file-${label}.png`,fullPage:true});
    await original.setViewportSize(viewport);
    for(const [kind,target] of [['implementation',page],['prototype',original]] as const){await target.locator('.form-footer').evaluate(el=>el.scrollIntoView({block:'center'}));await target.locator('.form-footer').screenshot({path:`${output}/${kind}-summary-label-${label}.png`});}
  }
  await original.close();
});

function completeTask(s:ReturnType<typeof fixture>,task:M4Task){
  const fresh={...s.artifact,artifact_id:'new-artifact',revision_number:2,filename:'合成摘要新稿.docx',run_id:task.run.run_id};
  const note={...fresh,artifact_id:'new-note',filename:'合成编制说明.docx',kind:'preparation_note' as const};
  s.workspace.artifacts.push(fresh,note);task.run={...task.run,state:'succeeded',artifact_id:fresh.artifact_id};task.artifacts=[fresh,note];s.workspace.active_run=null;
  return {fresh,note};
}
test('live phases, terminal states and persistent task tabs keep the same immutable task',async({page})=>{
  const s=fixture(),task=s.addDocumentTask('observed');task.run.stage='m4_document_v1_prompt';
  await mount(page,s);await page.getByRole('button',{name:'查看生成进度',exact:true}).click();
  await expect(page.locator('.task-progress')).toContainText('正在编制材料');await expect(page.locator('.m4-content [data-m4-action=task]')).toHaveCount(0);
  await page.getByText('查看本次材料与要求',{exact:true}).click();
  task.events=[{event_id:'e1',schema_version:1,trace_id:'trace',run_id:task.run.run_id,seq:1,occurred_at:now,stage:'model_generation',type:'run.progress',state:'running',payload:{reason:'m4_reading_materials'}}];
  await page.getByRole('button',{name:'刷新状态'}).click();await expect(page.locator('.task-progress [aria-current=step]')).toContainText('准备材料');
  await expect(page.locator('[data-m4-detail=input]')).toHaveAttribute('open','');
  task.run.stage='word_delivery';await page.getByRole('button',{name:'刷新状态'}).click();await expect(page.locator('.task-progress [aria-current=step]')).toContainText('保存文档');
  await expect(page.locator('.task-progress')).not.toContainText('正在读取本轮材料');
  for(const state of ['paused','awaiting_input','failed','cancelled'] as const){task.run.state=state;s.workspace.active_run=['paused','awaiting_input'].includes(state)?task.run:null;await page.getByRole('button',{name:'刷新状态'}).click();await expect(page.locator('.task-progress')).not.toContainText('文档已生成');await expect(page.locator('[data-m4-action=download]')).toHaveCount(0);}
  await expect(page.getByRole('button',{name:'停止本次任务'})).toHaveCount(0);
  await expect(page.locator('.m4-tab-close')).toHaveCount(0);await page.getByRole('tab',{name:'任务输入',exact:true}).click();await page.getByRole('button',{name:'查看本轮任务'}).click();await expect(page.locator('.task-progress')).toContainText('本轮已停止');
  await page.getByRole('button',{name:'返回募集说明书摘要材料与要求',exact:true}).click();await expect(page.locator('[data-m4-type]:checked')).toHaveValue('private_summary');expect(s.executions).toHaveLength(0);
});
test('completion and reload retain paired downloads; download errors stay beside the exact file',async({page})=>{
  const s=fixture();await mount(page,s);await choose(page,'private_summary');await start(page);const task=s.workspace.tasks[0],{fresh,note}=completeTask(s,task);
  await page.getByRole('button',{name:'刷新状态'}).click();await expect(page.getByRole('tab',{name:'合成摘要新稿.docx · 第2稿'})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('button',{name:'下载正文 Word',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'下载编制说明',exact:true})).toBeVisible();
  await page.reload();await expect(page.getByRole('button',{name:'下载编制说明',exact:true})).toBeVisible();let bad=true;const requested:string[]=[];
  await page.route('**/m4/artifacts/*/versions/*/bytes',route=>{requested.push(route.request().url());return route.fulfill({status:200,contentType:mime,body:bad?'wrong bytes':'Synthetic DOCX bytes'});});
  await page.getByRole('button',{name:'下载编制说明',exact:true}).click();await expect(page.locator('.artifact-file').filter({hasText:'合成编制说明.docx'}).getByRole('alert')).toContainText('下载未完成');
  await expect(page.locator('.artifact-file').filter({hasText:'合成摘要新稿.docx'}).getByRole('alert')).toHaveCount(0);bad=false;
  for(const [label,file] of [['下载正文 Word',fresh],['下载编制说明',note]] as const){const pending=page.waitForEvent('download');await page.getByRole('button',{name:label,exact:true}).click();const downloaded=await pending;expect(downloaded.suggestedFilename()).toBe(file.filename);expect(requested.at(-1)).toContain(`/m4/artifacts/${file.artifact_id}/versions/${file.artifact_version}/bytes`);}
  expect(s.executions).toHaveLength(1);expect(s.quotes).toHaveLength(1);
});
test('historical note from another run is not presented as this result',async({page})=>{
  const s=fixture();s.workspace.artifacts.push({...s.artifact,artifact_id:'unrelated-note',run_id:'other-run',kind:'preparation_note',filename:'另一任务说明.docx'});await mount(page,s);await page.getByRole('button',{name:'合成摘要.docx · 第1稿',exact:true}).click();
  await expect(page.getByRole('button',{name:'下载编制说明',exact:true})).toHaveCount(0);await expect(page.getByText('本轮暂无可下载的编制说明。')).toBeVisible();expect(s.executions).toHaveLength(0);
});
test('material progress and results match the reference at desktop and mobile sizes',async({page})=>{
  test.setTimeout(120000);const output=resolve('test-evidence/material-dynamic-20261013');await mkdir(output,{recursive:true});
  const s=fixture(),task=s.addDocumentTask('visual');task.run.stage='model_generation';await mount(page,s);await page.getByRole('button',{name:'查看生成进度',exact:true}).click();
  const prototype=await page.context().newPage();await prototype.route('http://prototype.test/**',async route=>{const name=new URL(route.request().url()).pathname;const file=name.startsWith('/apps/web/src/')?resolve('../..'+name):resolve('../../product-prototype/public'+name);return route.fulfill({contentType:name.endsWith('.css')?'text/css':'text/html',body:await readFile(file)});});
  task.run.event_cursor=1;task.events=[{event_id:'synthetic-progress',schema_version:1,trace_id:'synthetic',run_id:task.run.run_id,seq:1,type:'run.progress',state:'running',stage:'model_generation',occurred_at:now,payload:{authoring_activity:{activity_id:hash('material-progress'),code:'read_materials',state:'started',summary:'正在核对发行人信息与财务材料'}}}];
  for(const state of ['running','paused','exhausted','failed','succeeded'] as const){
    task.run.state=state==='exhausted'?'paused':state;task.run.stage=state==='paused'?'user_paused':state==='exhausted'?'credits_exhausted':'model_generation';
    if(state==='failed'){s.workspace.active_run=null;}if(state==='succeeded')completeTask(s,task);
    task.run.billing_mode='fixed_credits';task.credit_charge={quote:null,state:['failed','succeeded'].includes(state)?state==='failed'?'released':'settled':'held',progress:{policy:'authoring_balance_v2',accrued_points:state==='failed'?0:state==='succeeded'?4500:state==='exhausted'?1000:125,charged_points:state==='failed'?0:state==='succeeded'?4500:state==='exhausted'?1000:125,released_points:0,active_ms:65000,credit_exhausted:state==='exhausted',available_points:state==='exhausted'?0:875,pause_requested:state==='paused',queued_at:now,sampled_at:now,last_activity_at:now,queue_ahead:0,clock_running:state==='running'}};
    await page.getByRole('button',{name:'刷新状态'}).click();await prototype.goto(`http://prototype.test/material-results.html#${state}`);await prototype.reload();
    await expect(prototype.locator('[aria-label=积分消耗]')).toBeVisible();await expect(prototype.getByText('来源与版本',{exact:true})).toHaveCount(0);
    for(const [label,viewport] of [['desktop',{width:1440,height:960}],['mobile',{width:390,height:844}],['narrow',{width:320,height:844}]] as const){await page.setViewportSize(viewport);await prototype.setViewportSize(viewport);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(page.locator('.task-progress [aria-current=step]')).toHaveCount(1);
      if(label!=='narrow'){
        const shot=await page.locator('#m4-content').screenshot({path:`${output}/implementation-${state}-${label}.png`,style:".topbar{visibility:hidden!important}"});
        const size={width:shot.readUInt32BE(16),height:shot.readUInt32BE(20)};
        await prototype.locator('#material-result').evaluate((node,size)=>{Object.assign((node as HTMLElement).style,{width:`${size.width}px`,height:`${size.height}px`,maxWidth:'none',position:'absolute',left:'0',top:'0',margin:'0'});},size);
        await prototype.locator('#material-result').screenshot({path:`${output}/prototype-${state}-${label}.png`});
      }
    }
  }await prototype.close();expect(s.executions).toHaveLength(0);
});

test('refresh preserves an expanded preview and its reading position',async({page})=>{
 const s=fixture();await mount(page,s);await page.route('**/preview',route=>reply(route,{artifact:s.artifact,content:Array.from({length:100},(_,i)=>`合成正文第 ${i} 段。`).join('\n\n')}));
 await page.getByRole('button',{name:'合成摘要.docx · 第1稿',exact:true}).click();await page.getByText('查看正文预览',{exact:true}).click();const preview=page.locator('.m4-preview');await expect(preview).toContainText('第 99 段');
 await preview.evaluate(node=>{node.scrollTop=400;});await expect.poll(()=>preview.evaluate(node=>node.scrollTop)).toBe(400);
 await page.getByRole('button',{name:'刷新状态'}).click();await expect(preview).toBeVisible();await expect.poll(()=>preview.evaluate(node=>node.scrollTop)).toBe(400);expect(s.executions).toHaveLength(0);
});

test('explicit legacy topic with source project context keeps the linked source on reload',async({page})=>{
 const s=fixture();await mount(page,s);await page.goto('/#generate?topic=topic-a&project=source-project&from=projects');
 await expect(page.getByRole('heading',{name:'文件生成',exact:true})).toBeVisible();
 await expect(page.getByText('当前项目：来源项目',{exact:true})).toBeVisible();
 await expect(page.getByRole('radio',{name:'关联募集书项目',exact:true})).toBeChecked();
 await page.reload();await expect(page.getByText('当前项目：来源项目',{exact:true})).toBeVisible();expect(s.executions).toHaveLength(0);
});
for(const state of ['running','succeeded','failed'] as const)test(`project material link opens exact ${state} run and keeps navigation on refresh`,async({page})=>{
 const s=fixture(),task=s.addDocumentTask('dashboard-run');task.run=s.run('dashboard-run',state);if(state!=='running')s.workspace.active_run=null;
 if(state==='succeeded'){task.artifacts=[{...s.artifact,artifact_id:'dashboard-artifact',run_id:'dashboard-run',filename:'本次材料成果.docx'}];s.workspace.artifacts.push(...task.artifacts);}
 await mount(page,s);
 await page.route('**/api/v1/projects**',async route=>{const url=new URL(route.request().url());if(url.pathname==='/api/v1/projects/m4-project/tasks')return reply(route,taskPage('m4-project',[task.run],'generation',{topic_id:s.workspace.topic.topic_id}));if(url.pathname==='/api/v1/projects')return reply(route,{items:[{...s.workspace.project,status:state,latest_run:{run_id:'dashboard-run',state,updated_at:now}}],page:{has_more:false,next_cursor:null}});if(url.pathname==='/api/v1/projects/m4-project')return reply(route,s.workspace.project);return route.fallback();});
 await page.goto('/#dashboard');await page.locator('[data-tasks]').click();await page.locator('.collection-task a').click();
 await expect(page.locator('.nav-item.active')).toHaveText('任务进度与结果');await expect(page.locator('#m4-content')).toHaveAttribute('data-tab','run:dashboard-run');
 if(state==='succeeded')await expect(page.locator('#m4-content')).toContainText('本次材料成果.docx');else await expect(page.locator('#m4-content')).toContainText(state==='running'?'正在':'本轮未完成');
 await page.reload();await expect(page.locator('.nav-item.active')).toHaveText('任务进度与结果');await expect(page.locator('#m4-content')).toHaveAttribute('data-tab','run:dashboard-run');
 await page.getByRole('link',{name:'返回任务进度与结果'}).click();await expect(page.getByRole('heading',{name:'任务进度与结果',exact:true})).toBeVisible();expect(s.executions).toHaveLength(0);
});


for(const width of [1440,390])test(`delete owned material source and support without changing task history ${width}`,async({page})=>{
  const s=fixture();const source={...s.workspace.materials[0],source_project_id:'m4-project'};
  const support={...source,material_id:'support',sha256:hash('support')};
  s.workspace.materials=[source,support];s.workspace.material_details=[{...source,filename:'误传募集书.docx',state:'persisted',media_type:mime},{...support,filename:'误传财务报表.docx',state:'persisted',media_type:mime}];
  s.workspace.drafts.private_summary.source_material=source;s.workspace.drafts.private_summary.materials=[support];
  const old=s.addDocumentTask('completed');old.run.state='succeeded';s.workspace.active_run=null;const history=JSON.stringify(s.workspace.tasks);
  await page.setViewportSize({width,height:width===1440?960:844});await mount(page,s);await choose(page,'private_summary');
  let failed=false,deleteAttempts=0;await page.route('**/materials/*',route=>{if(route.request().method()!=='DELETE'){const m=s.workspace.material_details?.find(m=>m.material_id===new URL(route.request().url()).pathname.split('/').at(-1));return m?reply(route,m):route.fallback();}deleteAttempts++;if(!failed){failed=true;return reply(route,{code:'DATA_UNAVAILABLE'},503);}const id=new URL(route.request().url()).pathname.split('/').at(-1);s.workspace.materials=s.workspace.materials.filter(m=>m.material_id!==id);s.workspace.material_details=s.workspace.material_details!.filter(m=>m.material_id!==id);return route.fulfill({status:204});});
  page.on('dialog',dialog=>dialog.accept());const remove=page.getByRole('button',{name:'删除 误传财务报表.docx',exact:true});
  await remove.click();await expect(page.locator('#m4-status')).toContainText('删除结果暂未确认');await expect(page.locator('#m4-status')).toContainText('请先重新读取材料列表，核对后再继续。');await expect(remove).toBeEnabled();expect(deleteAttempts).toBe(1);
  await remove.evaluate(node=>(node as HTMLElement).dataset.r40BeforeRefresh='true');await page.getByRole('button',{name:'刷新状态',exact:true}).click();await expect(remove).not.toHaveAttribute('data-r40-before-refresh','true');await expect(remove).toBeEnabled();expect(deleteAttempts).toBe(1);
  await remove.click();await expect(remove).toHaveCount(0);await expect.poll(()=>s.workspace.drafts.private_summary.materials).toEqual([]);
  await expect(page.getByRole('button',{name:'删除 误传募集书.docx',exact:true})).toBeEnabled();
  if(process.env.BB_DELETE_EVIDENCE){const dir='test-evidence/material-delete-20261010';await mkdir(dir,{recursive:true});await page.locator('.m4-source-file').evaluate(el=>el.scrollIntoView({block:'center'}));await page.locator('.m4-source-file').screenshot({path:`${dir}/material-source-${width}.png`});}
  await page.getByRole('button',{name:'删除 误传募集书.docx',exact:true}).click();await expect.poll(()=>s.workspace.drafts.private_summary.source_material).toBeNull();
  await page.reload();await choose(page,'private_summary');await expect(page.locator('.m4-source-file')).toHaveCount(0);await expect(page.getByLabel('上传最新版募集说明书',{exact:true})).toBeVisible();
  expect(JSON.stringify(s.workspace.tasks)).toBe(history);expect(s.executions).toHaveLength(0);
});

test('linked source is not deleted from another project and own material unlocks after cancellation',async({page})=>{
  const s=fixture();await mount(page,s);await choose(page,'private_summary');
  await expect(page.locator('[data-m4-action=delete-material]')).toHaveCount(0);
  const source={...s.workspace.materials[0],source_project_id:'m4-project'};s.workspace.materials=[source];s.workspace.material_details=[{...source,filename:'本次上传.docx',state:'persisted',media_type:mime}];s.workspace.drafts.private_summary.source_material=source;
  const task=s.addDocumentTask('active');await page.reload();await choose(page,'private_summary');
  const remove=page.getByRole('button',{name:'删除 本次上传.docx',exact:true});await expect(remove).toBeDisabled();
  task.run.state='cancelled';s.workspace.active_run=null;await page.getByRole('button',{name:'刷新状态',exact:true}).click();await expect(remove).toBeEnabled();
});

for(const viewport of [{width:1440,height:960},{width:390,height:844}])test(`dynamic material progress, persistent tabs, pause/resume and wallet polling at ${viewport.width}px`,async({page})=>{
  await page.setViewportSize(viewport);const s=fixture(true);s.balance.available=1000;await mount(page,s);await choose(page,'private_summary');await start(page);
  expect(s.executions).toHaveLength(1);expect(s.balance).toEqual({available:1000,frozen:0});
  await expect(page.getByRole('tab',{name:'生成进度'})).toHaveAttribute('aria-selected','true');
  await expect(page.locator('.m4-tab-close')).toHaveCount(0);await expect(page.locator('[data-m4-detail=provenance]')).toHaveCount(0);
  await expect(page.locator('[aria-label=积分消耗]')).toContainText('当前已消耗');await expect(page.locator('[aria-label=积分消耗] strong')).toHaveText('0 积分');
  const task=s.workspace.tasks[0],p=task.credit_charge!.progress!;
  task.run.event_cursor=1;task.events=[{event_id:'synthetic-activity',schema_version:1,trace_id:'synthetic',run_id:task.run.run_id,seq:1,type:'run.progress',state:'running',stage:task.run.stage,payload:{authoring_activity:{activity_id:hash('read'),code:'read_materials',state:'started',summary:'正在核对发行人信息与财务材料'}},occurred_at:now}];
  p.accrued_points=p.charged_points=125;p.available_points=s.balance.available=875;p.active_ms=65000;p.last_activity_at=now;
  await expect(page.locator('[aria-label=积分消耗] strong')).toHaveText('125 积分',{timeout:10000});
  await expect(page.locator('[aria-label=生成过程]')).toContainText('正在核对发行人信息与财务材料');
  const wallet=page.locator(viewport.width>760?'.credit-wallet .wallet-value strong':'.mobile-credit-wallet strong');await expect(wallet).toHaveText('875');
  if(process.env.M4_DYNAMIC_EVIDENCE){const dir=resolve('test-evidence/material-dynamic-20261013');await mkdir(dir,{recursive:true});await page.screenshot({path:resolve(dir,`running-${viewport.width}.png`),fullPage:true});}
  await page.getByRole('button',{name:'暂停生成',exact:true}).click();await expect(page.locator('.task-progress')).toContainText('任务已暂停');
  await expect(page.locator('[aria-label=积分消耗] strong')).toHaveText('125 积分');await page.reload();await expect(page.getByRole('button',{name:'继续生成'})).toBeVisible();
  await page.getByRole('button',{name:'继续生成'}).click();await expect(page.getByRole('button',{name:'暂停生成'})).toBeVisible();expect(s.controls).toEqual(['pause','resume']);
  p.credit_exhausted=true;p.clock_running=false;p.available_points=s.balance.available=0;p.charged_points=p.accrued_points=1000;task.run.state='paused';task.run.stage='credits_exhausted';
  await page.getByRole('button',{name:'刷新状态'}).click();await expect(page.locator('.task-progress')).toContainText('积分已用完');await expect(page.getByRole('link',{name:'充值积分',exact:true})).toBeVisible();
  await expect(page.locator('[data-m4-action=download]')).toHaveCount(0);
  if(process.env.M4_DYNAMIC_EVIDENCE){await page.screenshot({path:resolve('test-evidence/material-dynamic-20261013',`exhausted-${viewport.width}.png`),fullPage:true});}
  await page.getByRole('button',{name:'结束本次生成'}).click();await expect(page.locator('[aria-label=积分消耗]')).toContainText('本次已扣费');
  await expect(page.locator('[aria-label=积分消耗] strong')).toHaveText('1,000 积分');expect(s.executions).toHaveLength(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('dynamic material zero balance keeps the draft and does not execute',async({page})=>{
  const s=fixture(true);s.balance.available=0;await mount(page,s);await choose(page,'private_summary');await start(page);
  await expect(page.locator('#m4-submit-status')).toContainText('积分不足');expect(s.executions).toHaveLength(0);
});
