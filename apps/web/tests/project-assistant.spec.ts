import { test,expect,type Page } from '@playwright/test';
import { mkdir,readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const evidenceDir=fileURLToPath(new URL('../test-evidence/assistant-refined/',import.meta.url));
import { createHash } from 'node:crypto';
const now='2026-10-08T10:00:00Z',hash='a'.repeat(64);
function fixture(){return {topic:{topic_id:'topic',project_id:'scope',source_project_id:null,name:'项目助手',surface:'assistant',created_at:now,updated_at:now},
 project:{project_id:'scope',kind:'qa',name:'项目助手',draft_revision:1},materials:[],material_details:[],drafts:{},templates:[],messages:[] as any[],tasks:[],artifacts:[],pending_requirements:[],active_run:null,
 view:{version:0,selected_document_type:null,open_tabs:[],active_tab:null,unsent_content:'',unsent_context:{document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:null},assistant:{project_id:null,action:null}}};}
async function setup(page:Page,{paid=false,fixed=false}={}){
 const w:any=fixture(),messages:any[]=[],executions:any[]=[],cards:any[]=[],uploads:any[]=[];let quoteReads=0,releaseUpload:(()=>void)|undefined;
 const delivered=Buffer.from('Synthetic downloadable report'),deliveredHash=createHash('sha256').update(delivered).digest('hex');
 w.drafts.private_summary={document_type:'private_summary',version:0,sha256:hash,updated_at:null,source_material:null,materials:[],template:null,edit_base:null,scope:'whole',fields:{},requirements:[]};
 await page.route('**/api/v1/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname.replace('/api/v1','');let body:unknown={},status=200;
  if(path==='/me')body={user_id:'synthetic-assistant-user',session_status:'active'};
  else if(path==='/account')body={user_id:'synthetic-assistant-user',username:'synthetic'};
  else if(path==='/credits/balance')body={enabled:true,available:100000,frozen:0};
  else if(path==='/projects')body={items:[],page:{has_more:false,next_cursor:null}};
  else if(path==='/m4/topics')body=req.method()==='GET'?{topics:[w.topic]}:{topic:w.topic};
  else if(path.endsWith('/workspace'))body=w;
  else if(path.endsWith('/view')){const b=req.postDataJSON();expect(b.expected_version).toBe(w.view.version);w.view={...b.view,version:w.view.version+1};body={view:w.view};}
  else if(path.endsWith('/cards')){if(req.method()==='POST'){const b=req.postDataJSON();const card={...b,draft_token:w.view.assistant.draft_token,created_at:new Date().toISOString(),project_name:'合成材料任务',requirements:w.drafts.private_summary.supplemental_requirements,material_names:w.material_details.map((m:any)=>m.filename),baseline:null,quote:{points:4500},balance:{available:100000,frozen:0},run:null};cards.push(card);body={card};}else body={cards};}
  else if(path.endsWith('/quote')){quoteReads++;const document=req.postDataJSON().kind==='document';body={quote:{quote_id:'quote',topic_id:'topic',input_hash:hash,points:document?4500:fixed?60:paid?20:0,task_type:document?'m4_G05':paid||fixed?'m4_Q01':'m4_Q00',billing_method:document||fixed?'fixed':paid?'metered_capped':'free',amount_semantics:document||fixed?'fixed_price':'reservation_cap'},balance:{available:100000,frozen:0},shortage:0};}
  else if(path.endsWith('/drafts/private_summary')){const b=req.postDataJSON();w.drafts.private_summary={...b.input,version:w.drafts.private_summary.version+1,sha256:hash,updated_at:now};body={draft:w.drafts.private_summary};}
  else if(path==='/m4/topics/topic/execute'){const b=req.postDataJSON();executions.push(b);const card=cards.find(c=>c.execution_request_id===b.execution_request_id);card.run={run_id:'document-run',project_id:'scope',state:'queued',stage:'queued',input_revision:1};body={run:card.run};}
  else if(path.endsWith('/materials/uploads')){const b=req.postDataJSON(),id=String(uploads.length);uploads.push(b);body={upload_id:id,upload_url:'/api/v1/synthetic-upload/'+id};}
  else if(path.startsWith('/synthetic-upload/')){if(uploads[Number(path.split('/').at(-1))].filename==='first.txt')await new Promise<void>(resolve=>{releaseUpload=resolve;});await route.fulfill({status:204});return;}
  else if(path.endsWith('/complete')){const id=path.split('/').at(-2)!,u=uploads[Number(id)];body={...u,material_id:'material-'+id,material_version:1,state:'persisted'};}
  else if(path==='/m4/topics/topic/materials'){const pin=req.postDataJSON().material,index=Number(pin.material_id.split('-').at(-1));w.materials.push(pin);w.material_details.push({...pin,...uploads[index],state:'persisted'});body={materials:w.materials};}
  else if(path==='/artifacts/result')body={filename:'合成项目_复核报告_V2_20261009.txt',artifact_id:'result',media_type:'text/plain',sha256:deliveredHash,download_url:'/api/v1/artifacts/result/download'};
  else if(path==='/artifacts/result/download'){await route.fulfill({contentType:'text/plain',body:delivered});return;}
  else if(path.endsWith('/messages')){const b=req.postDataJSON();messages.push(b);w.messages.push({message_id:'message',role:'user',content:b.content,created_at:now,reply_status:'completed',context:b.context},
    {message_id:'answer',role:'assistant',content:'可先说明需要调整的内容，确认后再生成新版本。',created_at:now,reply_status:'completed',context:b.context});body={message:w.messages[0],run:{run_id:'qa'}};}
  else if(path==='/runs/execute'){executions.push(req.postDataJSON());body={};}
  else {status=404;body={code:'NOT_FOUND'};}
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });await page.goto('/#dashboard');return {w,messages,executions,cards,uploads,releaseUpload:()=>releaseUpload?.(),quoteReads:()=>quoteReads};
}
test('mobile navigation can log out while the assistant panel is open',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 const s=await setup(page);let logouts=0;
 await page.route('**/api/v1/auth/logout',async route=>{logouts++;await route.fulfill({status:204});});
 await page.getByRole('button',{name:'打开项目助手',exact:true}).click();
 await expect(page.locator('.ba-panel')).toBeVisible();
 await expect(page.locator('[data-composer]')).toBeEnabled();
 // The narrow panel covers the header; the underlying navigation is still keyboard-accessible.
 await page.getByRole('button',{name:'打开菜单',exact:true}).press('Enter');
 await expect(page.locator('#sidebar')).toHaveClass(/mobile-open/);
 await expect(page.locator('.ba-panel')).toBeVisible();
 if(process.env.ASSISTANT_EVIDENCE){await mkdir(evidenceDir,{recursive:true});await page.screenshot({path:resolve(evidenceDir,'implementation-mobile-menu-open.png')});}
 await page.getByRole('button',{name:'退出',exact:true}).click();
 await expect(page.getByRole('heading',{name:'登录工作区',exact:true})).toBeVisible();
 await expect(page.locator('.bb-assistant')).toHaveCount(0);
 expect(logouts).toBe(1);expect(s.messages).toHaveLength(0);expect(s.executions).toHaveLength(0);
});
test('global launcher preserves unsent text across navigation, collapse, reload and history; questions never create document jobs',async({page})=>{
 const s=await setup(page);await page.getByRole('button',{name:'打开项目助手'}).click();await expect(page.locator('[data-composer]')).toBeVisible();
 await page.locator('[data-composer]').fill('这种表述是否合适？');await expect.poll(()=>s.w.view.unsent_content).toBe('这种表述是否合适？');
 await page.locator('.ba-header [data-a=toggle]').click();await page.locator('.sidebar a[href="#tasks"]').click();await page.getByRole('button',{name:'打开项目助手'}).click();await expect(page.locator('[data-composer]')).toHaveValue('这种表述是否合适？');
 await page.reload();await page.getByRole('button',{name:'打开项目助手'}).click();await expect(page.locator('[data-composer]')).toHaveValue('这种表述是否合适？');
 await page.locator('[data-a=send]').click();await expect(page.locator('.ba-message.assistant')).toContainText('可先说明');expect(s.messages).toHaveLength(1);expect(s.executions).toHaveLength(0);await expect(page.locator('.ba-task')).toHaveCount(0);
 await page.locator('[data-a=history]').click();await expect(page.locator('.ba-history')).toContainText('项目助手');
});
test('a slow autosave receipt survives background polling without a false conversation conflict',async({page})=>{
 const s=await setup(page);await page.clock.install();
 let releaseSave!:()=>void,saveStarted!:()=>void;const savedVersions:number[]=[],heldSave=new Promise<void>(resolve=>releaseSave=resolve),started=new Promise<void>(resolve=>saveStarted=resolve);
 await page.route('**/api/v1/m4/topics/topic/view',async route=>{
  const b=route.request().postDataJSON();savedVersions.push(b.expected_version);
  if(savedVersions.length===1){saveStarted();await heldSave;}
  if(b.expected_version!==s.w.view.version){await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({code:'INPUT_REVISION_CONFLICT',message:'Synthetic stale conversation view'})});return;}
  s.w.view={...b.view,version:s.w.view.version+1};await route.fulfill({contentType:'application/json',body:JSON.stringify({view:s.w.view})});
 });
 await page.getByRole('button',{name:'打开项目助手'}).click();await expect(page.locator('[data-composer]')).toBeVisible();
 await page.locator('[data-composer]').fill('第一次未发送编辑');await page.clock.fastForward(500);await started;
 // Seeing this server-only reply proves polling replaced the workspace during the held PUT.
 s.w.messages.push({message_id:'poll-marker',role:'assistant',content:'合成后台轮询回执',created_at:now,reply_status:'completed',context:s.w.view.unsent_context});
 await page.clock.fastForward(4000);await expect(page.locator('.ba-message.assistant')).toContainText('合成后台轮询回执');
 const receipt=page.waitForResponse(response=>response.url().endsWith('/m4/topics/topic/view')&&response.request().method()==='PUT');releaseSave();await receipt;
 await expect.poll(()=>s.w.view.version).toBe(1);
 await page.locator('[data-composer]').fill('第二次未发送编辑');await page.clock.fastForward(500);
 await expect.poll(()=>s.w.view.unsent_content).toBe('第二次未发送编辑');expect(savedVersions).toEqual([0,1]);
 await expect(page.locator('[data-a=recover-view]')).toHaveCount(0);expect(s.messages).toHaveLength(0);expect(s.executions).toHaveLength(0);
});

