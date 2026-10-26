import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,test,type Page} from '@playwright/test';
import {Value} from '@sinclair/typebox/value';
import {ProjectFileCheckSchema,type ProjectFileCheck} from '@bondbuddy/contracts';
import {assertFixture,base,checkId,checkRoute,fixture,ids,install,replaceSource,writeCalls} from './consistency-originals-fixtures';

// Desktop-only synthetic HTTP journeys through the real application. These do
// not call a worker, ledger, model, storage service or external Word client.
const checkPath=base+'/project-files/checks';
const evidence=process.env.BB_CONSISTENCY_HISTORY_EVIDENCE_DIR;
test.beforeEach(()=>test.skip(process.env.BB_CONSISTENCY_HISTORY_BASELINE==='1','The baseline collector runs against the unchanged previously published application.'));
const row=(page:Page)=>page.locator('[data-fc-result-version="'+ids.version+'"]');
const context=(page:Page)=>page.locator('#pw-file-context');
const failure=(status:number)=>({code:status===404?'NOT_FOUND':status===403?'FORBIDDEN':'DATA_UNAVAILABLE',message:'合成指定检查读取失败',retryable:status>=500,correlation_id:'synthetic-history',field_errors:[]});
function historyFixture(){
  const s=fixture({historical:true});replaceSource(s);
  s.check.created_at='2026-09-01T01:00:00Z';
  s.check.result!.files[0].findings[0].reason='合成第31轮之外的原始检查，准确历史说明。';
  const recent=Array.from({length:30},(_,index):ProjectFileCheck=>{
    const c=structuredClone(s.check);c.run_id='synthetic-history-recent-'+index;c.created_at=new Date(Date.UTC(2026,9,25,12,index)).toISOString();
    c.source=structuredClone(s.source);c.stale=false;
    c.files.forEach(f=>{f.filename='近期检查'+index+'_'+f.filename;});
    c.result!.files.forEach(f=>f.findings.forEach(item=>{item.reason='合成最近30轮说明 '+index;}));
    return c;
  });
  s.checks=[...recent,s.check];
  return Object.assign(s,{recent,singleReads:[] as string[],singleStatus:200,response:undefined as ProjectFileCheck|undefined});
}
type State=ReturnType<typeof historyFixture>;
async function mount(page:Page,s=historyFixture()){
  await page.setViewportSize({width:1440,height:960});await install(page,s);
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.slice('/api/v1'.length);
    if(request.method()!=='GET'||path!==checkPath&&!path.startsWith(checkPath+'/'))return route.fallback();
    s.calls.push({owner:s.owner,method:'GET',path,search:url.search,body:null});
    if(path===checkPath)return route.fulfill({status:200,json:{checks:s.recent}});
    const requested=decodeURIComponent(path.slice(checkPath.length+1));s.singleReads.push(requested);
    if(s.singleStatus!==200)return route.fulfill({status:s.singleStatus,json:failure(s.singleStatus)});
    return route.fulfill({status:200,json:{check:s.response??s.check}});
  });return s;
}
async function open(page:Page,s=historyFixture(),route=checkRoute()){
  await mount(page,s);await page.goto(route);return s;
}
function readonly(s:State){
  expect(writeCalls(s)).toEqual([]);expect(s.imports).toEqual([]);expect(s.executions).toEqual([]);expect(s.quotes).toEqual([]);
  expect(s.checkRequests).toEqual([]);expect(s.updatePosts).toEqual([]);assertFixture(s);
  for(const check of s.checks)expect(Value.Check(ProjectFileCheckSchema,check)).toBe(true);
}
async function oldShown(page:Page,s:State){
  await expect(page.locator('#fc-history')).toHaveValue(checkId);
  await expect(page.locator('.pf-source-strip strong')).toHaveText(s.check.source.filename);
  await expect(page.locator('.pf-source-strip')).toContainText('V'+s.check.source.sequence);
  await expect(row(page).locator('.pf-template-row strong')).toHaveText(s.check.files[0].filename);
  await expect(row(page)).toContainText('合成第31轮之外的原始检查，准确历史说明。');
}
async function capture(page:Page,name:string){if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,name+'.png')});}}

