import {fixtureJson,fixtureRequest,serveDisabledBillingCatalog} from './billing-fixture-wire';
import {AUTOMATIC_PRICE_VERSION,commerceMetadata} from '@bondbuddy/contracts';
import { test,expect,type Page } from '@playwright/test';
import { mkdir,readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const evidenceDir=()=>test.info().outputPath('assistant-refined');
import { createHash } from 'node:crypto';
import { duplicateUploadFixture } from './duplicate-upload-fixture';
const now='2026-10-08T10:00:00Z',hash='a'.repeat(64);
function fixture(){return {topic:{topic_id:'topic',project_id:'scope',source_project_id:null,name:'BondBuddy',surface:'assistant',created_at:now,updated_at:now},
 project:{project_id:'scope',kind:'qa',name:'BondBuddy',draft_revision:1},materials:[],material_details:[],drafts:{},templates:[],messages:[] as any[],tasks:[],artifacts:[],pending_requirements:[],active_run:null,
 view:{version:0,selected_document_type:null,open_tabs:[],active_tab:null,unsent_content:'',unsent_context:{document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:null},assistant:{project_id:null,action:null}}};}
async function setup(page:Page,{paid=false,fixed=false}={}){
 const w:any=fixture(),messages:any[]=[],executions:any[]=[],cards:any[]=[],uploads:any[]=[];let quoteReads=0,releaseUpload:(()=>void)|undefined;
 const delivered=Buffer.from('Synthetic downloadable report'),deliveredHash=createHash('sha256').update(delivered).digest('hex');
 w.drafts.private_summary={document_type:'private_summary',version:0,sha256:hash,updated_at:null,source_material:null,materials:[],template:null,edit_base:null,scope:'whole',fields:{},requirements:[]};
 await page.route('**/api/v1/**',async route=>{if(await serveDisabledBillingCatalog(route))return;const req=route.request(),path=new URL(req.url()).pathname.replace('/api/v1','');let body:unknown={},status=200;
  if(path==='/me')body={user_id:'synthetic-assistant-user',session_status:'active'};
  else if(path==='/account')body={user_id:'synthetic-assistant-user',username:'synthetic'};
  else if(path==='/account/sessions')body={items:[]};
  else if(path==='/account/recovery')body={enabled:false,support_operator:false,current:null,pending:null};
  else if(path==='/credits/balance')body={enabled:true,available:100000,frozen:0};
  else if(path==='/credits/recharge-config')body={enabled:false,providers:[],packs:[{id:'cny200',amount_fen:20000,points:20000},{id:'cny500',amount_fen:50000,points:52500},{id:'cny2000',amount_fen:200000,points:220000},{id:'cny10000',amount_fen:1000000,points:1150000}],pack_version:'synthetic'};
  else if(path==='/projects')body={items:[],page:{has_more:false,next_cursor:null}};
  else if(path==='/m4/topics')body=req.method()==='GET'?{topics:[w.topic]}:{topic:w.topic};
  else if(path.endsWith('/workspace'))body=w;
  else if(path.endsWith('/view')){const b=fixtureRequest(req);expect(b.expected_version).toBe(w.view.version);w.view={...b.view,version:w.view.version+1};body={view:w.view};}
  else if(path.endsWith('/cards')){if(req.method()==='POST'){const b=fixtureRequest(req);const card={...b,draft_token:w.view.assistant.draft_token,created_at:new Date().toISOString(),project_name:'合成材料任务',requirements:w.drafts.private_summary.supplemental_requirements,material_names:w.material_details.map((m:any)=>m.filename),baseline:null,quote:{points:4500},balance:{available:100000,frozen:0},run:null};cards.push(card);body={card};}else body={cards};}
  else if(path.endsWith('/quote')){quoteReads++;const document=fixtureRequest(req).kind==='document';body={quote:{quote_id:'quote',topic_id:'topic',input_hash:hash,points:document?4500:fixed?60:paid?20:0,task_type:document?'m4_G05':paid||fixed?'m4_Q01':'m4_Q00',billing_method:document||fixed?'fixed':paid?'metered_capped':'free',amount_semantics:document||fixed?'fixed_price':'reservation_cap'},balance:{available:100000,frozen:0},shortage:0};}
  else if(path.endsWith('/drafts/private_summary')){const b=fixtureRequest(req);w.drafts.private_summary={...b.input,version:w.drafts.private_summary.version+1,sha256:hash,updated_at:now};body={draft:w.drafts.private_summary};}
  else if(path==='/m4/topics/topic/execute'){const b=fixtureRequest(req);executions.push(b);const card=cards.find(c=>c.execution_request_id===b.execution_request_id);card.run={run_id:'document-run',project_id:'scope',state:'queued',stage:'queued',input_revision:1};body={run:card.run};}
  else if(path.endsWith('/materials/uploads')){const b=fixtureRequest(req),id=String(uploads.length);uploads.push(b);body={upload_id:id,state:'uploading',upload_url:'/api/v1/synthetic-upload/'+id,expires_at:'2099-01-01T00:00:00Z',max_bytes:104857600};}
  else if(path.startsWith('/synthetic-upload/')){if(uploads[Number(path.split('/').at(-1))].filename==='first.txt')await new Promise<void>(resolve=>{releaseUpload=resolve;});await route.fulfill({status:204});return;}
  else if(path.endsWith('/complete')){const id=path.split('/').at(-2)!,u=uploads[Number(id)];body={...u,material_id:'material-'+id,material_version:1,upload_id:id,state:'persisted',persisted_at:now,error:null};}
  else if(path==='/m4/topics/topic/materials'){const pin=fixtureRequest(req).material,index=Number(pin.material_id.split('-').at(-1));w.materials.push(pin);w.material_details.push({...pin,...uploads[index],state:'persisted'});body={materials:w.materials};}
  else if(path==='/artifacts/result')body={filename:'合成项目_复核报告_V2_20261009.txt',artifact_id:'result',media_type:'text/plain',sha256:deliveredHash,download_url:'/api/v1/artifacts/result/download'};
  else if(path==='/artifacts/result/download'){await route.fulfill({contentType:'text/plain',body:delivered});return;}
  else if(path.endsWith('/messages')){const b=fixtureRequest(req);messages.push(b);const message={message_id:'message-'+messages.length,role:'user',content:b.content,created_at:now,reply_status:'completed',context:b.context};w.messages.push(message,
    {message_id:'answer-'+messages.length,role:'assistant',content:'可先说明需要调整的内容，确认后再生成新版本。',created_at:now,reply_status:'completed',context:b.context});body={message,run:{run_id:'qa-'+messages.length}};}
  else if(path==='/runs/execute'){executions.push(fixtureRequest(req));body={};}
  else {status=404;body={code:'NOT_FOUND'};}
  await route.fulfill({status,contentType:'application/json',body:fixtureJson(route,body)});
 });await page.goto('/#dashboard');return {w,messages,executions,cards,uploads,releaseUpload:()=>releaseUpload?.(),quoteReads:()=>quoteReads};
}
test('duplicate feedback: assistant attachments identify renamed duplicates without another material',async({page})=>{
 const s=await setup(page);await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();
 await expect(page.locator('[data-composer]')).toBeEnabled();
 const receipts=await duplicateUploadFixture(page,m=>{
   if(!s.w.materials.some((p:any)=>p.material_id===m.material_id)){const pin={source_project_id:'scope',material_id:m.material_id,material_version:m.material_version,sha256:m.sha256};s.w.materials.push(pin);s.w.material_details.push({...pin,...m});}
 });
 const picker=page.locator('.ba-composer [data-file]'),file={name:'合成助手附件.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic assistant attachment')};
 const nativeInput=await picker.elementHandle();
 await picker.setInputFiles(file);await expect(page.locator('[data-uploads]')).toContainText('已保存');
 await picker.setInputFiles({...file,name:'合成助手附件副本.txt'});
 const notice=page.locator('[data-uploads] .duplicate-upload-notice');await expect(notice).toHaveCount(1);
 await expect(notice).toContainText('合成助手附件副本.txt：重复文件');await expect(notice).toContainText('已保留原文件“合成助手附件.txt”');
 expect(receipts.materials).toHaveLength(1);expect(s.w.materials).toHaveLength(1);expect(s.messages).toHaveLength(0);expect(s.executions).toHaveLength(0);
 await expect(page.locator('[data-composer]')).toBeEnabled();expect(await nativeInput!.evaluate(el=>el.isConnected)).toBe(true);
 await page.getByRole('button',{name:'收起助手',exact:true}).click();await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();await expect(notice).toHaveCount(1);
 if(process.env.BB_DUPLICATE_EVIDENCE)await notice.screenshot({path:`${process.env.BB_DUPLICATE_EVIDENCE}/assistant.png`});
});