test('paid QA shows real cap, sends only after confirmation and preserves requested content',async({page})=>{
 const s=await setup(page,{paid:true});await page.getByRole('button',{name:'打开项目助手'}).click();await page.locator('[data-composer]').fill('解释担保条款');await page.locator('[data-a=send]').click();
 await expect(page.locator('[data-qa-price]')).toContainText('20');expect(s.messages).toHaveLength(0);await page.locator('[data-a=send]').click();await expect.poll(()=>s.messages.length).toBe(1);expect(s.messages[0].content).toBe('解释担保条款');expect(s.messages[0].execute).toBeUndefined();expect(s.quoteReads()).toBe(1);
});

test('update card has no upfront price and recharge retains the project',async({page})=>{
 const s=await setup(page);s.w.view.assistant={...s.w.view.assistant,draft_token:'draft',prepared_card_id:'update-card'};
 const key=createHash('sha256').update(JSON.stringify(['source-project',1,hash])).digest('hex');
 const card:any={card_id:'update-card',operation:'update',project_id:'source-project',project_name:'合成更新项目',draft_token:'draft',created_at:now,
  input_revision:1,input_hash:hash,execution_request_id:'web-update-'+key,quote_id:'update-quote',quote:{points:17900},balance:{available:1,frozen:0},material_names:['原稿.docx'],requirements:'仅更新本期',baseline:null,run:null};s.cards.push(card);
 await page.getByRole('button',{name:'打开项目助手'}).click();await expect(page.locator('.ba-task')).toContainText('仅更新本期');
 await expect(page.locator('.ba-task .ba-credits')).toHaveCount(0);
 await expect(page.locator('.ba-task a.ba-primary')).toHaveAttribute('href','#/account?project=source-project');
 card.balance.available=17900;
 await expect(page.locator('.ba-task').getByRole('button',{name:'开始更新',exact:true})).toBeVisible({timeout:12000});expect(s.executions).toHaveLength(0);
 await page.locator('.ba-task').getByRole('button',{name:'开始更新',exact:true}).click();
 await expect.poll(()=>s.executions.length).toBe(1);expect(s.executions[0].quote_id).toBe('update-quote');
});
test('fixed QA states the exact price and success/failure terms before confirmation',async({page})=>{
 const s=await setup(page,{fixed:true});await page.getByRole('button',{name:'打开项目助手'}).click();await page.locator('[data-composer]').fill('解释担保条款');await page.locator('[data-a=send]').click();
 await expect(page.locator('[data-qa-price]')).toContainText('本次回答 60 积分');await expect(page.locator('[data-qa-price]')).toContainText('失败不扣费');await expect(page.locator('[data-qa-price]')).not.toContainText('按实际用量');expect(s.messages).toHaveLength(0);
 if(process.env.QA_PRICE_EVIDENCE){const dir=fileURLToPath(new URL('../test-evidence/assistant-qa-price/',import.meta.url));await mkdir(dir,{recursive:true});await page.setViewportSize({width:1440,height:960});await page.mouse.move(0,0);await page.locator('.ba-panel').screenshot({path:resolve(dir,'implementation-panel.png')});const source=await readFile(new URL('../../../product-prototype/public/project-assistant-refined.html',import.meta.url),'utf8');const prototype=await page.context().newPage();await prototype.setViewportSize({width:1440,height:960});await prototype.setContent(source);await prototype.getByRole('textbox',{name:'发送给项目助手'}).fill('解释担保条款');await prototype.locator('[data-a=send]').click();await prototype.mouse.move(0,0);await prototype.locator('.ba-panel').screenshot({path:resolve(dir,'prototype-panel.png')});await prototype.close();}
 await page.locator('[data-a=send]').click();await expect.poll(()=>s.messages.length).toBe(1);expect(s.messages[0].quote_id).toBe('quote');
});
test('editable task card uses quarters and optional requirements; insufficient input never executes',async({page})=>{
 const s=await setup(page);await page.getByRole('button',{name:'打开项目助手'}).click();await page.locator('[data-kind=update]').click();await expect(page.locator('.ba-form')).toBeVisible();
 await expect(page.locator('.ba-form input[type=date]')).toHaveCount(0);await page.locator('[data-field=issuer_name]').fill('合成发行人');await page.locator('[data-requirements]').fill('只改偿债能力文字，不改数字');
 await page.locator('[data-a=prepare]').click();await expect(page.locator('[data-status]')).toContainText('请先填写');expect(s.executions).toHaveLength(0);
 await expect.poll(()=>s.w.view.assistant.action).toMatchObject({requirements:'只改偿债能力文字，不改数字',fields:{issuer_name:'合成发行人'}});
});
test('desktop, focus and narrow assistant stay within viewport and preserve normal page layout',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await setup(page);await page.getByRole('button',{name:'打开项目助手'}).click();
 for(const width of [1440,1024,390,320]){await page.setViewportSize({width,height:960});await expect(page.locator('.ba-panel')).toBeVisible();const box=await page.locator('.ba-panel').boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(process.env.ASSISTANT_EVIDENCE){const dir=evidenceDir;await mkdir(dir,{recursive:true});await page.mouse.move(0,0);await page.screenshot({path:resolve(dir,`implementation-${width}.png`)});if(width===1440)await page.locator('.ba-panel').screenshot({path:resolve(dir,'implementation-panel.png')});}}
 await page.setViewportSize({width:1440,height:960});await page.locator('[data-a=wide]').click();expect((await page.locator('.ba-panel').boundingBox())!.width).toBeGreaterThan(700);expect(errors).toEqual([]);
});

