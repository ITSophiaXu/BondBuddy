import {hold,check} from './upload-progress-fixtures';
import {fixtureBody,fixtureRequest} from './billing-fixture-wire';
import {test,expect,type Page,type Route} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fixture,href,ids,sha,now,file} from './generation-entry-fixtures';
import {AUTOMATIC_PRICE_VERSION,emptyFileGenerationPreparation,type FileGenerationWorkspace,type FileTemplateSet,type WorkpaperCatalogue} from '@bondbuddy/contracts';
const catalogue:WorkpaperCatalogue={catalogue_id:'builtin-cat',filename:'光大证券底稿目录.xlsx',sha256:sha,created_at:now,warnings:[],entries:['1','2'].map((code,i)=>({id:'entry-'+code,code,title:i?'关联方情况说明':'基本情况核查记录',folder:'',sheet:'尽职调查文件',row:i+2,instructions:'',kind:'file',path:code+'.docx'}))};
const set:FileTemplateSet={set_id:'builtin-set',name:'光大证券模板',version:'synthetic-v1',origin:'builtin',warnings:[],records:[...['1','2'].map(code=>({set_id:'builtin-set',record_id:'word-'+code,sha256:sha,name:code+' 核查模板',code,role:'核查记录',document_type:'workpaper' as const})),{set_id:'builtin-set',record_id:'annual',sha256:sha,name:'年度报告',code:'',role:'年度报告',document_type:'annual'}]};
async function setup(page:Page,automatic=false,builtinReply?:(route:Route)=>Promise<void>){
 const transport=await fixture(page);const state={transport,data:{revision:0,preparation:emptyFileGenerationPreparation(),sets:[],builtin:{name:'光大证券模板',version:'synthetic-v1',available:true},batches:[]} as FileGenerationWorkspace,submissions:[] as any[],lost:false,imports:[] as Buffer[]};
 if(automatic)state.data.pricing={mode:'automatic',price_version:AUTOMATIC_PRICE_VERSION,workpaper_points:3458,document_points:7965};
 await page.route('**/api/v1/projects/*/file-generation**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname,body=req.method()==='GET'?undefined:req.headers()['content-type']==='application/octet-stream'?undefined:fixtureRequest(req);
  const reply=(body:unknown)=>route.fulfill({json:fixtureBody(route,body)});
  if(req.method()==='GET'&&path.endsWith('/file-generation'))return reply(state.data);
  if(path.endsWith('/preparation')){state.data.revision++;state.data.preparation=body.preparation;return reply({revision:state.data.revision,preparation:state.data.preparation});}
  if(path.endsWith('/builtin')){if(!state.data.sets.length)state.data.sets.push(set);if(builtinReply)return builtinReply(route);return reply({...(body.part!=='catalogue'?{set}:{}),...(body.part!=='templates'?{catalogue}:{})});}
  if(path.endsWith('/matches'))return reply({matches:catalogue.entries.map(e=>({item_id:e.id,status:'suggested',reason:'same code',candidates:[{set_id:set.set_id,record_id:'word-'+e.code,sha256:sha}]}))});
  if(path.endsWith('/template-preview'))return reply({title:'核查记录',redacted:true,view:'structure',pdf_available:false,blocks:[{kind:'paragraph',text:'项目名称：【本项信息】',bold:false,align:'left'},{kind:'table',rows:[['姓名','职务'],['—','—']]}]});
  if(path.endsWith('/template-preview-pdf'))return route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE',message:'unavailable',retryable:true}});
  if(path.endsWith('/quote'))return reply({count:automatic?state.data.preparation.item_ids.length+state.data.preparation.document_types.filter(t=>t!=='workpaper').length:body.expected_points/4500,points:body.expected_points,price_version:body.price_version,omitted:catalogue.entries.filter(e=>!state.data.preparation.item_ids.includes(e.id)),...(automatic?{auto_charge:true,quote_status:'ready',documents:state.data.preparation.document_types.filter(t=>t!=='workpaper').map(document_type=>({document_type,draft_version:5,scope_quote_id:'scope-'+document_type,points:7965,price_version:AUTOMATIC_PRICE_VERSION,auto_charge:true,quote_status:'ready'}))}:{})});
  if(path.endsWith('/templates/import')){expect(req.headers()['content-type']).toBe('application/octet-stream');state.imports.push(req.postDataBuffer()!);const own={...set,set_id:'uploaded-set',name:'我的模板包',origin:'private',version:'uploaded-v1',records:set.records.map(r=>({...r,set_id:'uploaded-set'}))};state.data.sets.push(own as FileTemplateSet);return reply(own);}
  if(path.endsWith('/batches')){state.submissions.push(body);const batch={batch_id:'batch-one',created_at:now,points:body.expected_points,workpapers:null,documents:{batch_id:'docs-one',state:'queued',items:[{document_type:'annual',run_id:null,state:'queued',error:null}]}};state.data.batches=[batch as any];if(state.lost){state.lost=false;return route.abort('failed');}return reply(batch);}
  return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
 });
 await page.route('**/api/v1/projects/*/workpapers/catalogues/*',route=>route.fulfill({json:catalogue}));
 await page.goto('/'+href({step:'prepare'}));await expect(page.getByRole('heading',{name:'底稿目录与文件模板'})).toBeVisible();return state;
}
test('independent catalogue/template cards, safe preview and mixed confirmation use the production component',async({page})=>{
 await page.setViewportSize({width:1440,height:960});
 const state=await setup(page);await expect(page.locator('.fg-template-panel')).toContainText('光大证券底稿目录.xlsx');
 await expect(page.locator('#fg-matches select')).toHaveCount(0);
 await page.getByRole('button',{name:'预览目录',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('基本情况核查记录');await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('button',{name:'预览模板',exact:true}).click();await page.locator('[data-record="word-1"]').click();await expect(page.getByRole('dialog')).toContainText('项目名称：【本项信息】');
 await page.getByRole('button',{name:'查看版式预览'}).click();await expect(page.locator('#fg-layout-status')).toContainText('结构预览已保留');await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.locator('#fg-match-toggle').click();await page.getByRole('button',{name:'采用单一候选建议'}).click();await expect(page.locator('#fg-match-toggle')).toContainText('核对逐项模板');
 await page.locator('[data-fg-type="annual"]').check();await page.locator('#fg-year').fill('2026');await page.locator('#fg-year').blur();
 await page.locator('[data-fg-general="annual"]').selectOption('builtin-set|annual');
 await page.locator('#fg-requirements').fill('合成验收要求，保留原 Word 格式');await page.getByRole('button',{name:'保存准备清单'}).click();
 await page.getByRole('button',{name:'核对清单与费用'}).click();await expect(page.getByRole('dialog')).toContainText('3 份文件 · 13,500 积分');
 await expect(page.locator('[data-flow-step="3"]')).toHaveAttribute('aria-current','step');
 await page.getByRole('button',{name:'确认生成 3 份文件'}).click();await expect(page.locator('.fg-status')).toContainText('已提交');expect(state.submissions).toHaveLength(1);
 await expect(page.locator('[data-flow-step="4"]')).toHaveAttribute('aria-current','step');
 const evidence=resolve('test-evidence/file-template-preparation');await mkdir(evidence,{recursive:true});await page.screenshot({path:resolve(evidence,'desktop-synthetic.png'),fullPage:true});
});
for(const width of [1440,390])test(`current dual-card prototype reference ${width}`,async({page})=>{
 await page.setViewportSize({width,height:width===1440?960:844});
 const path=resolve('../../product-prototype/public/file-templates-v2.html').replaceAll('\\','/');await page.goto('/@fs/'+path);
 await expect(page.getByRole('heading',{name:'生成文件',exact:true})).toBeVisible();
 const evidence=resolve('test-evidence/file-template-preparation');await mkdir(evidence,{recursive:true});await page.screenshot({path:resolve(evidence,`prototype-${width}.png`),fullPage:true});
});
for(const received of [false,true])test(`support upload interruption resumes once, bytes received=${received}`,async({page})=>{
 const state=await setup(page);let fail=true;
 await page.route('**/materials/uploads/*/bytes',async route=>{if(fail){fail=false;if(received){state.transport.sessions.get(new URL(route.request().url()).pathname.split('/').at(-2)!)!.received=true;state.transport.puts++;}return route.abort('failed');}return route.fallback();});
 await page.route('**/materials/uploads/*/complete',async route=>state.transport.sessions.get(new URL(route.request().url()).pathname.split('/').at(-2)!)?.received?route.fallback():route.fulfill({status:422,json:{code:'MATERIAL_UNREADABLE',message:'Upload bytes not received'}}));
 await page.locator('#fg-support').setInputFiles(file);await expect(page.getByRole('button',{name:'继续保存',exact:true})).toBeEnabled();
 await page.reload();await page.getByRole('button',{name:'继续保存',exact:true}).click();
 if(!received){await expect(page.locator('.fg-status')).toContainText('相同内容');await page.locator('#fg-controls > section:last-child .fg-notice input[type=file]').setInputFiles(file);}
 await expect(page.locator('#fg-controls'),await page.locator('.fg-status').innerText()).toContainText('已采用 1 份补充资料');await expect(page.getByRole('button',{name:'继续保存',exact:true})).toHaveCount(0);
 expect(state.transport.puts).toBe(1);expect(state.data.preparation.materials).toHaveLength(1);expect(state.submissions).toHaveLength(0);
});
test('custom templates have independent selections, upload actual bytes and survive mode changes and refresh',async({page})=>{
 const state=await setup(page);await expect(page.locator('#fg-preview-set')).toBeEnabled();await page.locator('#fg-custom').click();
 await expect(page.locator('#fg-template-upload')).toBeEnabled();
 await expect(page.getByText('使用光大目录',{exact:true})).toHaveCount(0);await expect(page.getByText('使用光大模板',{exact:true})).toHaveCount(0);
 expect(state.data.preparation.catalogue_id).toBeNull();
 const bytes=Buffer.from('synthetic Word bytes for transport test');await page.locator('#fg-template-upload').setInputFiles({name:'template.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:bytes});
 await expect(page.locator('.fg-template-panel')).toContainText('我的模板包');expect(state.imports[0]).toEqual(bytes);expect(state.data.preparation.catalogue_id).toBeNull();
 await page.locator('#fg-builtin-all').click();await expect(page.locator('#fg-preview-catalogue')).toBeEnabled();
 await page.locator('#fg-custom').click();await expect(page.locator('.fg-template-panel')).toContainText('我的模板包');
 await page.reload();await expect(page.locator('.fg-template-panel')).toContainText('我的模板包');await expect(page.locator('.fg-template-panel')).not.toContainText('光大证券底稿目录.xlsx');
 await page.setViewportSize({width:390,height:844});await expect(page.locator('#fg-confirm')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 const evidence=resolve('test-evidence/file-template-preparation');await mkdir(evidence,{recursive:true});await page.screenshot({path:resolve(evidence,'mobile-synthetic.png'),fullPage:true});
});

test('a late builtin reply cannot replace custom mode; cancellation and retry keep the page usable',async({page})=>{
 let release!:()=>void,calls=0;const gate=new Promise<void>(r=>release=r);
 const state=await setup(page,false,async route=>{calls++;if(calls===1)await gate;await route.fulfill({json:fixtureBody(route,{set,catalogue})}).catch(()=>{});});
 await expect(page.locator('#fg-cancel-builtin')).toBeVisible();await page.locator('#fg-custom').click();
 await expect(page.locator('#fg-template-upload')).toBeEnabled();release();
 await expect(page.locator('#fg-custom')).toHaveAttribute('aria-pressed','true');expect(state.data.preparation.template_set_id).toBeNull();
 await page.locator('#fg-builtin-all').click();await expect(page.locator('#fg-preview-catalogue')).toBeEnabled();await expect(page.locator('#fg-preview-set')).toBeEnabled();
 await expect(page.locator('#fg-builtin-all')).toHaveAttribute('aria-pressed','true');expect(state.submissions).toHaveLength(0);
});

test('builtin failure and explicit cancellation can retry without losing other preparation',async({page})=>{
 let calls=0;
 await setup(page,false,async route=>{
  calls++;if(calls===1)return route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE'}});
  if(calls===2)return;
  await route.fulfill({json:fixtureBody(route,{set,catalogue})});
 });
 await expect(page.locator('#fg-load-builtin')).toBeEnabled();await page.locator('#fg-load-builtin').click();
 await expect(page.locator('#fg-cancel-builtin')).toBeVisible();await page.locator('#fg-cancel-builtin').click();
 await expect(page.locator('.fg-load-status')).toContainText('已取消');await expect(page.locator('#fg-custom')).toBeEnabled();
 await page.locator('#fg-load-builtin').click();await expect(page.locator('#fg-preview-set')).toBeEnabled();expect(calls).toBe(3);
});
test('builtin timeout leaves a visible retry and a usable custom mode',async({page})=>{
 await page.addInitScript(()=>{const timeout=AbortSignal.timeout.bind(AbortSignal);let first=true;AbortSignal.timeout=(ms)=>{if(ms===60_000&&first){first=false;return timeout(100);}return timeout(ms);};});
 let calls=0;await setup(page,false,async route=>{if(++calls===1)return;await route.fulfill({json:fixtureBody(route,{set,catalogue})});});
 await expect(page.locator('.fg-load-status')).toContainText('加载超时');await expect(page.locator('#fg-custom')).toBeEnabled();
 await page.locator('#fg-load-builtin').click();await expect(page.locator('#fg-preview-set')).toBeEnabled();
});

test('248-entry catalogue and 147 templates render matches only on expansion and still switch modes',async({page})=>{
 const state=await setup(page);await expect(page.locator('#fg-preview-set')).toBeEnabled();
 const largeCatalogue=structuredClone(catalogue),largeSet=structuredClone(set);
 largeCatalogue.entries=Array.from({length:248},(_,i)=>({...catalogue.entries[0],id:'scale-'+i,code:'1-'+i,title:'合成核查 '+i}));
 largeSet.records=Array.from({length:147},(_,i)=>({...set.records[0],record_id:'scale-'+i,code:'1-'+i,name:'合成模板 '+i}));
 state.data.sets=[largeSet];state.data.preparation.item_ids=largeCatalogue.entries.map(e=>e.id);state.data.preparation.mappings={};state.data.revision++;
 await page.route('**/api/v1/projects/*/workpapers/catalogues/*',route=>route.fulfill({json:largeCatalogue}));
 await page.route('**/file-generation/matches?*',route=>route.fulfill({json:{matches:[]}}));
 await page.reload();await expect(page.locator('#fg-preview-set')).toBeEnabled();await expect(page.locator('#fg-matches select')).toHaveCount(0);
 const start=Date.now();await page.locator('#fg-match-toggle').click();await expect(page.locator('#fg-matches select')).toHaveCount(248);
 console.log(JSON.stringify({syntheticEntries:248,templates:147,expandMs:Date.now()-start}));
 await expect(page.locator('#fg-matches option')).toHaveCount(248);
 const first=page.locator('#fg-matches select').first();await first.focus();await expect(first.locator('option')).toHaveCount(148);
 await first.selectOption('scale-146');await expect.poll(()=>state.data.preparation.mappings['scale-0']?.record_id).toBe('scale-146');
 await page.locator('#fg-custom').click();await expect(page.locator('#fg-template-upload')).toBeEnabled();await expect(page.locator('#fg-matches select')).toHaveCount(0);
});

test('lost submission reply is recovered with the same frozen request after reload',async({page})=>{
 const state=await setup(page);await page.locator('[data-fg-type="workpaper"]').uncheck();await page.locator('[data-fg-type="annual"]').check();await page.locator('#fg-year').fill('2026');await page.locator('#fg-year').blur();
 state.lost=true;await page.getByRole('button',{name:'核对清单与费用'}).click();await page.getByRole('button',{name:'确认生成 1 份文件'}).click();await expect(page.locator('#fg-submit-status')).not.toBeEmpty();
 await page.reload();await page.getByRole('button',{name:'确认上次提交结果'}).click();await expect(page.locator('.fg-status')).toContainText('已提交');expect(state.submissions).toHaveLength(2);expect(state.submissions[1]).toEqual(state.submissions[0]);
});
test('automatic mixed package uses server tariffs and starts without an amount confirmation',async({page})=>{
 const state=await setup(page,true);
 await page.getByRole('button',{name:'直接使用光大整套'}).click();
 await page.locator('#fg-match-toggle').click();await page.getByRole('button',{name:'采用单一候选建议'}).click();
 await page.locator('[data-fg-type="annual"]').check();await page.locator('#fg-year').fill('2026');await page.locator('#fg-year').blur();
 await expect(page.locator('.fg-footer')).toContainText('14,881 积分');
 await page.getByRole('button',{name:'开始生成',exact:true}).click();
 await expect(page.locator('.fg-status')).toContainText('已提交');
 await expect(page.getByRole('dialog')).toHaveCount(0);expect(state.submissions).toHaveLength(1);
 expect(state.submissions[0]).toMatchObject({expected_points:14881,price_version:AUTOMATIC_PRICE_VERSION,document_quotes:[{document_type:'annual',draft_version:5,scope_quote_id:'scope-annual'}]});
});

test('mixed package funding return replays the exact original request without a second batch or payment',async({page})=>{
 const state=await setup(page,true),requests:string[]=[],payments:string[]=[];
 await page.route('**/api/v1/projects/*/file-generation/batches',async route=>{
  requests.push(route.request().postData()!);
  if(requests.length===1)return route.fulfill({status:402,json:{code:'CREDITS_INSUFFICIENT'}});
  return route.fallback();
 });
 await page.route('**/api/v1/subscriptions',route=>{payments.push(route.request().postData()??'');return route.fulfill({status:500,json:{code:'MUST_NOT_PAY'}});});
 await page.getByRole('button',{name:'直接使用光大整套'}).click();
 await page.locator('#fg-match-toggle').click();await page.getByRole('button',{name:'采用单一候选建议'}).click();
 await page.locator('[data-fg-type="annual"]').check();await page.locator('#fg-year').fill('2026');await page.locator('#fg-year').blur();
 await page.getByRole('button',{name:'开始生成',exact:true}).click();
 const link=page.locator('#billing-task-notice').getByRole('link',{name:'订阅或充值，继续原任务',exact:true});await expect(link).toBeVisible();
 expect(requests).toHaveLength(1);expect(state.submissions).toHaveLength(0);
 const resumeId=new URLSearchParams((await link.getAttribute('href'))!.split('?')[1]).get('resume_request')!;
 const saved=await page.evaluate(async({owner,id})=>{const recovery=await import('/src/'+'billing-task-recovery.ts');return {task:await recovery.readBillingTask(owner,id),returnTo:await recovery.billingTaskReturnTo(owner,id)};},{owner:ids.owner,id:resumeId});
 expect(saved.task).toMatchObject({version:2,state:'needs_funds',requiredPoints:'14881',body:JSON.parse(requests[0])});
 expect(saved.returnTo).toBeTruthy();await page.goto('/'+saved.returnTo);
 await expect.poll(()=>requests.length).toBe(2);expect(requests[1]).toBe(requests[0]);expect(state.submissions).toHaveLength(1);
 await expect(page.locator('.fg-history')).toContainText('其他文件 0/1');
 await page.reload();await expect(page.locator('.fg-history')).toContainText('其他文件 0/1');
 expect(requests).toHaveLength(2);expect(state.submissions).toHaveLength(1);expect(payments).toEqual([]);
});

for(const width of [1440,390])test('supplement exposes byte progress and saving at '+width,async({page})=>{
 await page.setViewportSize({width,height:960});const s=await setup(page);await hold(page);
 await page.locator('#fg-support').setInputFiles(file);await check(page,page.locator('.fg-upload-progress progress'),'file-generation-support',width);
 await expect(page.locator('.fg-upload-progress')).toHaveCount(0);expect(s.data.preparation.materials).toHaveLength(1);
});
test('template batch shows the current filename and transfer then processing',async({page})=>{
 await setup(page);await page.locator('#fg-custom').click();
 await page.evaluate(async()=>{const {ApiClient}=await import(String('/src/api.ts')),original=ApiClient.prototype.uploadRequest;
 ApiClient.prototype.uploadRequest=async function(path:string,file:File,progress:any,signal:AbortSignal,uploaded:any){progress(file.size*.4,file.size);await new Promise<void>(r=>(window as any).releaseBytes=r);uploaded();await new Promise<void>(r=>(window as any).releaseSave=r);return original.call(this,path,file,progress,signal,uploaded);};});
 const first={name:'第一份模板.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:Buffer.from('synthetic template')};
 await page.locator('#fg-template-upload').setInputFiles(first);await expect(page.locator('.fg-upload-progress')).toContainText(first.name);
 await check(page,page.locator('.fg-upload-progress progress'),'file-generation-template',1440);await expect(page.locator('.fg-upload-progress')).toHaveCount(0);
});
