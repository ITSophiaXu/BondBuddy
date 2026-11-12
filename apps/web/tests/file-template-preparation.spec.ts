import {hold,check} from './upload-progress-fixtures';
import {fixtureBody,fixtureRequest} from './billing-fixture-wire';
import {test,expect,type Page,type Route} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fixture,href,ids,sha,now,file} from './generation-entry-fixtures';
import {AUTOMATIC_PRICE_VERSION,emptyFileGenerationPreparation,type FileGenerationWorkspace,type FileTemplateSet,type FileTemplateMatch,type WorkpaperCatalogue} from '@bondbuddy/contracts';
const catalogue:WorkpaperCatalogue={catalogue_id:'builtin-cat',filename:'光大证券底稿目录.xlsx',sha256:sha,created_at:now,warnings:[],entries:['1','2'].map((code,i)=>({id:'entry-'+code,code,title:i?'关联方情况说明':'基本情况核查记录',folder:'',sheet:'尽职调查文件',row:i+2,instructions:'',kind:'file',path:code+'.docx'}))};
const set:FileTemplateSet={set_id:'builtin-set',name:'光大证券模板',version:'synthetic-v1',origin:'builtin',warnings:[],records:[...['1','2'].map(code=>({set_id:'builtin-set',record_id:'word-'+code,sha256:sha,name:code+' 核查模板',code,role:'核查记录',document_type:'workpaper' as const})),{set_id:'builtin-set',record_id:'annual',sha256:sha,name:'年度报告',code:'',role:'年度报告',document_type:'annual'}]};
async function setup(page:Page,automatic=false,configure?:(state:any)=>void,builtinHandler?:(route:Route)=>Promise<unknown>){
 const transport=await fixture(page);const state={transport,data:{revision:0,preparation:emptyFileGenerationPreparation(),sets:[],builtin:{name:'光大证券模板',version:'synthetic-v1',available:true},batches:[]} as FileGenerationWorkspace,submissions:[] as any[],lost:false,imports:[] as Buffer[],catalogue:structuredClone(catalogue),matches:undefined as FileTemplateMatch[]|undefined,quotes:0};
 if(automatic)state.data.pricing={mode:'automatic',price_version:AUTOMATIC_PRICE_VERSION,workpaper_points:3458,document_points:7965};
 configure?.(state);
 await page.route('**/api/v1/projects/*/file-generation**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname,body=req.method()==='GET'?undefined:req.headers()['content-type']==='application/octet-stream'?undefined:fixtureRequest(req);
  const reply=(body:unknown)=>route.fulfill({json:fixtureBody(route,body)});
  if(req.method()==='GET'&&path.endsWith('/file-generation'))return reply(state.data);
  if(path.endsWith('/preparation')){if(state.data.revision===body.expected_revision+1&&JSON.stringify(state.data.preparation)===JSON.stringify(body.preparation))return reply({revision:state.data.revision,preparation:state.data.preparation});if(state.data.revision!==body.expected_revision)return route.fulfill({status:409,json:{code:'INPUT_REVISION_CONFLICT'}});state.data.revision++;state.data.preparation=structuredClone(body.preparation);return reply({revision:state.data.revision,preparation:state.data.preparation});}
  if(path.endsWith('/builtin')){if(builtinHandler)return builtinHandler(route);if(body.part!=='catalogue'&&!state.data.sets.length)state.data.sets.push(set);return reply({...(body.part!=='catalogue'?{set}:{}),...(body.part!=='templates'?{catalogue:state.catalogue}:{})});}
  if(path.endsWith('/matches')){const chosen=state.data.sets.find(s=>s.set_id===url.searchParams.get('set_id'))??set;return reply({matches:state.matches??state.catalogue.entries.map(e=>{const record=chosen.records.find(r=>r.document_type==='workpaper'&&r.code===e.code);return {item_id:e.id,status:record?'suggested':'missing',reason:record?'same code':'no candidate',candidates:record?[{set_id:chosen.set_id,record_id:record.record_id,sha256:sha}]:[]};})});}
  if(path.endsWith('/system-templates'))return reply({templates:[{family:'综合核查记录',preview:{title:'合成核查记录',blocks:[{kind:'paragraph',text:'项目名称：【本项信息】',bold:false,align:'left'}]}}]});
  if(path.endsWith('/template-preview'))return reply({title:'核查记录',redacted:true,view:'structure',pdf_available:false,blocks:[{kind:'paragraph',text:'项目名称：【本项信息】',bold:false,align:'left'},{kind:'table',rows:[['姓名','职务'],['—','—']]}]});
  if(path.endsWith('/template-preview-pdf'))return route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE',message:'unavailable',retryable:true}});
  if(path.endsWith('/quote')){state.quotes++;if(state.data.preparation.workpaper_template_mode!=='automatic'&&state.data.preparation.document_types.includes('workpaper')&&state.data.preparation.item_ids.some(id=>!state.data.preparation.mappings[id]))return route.fulfill({status:422,json:{code:'VALIDATION_FAILED',message:'请为每份所选文件指定 Word 模板。'}});return reply({count:automatic?state.data.preparation.item_ids.length+state.data.preparation.document_types.filter(t=>t!=='workpaper').length:body.expected_points/4500,points:body.expected_points,price_version:body.price_version,omitted:catalogue.entries.filter(e=>!state.data.preparation.item_ids.includes(e.id)),...(automatic?{auto_charge:true,quote_status:'ready',documents:state.data.preparation.document_types.filter(t=>t!=='workpaper').map(document_type=>({document_type,draft_version:5,scope_quote_id:'scope-'+document_type,points:7965,price_version:AUTOMATIC_PRICE_VERSION,auto_charge:true,quote_status:'ready'}))}:{})});}
  if(path.endsWith('/templates/import')){expect(req.headers()['content-type']).toBe('application/octet-stream');state.imports.push(req.postDataBuffer()!);const own={...set,set_id:'uploaded-set',name:'我的模板包',origin:'private',version:'uploaded-v1',records:set.records.map(r=>({...r,set_id:'uploaded-set'}))};state.data.sets.push(own as FileTemplateSet);return reply(own);}
  if(path.endsWith('/batches')){state.submissions.push(body);const batch={batch_id:'batch-one',created_at:now,points:body.expected_points,workpapers:null,documents:{batch_id:'docs-one',state:'queued',items:[{document_type:'annual',run_id:null,state:'queued',error:null}]}};state.data.batches=[batch as any];if(state.lost){state.lost=false;return route.abort('failed');}return reply(batch);}
  return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
 });
 await page.route('**/api/v1/projects/*/workpapers/catalogues/*',route=>route.fulfill({json:state.catalogue}));
 await page.goto('/'+href({step:'prepare'}));await expect(page.getByRole('heading',{name:'底稿目录与文件模板'})).toBeVisible();if(!builtinHandler)await expect(page.locator('#fg-confirm')).toBeEnabled();return state;
}
async function useWord(page:Page,mode:'builtin'|'custom'='builtin'){
 if(!await page.locator('#fg-builtin-all').isVisible())await page.locator('#fg-change-templates').click();
 await page.locator(mode==='builtin'?'#fg-builtin-all':'#fg-custom').click();
 await expect(page.locator('#fg-confirm')).toBeEnabled();
}

