import { test,expect,type Page,type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { Value } from '@sinclair/typebox/value';
import { M4DraftRequestSchema,M4ViewRequestSchema,M4MessageRequestSchema,M4ExecuteRequestSchema,
  type M4Workspace,type M4Draft,type M4Artifact,type M4Task,type M4MessageRequest,type M4ExecuteRequest,type M4QuoteRequest,type Run } from '@bondbuddy/contracts';

// Owner-scoped synthetic HTTP fixtures. These verify browser behavior, not model or DOCX quality.
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const now='2026-10-06T00:00:00Z',mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const reply=(route:Route,body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
function fixture(){
  const source={source_project_id:'source-project',material_id:'source-doc',material_version:3,sha256:hash('source')};
  const draft=(type:'init'|'private_summary'):M4Draft=>({document_type:type,version:1,sha256:hash(type),updated_at:now,source_material:type==='private_summary'?source:null,materials:[],template:null,edit_base:null,scope:'whole',fields:{issuer_name:'合成发行人',market:'sse',broker:'合成券商'},requirements:[{requirement_id:'req1',text:'保留已采纳要求',message_id:'m0',message_version:1}]});
  const artifact:M4Artifact={source_project_id:'m4-project',artifact_id:'old-artifact',artifact_version:1,sha256:hash('Synthetic DOCX bytes'),topic_id:'topic-a',run_id:'run-old',document_type:'private_summary',kind:'document',filename:'合成摘要.docx',mime_type:mime,byte_size:Buffer.byteLength('Synthetic DOCX bytes'),created_at:now,base_artifact:null,input_hash:hash('old-input'),revision_number:1};
  const run=(id:string,state:Run['state']='running'):Run=>({run_id:id,project_id:'m4-project',execution_request_id:'execution-'+id,input_revision:1,input_hash:hash(id),state,stage:'m4_document_prompt',channel:'production',test_grant_id:null,uncovered_items:[],event_cursor:0,billing_mode:'platform_trial',reservation_id:null,artifact_id:state==='succeeded'?artifact.artifact_id:null,prompt_snapshot_ref:null,updated_at:now});
  const workspace:M4Workspace={topic:{topic_id:'topic-a',project_id:'m4-project',source_project_id:'source-project',name:'合成材料工作区',created_at:now,updated_at:now},project:{project_id:'m4-project',draft_revision:1,input_revision:null,input_hash:null,name:'合成材料工作区',kind:'generation',issuer_name:'合成发行人',market:'sse',offering:'private',updated_at:now},drafts:{init:draft('init'),private_summary:draft('private_summary')},materials:[source],material_details:[{...source,filename:'来源募集书.docx',state:'persisted',media_type:mime}],templates:[],messages:[],tasks:[],pending_requirements:[],artifacts:[artifact],view:{selected_document_type:null,open_tabs:[],active_tab:null,unsent_content:'',unsent_context:{document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:null},version:0},active_run:null};
  const addDocumentTask=(id:string,type:'init'|'private_summary'='private_summary',version=workspace.drafts[type].version)=>{const current=run(id);workspace.active_run=current;const task:M4Task={run:current,manifest:{version:'m4-document-input-v1',kind:'document',topic_id:'topic-a',execution_scope_project_id:'source-project',draft_version:version,input:structuredClone(workspace.drafts[type]),template_material:null,market:'sse',offering:'private',billing_task:type==='init'?'m4_G01':'m4_G05'},created_at:now,events:[],artifacts:[]};workspace.tasks.push(task);return task;};
  return {workspace,artifact,run,addDocumentTask,messages:[] as M4MessageRequest[],executions:[] as M4ExecuteRequest[],quotes:[] as M4QuoteRequest[],startDocumentOnMessage:false,dropMessage:false,charged:0};
}
async function mount(page:Page,state:ReturnType<typeof fixture>){
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;
    if(path==='/api/v1/me')return reply(route,{user_id:'owner-a'});
    if(path==='/api/v1/credits/balance')return reply(route,{enabled:true,available:1000,frozen:0});
    if(path==='/api/v1/m4/topics')return reply(route,{topics:[state.workspace.topic]});
    if(path==='/api/v1/projects/source-project')return reply(route,{...state.workspace.project,project_id:'source-project',name:'来源项目'});
    if(path.endsWith('/workspace'))return reply(route,state.workspace);
    if(path.includes('/drafts/')){const body=req.postDataJSON();expect(Value.Check(M4DraftRequestSchema,body)).toBe(true);const d=state.workspace.drafts[body.input.document_type as 'init'|'private_summary'];if(body.expected_version!==d.version)return reply(route,{code:'INPUT_REVISION_CONFLICT'},409);const saved={...body.input,version:d.version+1,sha256:hash(JSON.stringify(body.input)),updated_at:now};state.workspace.drafts[saved.document_type as 'init'|'private_summary']=saved;return reply(route,{draft:saved});}
    if(path.endsWith('/view')){const body=req.postDataJSON();expect(Value.Check(M4ViewRequestSchema,body)).toBe(true);if(body.expected_version!==state.workspace.view.version)return reply(route,{code:'INPUT_REVISION_CONFLICT'},409);state.workspace.view={...body.view,version:body.expected_version+1};return reply(route,{view:state.workspace.view});}
    if(path.endsWith('/quote')){state.quotes.push(req.postDataJSON());return reply(route,{quote:{quote_id:'quote-a',topic_id:'topic-a',input_hash:hash('quote'),task_type:req.postDataJSON().kind==='qa'?'m4_Q01':'m4_G05',points:20,price_version:'test-v1',reason:'合成报价，用于验证预留上限展示',created_at:now,billing_method:'metered_capped',amount_semantics:'reservation_cap',multiplier:1,expires_at:'2099-01-01T00:00:00Z'},balance:{available:1000,frozen:0},shortage:0});}
    if(path.endsWith('/messages')){const body=req.postDataJSON() as M4MessageRequest;expect(Value.Check(M4MessageRequestSchema,body)).toBe(true);state.messages.push(body);let message=state.workspace.messages.find(m=>m.message_id===body.submission_request_id);if(!message){state.charged++;message={message_id:body.submission_request_id,role:'user',content:body.content,context:body.context,version:1,created_at:now,reply_status:'completed',reply_to:null,run_id:'qa-run',reply:null,error:null};state.workspace.messages.push(message,{...message,message_id:'reply-'+message.message_id,role:'assistant',content:'合成接口回复：原文字与版本已保留。',reply_to:message.message_id});if(state.startDocumentOnMessage&&body.execute)state.addDocumentTask('assistant-document',body.context.document_type??'private_summary',body.context.draft_version);}if(state.dropMessage){state.dropMessage=false;return route.abort('connectionreset');}return reply(route,{message,run:state.run('qa-run','succeeded')});}
    if(path.endsWith('/execute')){const body=req.postDataJSON() as M4ExecuteRequest;expect(Value.Check(M4ExecuteRequestSchema,body)).toBe(true);state.executions.push(body);const task=state.addDocumentTask('new-run',body.document_type,body.expected_draft_version);return reply(route,{run:task.run});}
    if(path.endsWith('/preview')){const id=path.split('/')[5],a=state.workspace.artifacts.find(a=>a.artifact_id===id);return a?reply(route,{artifact:a,content:'合成正文第一段：原准确版本。\n\n合成正文第二段。'}):reply(route,{code:'NOT_FOUND'},404);}
    if(path.endsWith('/bytes'))return route.fulfill({status:200,contentType:mime,body:'Synthetic DOCX bytes'});
    return reply(route,{code:'NOT_FOUND'},404);
  });
  await page.goto('/#generate?topic=topic-a');await expect(page.getByRole('heading',{name:'材料生成与问答'})).toBeVisible();
}
test('one combined entry; choose type before material inputs and QA stays in always-on assistant',async({page})=>{const s=fixture();await mount(page,s);await expect(page.locator('.sidebar').getByRole('link',{name:'材料生成与问答'})).toHaveCount(1);await expect(page.locator('.sidebar').getByRole('link',{name:'项目问答',exact:true})).toHaveCount(0);await expect(page.locator('[data-m4-upload]')).toHaveCount(0);await expect(page.locator('#m4-agent')).toBeVisible();await page.locator('#m4-document-type').selectOption('private_summary');await expect(page.getByRole('heading',{name:'来源募集说明书'})).toBeVisible();await expect(page.getByRole('heading',{name:'私有立项模板'})).toHaveCount(0);await expect(page.locator('#m4-content textarea')).toHaveCount(0);await page.locator('#m4-document-type').selectOption('init');await expect(page.getByRole('heading',{name:'私有立项模板'})).toBeVisible();await expect(page.getByRole('heading',{name:'来源募集说明书'})).toHaveCount(0);await page.setViewportSize({width:760,height:900});await expect(page.locator('#m4-agent')).toBeVisible();expect(await page.locator('#m4-agent').evaluate(el=>getComputedStyle(el).position)).toBe('static');});
test('discussion button keeps unsent words and exact previous-version quotation; reload restores both',async({page})=>{const s=fixture();await mount(page,s);await page.getByRole('button',{name:'合成摘要.docx · 第1稿',exact:true}).click();await expect(page.locator('.m4-preview')).toContainText('合成正文第一段');await page.locator('.m4-preview p').first().evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const selection=getSelection();selection?.removeAllRanges();selection?.addRange(range);});await page.getByRole('button',{name:'引用选中文字与助手讨论'}).click();await page.locator('#m4-message').fill('尚未发送的讨论');await page.getByRole('tab',{name:'任务输入'}).click();await page.locator('#m4-document-type').selectOption('private_summary');await page.getByRole('button',{name:'与助手讨论',exact:true}).click();await expect(page.locator('#m4-message')).toHaveValue('尚未发送的讨论');await expect(page.locator('.m4-quote')).toContainText('原准确版本');await expect.poll(()=>s.workspace.view.quotation?.citation.kind).toBe('artifact');await page.reload();await expect(page.locator('#m4-message')).toHaveValue('尚未发送的讨论');await expect(page.locator('.m4-quote')).toContainText('原准确版本');expect(s.messages.length).toBe(0);expect(s.executions.length).toBe(0);});
test('priced QA requires explicit send; a lost response reuses request ID and never bills twice',async({page})=>{const s=fixture();await mount(page,s);await page.locator('#m4-message').fill('请解释普通私募');await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.locator('#m4-composer')).toContainText('预留上限 B');expect(s.messages).toHaveLength(0);s.dropMessage=true;await page.getByRole('button',{name:'确认并发送',exact:true}).click();await expect(page.getByRole('button',{name:'重试原请求',exact:true})).toBeVisible();await page.getByRole('button',{name:'重试原请求',exact:true}).click();await expect(page.locator('.m4-messages')).toContainText('合成接口回复');expect(s.messages).toHaveLength(2);expect(s.messages[0].submission_request_id).toBe(s.messages[1].submission_request_id);expect(s.charged).toBe(1);expect(s.executions).toHaveLength(0);});
test('making becomes an actual artifact in place and completion does not steal an old artifact reader',async({page})=>{const s=fixture();await mount(page,s);await page.locator('#m4-document-type').selectOption('private_summary');await page.getByRole('button',{name:'查看报价并制作'}).click();await page.getByRole('button',{name:'确认并开始制作'}).click();await expect(page.getByRole('tab',{name:'正在制作'})).toHaveAttribute('aria-selected','true');await expect(page.locator('#m4-content h2')).toHaveText('正在制作');await expect(page.locator('#m4-messages')).toContainText('执行过程');await page.getByRole('button',{name:'准备新任务'}).click();await page.getByRole('button',{name:'合成摘要.docx · 第1稿',exact:true}).click();const fresh={...s.artifact,artifact_id:'new-artifact',artifact_version:1,revision_number:2,filename:'合成摘要新稿.docx',run_id:'new-run',base_artifact:{source_project_id:'m4-project',artifact_id:s.artifact.artifact_id,artifact_version:1,sha256:s.artifact.sha256}};s.workspace.artifacts.push(fresh);s.workspace.tasks[0].run=s.run('new-run','succeeded');s.workspace.tasks[0].artifacts=[fresh];s.workspace.active_run=null;await page.getByRole('button',{name:'刷新状态'}).click();await expect(page.getByRole('tab',{name:'合成摘要.docx · 第1稿',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('tab',{name:'合成摘要新稿.docx · 第2稿',exact:true})).toHaveCount(1);await page.getByRole('tab',{name:'合成摘要新稿.docx · 第2稿',exact:true}).click();await expect(page.locator('#m4-content h2')).toHaveText('合成摘要新稿.docx');await expect(page.locator('.m4-task > p')).toHaveText('已完成');await expect(page.locator('#m4-status')).toContainText('本次制作已完成');await expect(page.locator('.m4-artifact-head > div > p')).toContainText('第2稿');await expect(page.locator('.m4-artifact-head > div > p')).not.toContainText('V1');await page.reload();await expect(page.locator('#m4-content h2')).toHaveText('合成摘要新稿.docx');});
test('whole-document continuation preserves source/requirements and pins selected exact artifact base',async({page})=>{const s=fixture();await mount(page,s);await page.getByRole('button',{name:'合成摘要.docx · 第1稿',exact:true}).click();await page.getByRole('button',{name:'基于 合成摘要.docx · 第1稿 继续全文改稿'}).click();await expect(page.locator('#m4-content')).toContainText('本次全文改稿基于 合成摘要.docx · 第1稿');await expect.poll(()=>s.workspace.drafts.private_summary.edit_base?.artifact_id).toBe('old-artifact');expect(s.workspace.drafts.private_summary.source_material?.material_version).toBe(3);expect(s.workspace.drafts.private_summary.requirements[0].text).toBe('保留已采纳要求');expect(s.workspace.drafts.private_summary.scope).toBe('whole');expect(s.executions).toHaveLength(0);});

test('an active source-project task rejects execution while retaining drafts and never resumes automatically',async({page})=>{
  const s=fixture();await mount(page,s);let sourceBusy=true,attempts=0;
  await page.route('**/api/v1/m4/topics/topic-a/execute',route=>{attempts++;return sourceBusy?reply(route,{code:'PROJECT_RUN_ACTIVE',message:'Synthetic private worker path must not reach the UI'},409):route.fallback();});
  await page.locator('#m4-document-type').selectOption('private_summary');await page.locator('#m4-issuer').fill('被阻塞后保留的发行人');await page.locator('#m4-message').fill('尚未发送的更新要求');await expect.poll(()=>s.workspace.drafts.private_summary.fields.issuer_name).toBe('被阻塞后保留的发行人');
  const fixedDraft=structuredClone(s.workspace.drafts.private_summary);await page.getByRole('button',{name:'查看报价并制作'}).click();await page.getByRole('button',{name:'确认并开始制作'}).click();
  await expect(page.locator('#m4-status')).toContainText('同一来源项目已有任务正在执行');await expect(page.locator('#m4-status')).toContainText('本次未开始，草稿保留');await expect(page.locator('#m4-status')).not.toContainText('其他页面');await expect(page.locator('body')).not.toContainText('Synthetic private worker');
  expect(attempts).toBe(1);expect(s.executions).toHaveLength(0);expect(s.workspace.tasks).toHaveLength(0);expect(s.workspace.drafts.private_summary).toEqual(fixedDraft);await expect(page.locator('#m4-message')).toHaveValue('尚未发送的更新要求');await expect(page.getByRole('tab',{name:'正在制作',exact:true})).toHaveCount(0);
  sourceBusy=false;await page.getByRole('button',{name:'刷新状态'}).click();await page.reload();await expect(page.locator('#m4-issuer')).toHaveValue('被阻塞后保留的发行人');await expect(page.locator('#m4-message')).toHaveValue('尚未发送的更新要求');expect(attempts).toBe(1);expect(s.executions).toHaveLength(0);
  await page.getByRole('button',{name:'查看报价并制作'}).click();await page.getByRole('button',{name:'确认并开始制作'}).click();await expect(page.getByRole('tab',{name:'正在制作',exact:true})).toHaveAttribute('aria-selected','true');expect(attempts).toBe(2);expect(s.executions).toHaveLength(1);
});

test('assistant start without a quote prepares price first, then a real document task controls making',async({page})=>{
  const s=fixture();await mount(page,s);await page.locator('#m4-document-type').selectOption('private_summary');
  await page.locator('#m4-message').fill('开始制作');await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect(page.locator('#m4-composer')).toContainText('预留上限 B');expect(s.messages).toHaveLength(0);expect(s.workspace.tasks).toHaveLength(0);
  s.startDocumentOnMessage=true;await page.getByRole('button',{name:'确认并发送',exact:true}).click();
  await expect(page.getByRole('tab',{name:'正在制作'})).toHaveAttribute('aria-selected','true');
  expect(s.messages).toHaveLength(1);expect(s.messages[0].execute).toBe(true);expect(s.messages[0].quote_id).toBe('quote-a');
  expect(s.executions).toHaveLength(0);expect(s.workspace.tasks[0].manifest.kind).toBe('document');
});

for(const content of ['摘要中的募集资金用途是什么意思？','先别生成摘要，只帮我确认资料','如何生成募集说明书摘要？','请根据复核结果更新募集书','只修改我引用的这一段','请生成法律意见书']){
  test(`a displayed document quote is only a proposal; interpretation without a document run never shows making: ${content}`,async({page})=>{
    const s=fixture();await mount(page,s);await page.locator('#m4-document-type').selectOption('private_summary');
    await page.getByRole('button',{name:'查看报价并制作'}).click();await expect(page.locator('#m4-content')).toContainText('预留上限 B');
    await page.locator('#m4-message').fill(content);await page.getByRole('button',{name:'发送',exact:true}).click();
    await expect.poll(()=>s.messages.length).toBe(1);expect(s.messages[0].content).toBe(content);expect(s.messages[0].execute).toBe(true);
    await expect(page.locator('.m4-messages')).toContainText('合成接口回复');
    await expect(page.getByRole('tab',{name:'正在制作'})).toHaveCount(0);await expect(page.getByRole('tab',{name:'任务输入'})).toHaveAttribute('aria-selected','true');
    expect(s.executions).toHaveLength(0);expect(s.workspace.tasks).toHaveLength(0);
  });
}

test('complex explicit request stays intact; only an observed downstream document run adds the making tab',async({page})=>{
  const s=fixture();await mount(page,s);await page.locator('#m4-document-type').selectOption('private_summary');
  await page.getByRole('button',{name:'查看报价并制作'}).click();
  await expect(page.locator('#m4-content')).toContainText('预留上限 B');
  const content='请开始生成摘要，保留待核事项，不要生成签署页';
  await page.locator('#m4-message').fill(content);await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect.poll(()=>s.messages.length).toBe(1);expect(s.messages[0].content).toBe(content);
  await expect(page.getByRole('tab',{name:'正在制作'})).toHaveCount(0);
  s.addDocumentTask('downstream-document');await page.getByRole('button',{name:'刷新状态'}).click();
  await expect(page.getByRole('tab',{name:'正在制作'})).toHaveAttribute('aria-selected','true');
});

test('new draft edits during production leave the task snapshot and execution count unchanged',async({page})=>{
  const s=fixture();await mount(page,s);await page.locator('#m4-document-type').selectOption('private_summary');
  await page.getByRole('button',{name:'查看报价并制作'}).click();await page.getByRole('button',{name:'确认并开始制作'}).click();
  await expect(page.getByRole('tab',{name:'正在制作'})).toBeVisible();const snapshot=structuredClone(s.workspace.tasks[0].manifest);
  await page.getByRole('button',{name:'准备新任务'}).click();await page.locator('#m4-issuer').fill('下一份草稿发行人');
  await expect.poll(()=>s.workspace.drafts.private_summary.fields.issuer_name).toBe('下一份草稿发行人');
  expect(s.workspace.tasks[0].manifest).toEqual(snapshot);expect(s.executions).toHaveLength(1);
  await page.getByRole('button',{name:'查看正在制作'}).click();await expect(page.locator('.m4-fixed-input')).toContainText('合成发行人');
  await expect(page.locator('.m4-fixed-input')).not.toContainText('下一份草稿发行人');
});

test('internal QA evidence cannot become a workspace artifact, including restored server tabs',async({page})=>{
  const s=fixture();const qa={...s.artifact,artifact_id:'internal-qa',document_type:null,kind:'qa_text' as const,filename:'内部问答用量证据.txt',revision_number:null};s.workspace.artifacts.push(qa);
  s.workspace.view.open_tabs=[{source_project_id:qa.source_project_id,artifact_id:qa.artifact_id,artifact_version:qa.artifact_version,sha256:qa.sha256}];s.workspace.view.active_tab=s.workspace.view.open_tabs[0];
  await mount(page,s);await expect(page.getByRole('tab',{name:'任务输入'})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('tab',{name:/内部问答/})).toHaveCount(0);await expect(page.getByRole('button',{name:/内部问答/})).toHaveCount(0);
});

test('QA quotes survive pure reading changes; a saved document edit updates assistant task context',async({page})=>{
  const s=fixture();await mount(page,s);await page.locator('#m4-message').fill('请解释普通私募');await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect(page.getByRole('button',{name:'确认并发送',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'合成摘要.docx · 第1稿',exact:true}).click();await page.getByRole('tab',{name:'任务输入'}).click();
  await expect(page.getByRole('button',{name:'确认并发送',exact:true})).toBeVisible();expect(s.quotes).toHaveLength(1);
  await page.locator('#m4-document-type').selectOption('private_summary');await page.locator('#m4-issuer').fill('草稿字段已变');
  await expect.poll(()=>s.workspace.drafts.private_summary.fields.issuer_name).toBe('草稿字段已变');
  await page.getByRole('button',{name:'与助手讨论',exact:true}).click();await expect(page.locator('#m4-context')).toContainText(`输入 V${s.workspace.drafts.private_summary.version}`);
  await expect(page.locator('#m4-message')).toHaveValue('请解释普通私募');expect(s.messages).toHaveLength(0);
});

test('template scope follows broker and exchange, and missing scope is explained before upload bytes',async({page})=>{
  const s=fixture();s.workspace.templates=['sse','szse'].map((market,index)=>({template_id:'t'+index,template_version:1,sha256:hash(market),name:market==='sse'?'合成上交所模板':'合成深交所模板',broker:'合成券商',document_type:'init',material:s.workspace.materials[0],owner_scope:'private',market:market as 'sse'|'szse',offering:'private',status:'active',created_at:now,retired_at:null}));
  await mount(page,s);await page.locator('#m4-document-type').selectOption('init');await expect(page.locator('#m4-template option')).toHaveCount(2);await expect(page.locator('#m4-template')).toContainText('合成上交所模板');
  await page.locator('#m4-market').selectOption('szse');await expect(page.locator('#m4-template')).toContainText('合成深交所模板');await expect(page.locator('#m4-template')).not.toContainText('合成上交所模板');
  let uploadRequests=0;page.on('request',request=>{if(request.url().includes('/materials/uploads'))uploadRequests++;});
  await page.locator('#m4-broker').fill('');await page.getByLabel('上传本机构模板',{exact:true}).setInputFiles({name:'合成模板.docx',mimeType:mime,buffer:Buffer.from('Synthetic template')});
  await expect(page.locator('#m4-status')).toContainText('请先填写主承销商并选择交易所');expect(uploadRequests).toBe(0);expect(s.executions).toHaveLength(0);
});

test('polling keeps a focused native file input connected',async({page})=>{
  const s=fixture();await mount(page,s);await page.locator('#m4-document-type').selectOption('private_summary');
  const input=page.getByLabel('上传募集说明书',{exact:true});await input.evaluate(el=>el.setAttribute('data-identity','native-picker'));await input.focus();
  await page.getByRole('button',{name:'刷新状态'}).evaluate(el=>(el as HTMLButtonElement).click());
  await expect(input).toHaveAttribute('data-identity','native-picker');
});

test('assistant attachments work before choosing a document and are not silently adopted into formal drafts',async({page})=>{
  const s=fixture();await mount(page,s);const filename='合成问答资料.txt',bytes='Synthetic QA source',sha256=hash(bytes);
  await page.route('**/api/v1/projects/m4-project/materials/uploads',route=>reply(route,{upload_id:'attachment-upload',state:'uploading',upload_url:'/synthetic-upload',expires_at:'2099-01-01T00:00:00Z',max_bytes:100000}));
  await page.route('**/synthetic-upload',route=>route.fulfill({status:204}));
  await page.route('**/api/v1/projects/m4-project/materials/uploads/attachment-upload/complete',route=>reply(route,{material_id:'attachment-material',material_version:1,upload_id:'attachment-upload',role:'other',filename,media_type:'text/plain',byte_size:Buffer.byteLength(bytes),sha256,state:'persisted',persisted_at:now,error:null}));
  await page.route('**/api/v1/m4/topics/topic-a/materials',route=>{const pin=route.request().postDataJSON().material;s.workspace.materials.push(pin);s.workspace.material_details.push({...pin,filename,state:'persisted',media_type:'text/plain'});return reply(route,{});});
  await page.getByLabel('向助手添加附件',{exact:true}).setInputFiles({name:filename,mimeType:'text/plain',buffer:Buffer.from(bytes)});
  await expect(page.locator('#m4-content')).toContainText(filename);await expect(page.locator('#m4-document-type')).toHaveValue('');
  expect(s.workspace.drafts.init.materials).toHaveLength(0);expect(s.workspace.drafts.private_summary.materials).toHaveLength(0);expect(s.executions).toHaveLength(0);expect(s.messages).toHaveLength(0);
});

test('assistant-adopted report cutoff appears in the canonical workspace date control without executing',async({page})=>{
  const s=fixture();await mount(page,s);await page.locator('#m4-document-type').selectOption('private_summary');
  s.workspace.drafts.private_summary={...s.workspace.drafts.private_summary,version:2,fields:{...s.workspace.drafts.private_summary.fields,reporting_cutoff:'2025-09-30'}};
  await page.getByRole('button',{name:'刷新状态'}).click();await expect(page.locator('#m4-cutoff')).toHaveValue('2025-09-30');
  expect(s.executions).toHaveLength(0);expect(s.messages).toHaveLength(0);
});

test('reference material choices exclude the fixed source and use a standard adjacent checkbox',async({page})=>{
  const s=fixture(),reference={...s.workspace.materials[0],material_id:'audit-reference',sha256:hash('reference')};s.workspace.materials.push(reference);s.workspace.material_details.push({...reference,filename:'合成审计报告.pdf',state:'persisted',media_type:'application/pdf'});
  await mount(page,s);await page.locator('#m4-document-type').selectOption('private_summary');await expect(page.locator('.m4-material-choice')).toHaveCount(1);await expect(page.locator('.m4-material-choice')).toContainText('合成审计报告.pdf');await expect(page.locator('.m4-material-choice')).not.toContainText('来源募集书');
  const choice=page.getByRole('checkbox',{name:'合成审计报告.pdf · V3',exact:true});const box=await choice.boundingBox();expect(box!.width).toBeLessThanOrEqual(18);expect(box!.height).toBeLessThanOrEqual(18);
  await choice.check();await expect.poll(()=>s.workspace.drafts.private_summary.materials).toEqual([reference]);expect(s.workspace.drafts.private_summary.source_material?.material_id).toBe('source-doc');expect(s.executions).toHaveLength(0);
});

test('synthetic M4 same-size implementation and schema6 design evidence',async({page})=>{
  test.skip(!process.env.BB_M4_EVIDENCE,'Only run when refreshing marked synthetic design evidence.');
  const output=process.env.BB_M4_EVIDENCE!;await mkdir(output,{recursive:true});
  const s=fixture(),reference={source_project_id:'source-project',material_id:'reference-audit',material_version:1,sha256:hash('Synthetic financial reference')};s.workspace.materials.push(reference);s.workspace.material_details.push({...reference,filename:'合成2025年审计报告.pdf',state:'persisted',media_type:'application/pdf'});s.workspace.drafts.private_summary.materials=[reference];await mount(page,s);await page.locator('#m4-document-type').selectOption('private_summary');
  const capture=async(prefix:string,scene:string)=>{for(const width of [1360,390]){await page.setViewportSize({width,height:width===1360?900:844});await page.evaluate(()=>window.scrollTo(0,0));expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:`${output}/${prefix}-${scene}-${width}.png`,fullPage:true});}};
  await capture('implementation','preparation');
  await page.setViewportSize({width:1360,height:900});await page.getByRole('button',{name:'查看报价并制作'}).click();await page.getByRole('button',{name:'确认并开始制作'}).click();await expect(page.getByRole('tab',{name:'正在制作'})).toHaveAttribute('aria-selected','true');
  await capture('implementation','making');
  await page.setViewportSize({width:1360,height:900});const generated={...s.artifact,artifact_id:'new-artifact',run_id:'new-run',filename:'合成摘要第2稿.docx',revision_number:2};s.workspace.artifacts.push(generated);s.workspace.tasks[0].run={...s.run('new-run','succeeded'),artifact_id:generated.artifact_id};s.workspace.tasks[0].artifacts=[generated];s.workspace.active_run=null;await page.getByRole('button',{name:'刷新状态'}).click();await expect(page.locator('.m4-preview')).toContainText('合成正文第一段');await capture('implementation','artifact');
  const prototypePath=process.env.BB_M4_PROTOTYPE;
  if(!prototypePath){await writeFile(`${output}/prototype-status.txt`,'schema6 source not supplied; same-size design comparison remains pending.\n');return;}
  const baseline=await readFile(prototypePath,'utf8');expect(hash(baseline)).toBe('aa15f4e7c517f893019e60cf546f6163a63620fc47287bb037172ed653d7a94a');
  await page.route('**/m4-design-evidence.html',route=>route.fulfill({status:200,contentType:'text/html',body:`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;color-scheme:light}</style><script>window.openai={setWidgetState:function(state){this.widgetState=state;return Promise.resolve();}};</script></head><body>${baseline}</body></html>`}));
  await page.goto('/m4-design-evidence.html');await page.locator('[data-action="select-material-type"][data-id="summary"]').click();
  await capture('prototype','preparation');
  await page.locator('[data-action="gen-source-upload"]').click();await page.locator('[data-action="gen-template"]').click();await page.locator('[data-action="execute"]').click();await expect(page.locator('.aw-making')).toContainText('正在制作');await capture('prototype','making');
  for(let step=0;step<8&&await page.locator('[data-action="advance-flow"]').count();step++)await page.locator('[data-action="advance-flow"]').click();
  await expect(page.locator('[role="tab"][aria-selected="true"]')).toContainText('募集说明书摘要 v1');await capture('prototype','artifact');
  await writeFile(`${output}/prototype-status.txt`,'All three schema6 scenes captured from the exact approved source using its own marked synthetic controls. No source rewrite, model, real task or settlement.\n');
});