test('mobile assistant keeps focus inside and restores navigation and logout after closing',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 const s=await setup(page);let logouts=0;
 await page.route('**/api/v1/auth/logout',async route=>{logouts++;await route.fulfill({status:204});});
 await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();
 await expect(page.locator('.ba-panel')).toBeVisible();
 await expect(page.locator('[data-composer]')).toBeEnabled();
 await expect(page.locator('.prototype-app')).toHaveAttribute('inert','');
 await page.locator('.ba-header [data-a=new]').focus();await page.keyboard.press('Shift+Tab');
 await expect(page.locator('.ba-composer [data-file]')).toBeFocused();
 await page.keyboard.press('Tab');await expect(page.locator('.ba-header [data-a=new]')).toBeFocused();
 await page.getByRole('button',{name:'收起助手',exact:true}).click();
 await expect(page.locator('.prototype-app')).not.toHaveAttribute('inert','');
 await page.getByRole('button',{name:'打开菜单',exact:true}).click();
 await expect(page.locator('#sidebar')).toHaveClass(/mobile-open/);
 await expect(page.locator('.ba-panel')).toHaveCount(0);
 if(process.env.ASSISTANT_EVIDENCE){await mkdir(evidenceDir(),{recursive:true});await page.screenshot({path:resolve(evidenceDir(),'implementation-mobile-menu-open.png')});}
 await page.getByRole('button',{name:'退出',exact:true}).click();
 await expect(page.getByRole('heading',{name:'登录工作区',exact:true})).toBeVisible();
 await expect(page.locator('.bb-assistant')).toHaveCount(0);
 await expect(page.locator('[data-assistant-dock]')).toHaveCount(0);
 expect(logouts).toBe(1);expect(s.messages).toHaveLength(0);expect(s.executions).toHaveLength(0);
});
test('global launcher preserves unsent text across navigation, collapse, reload and history; questions never create document jobs',async({page})=>{
 const s=await setup(page);await page.getByRole('button',{name:'打开 BondBuddy'}).click();await expect(page.locator('[data-composer]')).toBeVisible();
 await page.locator('[data-composer]').fill('这种表述是否合适？');await expect.poll(()=>s.w.view.unsent_content).toBe('这种表述是否合适？');
 await page.locator('.ba-header [data-a=toggle]').click();await page.locator('.sidebar').getByRole('link',{name:'任务进度与结果',exact:true}).click();await page.getByRole('button',{name:'打开 BondBuddy'}).click();await expect(page.locator('[data-composer]')).toHaveValue('这种表述是否合适？');
 await page.reload();await page.getByRole('button',{name:'打开 BondBuddy'}).click();await expect(page.locator('[data-composer]')).toHaveValue('这种表述是否合适？');
 await page.locator('[data-a=send]').click();await expect(page.locator('.ba-message.assistant')).toContainText('可先说明');expect(s.messages).toHaveLength(1);expect(s.executions).toHaveLength(0);await expect(page.locator('.ba-task')).toHaveCount(0);
 await page.locator('[data-a=history]').click();await expect(page.locator('.ba-history')).toContainText('BondBuddy');
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
 await page.getByRole('button',{name:'打开 BondBuddy'}).click();await expect(page.locator('[data-composer]')).toBeVisible();
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
 const s=await setup(page,{paid:true});await page.getByRole('button',{name:'打开 BondBuddy'}).click();await page.locator('[data-composer]').fill('解释担保条款');await page.locator('[data-a=send]').click();
 await expect(page.locator('[data-qa-price]')).toContainText('20');expect(s.messages).toHaveLength(0);await page.locator('[data-a=send]').click();await expect.poll(()=>s.messages.length).toBe(1);expect(s.messages[0].content).toBe('解释担保条款');expect(s.messages[0].execute).toBeUndefined();expect(s.quoteReads()).toBe(1);
});