test('independent catalogue/template cards, safe preview and mixed confirmation use the production component',async({page})=>{
 await page.setViewportSize({width:1440,height:960});
 const state=await setup(page);await useWord(page);await expect(page.locator('.fg-template-panel')).toContainText('光大证券底稿目录.xlsx');
 await expect(page.locator('#fg-matches select')).toHaveCount(0);
 await page.getByRole('button',{name:'预览目录',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('基本情况核查记录');await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('button',{name:'预览模板',exact:true}).click();await page.locator('[data-record="word-1"]').click();await expect(page.getByRole('dialog')).toContainText('项目名称：【本项信息】');
 await page.getByRole('button',{name:'查看版式预览'}).click();await expect(page.locator('#fg-layout-status')).toContainText('结构预览已保留');await page.getByRole('button',{name:'关闭',exact:true}).click();
 await expect(page.locator('.fg-match-summary')).toContainText('已匹配 2 / 2 项');expect(Object.keys(state.data.preparation.mappings)).toHaveLength(2);
 await page.locator('#fg-more-types').click();await page.locator('[data-fg-type="annual"]').check();await page.locator('#fg-year').fill('2026');await page.locator('#fg-year').blur();
 await page.locator('[data-fg-general="annual"]').selectOption('builtin-set|annual');
 await expect(page.locator('#fg-requirements')).toBeHidden();await page.getByText('补充资料与编制要求（选填）',{exact:true}).click();
 await page.locator('#fg-requirements').fill('合成验收要求，保留原 Word 格式');await page.getByRole('button',{name:'保存准备清单'}).click();
 await page.getByRole('button',{name:'核对清单与费用'}).click();await expect(page.getByRole('dialog')).toContainText('3 份文件 · 13,500 积分');
 await expect(page.locator('[data-flow-step="3"]')).toHaveAttribute('aria-current','step');
 await page.getByRole('button',{name:'确认生成 3 份文件'}).click();await expect(page.locator('.fg-status')).toContainText('已提交');expect(state.submissions).toHaveLength(1);
 await expect(page.locator('[data-flow-step="4"]')).toHaveAttribute('aria-current','step');
 const evidence=resolve('test-evidence/file-template-preparation');await mkdir(evidence,{recursive:true});await page.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();window.scrollTo({top:0,left:0,behavior:'instant'});});await page.screenshot({path:resolve(evidence,'desktop-synthetic.png'),fullPage:true});
});
for(const width of [1440,390])test(`current dual-card prototype reference ${width}`,async({page})=>{
 await page.setViewportSize({width,height:width===1440?960:844});
 const path=resolve('../../product-prototype/public/file-templates-v2.html').replaceAll('\\','/');await page.goto('/@fs/'+path);
 await expect(page.getByRole('heading',{name:'生成文件',exact:true})).toBeVisible();
 const evidence=resolve('test-evidence/file-template-preparation');await mkdir(evidence,{recursive:true});await page.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();window.scrollTo({top:0,left:0,behavior:'instant'});});await page.screenshot({path:resolve(evidence,`prototype-${width}.png`),fullPage:true});
});
test('support recovery only asks for original bytes after retry and keeps the original operation',async({page})=>{
 const state=await setup(page);
 const original=await page.evaluate(async({owner,project,name,mime,bytes})=>{
  const {UploadRecovery}=await import(String('/src/upload-recovery.ts')),{ApiClient}=await import(String('/src/api.ts'));
  const data=new Uint8Array(bytes),digest=await crypto.subtle.digest('SHA-256',data);
  const sha256=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
  return new UploadRecovery(new ApiClient(),owner,project,'file-generation-support').begin({filename:name,media_type:mime,byte_size:bytes.length,sha256,role:'other'}).id;
 },{owner:ids.owner,project:ids.api,name:file.name,mime:file.mimeType,bytes:[...file.buffer]});
 await page.reload();
 const reselect=page.locator('#fg-controls > section:last-child .fg-notice input[type=file]');
 await expect(reselect).toBeHidden();await page.getByRole('button',{name:'继续保存',exact:true}).click();
 await expect(reselect).toBeVisible();await expect(page.locator('.fg-status')).toContainText('相同内容');
 const changed=Buffer.from(file.buffer);changed[0]^=1;await reselect.setInputFiles({...file,buffer:changed});
 await expect(page.locator('.fg-status')).toContainText('冲突');expect(state.transport.sessions.size).toBe(0);
 const records=await page.evaluate(()=>Object.values(localStorage).filter(s=>s.includes('file-generation-support')).flatMap(s=>{try{return [JSON.parse(s)];}catch{return [];}}));
 expect(records.some(r=>r.id===original)).toBe(true);
 await reselect.setInputFiles(file);
 await expect(page.locator('#fg-controls')).toContainText('已采用 1 份补充资料');await expect(page.getByRole('button',{name:'继续保存',exact:true})).toHaveCount(0);
 expect(state.transport.puts).toBe(1);expect(state.data.preparation.materials).toHaveLength(1);expect(state.submissions).toHaveLength(0);
});
test('support automatically confirms a lost PUT acknowledgement without sending bytes twice',async({page})=>{
 const state=await setup(page);let fail=true;
 await page.route('**/materials/uploads/*/bytes',async route=>{if(fail){fail=false;state.transport.sessions.get(new URL(route.request().url()).pathname.split('/').at(-2)!)!.received=true;state.transport.puts++;return route.abort('failed');}return route.fallback();});
 await page.locator('#fg-support').setInputFiles(file);
 await expect(page.locator('#fg-controls')).toContainText('已采用 1 份补充资料');
 expect(state.transport.puts).toBe(1);expect(state.data.preparation.materials).toHaveLength(1);expect(state.submissions).toHaveLength(0);
});

