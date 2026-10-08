import { test,expect,type Page,type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { M4_DOCUMENT_BILLING_TASKS,M4DraftRequestSchema,M4ViewRequestSchema,M4MessageRequestSchema,M4ExecuteRequestSchema,
  type M4Workspace,type M4DocumentType,type M4Draft,type M4Artifact,type M4Task,type M4MessageRequest,type M4ExecuteRequest,type M4QuoteRequest,type Run } from '@bondbuddy/contracts';

// Owner-scoped synthetic HTTP fixtures. These verify browser behavior, not model or DOCX quality.
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const now='2026-10-06T00:00:00Z',mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const reply=(route:Route,body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
function fixture(){
  const source={source_project_id:'source-project',material_id:'source-doc',material_version:3,sha256:hash('source')};
  const draft=(type:M4DocumentType):M4Draft=>({document_type:type,version:1,sha256:hash(type),updated_at:now,source_material:type==='private_summary'?source:null,materials:[],template:null,edit_base:null,scope:'whole',fields:{issuer_name:'合成发行人',market:'sse',broker:'合成券商'},requirements:[{requirement_id:'req1',text:'保留已采纳要求',message_id:'m0',message_version:1}]});
  const artifact:M4Artifact={source_project_id:'m4-project',artifact_id:'old-artifact',artifact_version:1,sha256:hash('Synthetic DOCX bytes'),topic_id:'topic-a',run_id:'run-old',document_type:'private_summary',kind:'document',filename:'合成摘要.docx',mime_type:mime,byte_size:Buffer.byteLength('Synthetic DOCX bytes'),created_at:now,base_artifact:null,input_hash:hash('old-input'),revision_number:1};
  const run=(id:string,state:Run['state']='running'):Run=>({run_id:id,project_id:'m4-project',execution_request_id:'execution-'+id,input_revision:1,input_hash:hash(id),state,stage:'m4_document_prompt',channel:'production',test_grant_id:null,uncovered_items:[],event_cursor:0,billing_mode:'platform_trial',reservation_id:null,artifact_id:state==='succeeded'?artifact.artifact_id:null,prompt_snapshot_ref:null,updated_at:now});
  const workspace:M4Workspace={topic:{topic_id:'topic-a',project_id:'m4-project',source_project_id:'source-project',name:'合成材料工作区',created_at:now,updated_at:now},project:{project_id:'m4-project',draft_revision:1,input_revision:null,input_hash:null,name:'合成材料工作区',kind:'generation',issuer_name:'合成发行人',market:'sse',offering:'private',updated_at:now},drafts:{init:draft('init'),underwriter:draft('underwriter'),legal:draft('legal'),private_summary:draft('private_summary')},materials:[source],material_details:[{...source,filename:'来源募集书.docx',state:'persisted',media_type:mime}],templates:[],messages:[],tasks:[],pending_requirements:[],artifacts:[artifact],view:{selected_document_type:null,open_tabs:[],active_tab:null,unsent_content:'',unsent_context:{document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:null},version:0},active_run:null};
  const addDocumentTask=(id:string,type:M4DocumentType='private_summary',version=workspace.drafts[type].version)=>{const current=run(id);workspace.active_run=current;const task:M4Task={run:current,manifest:{version:'m4-document-input-v1',kind:'document',topic_id:'topic-a',execution_scope_project_id:'source-project',draft_version:version,input:structuredClone(workspace.drafts[type]),template_material:null,market:'sse',offering:'private',billing_task:M4_DOCUMENT_BILLING_TASKS[type]},created_at:now,events:[],artifacts:[]};workspace.tasks.push(task);return task;};
  return {workspace,artifact,run,addDocumentTask,messages:[] as M4MessageRequest[],executions:[] as M4ExecuteRequest[],quotes:[] as M4QuoteRequest[],startDocumentOnMessage:false,dropMessage:false,dropExecution:false,charged:0,balance:{available:10000,frozen:0},balanceReads:0};
}
async function mount(page:Page,state:ReturnType<typeof fixture>,mode:'generate'='generate',fresh=false){
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;
    if(path==='/api/v1/me')return reply(route,{user_id:'owner-a'});
    if(path==='/api/v1/credits/balance'){state.balanceReads++;return reply(route,{enabled:true,...state.balance});}
    if(path==='/api/v1/m4/topics')return reply(route,req.method()==='POST'?{topic:state.workspace.topic}:{topics:[state.workspace.topic]});
    if(path==='/api/v1/projects/source-project')return reply(route,{...state.workspace.project,project_id:'source-project',name:'来源项目'});
    if(path.endsWith('/workspace'))return reply(route,state.workspace);
    if(path.includes('/drafts/')){const body=req.postDataJSON();expect(Value.Check(M4DraftRequestSchema,body)).toBe(true);const d=state.workspace.drafts[body.input.document_type as 'init'|'private_summary'];if(body.expected_version!==d.version)return reply(route,{code:'INPUT_REVISION_CONFLICT'},409);const saved={...body.input,version:d.version+1,sha256:hash(JSON.stringify(body.input)),updated_at:now};state.workspace.drafts[saved.document_type as 'init'|'private_summary']=saved;return reply(route,{draft:saved});}
    if(path.endsWith('/view')){const body=req.postDataJSON();expect(Value.Check(M4ViewRequestSchema,body)).toBe(true);if(body.expected_version!==state.workspace.view.version)return reply(route,{code:'INPUT_REVISION_CONFLICT'},409);state.workspace.view={...body.view,version:body.expected_version+1};return reply(route,{view:state.workspace.view});}
    if(path.endsWith('/quote')){const body=req.postDataJSON(),fixed=body.kind==='document';state.quotes.push(body);return reply(route,{quote:{quote_id:'quote-a',topic_id:'topic-a',input_hash:hash('quote'),task_type:fixed?M4_DOCUMENT_BILLING_TASKS[body.document_type as M4DocumentType]:'m4_Q01',points:fixed?4500:20,price_version:'synthetic-v1',reason:fixed?'每份材料固定 4,500 积分，包含正文 Word 和编制说明；成功交付后扣款，失败或取消全额释放。':'合成问答报价，按用量结算',created_at:now,billing_method:fixed?'fixed':'metered_capped',amount_semantics:fixed?'fixed_price':'reservation_cap',multiplier:1,expires_at:'2099-01-01T00:00:00Z'},balance:state.balance,shortage:Math.max(0,(fixed?4500:20)-state.balance.available)});}
    if(path.endsWith('/messages')){const body=req.postDataJSON() as M4MessageRequest;expect(Value.Check(M4MessageRequestSchema,body)).toBe(true);state.messages.push(body);let message=state.workspace.messages.find(m=>m.message_id===body.submission_request_id);if(!message){state.charged++;message={message_id:body.submission_request_id,role:'user',content:body.content,context:body.context,version:1,created_at:now,reply_status:'completed',reply_to:null,run_id:'qa-run',reply:null,error:null};state.workspace.messages.push(message,{...message,message_id:'reply-'+message.message_id,role:'assistant',content:'合成接口回复：原文字与版本已保留。',reply_to:message.message_id});if(state.startDocumentOnMessage&&body.execute)state.addDocumentTask('assistant-document',body.context.document_type??'private_summary',body.context.draft_version);}if(state.dropMessage){state.dropMessage=false;return route.abort('connectionreset');}return reply(route,{message,run:state.run('qa-run','succeeded')});}
    if(path.endsWith('/execute')){const body=req.postDataJSON() as M4ExecuteRequest;expect(Value.Check(M4ExecuteRequestSchema,body)).toBe(true);state.executions.push(body);let task=state.workspace.tasks.find(t=>t.run.execution_request_id===body.execution_request_id);if(!task){task=state.addDocumentTask('new-run',body.document_type,body.expected_draft_version);task.run.execution_request_id=body.execution_request_id;state.balance.available-=4500;state.balance.frozen+=4500;}if(state.dropExecution){state.dropExecution=false;return route.abort('connectionreset');}return reply(route,{run:task.run});}
    if(path.endsWith('/preview')){const id=path.split('/')[5],a=state.workspace.artifacts.find(a=>a.artifact_id===id);return a?reply(route,{artifact:a,content:'合成正文第一段：原准确版本。\n\n合成正文第二段。'}):reply(route,{code:'NOT_FOUND'},404);}
    if(path.endsWith('/bytes'))return route.fulfill({status:200,contentType:mime,body:'Synthetic DOCX bytes'});
    return reply(route,{code:'NOT_FOUND'},404);
  });
  await page.goto(`/#${mode}?${fresh?'new=synthetic':'topic=topic-a'}`);await expect(page.getByRole('heading',{name:'材料生成',exact:true})).toBeVisible();
}

