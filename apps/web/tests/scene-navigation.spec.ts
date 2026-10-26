import {expect,test,type Page} from '@playwright/test';
import {INTEGRITY_PRICE,PROJECT_DOCUMENT_CATALOG,type IntegrityWorkspace} from '@bondbuddy/contracts';

import {fixture as qaFixture,install as installQa,projectId as qaExecution,otherProjectId as qaOriginal,answerId as qaAnswer,assertFixture as assertQa,checked} from './project-qa-continuation-fixtures';

// Synthetic HTTP fixtures isolate navigation; no payment, document generation or external lookup runs.
const original='scene-original',execution='scene-execution',now='2026-10-25T04:00:00Z',sha='a'.repeat(64);
async function fixture(page:Page){
  const calls:{path:string;method:string;body:unknown}[]=[];
  const subjects=[{id:'issuer',kind:'company' as const,name:'合成发行人',identifier:'',role:'发行人',province:'河北',city:'沧州'}],draft={subjects,site_ids:['tax'],notes:''};
  const integrity:IntegrityWorkspace={draft,revision:1,price:INTEGRITY_PRICE,rounds:[{run_id:'check-1',round_id:'check-1',operation:'check',sequence:1,state:'succeeded',stage:null,created_at:now,manifest:{version:'integrity-round-v1',operation:'check',round_id:'check-1',project_name:'执行工作区',draft,price_version:INTEGRITY_PRICE.version,points:5000,records:[],evidence_ids:[]},records:[],evidence:[],artifact_id:null,artifacts:[],charged_points:5000,reserved_points:0}]};
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname.replace('/api/v1',''),method=req.method(),body=req.postData()?req.postDataJSON():undefined;calls.push({path,method,body});
    const json=(value:unknown)=>route.fulfill({json:value});
    if(path==='/me')return json({user_id:'scene-owner',session_status:'active'});
    if(path==='/account')return json({user_id:'scene-owner',username:'sample_user',phone_masked:null,status:'active',created_at:now,accepted_terms_version:null,current_terms_version:null,password_updated_at:null,self_service_recovery:'unavailable',support_contact:null});
    if(path==='/credits/balance')return json({enabled:true,available:20000,frozen:0});
    if(path===`/projects/${execution}`||path===`/projects/${original}`)return json({project_id:path.split('/').at(-1),name:path.endsWith(original)?'原债券项目':'执行工作区',kind:'generation',issuer_name:'合成发行人',market:'sse',offering:'private',draft_revision:1,input_revision:null,input_hash:null,updated_at:now});
    if(path===`/projects/${execution}/integrity`){checked('IntegrityWorkspaceResponse',integrity);return json(integrity);}
    if(path===`/projects/${execution}/integrity/runs/check-1/exports`){checked('IntegrityExportRequest',body);const check=integrity.rounds.find(round=>round.run_id==='check-1')!;integrity.rounds.unshift({...structuredClone(check),run_id:'export-2',operation:'export',sequence:2,charged_points:0,manifest:{...structuredClone(check.manifest),operation:'export',points:0,records:structuredClone(check.records),evidence_ids:check.evidence.map(item=>item.id)}});return json({run_id:'export-2'});}
    if(path===`/projects/${execution}/project-files/workspace`)return json({project_id:execution,source:{project_id:execution,version_id:'source-v1',sequence:1,filename:'募集说明书.docx',selection_revision:1,asset:{kind:'material',pin:{source_project_id:execution,material_id:'source',material_version:1,sha256:sha}}},workspace:{topic:{topic_id:'file-topic',project_id:'file-execution'},drafts:Object.fromEntries(PROJECT_DOCUMENT_CATALOG.map(d=>[d.id,{template:null}])),tasks:[]},files:[],batches:[{batch_id:'files-1',state:'complete',items:[{document_type:'issuer',run_id:'file-task',state:'succeeded',error:null}]}]});
    return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
  });
  return {calls};
}
async function expectScope(page:Page,work:string,run:string|null,apiProject=execution,returnProject=original){
  await expect.poll(()=>page.evaluate(()=>{const [path,search]=location.hash.split('?'),query=new URLSearchParams(search);return {path,project:query.get('project'),original:query.get('return_project'),run:query.get('run')};})).toEqual({path:'#'+work,project:apiProject,original:returnProject,run});
  await expect(page.locator('[data-project-context-name]')).toHaveText('原债券项目');
}

