import {expect,test,type Page,type Route} from '@playwright/test';
import type {Dto} from '../src/api';
import {
  installSupplementHttp,mountSupplementSurface,supplementFixture,supplementHash,supplementIds,supplementNow,
  type SupplementFixture,type SupplementSurface,
} from './run-supplement-fixture';

// Real desktop components with synthetic HTTP authority; no database, model or billing acceptance.
type Surface=Exclude<SupplementSurface,'panel'>;
type RequestRecord={method:string;path:string};
const runPath=`/runs/${supplementIds.run}`;
const currentPath=`${runPath}/supplement-adoptions/current`;
const projectPath=`/projects/${supplementIds.project}`;
const localKeys=[
  `bondbuddy:run-supplement-adoption:v1:${supplementIds.owner}:${supplementIds.project}:${supplementIds.run}`,
  `bondbuddy:run-supplement:v1:${supplementIds.owner}:${supplementIds.project}:${supplementIds.run}`,
];
const panel=(page:Page)=>page.locator(`[data-run-supplement="${supplementIds.run}"]`);
const retry=(page:Page)=>panel(page).getByRole('button',{name:'重新核对任务采用状态',exact:true});
const resume=(page:Page,surface:Surface)=>surface==='m1'?page.locator('#resume-run'):
  surface==='m3'?page.locator('#review-making-panel [data-review-action="resume"]'):
    page.locator(`[data-m4-action="resume"][data-run="${supplementIds.run}"]`);
const json=(route:Route,body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});

async function installCurrent(page:Page,s:SupplementFixture){
  s.failLatestReads=true; // Any accidental read of the retired V1 draft is recorded and fails with 503.
  const adoption:Dto<'RunSupplementAdoptionResponse'>={adoption:{
    adoption_id:'server-current-adoption',request_id:'server-adopt-request',project_id:s.project.project_id,run_id:s.run.run_id,
    job_id:'server-supplement-job',execution_version:2,input_revision:8,input_hash:supplementHash('server-adopted-input'),
    quote_id:'server-confirmed-quote',confirmation_id:'server-confirmation',quote_hash:supplementHash('server-confirmed-quote'),
    adopted_at:supplementNow,assignment_kind:'rework',additional_points:4500,billing_segment_id:'server-rework-fee',reservation_id:'server-rework-fee',
  }};
  await page.addInitScript(keys=>{for(const key of keys)localStorage.removeItem(key);},localKeys);
  await installSupplementHttp(page,s);
  const server={unavailable:false,requests:[] as RequestRecord[],dialogs:[] as string[]};
  page.on('dialog',dialog=>{server.dialogs.push(dialog.message());void dialog.dismiss();});
  await page.context().route('**/api/v1/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1','');
    server.requests.push({method:request.method(),path});
    if(path===currentPath&&request.method()==='GET')return server.unavailable?
      json(route,{code:'DATA_UNAVAILABLE'},503):json(route,adoption);
    return route.fallback();
  });
  return server;
}
type CurrentServer=Awaited<ReturnType<typeof installCurrent>>;