test('update card has no upfront price and recharge retains the project',async({page})=>{
 const s=await setup(page);s.w.view.assistant={...s.w.view.assistant,draft_token:'draft',prepared_card_id:'update-card'};
 const key=createHash('sha256').update(JSON.stringify(['source-project',1,hash])).digest('hex');
 const card:any={card_id:'update-card',operation:'update',project_id:'source-project',project_name:'合成更新项目',draft_token:'draft',created_at:now,
  input_revision:1,input_hash:hash,execution_request_id:'web-update-'+key,quote_id:'update-quote',quote:{points:17900},balance:{available:1,frozen:0},material_names:['原稿.docx'],requirements:'仅更新本期',baseline:null,run:null};s.cards.push(card);
 await page.getByRole('button',{name:'打开 BondBuddy'}).click();await expect(page.locator('.ba-task')).toContainText('仅更新本期');
 await expect(page.locator('.ba-task .ba-credits')).toHaveCount(0);
 await expect(page.locator('.ba-task a.ba-primary')).toHaveAttribute('href','#/account?project=source-project');
  await expect(page.locator('.ba-task a.ba-primary')).toHaveText('查看余额与支付状态');
 card.balance.available=17900;
 await expect(page.locator('.ba-task').getByRole('button',{name:'开始更新',exact:true})).toBeVisible({timeout:12000});expect(s.executions).toHaveLength(0);
 await page.locator('.ba-task').getByRole('button',{name:'开始更新',exact:true}).click();
 await expect.poll(()=>s.executions.length).toBe(1);expect(s.executions[0].quote_id).toBe('update-quote');
});
test('fixed QA states the exact price and success/failure terms before confirmation',async({page})=>{
 const s=await setup(page,{fixed:true});await page.getByRole('button',{name:'打开 BondBuddy'}).click();await page.locator('[data-composer]').fill('解释担保条款');await page.locator('[data-a=send]').click();
 await expect(page.locator('[data-qa-price]')).toContainText('本次回答 60 积分');await expect(page.locator('[data-qa-price]')).toContainText('失败不扣费');await expect(page.locator('[data-qa-price]')).not.toContainText('按实际用量');expect(s.messages).toHaveLength(0);
 if(process.env.QA_PRICE_EVIDENCE){const dir=test.info().outputPath('assistant-qa-price');await mkdir(dir,{recursive:true});await page.setViewportSize({width:1440,height:960});await page.mouse.move(0,0);await page.locator('.ba-panel').screenshot({path:resolve(dir,'implementation-panel.png')});const source=await readFile(new URL('../../../product-prototype/public/project-assistant-refined.html',import.meta.url),'utf8');const prototype=await page.context().newPage();await prototype.setViewportSize({width:1440,height:960});await prototype.setContent(source);await prototype.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();await prototype.getByRole('textbox',{name:'发送给 BondBuddy'}).fill('解释担保条款');await prototype.locator('[data-a=send]').click();await prototype.mouse.move(0,0);await prototype.locator('.ba-panel').screenshot({path:resolve(dir,'prototype-panel.png')});await prototype.close();}
 await page.locator('[data-a=send]').click();await expect.poll(()=>s.messages.length).toBe(1);expect(s.messages[0].quote_id).toBe('quote');
});
test('editable task card uses quarters and optional requirements; insufficient input never executes',async({page})=>{
 const s=await setup(page);await page.getByRole('button',{name:'打开 BondBuddy'}).click();await page.locator('[data-kind=update]').click();await expect(page.locator('.ba-form')).toBeVisible();
 await expect(page.locator('.ba-form input[type=date]')).toHaveCount(0);await page.locator('[data-field=issuer_name]').fill('合成发行人');await page.locator('[data-requirements]').fill('只改偿债能力文字，不改数字');
 await page.locator('[data-a=prepare]').click();await expect(page.locator('[data-status]')).toContainText('请先填写');expect(s.executions).toHaveLength(0);
 await expect.poll(()=>s.w.view.assistant.action).toMatchObject({requirements:'只改偿债能力文字，不改数字',fields:{issuer_name:'合成发行人'}});
});
test('desktop, focus and narrow assistant stay within viewport and preserve normal page layout',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await setup(page);await page.getByRole('button',{name:'打开 BondBuddy'}).click();
 for(const width of [1440,1024,390,320]){await page.setViewportSize({width,height:960});await expect(page.locator('.ba-panel')).toBeVisible();const box=await page.locator('.ba-panel').boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(process.env.ASSISTANT_EVIDENCE){const dir=evidenceDir();await mkdir(dir,{recursive:true});await page.mouse.move(0,0);await page.screenshot({path:resolve(dir,`implementation-${width}.png`)});if(width===1440)await page.locator('.ba-panel').screenshot({path:resolve(dir,'implementation-panel.png')});}}
 await page.setViewportSize({width:1440,height:960});const normal=(await page.locator('.ba-panel').boundingBox())!.width;
 await page.locator('[data-a=wide]').click();expect((await page.locator('.ba-panel').boundingBox())!.width).toBeGreaterThan(normal);
 const main=await page.locator('.shell').boundingBox(),panel=await page.locator('.ba-panel').boundingBox();expect(main!.x+main!.width).toBeLessThanOrEqual(panel!.x+1);expect(errors).toEqual([]);
});