const choose=async(page:Page,type:M4DocumentType)=>page.locator(`[data-m4-type][value="${type}"]`).check();
const start=async(page:Page)=>{await page.getByRole('button',{name:'生成普通私募募集说明书摘要',exact:true}).click();await expect(page.getByRole('button',{name:'正在提交…',exact:true})).toHaveCount(0);};

for(const viewport of [{width:1440,height:1100},{width:430,height:932}])test(`one click starts a document without a price panel and balance drops only after success at ${viewport.width}px`,async({page})=>{
  await page.setViewportSize(viewport);const s=fixture();await mount(page,s);await choose(page,'private_summary');
  const wallet=page.locator(viewport.width>760?'.credit-wallet .wallet-value strong':'.mobile-credit-wallet strong');
  await expect(wallet).toHaveText('10,000');
  await expect(page.locator('.m4-price')).toHaveCount(0);await expect(page.getByRole('button',{name:'确认并生成'})).toHaveCount(0);
  if(process.env.M4_UX_EVIDENCE){const dir=resolve('test-evidence/m4-one-click-20261008');await mkdir(dir,{recursive:true});await page.locator('.form-footer').scrollIntoViewIfNeeded();await page.screenshot({path:resolve(dir,`ready-${viewport.width}.png`)});}
  await start(page);await expect.poll(()=>s.executions.length).toBe(1);expect(s.quotes).toHaveLength(1);
  await expect(page.getByRole('tab',{name:'正在制作'})).toHaveAttribute('aria-selected','true');
  await expect(page.locator('.m4-price')).toHaveCount(0);await expect(wallet).toHaveText('10,000');
  await expect(page.locator('.wallet-note')).toContainText('任务已预留 4,500');
  const reads=s.balanceReads;s.balance.frozen=0;
  const fresh={...s.artifact,artifact_id:'new-artifact',revision_number:2,filename:'合成摘要新稿.docx',run_id:'new-run'};
  s.workspace.artifacts.push(fresh);s.workspace.tasks[0].run=s.run('new-run','succeeded');s.workspace.tasks[0].artifacts=[fresh];s.workspace.active_run=null;
  // The material poll, not the 30s wallet timer or a manual refresh, updates settlement.
  await expect(wallet).toHaveText('5,500',{timeout:10000});expect(s.balanceReads).toBeGreaterThan(reads);
  await expect(page.locator('#m4-status')).toContainText('本次制作已完成');
  await expect(page.locator('.wallet-note')).toContainText('暂无预留积分');
  if(process.env.M4_UX_EVIDENCE){await page.screenshot({path:resolve('test-evidence/m4-one-click-20261008',`success-${viewport.width}.png`)});}
});