test('consistency history: an exact check beyond the recent thirty opens its pinned source and original file, then returns through the current family',async({page})=>{
  const s=await open(page);await oldShown(page,s);
  expect(s.singleReads).toEqual([checkId]);await expect(page.locator('#fc-history option')).toHaveCount(31);
  expect((await page.locator('#fc-history option').allTextContents()).some(label=>/^第\s*\d+\s*轮/.test(label))).toBe(false);
  await page.locator('.pf-source-strip').scrollIntoViewIfNeeded();await capture(page,'history-old-check-1440');
  const link=row(page).locator('.fc-manual-next a');await expect(link).toHaveCount(1);await link.click();
  await expect(context(page)).toContainText('检查时原文件');await expect(context(page)).toContainText('V1');await expect(context(page)).toContainText('V2');
  await expect(page.locator('.collection-file[data-file-family="'+ids.family+'"]')).toHaveAttribute('data-file-version',s.registry.find(v=>v.file_id===ids.family&&v.latest)!.version_id);
  await context(page).scrollIntoViewIfNeeded();await capture(page,'history-file-return-1440');
  const back=context(page).getByRole('link',{name:'返回原检查',exact:true});
  expect(new URLSearchParams((await back.getAttribute('href'))!.split('?')[1]).get('run')).toBe(checkId);
  await back.click();await oldShown(page,s);expect(s.singleReads).toEqual([checkId,checkId,checkId]);
  await expect(page.locator('dialog[open]')).toHaveCount(0);readonly(s);
});

test('consistency history: explicit refresh re-reads the old check and preserves its exact original while performing only GET requests',async({page})=>{
  const s=await open(page);await oldShown(page,s);const before=structuredClone(s.check);
  await page.locator('[data-fc-refresh]').click();await expect.poll(()=>s.singleReads.length).toBe(2);await oldShown(page,s);
  expect(s.check).toEqual(before);expect(s.calls.every(call=>call.method==='GET')).toBe(true);readonly(s);
});

test('consistency history: a failed poll keeps the last readable old running check and the next poll automatically recovers that same run',async({page})=>{
  const start=new Date('2026-10-26T04:00:00Z');await page.clock.install({time:start});await page.clock.pauseAt(new Date(start.getTime()+1000));
  const s=historyFixture(),result=structuredClone(s.check.result),sha=s.check.sha256;
  s.check.state='running';s.check.stage='file_check';s.check.result=null;s.check.sha256=null;
  await open(page,s);
  await expect(page.locator('#fc-history')).toHaveValue(checkId);await expect(page.locator('.fc-progress')).toBeVisible();
  await expect(page.locator('.pf-source-strip strong')).toHaveText(s.check.source.filename);expect(s.singleReads).toEqual([checkId]);
  s.singleStatus=503;await page.clock.runFor(4000);await expect.poll(()=>s.singleReads.length).toBe(2);
  const warning=page.locator('.fc-warning[role="status"]');
  await expect(warning).toBeVisible();await expect(warning).toContainText('当前显示上次读取的记录');await expect(warning).toContainText(/读取.*未成功|读取.*失败/);
  await expect(page.locator('#fc-history')).toHaveValue(checkId);await expect(page.locator('.fc-progress')).toBeVisible();
  await expect(page.locator('.pf-source-strip strong')).toHaveText(s.check.source.filename);
  await expect(page.getByRole('heading',{name:'指定的检查记录暂时无法读取',exact:true})).toHaveCount(0);
  expect(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('run')).toBe(checkId);
  s.singleStatus=200;s.check.state='succeeded';s.check.stage='completed';s.check.result=result;s.check.sha256=sha;
  await page.clock.runFor(4000);await expect.poll(()=>s.singleReads.length).toBe(3);await oldShown(page,s);
  await expect(page.locator('.fc-progress')).toHaveCount(0);await expect(warning).toHaveCount(0);expect(s.calls.every(call=>call.method==='GET')).toBe(true);readonly(s);
});

