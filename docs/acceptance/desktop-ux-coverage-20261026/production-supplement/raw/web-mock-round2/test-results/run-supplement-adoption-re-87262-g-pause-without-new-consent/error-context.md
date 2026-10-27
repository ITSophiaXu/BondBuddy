# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: run-supplement-adoption-resume.spec.ts >> desktop M1: a server-adopted running execution can withdraw its pending pause without new consent
- Location: tests\run-supplement-adoption-resume.spec.ts:110:1

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('[data-run-supplement="supplement-run"]').locator('[data-supplement-adoption]')
Expected substring: "补料已采用"
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toContainText" locator('[data-run-supplement="supplement-run"]').locator('[data-supplement-adoption]') with timeout 5000ms
  - waiting for locator('[data-run-supplement="supplement-run"]').locator('[data-supplement-adoption]')

```

```yaml
- main:
  - group:
    - text: 募集书全文更新
    - region "编制进度":
      - status: 正在保存进度后暂停
      - paragraph: 积分已冻结。当前模型处理结果保存后暂停，继续时会复用已保存的结果。
      - list "处理流程":
        - listitem: 1 等待开始
        - listitem: 2 准备材料
        - listitem: 3 编制募集书
        - listitem: 4 保存文档
        - listitem: 5 可下载
      - paragraph: 关闭页面后任务仍会继续，重新打开可查看最新进度。
    - region "积分消耗":
      - text: 当前已消耗
      - status: 1,200 积分
      - text: 可用余额 10,000 积分 有效处理 1分00秒 积分已冻结，继续处理后再累计。
      - group: 计费说明
    - paragraph: 关闭页面不会取消任务。编制开始后材料已锁定，仅可查看。
    - button "停止本次任务"
    - button "继续本次任务"
    - button "查看材料"
  - status
  - status: 已有任务正在处理，请查看上方进度。
  - button "重新读取"
  - button "开始更新" [disabled]