test('insufficient credits show a recharge action, retain input and never auto-start',async({page})=>{
  const s=fixture();s.balance.available=1000;await mount(page,s);await choose(page,'private_summary');
  await page.locator('#m4-requirements').fill('积分不足时保留这份输入');await start(page);
  await expect(page.locator('#m4-submit-status [role=alert]')).toContainText('积分不足');
  await expect(page.locator('#m4-submit-status').getByRole('link',{name:'充值积分'})).toHaveAttribute('href','#/account');
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
  await page.getByRole('button',{name:'生成普通私募募集说明书摘要',exact:true}).evaluate(el=>{(el as HTMLButtonElement).click();(el as HTMLButtonElement).click();});
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
  await page.getByRole('button',{name:'生成普通私募募集说明书摘要',exact:true}).click();await expect.poll(()=>quotes).toBe(1);
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

test('first form save and concurrent upload share creation and retain entered requirements',async({page})=>{
  const s=fixture();for(const d of Object.values(s.workspace.drafts)){d.version=0;d.fields={};d.requirements=[];d.source_material=null;}
  await mount(page,s,'generate',true);let creates=0,uploads=0,release!:()=>void;
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
  await expect(page.locator('.sidebar').getByRole('link',{name:'材料生成',exact:true})).toHaveCount(1);
  await expect(page.locator('.sidebar').getByRole('link',{name:'项目问答',exact:true})).toHaveCount(0);
  await expect(page.locator('#m4-agent,#m4-message,[data-m4-action=discuss],#m4-topic,[data-m4-action=new-topic],#m4-source')).toHaveCount(0);
  await expect(page.locator('[data-m4-type]')).toHaveCount(4);await expect(page.getByText('推荐函',{exact:true})).toBeVisible();
  await choose(page,'legal');await expect(page.getByRole('heading',{name:'这份材料依据哪份募集书'})).toBeVisible();
  await expect(page.locator('#m4-content textarea')).toHaveCount(1);await expect(page.locator('#m4-requirements')).toBeVisible();
  await page.getByRole('radio',{name:'关联募集书项目',exact:true}).check();await expect(page.getByRole('button',{name:'选择募集书项目'})).toBeVisible();
  await expect(page.locator('[data-m4-upload=source]')).toHaveCount(0);await page.getByRole('radio',{name:'上传最新版募集书',exact:true}).check();
  await expect(page.locator('[data-m4-upload=source]')).toHaveCount(1);expect(s.executions).toHaveLength(0);expect(s.messages).toHaveLength(0);
  await page.route('**/projects/m4-project',route=>reply(route,s.workspace.project));
  await page.goto('/#/projects/m4-project');await expect(page.getByRole('heading',{name:'材料生成',exact:true})).toBeVisible();
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
  await expect(page.getByRole('tab',{name:'正在制作'})).toHaveAttribute('aria-selected','true');await expect(page.locator('.m4-task')).toContainText('正在制作');
  await expect(page.locator('#m4-requirements,#m4-message')).toHaveCount(0);
  const fixed=structuredClone(s.workspace.tasks[0].manifest);expect(fixed.kind==='document'&&fixed.input.supplemental_requirements).toBe('保留财务表格');
  await page.getByRole('button',{name:'准备新任务'}).click();await page.locator('#m4-requirements').fill('下一版增加风险分析');
  await expect.poll(()=>s.workspace.drafts.private_summary.supplemental_requirements).toBe('下一版增加风险分析');expect(s.workspace.tasks[0].manifest).toEqual(fixed);expect(s.executions).toHaveLength(1);
});

test('completion keeps older reader, new real artifact appears once and preview failure still permits download',async({page})=>{
  const s=fixture();await mount(page,s);await choose(page,'private_summary');await start(page);await page.getByRole('button',{name:'准备新任务'}).click();
  await page.getByRole('button',{name:'合成摘要.docx · 第1稿',exact:true}).click();await expect(page.locator('.m4-preview')).toContainText('合成正文');
  const fresh={...s.artifact,artifact_id:'new-artifact',revision_number:2,filename:'合成摘要新稿.docx',run_id:'new-run'};
  s.workspace.artifacts.push(fresh);s.workspace.tasks[0].run=s.run('new-run','succeeded');s.workspace.tasks[0].artifacts=[fresh];s.workspace.active_run=null;
  await page.getByRole('button',{name:'刷新状态'}).click();await expect(page.getByRole('tab',{name:'合成摘要.docx · 第1稿',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('tab',{name:'合成摘要新稿.docx · 第2稿'})).toHaveCount(1);
  await page.route('**/preview',route=>reply(route,{code:'DATA_UNAVAILABLE'},503));await page.getByRole('tab',{name:'合成摘要新稿.docx · 第2稿'}).click();
  await expect(page.locator('.m4-preview')).toContainText('可下载原成果查看');await expect(page.getByRole('button',{name:'下载',exact:true})).toBeEnabled();expect(s.executions).toHaveLength(1);
});

test('whole-document continuation keeps original source and requirements',async({page})=>{
  const s=fixture();await mount(page,s);await page.getByRole('button',{name:'合成摘要.docx · 第1稿',exact:true}).click();
  await page.getByRole('button',{name:'基于 合成摘要.docx · 第1稿 继续全文改稿'}).click();
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
  await page.getByRole('button',{name:'生成普通私募募集说明书摘要',exact:true}).click();await expect.poll(()=>s.workspace.drafts.private_summary.supplemental_requirements).toBe('保存失败也不能丢失');
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
  if(process.env.M4_UX_EVIDENCE){const output=resolve('test-evidence/m4-one-click-20261008');await mkdir(output,{recursive:true});await page.screenshot({path:`${output}/implementation-error-${label}.png`});}
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
  await expect(page.locator('#m4-status')).toContainText('请先填写主承销商并选择交易所');expect(uploadRequests).toBe(0);expect(s.executions).toHaveLength(0);
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
  const output=resolve('test-evidence/m4-one-click-20261008');await mkdir(output,{recursive:true});
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
  for(const [label,viewport] of [['desktop',{width:1440,height:960}],['mobile',{width:390,height:844}]] as const){
    await page.setViewportSize(viewport);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const headings=await page.locator('.form-card>h2').evaluateAll(nodes=>nodes.map(node=>({size:getComputedStyle(node).fontSize,weight:getComputedStyle(node).fontWeight})));
    expect(new Set(headings.map(h=>`${h.size}:${h.weight}`)).size).toBe(1);
    await page.screenshot({path:`${output}/saved-file-${label}.png`,fullPage:true});
  }
  await original.close();
});