test('attachments selected during an upload are queued and retained; changed cards cannot execute; results recover after reload',async({page})=>{
 const s=await setup(page);await page.getByRole('button',{name:'打开 BondBuddy'}).click();await expect(page.locator('[data-composer]')).toBeEnabled();
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
 await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();await expect(page.locator('.ba-task').last()).toBeVisible();
 if(process.env.ASSISTANT_EVIDENCE){await page.setViewportSize({width:1440,height:960});await page.screenshot({path:resolve(evidenceDir(),'implementation-confirmed.png')});}
 await expect(page.locator('.ba-task').last()).toContainText('等待开始');await page.reload();await page.getByRole('button',{name:'打开 BondBuddy'}).click();await expect(page.locator('.ba-task').last()).toContainText('等待开始');
 s.cards.at(-1).run={...s.cards.at(-1).run,state:'succeeded',artifact_id:'result'};await expect(page.locator('[data-a=download]')).toBeVisible({timeout:12000});
 const download=page.waitForEvent('download');await page.locator('[data-a=download]').click();expect((await download).suggestedFilename()).toBe('合成项目_复核报告_V2_20261009.txt');expect(s.executions).toHaveLength(1);
});

test('approved prototype comparison capture',async({page})=>{
 test.skip(!process.env.ASSISTANT_EVIDENCE,'Opt-in visual evidence');
 await mkdir(evidenceDir(),{recursive:true});
 await page.setViewportSize({width:1440,height:960});
 for(const file of ['project-assistant-refined']){
  const source=await readFile(new URL('../../../product-prototype/public/'+file+'.html',import.meta.url),'utf8');
  await page.setContent('<!doctype html><meta charset="utf-8"><style>:root{color-scheme:light}body{margin:0}</style>'+source);
  await page.getByRole('textbox',{name:'发送给 BondBuddy'}).focus();
  await page.screenshot({path:resolve(evidenceDir(),'prototype-1440.png')});
  await page.locator('.ba-panel').screenshot({path:resolve(evidenceDir(),'prototype-panel.png')});
  await page.setViewportSize({width:390,height:960});
  await page.screenshot({path:resolve(evidenceDir(),'prototype-390.png')});
 }
});

