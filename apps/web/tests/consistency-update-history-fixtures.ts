import {serveDisabledBillingCatalog} from './billing-fixture-wire';
import {expect,type Page} from '@playwright/test';
import {Value} from '@sinclair/typebox/value';
import {ProjectFileCheckSchema,type ProjectFileCheck} from '@bondbuddy/contracts';
import {assertFixture,base,fixture,ids,install,serverSnapshot,writes,type Options} from './consistency-task-fixtures';

export {assertFixture,base,ids,serverSnapshot,writes};
export const individualPath=base+'/updates/'+ids.oldRun+'/check';
export function historyFixture(options:Options={}){
  const s=fixture(options),oldCheck=s.checks.find(check=>check.run_id===ids.oldCheck)!;
  const recent=Array.from({length:30},(_,index):ProjectFileCheck=>{
    const check=structuredClone(s.checks.find(check=>check.run_id===ids.newCheck)??oldCheck);
    check.run_id='update-history-recent-'+index;check.created_at=new Date(Date.UTC(2026,9,26,0,29-index)).toISOString();
    // This projection contains the recent checks, while their unrelated later
    // acceptances do not become acceptances of the requested historical run.
    check.updates=check.updates.filter(update=>update.run_id!==ids.oldRun);
    return check;
  });
  s.checks=[...recent,oldCheck];
  return Object.assign(s,{oldCheck,recent,individualReads:[] as string[],individualStatus:200,individualPayload:undefined as unknown});
}
export type HistoryState=ReturnType<typeof historyFixture>;

export async function mount(page:Page,s=historyFixture()){
  await page.setViewportSize({width:1440,height:960});await install(page,s);
  await page.route('**/api/v1/**',async route=>{
    if(await serveDisabledBillingCatalog(route))return;
    const request=route.request(),url=new URL(request.url()),path=url.pathname.slice('/api/v1'.length);
    if(request.method()!=='GET'||path!==base+'/checks'&&path!==individualPath)return route.fallback();
    s.calls.push({method:'GET',path,search:url.search,body:null});
    if(path===base+'/checks'){s.checkReads++;return route.fulfill({status:200,json:{checks:s.recent}});}
    s.individualReads.push(path);
    if(s.individualStatus!==200)return route.fulfill({status:s.individualStatus,json:{code:s.individualStatus===404?'NOT_FOUND':s.individualStatus===403?'FORBIDDEN':'DATA_UNAVAILABLE',
      message:'Synthetic historical update read failed',retryable:s.individualStatus>=500,correlation_id:'synthetic-update-history',field_errors:[]}});
    return route.fulfill({status:200,json:s.individualPayload===undefined?{check:s.oldCheck}:s.individualPayload});
  });
  return s;
}
export async function open(page:Page,s=historyFixture(),query='update_run='+ids.oldRun){
  await mount(page,s);await page.goto('/#consistency?project='+ids.root+'&'+query);return s;
}
export async function openHistoryTask(page:Page,s:HistoryState,entry:'projects'|'files'){
  await mount(page,s);await page.goto(entry==='projects'?'/#tasks':'/#/projects/'+ids.root+'/files');
  const link=entry==='projects'?page.locator('[data-run-id="'+ids.oldRun+'"] a'):page.locator('#pw-task-summary a[href*="'+ids.oldRun+'"]');
  if(entry==='projects'){
    const expand=page.locator(`[data-tasks="${ids.root}"]`);
    await expect(expand).toBeVisible();await expand.click();
  }
  await expect(link).toBeVisible();await expect(link).toHaveAttribute('href',new RegExp('project='+ids.root+'&update_run='+ids.oldRun+'(?:&|$)'));await link.click();
}
export async function readonly(page:Page,s:HistoryState,before?:ReturnType<typeof serverSnapshot>){
  expect(writes(s)).toEqual([]);expect(s.runActions).toEqual([]);expect(s.updatePosts).toEqual([]);
  if(before)expect(serverSnapshot(s)).toEqual(before);
  for(const check of s.checks)expect(Value.Check(ProjectFileCheckSchema,check)).toBe(true);
  await assertFixture(page,s);
}