```

# Test source

```ts
  1   | import {expect,test,type Page,type Route} from '@playwright/test';
  2   | import type {Dto} from '../src/api';
  3   | import {
  4   |   installSupplementHttp,mountSupplementSurface,supplementFixture,supplementHash,supplementIds,supplementNow,
  5   |   type SupplementFixture,type SupplementSurface,
  6   | } from './run-supplement-fixture';
  7   | 
  8   | // Real desktop components with synthetic HTTP authority; no database, model or billing acceptance.
  9   | type Surface=Exclude<SupplementSurface,'panel'>;
  10  | type RequestRecord={method:string;path:string};
  11  | const runPath=`/runs/${supplementIds.run}`;
  12  | const currentPath=`${runPath}/supplement-adoptions/current`;
  13  | const projectPath=`/projects/${supplementIds.project}`;
  14  | const localKeys=[
  15  |   `bondbuddy:run-supplement-adoption:v1:${supplementIds.owner}:${supplementIds.project}:${supplementIds.run}`,
  16  |   `bondbuddy:run-supplement:v1:${supplementIds.owner}:${supplementIds.project}:${supplementIds.run}`,
  17  | ];
  18  | const panel=(page:Page)=>page.locator(`[data-run-supplement="${supplementIds.run}"]`);
  19  | const retry=(page:Page)=>panel(page).getByRole('button',{name:'重新核对任务采用状态',exact:true});
  20  | const resume=(page:Page,surface:Surface)=>surface==='m1'?page.locator('#resume-run'):
  21  |   surface==='m3'?page.locator('#review-making-panel [data-review-action="resume"]'):
  22  |     page.locator(`[data-m4-action="resume"][data-run="${supplementIds.run}"]`);
  23  | const json=(route:Route,body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  24  | 
  25  | async function installCurrent(page:Page,s:SupplementFixture){
  26  |   s.failLatestReads=true; // Any accidental read of the retired V1 draft is recorded and fails with 503.
  27  |   const adoption:Dto<'RunSupplementAdoptionResponse'>={adoption:{
  28  |     adoption_id:'server-current-adoption',request_id:'server-adopt-request',project_id:s.project.project_id,run_id:s.run.run_id,
  29  |     job_id:'server-supplement-job',execution_version:2,input_revision:8,input_hash:supplementHash('server-adopted-input'),
  30  |     quote_id:'server-confirmed-quote',confirmation_id:'server-confirmation',quote_hash:supplementHash('server-confirmed-quote'),
  31  |     adopted_at:supplementNow,assignment_kind:'rework',additional_points:4500,billing_segment_id:'server-rework-fee',reservation_id:'server-rework-fee',
  32  |   }};
  33  |   await page.addInitScript(keys=>{for(const key of keys)localStorage.removeItem(key);},localKeys);
  34  |   await installSupplementHttp(page,s);
  35  |   const server={unavailable:false,requests:[] as RequestRecord[],dialogs:[] as string[]};
  36  |   page.on('dialog',dialog=>{server.dialogs.push(dialog.message());void dialog.dismiss();});
  37  |   await page.context().route('**/api/v1/**',async route=>{
  38  |     const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1','');
  39  |     server.requests.push({method:request.method(),path});
  40  |     if(path===currentPath&&request.method()==='GET')return server.unavailable?
  41  |       json(route,{code:'DATA_UNAVAILABLE'},503):json(route,adoption);
  42  |     return route.fallback();
  43  |   });
  44  |   return server;
  45  | }
  46  | type CurrentServer=Awaited<ReturnType<typeof installCurrent>>;
  47  | 
  48  | async function expectNoLocalJournal(page:Page){
  49  |   expect(await page.evaluate(keys=>keys.map(key=>localStorage.getItem(key)),localKeys)).toEqual([null,null]);
  50  | }
  51  | async function expectNoNewConsent(page:Page,s:SupplementFixture,server:CurrentServer){
  52  |   expect(server.requests.filter(r=>r.method!=='GET'&&/\/supplement-(quotes|adoptions)(?:\/|$)/.test(r.path))).toEqual([]);
  53  |   expect(s.reads).toEqual([]);expect(s.saves).toEqual([]);expect(s.uploads).toEqual([]);expect(s.byteWrites).toBe(0);
  54  |   expect(s.unexpectedMutations).toEqual([]);expect(server.dialogs).toEqual([]);
  55  |   await expect(page.locator('dialog[open]')).toHaveCount(0);
  56  |   await expect(page.getByRole('dialog')).toHaveCount(0);
  57  |   await expectNoLocalJournal(page);
  58  | }
  59  | async function expectAdopted(page:Page,surface:Surface){
> 60  |   await expect(panel(page).locator('[data-supplement-adoption]')).toContainText('补料已采用');
      |                                                                   ^ Error: expect(locator).toContainText(expected) failed
  61  |   await expect(panel(page).locator('[data-supplement-adoption]')).toContainText('追加 4500 积分');
  62  |   await expect(resume(page,surface)).toHaveText('继续当前任务');
  63  |   await expect(resume(page,surface)).toBeEnabled();
  64  | }
  65  | async function resumeOnce(page:Page,surface:Surface,s:SupplementFixture,server:CurrentServer){
  66  |   const offset=server.requests.length;
  67  |   await resume(page,surface).click();await expect.poll(()=>s.controls).toEqual(['resume']);
  68  |   const requests=server.requests.slice(offset),post=requests.findIndex(r=>r.method==='POST'&&r.path===`${runPath}/resume`);
  69  |   expect(post).toBeGreaterThan(-1);
  70  |   for(const path of [currentPath,runPath,projectPath]){
  71  |     const read=requests.findIndex(r=>r.method==='GET'&&r.path===path);
  72  |     expect(read,`GET ${path} must verify the adopted execution before resume`).toBeGreaterThan(-1);
  73  |     expect(read).toBeLessThan(post);
  74  |   }
  75  |   expect(requests.filter(r=>r.method==='POST'&&r.path===`${runPath}/resume`)).toHaveLength(1);
  76  |   expect(s.run.state).toBe('running');await expectNoNewConsent(page,s,server);
  77  | }
  78  | 
  79  | for(const surface of ['m1','m3','m4'] as const)test(`desktop ${surface}: server-adopted paused execution resumes without either local journal or the retired draft`,async({page})=>{
  80  |   const s=supplementFixture(),server=await installCurrent(page,s);
  81  |   await mountSupplementSurface(page,s,surface);await expectAdopted(page,surface);
  82  |   expect(server.requests.some(r=>r.method==='GET'&&r.path===currentPath)).toBe(true);
  83  |   expect(s.controls).toEqual([]);await expectNoNewConsent(page,s,server);
  84  |   await resumeOnce(page,surface,s,server);
  85  | });
  86  | 
  87  | test('desktop M3: an unavailable current-adoption read blocks resume and an explicit read-only retry recovers it',async({page})=>{
  88  |   const s=supplementFixture(),server=await installCurrent(page,s);server.unavailable=true;
  89  |   await mountSupplementSurface(page,s,'m3');await expect(retry(page)).toBeEnabled();
  90  |   await expect(panel(page)).toContainText('当前补料采用状态尚未核实');
  91  |   const button=resume(page,'m3');if(await button.isEnabled())await button.click();
  92  |   expect(s.controls).toEqual([]);expect(s.run.state).toBe('paused');await expectNoNewConsent(page,s,server);
  93  |   const priorReads=server.requests.filter(r=>r.path===currentPath).length;server.unavailable=false;
  94  |   await retry(page).click();await expectAdopted(page,'m3');
  95  |   expect(server.requests.filter(r=>r.path===currentPath).length).toBeGreaterThan(priorReads);
  96  |   expect(s.controls).toEqual([]);await expectNoNewConsent(page,s,server);
  97  |   await resumeOnce(page,'m3',s,server);
  98  | });
  99  | 
  100 | test('desktop M4: current-adoption failure during resume verification requires a fresh read before ordinary resume',async({page})=>{
  101 |   const s=supplementFixture(),server=await installCurrent(page,s);
  102 |   await mountSupplementSurface(page,s,'m4');await expectAdopted(page,'m4');server.unavailable=true;
  103 |   const offset=server.requests.length;await resume(page,'m4').click();await expect(retry(page)).toBeEnabled();
  104 |   expect(server.requests.slice(offset).some(r=>r.method==='GET'&&r.path===currentPath)).toBe(true);
  105 |   expect(s.controls).toEqual([]);expect(s.run.state).toBe('paused');await expectNoNewConsent(page,s,server);
  106 |   server.unavailable=false;await retry(page).click();await expectAdopted(page,'m4');
  107 |   expect(s.controls).toEqual([]);await resumeOnce(page,'m4',s,server);
  108 | });
  109 | 
  110 | test('desktop M1: a server-adopted running execution can withdraw its pending pause without new consent',async({page})=>{
  111 |   const s=supplementFixture();s.run.state='running';s.run.stage='model_generation';s.charge.progress!.pause_requested=true;
  112 |   const server=await installCurrent(page,s);await mountSupplementSurface(page,s,'m1');await expectAdopted(page,'m1');
  113 |   await resumeOnce(page,'m1',s,server);
  114 | });
  115 | 
```