for(const [name,width,height] of [['desktop',1440,960],['small-desktop',1024,768],['mobile',390,844],['narrow',320,740],['zoom-equivalent',720,480]] as const)
test('assistant closes to the bottom-right launcher and restores page space - '+name,async({page})=>{
 await page.setViewportSize({width,height});
 // Upgrade path: a user hid the assistant in the previous version.
 await page.addInitScript(()=>sessionStorage.setItem('bb-assistant-hidden:synthetic-assistant-user','true'));
 const s=await setup(page),dock=page.locator('[data-assistant-dock]');
 await expect(page.locator('.sidebar [data-assistant-restore]')).toHaveCount(0);
 await expect(page.locator('.sidebar .nav-item').filter({hasText:'BondBuddy'})).toHaveCount(0);
 await expect(dock).toBeVisible();await expect(dock).toHaveAttribute('aria-expanded','false');
 // The collapsed entry is only an icon, with its accessible name retained.
 expect((await dock.innerText()).trim()).toBe('');
 const initialDock=await dock.boundingBox();expect(initialDock!.width).toBe(initialDock!.height);expect(initialDock!.width).toBeLessThanOrEqual(52);
 if(width>960){const app=await page.locator('.prototype-app').boundingBox();expect(app!.x+app!.width).toBeLessThanOrEqual(initialDock!.x);}
 await expect(page.locator('.ba-launcher,[data-a=hide]')).toHaveCount(0);
 const closedWidth=(await page.locator('.shell').boundingBox())!.width;
 await page.evaluate(()=>{const b=document.createElement('button');b.id='underlying-action';b.textContent='保存项目';b.style.cssText='display:block;margin:100vh 0 0 auto;width:220px;height:56px';b.onclick=()=>b.dataset.clicked='true';document.querySelector('main')!.append(b);window.scrollTo(0,document.body.scrollHeight);});
 await page.locator('#underlying-action').click();await expect(page.locator('#underlying-action')).toHaveAttribute('data-clicked','true');
 await dock.click();await expect(page.locator('[data-composer]')).toBeEnabled();
 await expect(dock).toBeHidden();await expect(page.locator('.top-actions [data-assistant-dock]')).toHaveCount(0);
 const panel=await page.locator('.ba-panel').boundingBox();expect(panel!.y).toBe(0);expect(panel!.height).toBe(height);
 // Desktop keeps the page's native scrollbar gutter to the right of the panel.
 expect(panel!.x+panel!.width).toBeLessThanOrEqual(width);expect(panel!.x+panel!.width).toBeGreaterThanOrEqual(width-20);
 if(width>960){const main=await page.locator('.shell').boundingBox();expect(main!.x+main!.width).toBeLessThanOrEqual(panel!.x+1);expect(main!.width).toBeLessThan(closedWidth);await expect(page.locator('.prototype-app')).not.toHaveAttribute('inert','');await page.locator('#underlying-action').click();}
 await page.locator('[data-composer]').fill('收起后仍保留的未发送文字');
 // Collapse immediately, before the autosave debounce; reopening must keep local input.
 await page.getByRole('button',{name:'收起助手',exact:true}).click();
 await expect(dock).toBeFocused();await expect(page.locator('.ba-panel')).toHaveCount(0);
 expect((await page.locator('.shell').boundingBox())!.width).toBe(closedWidth);
 await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
 await page.locator('#underlying-action').click();
 await dock.click();await expect(page.locator('[data-composer]')).toHaveValue('收起后仍保留的未发送文字');
 await page.locator('[data-composer]').press('Escape');await expect(dock).toBeFocused();
 await expect.poll(()=>s.w.view.unsent_content).toBe('收起后仍保留的未发送文字');
 await page.reload();await expect(dock).toBeVisible();await expect(dock).toHaveAttribute('aria-expanded','false');
 await expect(page.locator('.sidebar [data-assistant-restore]')).toHaveCount(0);
 await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
 const dockBox=await dock.boundingBox();
 expect(dockBox!.x).toBeGreaterThanOrEqual(0);expect(dockBox!.x+dockBox!.width).toBeLessThanOrEqual(width);
 expect(dockBox!.y).toBeGreaterThan(height-100);expect(dockBox!.y+dockBox!.height).toBeLessThanOrEqual(height);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await dock.click();await expect(page.locator('[data-composer]')).toHaveValue('收起后仍保留的未发送文字');
 expect(s.messages).toHaveLength(0);expect(s.executions).toHaveLength(0);
 const evidence=process.env.BB_RIGHT_PANEL_EVIDENCE_DIR;
 if(evidence&&['desktop','small-desktop','mobile'].includes(name)){
   await page.evaluate(()=>window.scrollTo(0,0));
   await mkdir(evidence,{recursive:true});await page.screenshot({path:resolve(evidence,'implementation-open-'+name+'.png')});
   const prototype=await page.context().newPage(),prototypeErrors:string[]=[];prototype.on('pageerror',error=>prototypeErrors.push(error.message));await prototype.setViewportSize({width,height});
   await prototype.setContent(await readFile(new URL('../../../product-prototype/public/project-assistant-refined.html',import.meta.url),'utf8'));
   await prototype.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();
   await prototype.getByRole('textbox',{name:'发送给 BondBuddy'}).fill('收起后仍保留的未发送文字');
   await expect(prototype.getByRole('button',{name:'发送消息',exact:true})).toBeEnabled();expect(prototypeErrors).toEqual([]);
   await prototype.screenshot({path:resolve(evidence,'prototype-open-'+name+'.png')});
   await prototype.getByRole('button',{name:'收起助手',exact:true}).click();await expect(prototype.locator('.bb-assistant')).toBeHidden();
   await prototype.screenshot({path:resolve(evidence,'prototype-collapsed-'+name+'.png')});
   await prototype.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();await expect(prototype.getByRole('textbox')).toHaveValue('收起后仍保留的未发送文字');await prototype.close();
   await page.getByRole('button',{name:'收起助手',exact:true}).click();
   await page.screenshot({path:resolve(evidence,'implementation-collapsed-'+name+'.png')});
 }
});

