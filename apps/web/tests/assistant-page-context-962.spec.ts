import { test, expect, type Page } from '@playwright/test';
import { fixtureJson, fixtureRequest } from './billing-fixture-wire';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const now='2026-11-12T02:00:00Z', hash='a'.repeat(64);
const scaffold='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#f7f8f3;font:14px/1.6 system-ui;color:#233c34}.prototype-app main{padding:42px}.prototype-app h1{font-size:24px}.prototype-app p{color:#728078}</style><div class="prototype-app"><div class="shell"><main><h1>合成乙项目 · 项目文件</h1><p>合成界面测试，不连接客户项目。</p></main></div></div>';
function workspace(id:string,source:string){return {topic:{topic_id:id,project_id:'scope-'+source,source_project_id:source,name:'合成'+(source==='a'?'甲':'乙')+'项目 · BondBuddy',surface:'assistant',created_at:now,updated_at:now},project:{project_id:'scope-'+source,name:'对话工作区',kind:'qa',draft_revision:1},materials:[] as any[],material_details:[] as any[],drafts:{},templates:[],messages:[] as any[],tasks:[],artifacts:[],pending_requirements:[],active_run:null,view:{version:0,selected_document_type:null,open_tabs:[],active_tab:null,unsent_content:'',unsent_context:{document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:null as any},assistant:{project_id:source==='a'?'execution-a':source,action:null}}};}
async function setup(page:Page){
 const a=workspace('topic-a','a'),topics=new Map<string,any>([['topic-a',a]]),writes:{path:string,body:any}[]=[],unexpected:string[]=[];
 const pin={source_project_id:'execution-a',artifact_id:'result-a',artifact_version:3,sha256:hash};
 const material={material_id:'attachment-a',material_version:1,sha256:hash,source_project_id:'execution-a',filename:'合成甲项目附件.txt',state:'persisted',role:'other'};
 a.materials=[{source_project_id:'execution-a',material_id:material.material_id,material_version:1,sha256:hash}];a.material_details=[material];a.view.unsent_context.reading_artifact=pin;
 const projects:any={a:{project_id:'a',name:'合成甲项目',kind:'update',draft_revision:1},b:{project_id:'b',name:'合成乙项目',kind:'update',draft_revision:1},'execution-a':{project_id:'execution-a',source_project_id:'a',name:'合成甲项目',kind:'update',draft_revision:1},'execution-b':{project_id:'execution-b',source_project_id:'b',name:'乙更新工作区',kind:'update',draft_revision:1}};
 await page.route('**/ux-962-harness',route=>route.fulfill({contentType:'text/html',body:scaffold+'<script type="module">import {ProjectAssistant} from "/src/project-assistant.ts";import {ApiClient} from "/src/api.ts";window.assistant=new ProjectAssistant(new ApiClient(()=>{}),"ux-962-owner");</script>'}));
 await page.route('**/api/v1/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname.replace('/api/v1','');const input=req.method()==='GET'?undefined:fixtureRequest(req);if(req.method()!=='GET')writes.push({path,body:input});
  let body:any,status=200;
  if(path==='/m4/topics'){if(req.method()==='GET')body={topics:[...topics.values()].map(w=>w.topic)};else{const w=workspace('topic-b',input.source_project_id);topics.set('topic-b',w);body={topic:w.topic};}}
  else if(path.match(/^\/projects\/[^/]+$/)){const id=decodeURIComponent(path.split('/').at(-1)!);body=projects[id];if(!body){status=404;body={code:'NOT_FOUND'};}}
  else if(path.startsWith('/assistant/projects/')){const id=path.split('/').at(-1)!;body={project:projects[id],materials:[],results:id==='execution-a'?[{pin,label:'第 3 版 · 清洁稿',run_id:'run-a'}]:[]};}
  else if(path.endsWith('/cards'))body={cards:[]};
  else {const id=path.split('/')[3],w=topics.get(id);
   if(path.endsWith('/workspace')&&w)body=w;
   else if(path.endsWith('/view')&&w){expect(input.expected_version).toBe(w.view.version);w.view={...input.view,version:w.view.version+1};body={view:w.view};}
   else if(path.endsWith('/quote')&&w)body={quote:{quote_id:'quote-a',topic_id:id,input_hash:hash,points:0,task_type:'m4_Q00',billing_method:'free',amount_semantics:'reservation_cap'},balance:{available:10000,frozen:0},shortage:0};
   else if(path.endsWith('/messages')&&w){const message={message_id:'sent',role:'user',content:input.content,context:input.context,reply_status:'completed',created_at:now};w.messages.push(message);body={message,run:{run_id:'synthetic-qa'}};}
   else {unexpected.push(path);status=404;body={code:'NOT_FOUND'};}
  }
  await route.fulfill({status,contentType:'application/json',body:fixtureJson(route,body)});
 });
 await page.goto('/ux-962-harness#/projects/execution-a?return_project=a');await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();await expect(page.locator('[data-composer]')).toBeEnabled();await expect(page.locator('[data-send-context]')).toContainText('合成甲项目');
 return {a,topics,writes,unexpected,pin,projects};
}
for(const size of [{name:'desktop',width:1440,height:960},{name:'mobile',width:390,height:844}])test('explicit named handoff preserves complete original conversation - '+size.name,async({page})=>{
 await page.setViewportSize(size);const s=await setup(page);await page.locator('[data-composer]').fill('请只调整风险提示，不修改数字。');
 for(const route of ['#/projects/execution-b?return_project=b','#qa?project=b','#generate?project=b','#integrity?project=b']){
  await page.evaluate(route=>location.hash=route,route);await expect(page.locator('[data-page-context]')).toContainText('当前页面：合成乙项目');await expect(page.locator('[data-page-context]')).toContainText('本对话仍关联：合成甲项目');await expect(page.locator('[data-composer]')).toHaveValue('请只调整风险提示，不修改数字。');await expect(page.locator('[data-send-context]')).toContainText('第 3 版 · 清洁稿');
 }
 expect(s.writes.filter(w=>w.path==='/m4/topics')).toHaveLength(0);expect(s.a.view.unsent_context.reading_artifact).toEqual(s.pin);
 await page.locator('.ba-context-files summary').click();await expect(page.locator('.ba-context-files')).toContainText('合成甲项目附件.txt');await page.locator('.ba-context-files summary').click();
 const evidence=process.env.BB_UX_962_EVIDENCE;
 if(evidence){await mkdir(evidence,{recursive:true});await page.mouse.move(0,0);await page.screenshot({path:resolve(evidence,'implementation-'+size.name+'.png')});const prototype=await page.context().newPage();await prototype.setViewportSize(size);await prototype.route('**/ux-962-prototype',async route=>route.fulfill({contentType:'text/html',body:await readFile(new URL('../../../product-prototype/public/assistant-project-handoff.html',import.meta.url),'utf8')}));await prototype.goto('/ux-962-prototype');await expect(prototype.locator('.ba-page-handoff')).toBeVisible();await prototype.screenshot({path:resolve(evidence,'prototype-'+size.name+'.png')});await prototype.close();}
 await page.getByRole('button',{name:'为“合成乙项目”开新对话',exact:true}).click();await expect(page.locator('[data-send-context]')).toContainText('发送至：合成乙项目');await expect(page.locator('[data-composer]')).toHaveValue('');expect(s.writes.filter(w=>w.path==='/m4/topics').map(w=>w.body.source_project_id)).toEqual(['b']);
 await page.getByRole('button',{name:'最近对话',exact:true}).click();await page.locator('[data-a=select][data-id=topic-a]').click();await expect(page.locator('[data-composer]')).toHaveValue('请只调整风险提示，不修改数字。');await expect(page.locator('[data-baseline]')).toHaveValue('result-a');await expect(page.locator('.ba-context-files')).toContainText('合成甲项目附件.txt');
 await page.reload();await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();await expect(page.locator('[data-composer]')).toHaveValue('请只调整风险提示，不修改数字。');await expect(page.locator('[data-send-context]')).toContainText('第 3 版 · 清洁稿');
 expect(s.writes.filter(w=>/execute|messages|quote|credit/.test(w.path))).toHaveLength(0);expect(s.unexpected).toEqual([]);
});
test('failed draft save blocks a named handoff without losing original inputs',async({page})=>{
 const s=await setup(page);await page.route('**/api/v1/m4/topics/topic-a/view',route=>route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE'}}));await page.locator('[data-composer]').fill('保存失败也必须保留这段甲项目草稿');await page.evaluate(()=>location.hash='#qa?project=b');await expect(page.locator('[data-a=current-project]')).toBeVisible();await page.locator('[data-a=current-project]').click();await expect(page.locator('[data-composer]')).toHaveValue('保存失败也必须保留这段甲项目草稿');await expect(page.locator('[data-send-context]')).toContainText('合成甲项目');expect(s.writes.filter(w=>w.path==='/m4/topics')).toHaveLength(0);expect(s.a.materials).toHaveLength(1);expect(s.a.view.unsent_context.reading_artifact).toEqual(s.pin);
});
test('long project names keep the handoff and send target within a narrow viewport',async({page})=>{
 await page.setViewportSize({width:320,height:740});const s=await setup(page);s.projects.b.name='合成乙项目'+ '长名称用于验证项目上下文不会横向溢出'.repeat(8);await page.evaluate(()=>location.hash='#qa?project=b');await expect(page.locator('[data-a=current-project]')).toContainText(s.projects.b.name);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(page.locator('[data-composer]')).toBeInViewport();
});
test('navigation and forged return hints do not change the message destination',async({page})=>{
 const s=await setup(page);await page.evaluate(()=>location.hash='#qa?project=b&return_project=a');await expect(page.locator('[data-page-context]')).toContainText('当前页面：合成乙项目');await page.locator('[data-composer]').fill('仅讨论当前甲项目措辞');await page.locator('[data-a=send]').click();await expect.poll(()=>s.writes.filter(w=>w.path.endsWith('/messages')).length).toBe(1);const sent=s.writes.find(w=>w.path.endsWith('/messages'))!;expect(sent.path).toBe('/m4/topics/topic-a/messages');expect(sent.body.context.reading_artifact).toEqual(s.pin);expect(s.writes.some(w=>w.path.includes('execute'))).toBe(false);
});
test('unavailable page names can retry; late reads cannot restore an obsolete handoff',async({page})=>{
 const s=await setup(page);let release!:()=>void;await page.route('**/api/v1/projects/b',async route=>{await new Promise<void>(resolve=>release=resolve);await route.fulfill({json:s.projects.b});});await page.evaluate(()=>location.hash='#qa?project=b');await expect(page.locator('[data-page-context]')).toContainText('正在核对');await page.evaluate(()=>location.hash='#tasks');release();await expect(page.locator('[data-page-context]')).toBeEmpty();await expect(page.locator('[data-composer]')).toBeEnabled();
 await page.unroute('**/api/v1/projects/b');await page.route('**/api/v1/projects/b',route=>route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE'}}));await page.evaluate(()=>location.hash='#qa?project=b');await expect(page.locator('[data-page-context]')).toContainText('暂不可核实');await expect(page.locator('[data-a=current-project]')).toHaveCount(0);await page.unroute('**/api/v1/projects/b');await page.getByRole('button',{name:'重新读取页面项目'}).click();await expect(page.locator('[data-a=current-project]')).toHaveText('为“合成乙项目”开新对话');expect(s.writes.filter(w=>w.path==='/m4/topics')).toHaveLength(0);
});