test('consistency history: a failed initial old-check read can be retried explicitly without creating a task or charge',async({page})=>{
  const s=historyFixture();s.singleStatus=503;await open(page,s);
  await expect(page.getByRole('heading',{name:'指定的检查记录暂时无法读取',exact:true})).toBeVisible();
  expect(s.singleReads).toEqual([checkId]);s.singleStatus=200;
  await page.getByRole('button',{name:'重新读取原检查',exact:true}).click();await oldShown(page,s);
  expect(s.singleReads).toEqual([checkId,checkId]);expect(s.calls.every(call=>call.method==='GET')).toBe(true);readonly(s);
});

test('consistency history: a requested check already in the recent list needs no individual read',async({page})=>{
  const s=historyFixture();s.recent=[s.check,...s.recent.slice(0,29)];await open(page,s);await oldShown(page,s);
  expect(s.singleReads).toEqual([]);await expect(page.locator('#fc-history option')).toHaveCount(30);readonly(s);
});

for(const status of [404,403,503])test('consistency history: HTTP '+status+' for the pinned check never shows the latest result instead',async({page})=>{
  const s=historyFixture();s.singleStatus=status;await open(page,s);
  await expect(page.getByRole('heading',{name:'指定的检查记录暂时无法读取',exact:true})).toBeVisible();
  await expect(page.locator('.fc-results')).toHaveCount(0);await expect(page.locator('[data-fc-result-version]')).toHaveCount(0);
  expect(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('run')).toBe(checkId);
  expect(s.singleReads).toEqual([checkId]);if(status===404)await capture(page,'history-missing-check-1440');readonly(s);
});

for(const status of [403,404])test('consistency history: HTTP '+status+' after an earlier successful read removes the old result instead of retaining its actions',async({page})=>{
  const s=await open(page);await oldShown(page,s);s.singleStatus=status;
  await page.locator('[data-fc-refresh]').click();
  await expect(page.getByRole('heading',{name:'指定的检查记录暂时无法读取',exact:true})).toBeVisible();
  await expect(page.locator('.fc-results')).toHaveCount(0);await expect(page.locator('[data-fc-result-version]')).toHaveCount(0);
  await expect(page.locator('[data-fc-control]')).toHaveCount(0);expect(s.singleReads).toEqual([checkId,checkId]);
  expect(s.calls.every(call=>call.method==='GET')).toBe(true);readonly(s);
});

for(const query of ['run=','run='+checkId+'&run=synthetic-other-check'])test('consistency history: ambiguous or empty '+query+' never requests another check',async({page})=>{
  const s=await open(page,historyFixture(),'/#consistency?project='+ids.root+'&'+query);
  await expect(page.getByRole('heading',{name:'指定的检查记录暂时无法读取',exact:true})).toBeVisible();
  await expect(page.locator('.fc-results')).toHaveCount(0);expect(s.singleReads).toEqual([]);readonly(s);
});

test('consistency history: a successful response for a different run is rejected without displaying any substituted result',async({page})=>{
  const s=historyFixture();s.response=structuredClone(s.recent[0]);await open(page,s);
  await expect(page.getByRole('heading',{name:'指定的检查记录暂时无法读取',exact:true})).toBeVisible();
  await expect(page.locator('.fc-results')).toHaveCount(0);expect(s.singleReads).toEqual([checkId]);readonly(s);
});

test('consistency history: latest view does not request an older record and has no invented absolute round numbers',async({page})=>{
  const s=await open(page,historyFixture(),'/#consistency?project='+ids.root);
  await expect(page.locator('#fc-history')).toHaveValue(s.recent[0].run_id);await expect(page.locator('.fc-results')).toBeVisible();
  await expect(page.locator('.pf-source-strip strong')).toHaveText(s.source.filename);
  expect((await page.locator('#fc-history option').allTextContents()).some(label=>/^第\s*\d+\s*轮/.test(label))).toBe(false);
  expect(s.singleReads).toEqual([]);readonly(s);
});