test('scene navigation keeps the original project through QA history and next-round preparation',async({page})=>{
  const state=qaFixture();state.otherProject.name='原债券项目';await installQa(page,state);await page.goto(`/#qa?project=${qaExecution}&run=${qaAnswer}&return_project=${qaOriginal}`);
  await expect(page.locator('#qa-continue')).toBeVisible();
  await expect(page.getByRole('link',{name:'项目文件 →'})).toHaveAttribute('href',`#/projects/${qaOriginal}/files?folder=4.2`);
  await page.locator('#qa-continue').click();await expectScope(page,'qa',null,qaExecution,qaOriginal);
  await expect(page.locator('#qa-requirements')).toBeVisible();
  await page.locator('#qa-history').selectOption(qaAnswer);await expectScope(page,'qa',qaAnswer,qaExecution,qaOriginal);
  expect(state.calls.filter(c=>c.method==='POST')).toEqual([]);await assertQa(page);
});

test('scene navigation keeps integrity history and free exports in the original project',async({page})=>{
  const state=await fixture(page);await page.goto(`/#integrity?project=${execution}&run=check-1&return_project=${original}`);
  await expect(page.getByRole('link',{name:'项目文件 →'})).toHaveAttribute('href',`#/projects/${original}/files`);
  await page.getByRole('button',{name:'重新导出底稿 · 免费'}).click();await expect(page.locator('#integrity-export-free-confirm')).toBeVisible();await expectScope(page,'integrity','check-1');expect(state.calls.filter(c=>c.method==='POST')).toEqual([]);
  await page.locator('#integrity-export-free-confirm').click();await expectScope(page,'integrity','export-2');
  await page.getByRole('link',{name:'返回名单与历史'}).click();await expectScope(page,'integrity',null);
  await page.locator('.integrity-history').filter({hasText:'第 1 次任务'}).click();await expectScope(page,'integrity','check-1');
  expect(state.calls.filter(c=>c.method==='POST').map(c=>c.path)).toEqual([`/projects/${execution}/integrity/runs/check-1/exports`]);
  expect(state.calls.find(c=>c.method==='POST')!.body).toEqual({request_id:expect.any(String),expected_evidence_ids:[]});
});

test('scene navigation carries project context from generated files to their exact topic task',async({page})=>{
  await fixture(page);await page.goto(`/#generate?project=${execution}&step=results&return_project=${original}`);
  const href=await page.getByRole('link',{name:'查看任务',exact:true}).getAttribute('href'),query=new URLSearchParams(href!.split('?')[1]);
  expect(query.get('topic')).toBe('file-topic');expect(query.get('run')).toBe('file-task');expect(query.get('return_project')).toBe(original);expect(query.get('project')).toBeNull();
  await expect(page.getByRole('link',{name:'查看项目文件',exact:true})).toHaveAttribute('href',`#/projects/${original}/files`);
  const next=await page.getByRole('link',{name:'准备下一轮文件'}).getAttribute('href');
  expect(new URLSearchParams(next!.split('?')[1]).get('project')).toBe(execution);expect(new URLSearchParams(next!.split('?')[1]).get('return_project')).toBe(original);
  const check=await page.getByRole('link',{name:'检查文件一致性',exact:true}).getAttribute('href');
  expect(new URLSearchParams(check!.split('?')[1]).get('project')).toBe(execution);expect(new URLSearchParams(check!.split('?')[1]).get('return_project')).toBe(original);
});