test('desktop pages reflow beside the assistant at standard and wide widths',async({page})=>{
 await setup(page);await page.setViewportSize({width:1440,height:960});await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();
 for(const width of [1440,1280,1120,1024,961]){
  await page.setViewportSize({width,height:960});
  for(const [route,label] of [['dashboard','任务进度与结果'],['tasks','任务进度与结果'],['update','更新募集书'],['review','复核募集书'],['generate?new=1','文件生成'],['/account','我的账号']]){
   await page.evaluate(route=>{location.hash=route;},route);await expect(page.locator('.shell main')).toBeVisible();
   await expect(page.locator('.breadcrumb>span').last()).toHaveText(label);
   if(route==='/account')await expect(page.locator('.credit-pack')).toHaveCount(4);
   await expect(page.locator('.ba-panel')).toBeVisible();await expect(page.locator('[data-assistant-dock]')).toBeHidden();
   for(const wide of [false,true]){
    if(await page.locator('.bb-assistant').evaluate(el=>el.classList.contains('ba-wide'))!==wide)await page.locator('[data-a=wide]').click();
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${route} at ${width}, wide=${wide}`).toBe(true);
    await expect.poll(()=>page.locator('.shell main').evaluate(el=>el.scrollWidth<=el.clientWidth+1),`main content ${route} at ${width}, wide=${wide}`).toBe(true);
    await expect.poll(async()=>{const [main,panel]=await Promise.all([page.locator('.shell').boundingBox(),page.locator('.ba-panel').boundingBox()]);return !!main&&!!panel&&main.x+main.width<=panel.x+1;},`page and assistant remain beside each other on ${route} at ${width}, wide=${wide}`).toBe(true);
    if(process.env.BB_RIGHT_PANEL_EVIDENCE_DIR&&width===1280&&!wide&&['update','review'].includes(route))await page.screenshot({path:resolve(process.env.BB_RIGHT_PANEL_EVIDENCE_DIR,`implementation-${route}-1280.png`)});
    if(process.env.BB_RIGHT_PANEL_EVIDENCE_DIR&&width===1024&&!wide&&route==='/account')await page.screenshot({path:resolve(process.env.BB_RIGHT_PANEL_EVIDENCE_DIR,'implementation-account-1024.png')});
   }
  }
 }
});

for(const state of ['queued','paused'])test(`ordinary QA ${state} exposes status and cancellation without resending`,async({page})=>{
  const s=await setup(page,{fixed:true});const created=new Date(Date.now()-10*60000).toISOString();
  const message={message_id:'pending-qa',role:'user',version:1,content:'合成验收消息，请回复测试收到。',created_at:created,reply_status:'queued',run_id:'pending-run',reply:null,error:null};
  s.w.messages=[message];s.w.tasks=[{run:{run_id:'pending-run',project_id:'scope',state,stage:state==='paused'?'provider_reconcile':'queued'},manifest:{kind:'qa',topic_id:'topic'},created_at:created,events:[],artifacts:[]}];
  let cancellations=0;
  await page.route('**/api/v1/runs/pending-run/cancel',async route=>{cancellations++;s.w.tasks[0].run.state='cancelled';message.reply_status='failed';await route.fulfill({json:s.w.tasks[0].run});});
  await page.setViewportSize({width:1108,height:771});await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();
  await expect(page.locator('.ba-reply-progress')).toContainText(state==='queued'?'排队时间较长':'核对本次调用状态');
  await expect(page.locator('.ba-message')).toHaveCSS('display','block');
  expect((await page.locator('.ba-text').boundingBox())!.width).toBeGreaterThan(200);
  await page.getByRole('button',{name:'停止本次回答',exact:true}).click();
  await expect(page.getByRole('button',{name:'停止本次回答',exact:true})).toHaveCount(0);
  await expect(page.locator('.ba-message')).toContainText('本次回答已停止');
  expect(cancellations).toBe(1);expect(s.messages).toHaveLength(0);
});


test('automatic assistant answer is submitted once on the first send',async({page})=>{
 const s=await setup(page);await page.route('**/m4/topics/topic/quote',route=>route.fulfill({contentType:'application/json',body:fixtureJson(route,{quote:{...commerceMetadata(1218),quote_id:'automatic-qa',topic_id:'topic',input_hash:hash,points:1218,price_version:AUTOMATIC_PRICE_VERSION,auto_charge:true,quote_status:'ready',scope_quote_id:'scope-automatic',scope_lines:[],expires_at:'2099-01-01T00:00:00Z',task_type:'m4_Q01',billing_method:'fixed',amount_semantics:'fixed_price'},balance:{available:100000,frozen:0},shortage:0})}));
 await page.getByRole('button',{name:'打开 BondBuddy'}).click();await page.locator('[data-composer]').fill('解释担保条款');await page.locator('[data-a=send]').click();await expect.poll(()=>s.messages.length).toBe(1);expect(s.messages[0]).toMatchObject({content:'解释担保条款',quote_id:'automatic-qa'});expect(s.executions).toHaveLength(0);await expect(page.locator('[data-commerce-confirm]')).toHaveCount(0);
});

function pendingQa(s:Awaited<ReturnType<typeof setup>>,state='paused'){
 const created=new Date(Date.now()-10*60000).toISOString();
 const message={message_id:'pending-qa',role:'user',version:1,content:'上一轮募集资金问题',created_at:created,reply_status:'queued',run_id:'pending-run',reply:null,error:null};
 const task={run:{run_id:'pending-run',project_id:'scope',state,stage:state==='paused'?'provider_reconcile':'queued'},manifest:{kind:'qa',topic_id:'topic'},created_at:created,events:[],artifacts:[]};
 s.w.messages=[message];s.w.tasks=[task];return {message,task};
}

test('ordinary QA stop then send ignores late reads and preserves the new round across reload',async({page})=>{
 await page.clock.install();const s=await setup(page),old=pendingQa(s);let cancellations=0;
 await page.route('**/api/v1/runs/pending-run/cancel',async route=>{cancellations++;old.task.run.state='cancelled';old.message.reply_status='failed';await route.fulfill({json:old.task.run});});
 await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();await expect(page.locator('.ba-reply-progress')).toContainText('核对本次调用状态');
 let release:(()=>void)|undefined,lateReadFinished=false;
 await page.route('**/m4/topics/topic/workspace',async route=>{
  if(!release){const snapshot=structuredClone(s.w);await new Promise<void>(resolve=>{release=resolve;});await route.fulfill({contentType:'application/json',body:fixtureJson(route,snapshot)});lateReadFinished=true;}
  else await route.fulfill({contentType:'application/json',body:fixtureJson(route,s.w)});
 });
 await page.clock.fastForward(4000);await expect.poll(()=>!!release).toBe(true);
 await page.locator('[data-composer]').fill('2025年末总资产');await page.getByRole('button',{name:'停止本次回答',exact:true}).click();
 await expect(page.locator('[data-status]')).toContainText('已停止本次回答');await expect(page.locator('[data-composer]')).toHaveValue('2025年末总资产');
 await page.route('**/m4/topics/topic/messages',async route=>{
  const b=fixtureRequest(route.request());s.messages.push(b);
  const message={...old.message,message_id:'new-question',content:b.content,created_at:new Date().toISOString(),reply_status:'queued',run_id:'new-run'};
  const task={...old.task,run:{run_id:'new-run',project_id:'scope',state:'queued',stage:'queued'},created_at:message.created_at};s.w.messages.push(message);s.w.tasks.push(task);
  await route.fulfill({contentType:'application/json',body:fixtureJson(route,{message,run:task.run})});
 });
 await page.locator('[data-a=send]').evaluate(el=>{el.dispatchEvent(new MouseEvent('click',{bubbles:true}));el.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
 await expect(page.locator('.ba-message').filter({hasText:'2025年末总资产'})).toContainText('排队等待处理');
 await expect(page.locator('[data-status]')).toHaveText('');await expect(page.locator('.ba-message').filter({hasText:'上一轮募集资金问题'})).toContainText('本次回答已停止');
 release!();await expect.poll(()=>lateReadFinished).toBe(true);await expect(page.locator('.ba-message').filter({hasText:'2025年末总资产'})).toContainText('排队等待处理');
 expect(cancellations).toBe(1);expect(s.messages).toHaveLength(1);expect(s.messages[0].submission_request_id).toBeTruthy();
 await page.locator('[data-composer]').fill('下一条尚未发送的问题');await page.clock.fastForward(500);await expect.poll(()=>s.w.view.unsent_content).toBe('下一条尚未发送的问题');
 if(process.env.BB_REPLY_EVIDENCE_DIR){
  await mkdir(process.env.BB_REPLY_EVIDENCE_DIR,{recursive:true});const prototype=await page.context().newPage();
  await prototype.setContent(await readFile(new URL('../../../product-prototype/public/project-assistant-refined.html',import.meta.url),'utf8'));await prototype.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();
  await prototype.getByRole('textbox',{name:'发送给 BondBuddy'}).fill('下一条尚未发送的问题');
  for(const width of [1440,390]){await page.setViewportSize({width,height:960});await prototype.setViewportSize({width,height:960});await page.screenshot({path:resolve(process.env.BB_REPLY_EVIDENCE_DIR,`stopped-and-next-question-${width}.png`)});await prototype.screenshot({path:resolve(process.env.BB_REPLY_EVIDENCE_DIR,`prototype-${width}.png`)});}
  await prototype.close();
 }
 await page.reload();await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();await expect(page.locator('[data-composer]')).toHaveValue('下一条尚未发送的问题');
 await expect(page.locator('.ba-message').filter({hasText:'2025年末总资产'})).toContainText('排队等待处理');await expect(page.locator('[data-status]')).not.toContainText('已停止');
 await page.locator('[data-a=send]').click();await expect(page.locator('[data-status]')).toContainText('上一轮回复尚未结束');expect(s.messages).toHaveLength(1);
});

test('ordinary QA cancellation acknowledgement waits for terminal state before permitting the next send',async({page})=>{
 const s=await setup(page),old=pendingQa(s);let cancellations=0;
 await page.route('**/api/v1/runs/pending-run/cancel',async route=>{cancellations++;await route.fulfill({json:old.task.run});});
 await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();await page.locator('[data-composer]').fill('发行市场交易所');
 await page.getByRole('button',{name:'停止本次回答',exact:true}).click();await expect(page.locator('[data-status]')).toContainText('正在停止');
 await expect(page.locator('.ba-message')).not.toContainText('本次回答已停止');await expect(page.getByRole('button',{name:'停止本次回答',exact:true})).toHaveCount(0);
 if(process.env.BB_REPLY_EVIDENCE_DIR){await page.setViewportSize({width:390,height:960});await page.screenshot({path:resolve(process.env.BB_REPLY_EVIDENCE_DIR,'cancellation-pending-390.png')});}
 await page.locator('[data-a=send]').click();await expect(page.locator('[data-status]')).toContainText('等待确认任务结束');expect(s.messages).toHaveLength(0);expect(cancellations).toBe(1);
 old.task.run.state='cancelled';old.message.reply_status='failed';await page.locator('[data-a=refresh-reply]').click();
 await expect(page.locator('[data-status]')).toContainText('已停止本次回答');await expect(page.locator('[data-composer]')).toHaveValue('发行市场交易所');
 await page.locator('[data-a=send]').click();await expect.poll(()=>s.messages.length).toBe(1);await expect(page.locator('[data-status]')).toHaveText('');
 await page.locator('[data-composer]').fill('继续问发行期限');await page.locator('[data-a=send]').click();await expect.poll(()=>s.messages.length).toBe(2);
 expect(new Set(s.messages.map(m=>m.submission_request_id)).size).toBe(2);await expect(page.locator('.ba-message.user')).toHaveCount(3);
});

test('ordinary QA failed cancellation keeps its outcome unknown and retains the next question',async({page})=>{
 const s=await setup(page),old=pendingQa(s);
 await page.route('**/api/v1/runs/pending-run/cancel',route=>route.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}}));
 await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();await page.locator('[data-composer]').fill('未发送的下一问');
 await page.getByRole('button',{name:'停止本次回答',exact:true}).click();await expect(page.locator('[data-status]')).toContainText('停止结果尚未确认');
 await expect(page.locator('.ba-message')).not.toContainText('本次回答已停止');await page.locator('[data-a=send]').click();expect(s.messages).toHaveLength(0);await expect(page.locator('[data-composer]')).toHaveValue('未发送的下一问');
 // The request may have reached the server despite a lost response. A fresh terminal read resolves it.
 old.task.run.state='cancelled';old.message.reply_status='failed';await page.locator('[data-a=refresh-reply]').click();await expect(page.locator('[data-status]')).toContainText('已停止本次回答');
 await page.locator('[data-a=send]').click();await expect.poll(()=>s.messages.length).toBe(1);await expect(page.locator('[data-status]')).toHaveText('');
});

test('ordinary QA successful reread clears interruption and unblocks a completed reply without resending it',async({page})=>{
 await page.clock.install();const s=await setup(page),old=pendingQa(s);
 await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();await expect(page.locator('.ba-reply-progress')).toContainText('核对本次调用状态');
 let unavailable=true;await page.route('**/m4/topics/topic/workspace',route=>unavailable?route.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}}):route.fulfill({contentType:'application/json',body:fixtureJson(route,s.w)}));
 await page.clock.fastForward(4000);await expect(page.locator('[data-status]')).toContainText('暂无法确认回复状态');await expect(page.locator('[data-status]')).not.toContainText('继续运行');
 await page.locator('[data-composer]').fill('恢复后的下一问');await page.locator('[data-a=send]').click();expect(s.messages).toHaveLength(0);await expect(page.locator('[data-composer]')).toHaveValue('恢复后的下一问');
 unavailable=false;old.task.run.state='succeeded';old.message.reply_status='completed';
 await page.locator('[data-a=refresh-reply]').click();await expect(page.locator('[data-status]')).toHaveText('');
 await page.locator('[data-a=send]').click();await expect.poll(()=>s.messages.length).toBe(1);expect(s.messages[0].content).toBe('恢复后的下一问');
});

test('ordinary QA a recovered terminal task does not remain blocked by its stale message projection',async({page})=>{
 const s=await setup(page),old=pendingQa(s);await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();
 await page.locator('[data-composer]').fill('终态后的下一问');await page.locator('[data-a=send]').click();await expect(page.locator('[data-status]')).toContainText('仍在核对调用状态');expect(s.messages).toHaveLength(0);
 old.task.run.state='cancelled';// Exercise the run as authority even if the message projection has not caught up.
 await page.locator('[data-a=refresh-reply]').click();await expect(page.locator('[data-status]')).toHaveText('');
 await page.locator('[data-a=send]').click();await expect.poll(()=>s.messages.length).toBe(1);await expect(page.locator('.ba-message').filter({hasText:'上一轮募集资金问题'})).toContainText('本次回答已停止');
});

test('ordinary QA accepted receipt remains visible when its follow-up poll fails',async({page})=>{
 const s=await setup(page);await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();
 await page.route('**/m4/topics/topic/messages',async route=>{
  const b=fixtureRequest(route.request());s.messages.push(b);const message={message_id:'accepted',role:'user',content:b.content,created_at:now,reply_status:'queued',run_id:'accepted-run'};s.w.messages.push(message);
  await page.route('**/m4/topics/topic/workspace',r=>r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}}));
  await route.fulfill({contentType:'application/json',body:fixtureJson(route,{message,run:{run_id:'accepted-run'}})});
 });
 await page.locator('[data-composer]').fill('已收到但暂时无法刷新');await page.locator('[data-a=send]').click();
 await expect(page.locator('.ba-message')).toContainText('已收到但暂时无法刷新');await expect(page.locator('[data-status]')).toContainText('暂无法确认回复状态');
 await page.locator('[data-composer]').fill('保留下一问');await page.locator('[data-a=send]').click();expect(s.messages).toHaveLength(1);await expect(page.locator('[data-composer]')).toHaveValue('保留下一问');
});

test('ordinary QA late failed read from an old conversation cannot set a new conversation notice',async({page})=>{
 await page.clock.install();const s=await setup(page);pendingQa(s);await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();await expect(page.locator('.ba-reply-progress')).toBeVisible();
 let release:(()=>void)|undefined,finished=false;
 await page.route('**/m4/topics/topic/workspace',async route=>{await new Promise<void>(resolve=>{release=resolve;});await route.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});finished=true;});
 await page.clock.fastForward(4000);await expect.poll(()=>!!release).toBe(true);
 const next:any=fixture();next.topic={...next.topic,topic_id:'next-topic',project_id:'next-project',name:'新对话'};next.project={...next.project,project_id:'next-project'};
 await page.route('**/m4/topics',async route=>route.request().method()==='POST'?route.fulfill({json:{topic:next.topic}}):route.fallback());
 await page.route('**/m4/topics/next-topic/workspace',route=>route.fulfill({contentType:'application/json',body:fixtureJson(route,next)}));
 await page.route('**/assistant/topics/next-topic/cards',route=>route.fulfill({json:{cards:[]}}));
 await page.route('**/m4/topics/next-topic/view',route=>{const b=fixtureRequest(route.request());next.view={...b.view,version:next.view.version+1};return route.fulfill({contentType:'application/json',body:fixtureJson(route,{view:next.view})});});
 await page.getByRole('button',{name:'新对话',exact:true}).click();await expect(page.locator('.ba-message')).toHaveCount(0);await page.locator('[data-composer]').fill('新对话的草稿');
 release!();await expect.poll(()=>finished).toBe(true);await expect(page.locator('[data-status]')).toHaveText('');await expect(page.locator('[data-composer]')).toHaveValue('新对话的草稿');expect(s.messages).toHaveLength(0);
});

test('ordinary QA accepted message keeps polling when saving the cleared composer fails',async({page})=>{
 await page.clock.install();const s=await setup(page);let accepted=false,reads=0,failedSaves=0;
 await page.route('**/m4/topics/topic/workspace',route=>{if(accepted)reads++;return route.fulfill({contentType:'application/json',body:fixtureJson(route,s.w)});});
 await page.route('**/m4/topics/topic/view',route=>{if(!accepted)return route.fallback();failedSaves++;return route.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});});
 await page.route('**/m4/topics/topic/messages',async route=>{
  const b=fixtureRequest(route.request());s.messages.push(b);accepted=true;
  const message={message_id:'accepted-before-view-failure',role:'user',content:b.content,created_at:now,reply_status:'queued',run_id:'accepted-run'};s.w.messages.push(message);
  await route.fulfill({contentType:'application/json',body:fixtureJson(route,{message,run:{run_id:'accepted-run'}})});
 });
 await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();await page.locator('[data-composer]').fill('保存失败也继续查询已接受的回答');await page.locator('[data-a=send]').click();
 await expect(page.locator('.ba-message')).toContainText('保存失败也继续查询已接受的回答');await expect(page.locator('[data-status]')).not.toHaveText('');await expect.poll(()=>reads).toBeGreaterThan(0);expect(failedSaves).toBe(1);
 const before=reads;await page.clock.fastForward(4000);await expect.poll(()=>reads).toBeGreaterThan(before);expect(s.messages).toHaveLength(1);
});