test('attachments selected during an upload are queued and retained; changed cards cannot execute; results recover after reload',async({page})=>{
 const s=await setup(page);await page.getByRole('button',{name:'打开项目助手'}).click();await expect(page.locator('[data-composer]')).toBeEnabled();
 await page.locator('.ba-composer [data-file]').setInputFiles({name:'first.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic first')});
 await expect.poll(()=>s.uploads.length).toBe(1);
 await page.locator('.ba-composer [data-file]').setInputFiles({name:'second.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic second')});
 await expect(page.locator('[data-uploads]')).toContainText('second.txt');s.releaseUpload();await expect.poll(()=>s.w.materials.length).toBe(2);
 await page.locator('[data-kind=generation]').click();await page.locator('[data-field=document_type]').selectOption('private_summary');await page.locator('[data-field=market]').selectOption('sse');
 await page.locator('[data-requirements]').fill('只润色摘要，不改数字');await page.locator('[data-a=prepare]').click();await expect(page.locator('.ba-task')).toContainText('4,500');expect(s.executions).toHaveLength(0);
 await page.locator('[data-a=edit]').click();await page.locator('[data-requirements]').fill('新增一个风险提示段落');await expect(page.locator('[data-a=execute]')).toHaveCount(0);
 await page.locator('[data-a=prepare]').click();await expect(page.locator('[data-a=execute]')).toHaveCount(1);await page.locator('[data-a=execute]').click();await expect.poll(()=>s.executions.length).toBe(1);
 await page.locator('.ba-header [data-a=toggle]').click();await expect(page.locator('.bb-assistant')).toBeHidden();
 expect(s.cards.at(-1).run.state).toBe('queued');expect(s.executions).toHaveLength(1);
 await page.getByRole('button',{name:'BondBuddy 助手',exact:true}).click();await expect(page.locator('.ba-task').last()).toBeVisible();
 if(process.env.ASSISTANT_EVIDENCE){await page.setViewportSize({width:1440,height:960});await page.screenshot({path:resolve(evidenceDir,'implementation-confirmed.png')});}
 await expect(page.locator('.ba-task').last()).toContainText('等待开始');await page.reload();await page.getByRole('button',{name:'打开项目助手'}).click();await expect(page.locator('.ba-task').last()).toContainText('等待开始');
 s.cards.at(-1).run={...s.cards.at(-1).run,state:'succeeded',artifact_id:'result'};await expect(page.locator('[data-a=download]')).toBeVisible({timeout:12000});
 const download=page.waitForEvent('download');await page.locator('[data-a=download]').click();expect((await download).suggestedFilename()).toBe('合成项目_复核报告_V2_20261009.txt');expect(s.executions).toHaveLength(1);
});