test('custom templates have independent selections, upload actual bytes and survive mode changes and refresh',async({page})=>{
 const state=await setup(page);await expect(page.locator('#fg-preview-set')).toBeEnabled();await useWord(page,'custom');
 await expect(page.locator('#fg-template-upload')).toBeEnabled();
 await expect(page.getByText('使用光大目录',{exact:true})).toHaveCount(0);await expect(page.getByText('使用光大模板',{exact:true})).toHaveCount(0);
 expect(state.data.preparation.catalogue_id).toBe(catalogue.catalogue_id);
 const bytes=Buffer.from('synthetic Word bytes for transport test');await page.locator('#fg-template-upload').setInputFiles({name:'template.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:bytes});
 await expect(page.locator('.fg-match-summary')).toContainText('已匹配 2 / 2 项');await expect(page.locator('#fg-confirm')).toBeEnabled();await expect(page.locator('.fg-template-panel')).toContainText('我的模板包');expect(state.imports[0]).toEqual(bytes);expect(state.data.preparation.catalogue_id).toBe(catalogue.catalogue_id);expect(Object.values(state.data.preparation.mappings).every(p=>p.set_id==='uploaded-set')).toBe(true);expect(Object.keys(state.data.preparation.mappings)).toHaveLength(2);
 await page.reload();await expect(page.locator('.fg-template-panel')).toContainText('我的模板包');await expect(page.locator('.fg-template-panel')).toContainText('光大证券底稿目录.xlsx');
 await page.setViewportSize({width:390,height:844});await expect(page.locator('#fg-confirm')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 const evidence=resolve('test-evidence/file-template-preparation');await mkdir(evidence,{recursive:true});await page.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();window.scrollTo({top:0,left:0,behavior:'instant'});});await page.screenshot({path:resolve(evidence,'mobile-synthetic.png'),fullPage:true});
});

test('a late builtin reply cannot replace custom mode; cancellation and retry keep the page usable',async({page})=>{
 let release!:()=>void,calls=0;const gate=new Promise<void>(r=>release=r);
 const state=await setup(page);await page.route('**/file-generation/builtin',async route=>{calls++;if(calls===1)await gate;await route.fulfill({json:fixtureBody(route,{set,catalogue})}).catch(()=>{});});await page.locator('#fg-change-templates').click();await page.locator('#fg-builtin-all').click();
 await expect(page.locator('#fg-cancel-builtin')).toBeVisible();await useWord(page,'custom');
 await expect(page.locator('#fg-template-upload')).toBeEnabled();release();
 await expect(page.locator('#fg-custom')).toHaveAttribute('aria-pressed','true');expect(state.data.preparation.template_set_id).toBeNull();
 await page.locator('#fg-builtin-all').click();await expect(page.locator('#fg-preview-catalogue')).toBeEnabled();await expect(page.locator('#fg-preview-set')).toBeEnabled();
 await expect(page.locator('#fg-builtin-all')).toHaveAttribute('aria-pressed','true');expect(state.submissions).toHaveLength(0);
});

test('template loading can be cancelled, retried and switched without changing the directory',async({page})=>{
 const state=await setup(page);await expect(page.locator('#fg-confirm')).toBeEnabled();
 let calls=0;
 await page.route('**/file-generation/builtin',async route=>{calls++;if(calls===1)return route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE'}});if(calls===2)return;return route.fallback();});
 await page.locator('#fg-change-templates').click();await page.locator('#fg-builtin-all').click();await expect(page.locator('.fg-load-status')).not.toBeEmpty();
 expect(state.data.preparation.workpaper_template_mode).toBe('automatic');
 await page.locator('#fg-builtin-all').click();await expect(page.locator('#fg-cancel-builtin')).toBeVisible();await page.locator('#fg-cancel-builtin').click();
 await expect(page.locator('.fg-load-status')).toContainText('已取消');expect(state.data.preparation.item_ids).toEqual(['entry-1','entry-2']);
 await page.locator('#fg-builtin-all').click();await expect(page.locator('.fg-match-summary')).toContainText('已匹配 2 / 2 项');expect(calls).toBe(3);expect(state.submissions).toHaveLength(0);
});

test('template timeout keeps the selected system mode and allows retry',async({page})=>{
 await setup(page);await expect(page.locator('#fg-confirm')).toBeEnabled();
 await page.evaluate(()=>{const timeout=AbortSignal.timeout.bind(AbortSignal);let first=true;AbortSignal.timeout=(ms)=>{if(ms===60_000&&first){first=false;return timeout(100);}return timeout(ms);};});
 let calls=0;await page.route('**/file-generation/builtin',async route=>{if(++calls===1)return;return route.fallback();});
 await page.locator('#fg-change-templates').click();await page.locator('#fg-builtin-all').click();await expect(page.locator('.fg-load-status')).toContainText('加载超时');
 await expect(page.locator('#fg-automatic')).toHaveAttribute('aria-pressed','true');await page.locator('#fg-builtin-all').click();await expect(page.locator('.fg-match-summary')).toContainText('已匹配 2 / 2 项');
});

test('directory loading failure and cancellation leave upload and retry available',async({page})=>{
 let calls=0;await setup(page,false,undefined,async route=>{calls++;if(calls===1)return route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE'}});if(calls===2)return;return route.fulfill({json:fixtureBody(route,{catalogue})});});
 await expect(page.locator('#fg-load-builtin')).toBeEnabled();await page.locator('#fg-load-builtin').click();await expect(page.locator('#fg-cancel-builtin')).toBeVisible();await expect.poll(()=>calls).toBe(2);await page.locator('#fg-cancel-builtin').click();
 await expect(page.locator('#fg-catalogue-upload')).toBeEnabled();await page.locator('#fg-load-builtin').click();await expect(page.locator('#fg-preview-catalogue')).toBeEnabled();expect(calls).toBe(3);
});

test('lost submission reply is recovered with the same frozen request after reload',async({page})=>{
 const state=await setup(page);await useWord(page);await page.locator('[data-fg-type="workpaper"]').uncheck();await page.locator('#fg-more-types').click();await page.locator('[data-fg-type="annual"]').check();await page.locator('#fg-year').fill('2026');await page.locator('#fg-year').blur();
 state.lost=true;await page.getByRole('button',{name:'核对清单与费用'}).click();await page.getByRole('button',{name:'确认生成 1 份文件'}).click();await expect(page.locator('#fg-submit-status')).not.toBeEmpty();
 await page.reload();await page.getByRole('button',{name:'确认上次提交结果'}).click();await expect(page.locator('.fg-status')).toContainText('已提交');expect(state.submissions).toHaveLength(2);expect(state.submissions[1]).toEqual(state.submissions[0]);
});
test('automatic mixed package uses server tariffs and starts without an amount confirmation',async({page})=>{
 const state=await setup(page,true);
 await useWord(page);
 await expect(page.locator('.fg-match-summary')).toContainText('已匹配 2 / 2 项');
 await page.locator('#fg-more-types').click();await page.locator('[data-fg-type="annual"]').check();await page.locator('#fg-year').fill('2026');await page.locator('#fg-year').blur();
 await expect(page.locator('.fg-footer')).toContainText('14,881 积分');
 await page.getByRole('button',{name:'生成本批文件',exact:true}).click();
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
 await useWord(page);
 await expect(page.locator('.fg-match-summary')).toContainText('已匹配 2 / 2 项');
 await page.locator('#fg-more-types').click();await page.locator('[data-fg-type="annual"]').check();await page.locator('#fg-year').fill('2026');await page.locator('#fg-year').blur();
 await page.getByRole('button',{name:'生成本批文件',exact:true}).click();
 const link=page.locator('#billing-task-notice').getByRole('link',{name:'查看积分与支付状态',exact:true});await expect(link).toBeVisible();
 expect(requests).toHaveLength(1);expect(state.submissions).toHaveLength(0);
 const resumeId=new URLSearchParams((await link.getAttribute('href'))!.split('?')[1]).get('resume_request')!;
 const saved=await page.evaluate(async({owner,id})=>{const recovery=await import('/src/'+'billing-task-recovery.ts');return {task:await recovery.readBillingTask(owner,id),returnTo:await recovery.billingTaskReturnTo(owner,id)};},{owner:ids.owner,id:resumeId});
 expect(saved.task).toMatchObject({version:2,state:'needs_funds',requiredPoints:'14881',body:JSON.parse(requests[0])});
 expect(saved.returnTo).toBeTruthy();await page.goto('/'+saved.returnTo);
 await expect.poll(()=>requests.length).toBe(2);await expect.poll(()=>state.submissions.length).toBe(1);expect(requests[1]).toBe(requests[0]);expect(state.submissions).toHaveLength(1);
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
 await setup(page);await useWord(page,'custom');
 await page.evaluate(async()=>{const {ApiClient}=await import(String('/src/api.ts')),original=ApiClient.prototype.uploadRequest;
 ApiClient.prototype.uploadRequest=async function(path:string,file:File,progress:any,signal:AbortSignal,uploaded:any){progress(file.size*.4,file.size);await new Promise<void>(r=>(window as any).releaseBytes=r);uploaded();await new Promise<void>(r=>(window as any).releaseSave=r);return original.call(this,path,file,progress,signal,uploaded);};});
 const first={name:'第一份模板.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:Buffer.from('synthetic template')};
 await page.locator('#fg-template-upload').setInputFiles(first);await expect(page.locator('.fg-upload-progress')).toContainText(first.name);
 await check(page,page.locator('.fg-upload-progress progress'),'file-generation-template',1440);await expect(page.locator('.fg-upload-progress')).toHaveCount(0);
});

test('unresolved templates stay visible and stop quotes until the user chooses a Word template',async({page})=>{
 const state=await setup(page,false,s=>{s.matches=[{item_id:'entry-1',status:'suggested',candidates:[{set_id:set.set_id,record_id:'word-1',sha256:sha}],reason:'same code'},{item_id:'entry-2',status:'multiple',candidates:set.records.slice(0,2).map(r=>({set_id:r.set_id,record_id:r.record_id,sha256:r.sha256})),reason:'two roles'}];});
 await useWord(page);
 await expect(page.locator('.fg-match-summary')).toContainText('已匹配 1 / 2 项');
 await expect(page.getByRole('button',{name:'自动匹配模板',exact:true})).toBeVisible();
 await expect(page.locator('[data-fg-mapping]')).toHaveCount(1);
 await page.locator('#fg-match-toggle').click();await expect(page.locator('[data-fg-mapping]')).toHaveCount(0);
 await page.locator('#fg-confirm').click();await expect(page.locator('#fg-matches')).toBeFocused();
 await expect(page.locator('.fg-status')).toContainText('还有 1 项底稿需要选择 Word 模板');expect(state.quotes).toBe(0);expect(state.submissions).toHaveLength(0);
 await page.locator('[data-fg-mapping="entry-2"]').selectOption('word-2');
 await expect(page.locator('.fg-match-summary')).toContainText('已匹配 2 / 2 项');
 await page.getByRole('button',{name:'核对清单与费用',exact:true}).click();
 await page.getByRole('button',{name:'确认生成 2 份文件'}).click();await expect.poll(()=>state.submissions.length).toBe(1);expect(state.quotes).toBe(1);expect(state.submissions).toHaveLength(1);
});

test('reselecting the same package keeps manual choices and the selected scope',async({page})=>{
 const state=await setup(page);await useWord(page);
 await page.locator('#fg-match-toggle').click();await page.locator('[data-fg-mapping="entry-1"]').focus();await page.locator('[data-fg-mapping="entry-1"]').selectOption('word-2');await page.locator('[data-fg-item="entry-2"]').uncheck();
 await useWord(page);
 expect(state.data.preparation.item_ids).toEqual(['entry-1']);expect(state.data.preparation.mappings['entry-1'].record_id).toBe('word-2');
 await page.locator('#fg-automatic').click();await expect(page.locator('.fg-match-summary')).toContainText('光大模板');await useWord(page);
 expect(state.data.preparation.item_ids).toEqual(['entry-1']);expect(state.data.preparation.mappings['entry-1'].record_id).toBe('word-2');
});

for(const width of [1440,390])test(`old 248-item preparation exposes matching, paginates and restores at ${width}`,async({page})=>{
 await page.setViewportSize({width,height:960});
 const state=await setup(page,false,s=>{
  s.catalogue={...catalogue,entries:Array.from({length:248},(_,i)=>({...catalogue.entries[0],id:'entry-'+(i+1),code:String(i+1),title:'合成底稿 '+(i+1)}))};
  const large={...set,records:Array.from({length:170},(_,i)=>({...set.records[0],record_id:'word-'+(i+1),code:String(i+1),name:'合成 Word 模板 '+(i+1)}))};
  s.data={...s.data,revision:1,sets:[large],preparation:{...emptyFileGenerationPreparation(),catalogue_id:catalogue.catalogue_id,template_set_id:set.set_id,item_ids:s.catalogue.entries.map((e:any)=>e.id)}};
 });
 await expect(page.getByRole('button',{name:'自动匹配模板',exact:true})).toBeVisible();
 await expect(page.locator('[data-fg-mapping]')).toHaveCount(20);
 await page.getByRole('button',{name:'自动匹配模板',exact:true}).click();await expect(page.locator('.fg-match-summary')).toContainText('已匹配 170 / 248 项');
 expect(state.data.preparation.item_ids).toHaveLength(248);expect(state.quotes).toBe(0);
 await expect(page.locator('.fg-match-pages')).toContainText('共 78 项');await page.locator('#fg-next-page').click();await expect(page.locator('.fg-match-pages')).toContainText('第 2 / 4 页');
 await page.reload();await expect(page.locator('.fg-match-summary')).toContainText('已匹配 170 / 248 项');await expect(page.locator('[data-fg-mapping]')).toHaveCount(20);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 const evidence=resolve('test-evidence/template-selection');await mkdir(evidence,{recursive:true});await page.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();window.scrollTo({top:0,left:0,behavior:'instant'});});await page.screenshot({path:resolve(evidence,`unresolved-${width}.png`),fullPage:true});await page.locator('.fg-combination').screenshot({path:resolve(evidence,`matching-summary-${width}.png`)});
 await page.locator('#fg-match-toggle').click();await expect(page.locator('[data-fg-mapping]')).toHaveCount(0);
 await page.locator('#fg-confirm').click();await expect(page.locator('#fg-matches')).toBeFocused();expect(state.quotes).toBe(0);expect(state.submissions).toHaveLength(0);
});

test('a failed preparation save cannot submit the locally auto-matched selection',async({page})=>{
 const state=await setup(page);let failing=true;
 await page.route('**/file-generation/preparation',route=>failing?route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE',retryable:true}}):route.fallback());
 await useWord(page);await expect(page.locator('.fg-status')).toContainText('结果尚未确认');
 await page.locator('#fg-confirm').click();await expect(page.locator('#fg-save-retry')).toBeVisible();await expect(page.locator('#fg-save-retry')).toBeEnabled();expect(state.quotes).toBe(0);expect(state.submissions).toHaveLength(0);
 failing=false;await page.locator('#fg-confirm').click();await expect(page.getByRole('dialog')).toContainText('2 份文件');expect(Object.keys(state.data.preparation.mappings)).toHaveLength(2);
});

for(const width of [1440,390])test(`Guangda templates are the named default and submit without manual mappings at ${width}`,async({page})=>{
 await page.setViewportSize({width,height:960});const state=await setup(page,true);
 await expect(page.locator('.fg-template-panel')).toContainText('光大模板');await expect(page.locator('.fg-template-panel')).not.toContainText('系统模板');
 expect(state.data.preparation.workpaper_template_mode).toBe('automatic');expect(state.data.preparation.mappings).toEqual({});expect(state.data.sets).toHaveLength(0);
 await page.getByRole('button',{name:'预览模板',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('综合核查记录');await page.getByRole('button',{name:'关闭',exact:true}).click();
 const evidence=resolve('test-evidence/template-selection');await mkdir(evidence,{recursive:true});await page.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();window.scrollTo({top:0,left:0,behavior:'instant'});});await page.screenshot({path:resolve(evidence,`system-default-${width}.png`),fullPage:true});await page.locator('.fg-template-panel').screenshot({path:resolve(evidence,`system-panel-${width}.png`),style:'.fg-footer,.topbar,.skip-link,.ba-dock{visibility:hidden!important}'});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.locator('#fg-confirm').click();await expect(page.locator('.fg-status')).toContainText('已提交');expect(state.submissions).toHaveLength(1);expect(state.quotes).toBe(1);
});

test('legacy direct entry moves to one preparation and preserves its catalogue, selection and requirements',async({page})=>{
 await page.addInitScript(({owner,project})=>localStorage.setItem(`bb-workpapers-v1:${owner}:${project}`,JSON.stringify({catalogue:'builtin-cat',selected:['entry-2'],requirements:'保留旧目录编制要求'})),{owner:ids.owner,project:ids.api});
 const state=await setup(page);await page.goto('/'+href({step:'workpapers'}));await expect(page).toHaveURL(/step=prepare/);
 await expect(page.locator('#fg-requirements')).toHaveValue('保留旧目录编制要求');await expect(page.locator('.fg-match-summary')).toContainText('已选 1 项');
 await page.locator('#fg-confirm').click();await expect(page.getByRole('dialog')).toContainText('光大模板');expect(state.data.preparation.item_ids).toEqual(['entry-2']);expect(state.data.preparation.workpaper_template_mode).toBe('automatic');
});

test('legacy pending workpaper request stays on its recovery path and is never resubmitted automatically',async({page})=>{
 await fixture(page);
 const pending={request_id:'old-request',start_mode:'direct',catalogue_id:catalogue.catalogue_id,catalogue_sha256:sha,item_ids:['entry-1'],source_version_id:'old-source',source_selection_revision:2,requirements:'原要求',expected_points:4500,price_version:'m4-document-fixed-2026-10-02'};
 await page.addInitScript(({owner,project,pending})=>localStorage.setItem(`bb-workpapers-v1:${owner}:${project}`,JSON.stringify({catalogue:'builtin-cat',selected:['entry-1'],requirements:'原要求',pending})),{owner:ids.owner,project:ids.api,pending});
 const submissions:string[]=[];
 await page.route('**/api/v1/projects/*/workpapers',route=>route.fulfill({json:fixtureBody(route,{catalogues:[catalogue],batches:[],assessments:[]})}));
 await page.route('**/api/v1/projects/*/workpapers/batches',route=>{submissions.push(route.request().postData()!);return route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE'}});});
 await page.goto('/'+href({step:'prepare'}));await expect(page).toHaveURL(/step=workpapers/);await expect(page.getByRole('button',{name:'继续确认上次提交',exact:true})).toBeVisible();
 expect(submissions).toHaveLength(0);await page.getByRole('button',{name:'继续确认上次提交',exact:true}).click();await expect.poll(()=>submissions.length).toBe(1);expect(JSON.parse(submissions[0])).toEqual(pending);
});