async function expectNoLocalJournal(page:Page){
  expect(await page.evaluate(keys=>keys.map(key=>localStorage.getItem(key)),localKeys)).toEqual([null,null]);
}
async function expectNoNewConsent(page:Page,s:SupplementFixture,server:CurrentServer){
  expect(server.requests.filter(r=>r.method!=='GET'&&/\/supplement-(quotes|adoptions)(?:\/|$)/.test(r.path))).toEqual([]);
  expect(s.reads).toEqual([]);expect(s.saves).toEqual([]);expect(s.uploads).toEqual([]);expect(s.byteWrites).toBe(0);
  expect(s.unexpectedMutations).toEqual([]);expect(server.dialogs).toEqual([]);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectNoLocalJournal(page);
}
async function expectAdopted(page:Page,surface:Surface){
  await expect(panel(page).locator('[data-supplement-adoption]')).toContainText('补料已采用');
  await expect(panel(page).locator('[data-supplement-adoption]')).toContainText('追加 4500 积分');
  await expect(resume(page,surface)).toHaveText('继续当前任务');
  await expect(resume(page,surface)).toBeEnabled();
}
async function resumeOnce(page:Page,surface:Surface,s:SupplementFixture,server:CurrentServer){
  const offset=server.requests.length;
  await resume(page,surface).click();await expect.poll(()=>s.controls).toEqual(['resume']);
  const requests=server.requests.slice(offset),post=requests.findIndex(r=>r.method==='POST'&&r.path===`${runPath}/resume`);
  expect(post).toBeGreaterThan(-1);
  for(const path of [currentPath,runPath,projectPath]){
    const read=requests.findIndex(r=>r.method==='GET'&&r.path===path);
    expect(read,`GET ${path} must verify the adopted execution before resume`).toBeGreaterThan(-1);
    expect(read).toBeLessThan(post);
  }
  expect(requests.filter(r=>r.method==='POST'&&r.path===`${runPath}/resume`)).toHaveLength(1);
  expect(s.run.state).toBe('running');await expectNoNewConsent(page,s,server);
}

for(const surface of ['m1','m3','m4'] as const)test(`desktop ${surface}: server-adopted paused execution resumes without either local journal or the retired draft`,async({page})=>{
  const s=supplementFixture(),server=await installCurrent(page,s);
  await mountSupplementSurface(page,s,surface);await expectAdopted(page,surface);
  expect(server.requests.some(r=>r.method==='GET'&&r.path===currentPath)).toBe(true);
  expect(s.controls).toEqual([]);await expectNoNewConsent(page,s,server);
  await resumeOnce(page,surface,s,server);
});

test('desktop M3: an unavailable current-adoption read blocks resume and an explicit read-only retry recovers it',async({page})=>{
  const s=supplementFixture(),server=await installCurrent(page,s);server.unavailable=true;
  await mountSupplementSurface(page,s,'m3');await expect(retry(page)).toBeEnabled();
  await expect(panel(page)).toContainText('当前补料采用状态尚未核实');
  const button=resume(page,'m3');if(await button.isEnabled())await button.click();
  expect(s.controls).toEqual([]);expect(s.run.state).toBe('paused');await expectNoNewConsent(page,s,server);
  const priorReads=server.requests.filter(r=>r.path===currentPath).length;server.unavailable=false;
  await retry(page).click();await expectAdopted(page,'m3');
  expect(server.requests.filter(r=>r.path===currentPath).length).toBeGreaterThan(priorReads);
  expect(s.controls).toEqual([]);await expectNoNewConsent(page,s,server);
  await resumeOnce(page,'m3',s,server);
});

test('desktop M4: current-adoption failure during resume verification requires a fresh read before ordinary resume',async({page})=>{
  const s=supplementFixture(),server=await installCurrent(page,s);
  await mountSupplementSurface(page,s,'m4');await expectAdopted(page,'m4');server.unavailable=true;
  const offset=server.requests.length;await resume(page,'m4').click();await expect(retry(page)).toBeEnabled();
  expect(server.requests.slice(offset).some(r=>r.method==='GET'&&r.path===currentPath)).toBe(true);
  expect(s.controls).toEqual([]);expect(s.run.state).toBe('paused');await expectNoNewConsent(page,s,server);
  server.unavailable=false;await retry(page).click();await expectAdopted(page,'m4');
  expect(s.controls).toEqual([]);await resumeOnce(page,'m4',s,server);
});

test('desktop M1: a server-adopted running execution can withdraw its pending pause without new consent',async({page})=>{
  const s=supplementFixture();s.run.state='running';s.run.stage='model_generation';s.charge.progress!.pause_requested=true;
  const server=await installCurrent(page,s);await mountSupplementSurface(page,s,'m1');
  // The running surface creates its supplement panel lazily on the existing resume action.
  await expect(resume(page,'m1')).toBeEnabled();
  await resumeOnce(page,'m1',s,server);
});