test('approved prototype comparison capture',async({page})=>{
 test.skip(!process.env.ASSISTANT_EVIDENCE,'Opt-in visual evidence');
 await mkdir(evidenceDir,{recursive:true});
 await page.setViewportSize({width:1440,height:960});
 for(const file of ['project-assistant-refined']){
  const source=await readFile(new URL('../../../product-prototype/public/'+file+'.html',import.meta.url),'utf8');
  await page.setContent('<!doctype html><meta charset="utf-8"><style>:root{color-scheme:light}body{margin:0}</style>'+source);
  await page.getByRole('textbox',{name:'发送给项目助手'}).focus();
  await page.screenshot({path:resolve(evidenceDir,'prototype-1440.png')});
  await page.locator('.ba-panel').screenshot({path:resolve(evidenceDir,'prototype-panel.png')});
  await page.setViewportSize({width:390,height:960});
  await page.screenshot({path:resolve(evidenceDir,'prototype-390.png')});
 }
});

for(const [name,width,height] of [['desktop',1440,960],['mobile',390,844],['narrow',320,740],['zoom-equivalent',720,480]] as const)
test('assistant collapses into visible header without obstructing the page - '+name,async({page})=>{
 await page.setViewportSize({width,height});
 // Upgrade path: a user hid the assistant in the previous version.
 await page.addInitScript(()=>sessionStorage.setItem('bb-assistant-hidden:synthetic-assistant-user','true'));
 const s=await setup(page),dock=page.locator('[data-assistant-dock]');
 await expect(dock).toBeVisible();await expect(dock).toHaveAttribute('aria-expanded','false');
 await expect(page.locator('.ba-launcher,[data-a=hide]')).toHaveCount(0);
 await page.evaluate(()=>{const b=document.createElement('button');b.id='underlying-action';b.textContent='保存项目';b.style.cssText='position:fixed;right:12px;bottom:12px;width:220px;height:56px;z-index:1';b.onclick=()=>b.dataset.clicked='true';document.querySelector('main')!.append(b);});
 await page.locator('#underlying-action').click();await expect(page.locator('#underlying-action')).toHaveAttribute('data-clicked','true');
 await dock.click();await expect(page.locator('[data-composer]')).toBeEnabled();
 await page.locator('[data-composer]').fill('收起后仍保留的未发送文字');
 // Collapse immediately, before the autosave debounce; reopening must keep local input.
 await page.getByRole('button',{name:'收起助手',exact:true}).click();
 await expect(dock).toBeFocused();await expect(page.locator('.ba-panel')).toHaveCount(0);
 await page.locator('#underlying-action').click();
 await dock.click();await expect(page.locator('[data-composer]')).toHaveValue('收起后仍保留的未发送文字');
 await page.locator('[data-composer]').press('Escape');await expect(dock).toBeFocused();
 await expect.poll(()=>s.w.view.unsent_content).toBe('收起后仍保留的未发送文字');
 await page.reload();await expect(dock).toBeVisible();await expect(dock).toHaveAttribute('aria-expanded','false');
 await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
 const dockBox=await dock.boundingBox(),headerBox=await page.locator('.topbar').boundingBox();
 expect(dockBox!.x).toBeGreaterThanOrEqual(0);expect(dockBox!.x+dockBox!.width).toBeLessThanOrEqual(width);
 expect(dockBox!.y).toBeGreaterThanOrEqual(0);expect(dockBox!.y+dockBox!.height).toBeLessThanOrEqual(headerBox!.y+headerBox!.height);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await dock.click();await expect(page.locator('[data-composer]')).toHaveValue('收起后仍保留的未发送文字');
 expect(s.messages).toHaveLength(0);expect(s.executions).toHaveLength(0);
 const evidence=process.env.BB_COLLAPSE_ASSISTANT_EVIDENCE_DIR;
 if(evidence&&['desktop','mobile'].includes(name)){
   await mkdir(evidence,{recursive:true});await page.screenshot({path:resolve(evidence,'implementation-open-'+name+'.png')});
   const prototype=await page.context().newPage();await prototype.setViewportSize({width,height});
   await prototype.setContent(await readFile(new URL('../../../product-prototype/public/project-assistant-refined.html',import.meta.url),'utf8'));
   await prototype.getByRole('textbox',{name:'发送给项目助手'}).fill('收起后仍保留的未发送文字');
   await prototype.screenshot({path:resolve(evidence,'prototype-open-'+name+'.png')});
   await prototype.getByRole('button',{name:'收起助手',exact:true}).click();await expect(prototype.locator('.bb-assistant')).toBeHidden();
   await prototype.screenshot({path:resolve(evidence,'prototype-collapsed-'+name+'.png')});
   await prototype.getByRole('button',{name:'打开项目助手',exact:true}).click();await expect(prototype.getByRole('textbox')).toHaveValue('收起后仍保留的未发送文字');await prototype.close();
   await page.getByRole('button',{name:'收起助手',exact:true}).click();
   await page.screenshot({path:resolve(evidence,'implementation-collapsed-'+name+'.png')});
 }
});
