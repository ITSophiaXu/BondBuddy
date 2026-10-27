# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: run-supplement-production-real-main.spec.ts >> real desktop review: saved Word work → browser B1 quote/consent/adoption → real successor worker → private new Word
- Location: tests\run-supplement-production-real-main.spec.ts:26:56

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator:  locator('[data-review-action="download"]').filter({ hasText: '复核报告' }).first()
Expected: visible
Received: hidden
Timeout:  20000ms

Call log:
  - Expect "toBeVisible" locator('[data-review-action="download"]').filter({ hasText: '复核报告' }).first() with timeout 20000ms
  - waiting for locator('[data-review-action="download"]').filter({ hasText: '复核报告' }).first()
    32 × locator resolved to <button class="btn secondary" data-review-action="download" data-artifact-id="word-7be7bef5b42dfcbdea16b6123a079620d397af145f319f3f0b792c96f260528b">下载复核报告（Word）</button>
       - unexpected value "hidden"

```

```yaml
- link "跳到主要内容":
  - /url: "#main"
- complementary:
  - link "bondbuddy BETA":
    - /url: "#tasks"
  - strong: 我的工作空间
  - text: PERSONAL WORKSPACE
  - navigation "主导航":
    - link "全部项目":
      - /url: "#tasks"
    - text: 继续这个项目
    - link "更新募集书":
      - /url: "#update?project=8a87ea3f-e8fd-4bfc-95fa-11a1fa151b54&from=projects&return_project=8a87ea3f-e8fd-4bfc-95fa-11a1fa151b54"
    - link "复核募集书":
      - /url: "#review?project=8a87ea3f-e8fd-4bfc-95fa-11a1fa151b54&from=projects&return_project=8a87ea3f-e8fd-4bfc-95fa-11a1fa151b54"
    - link "文件生成":
      - /url: "#generate?project=8a87ea3f-e8fd-4bfc-95fa-11a1fa151b54&from=projects&return_project=8a87ea3f-e8fd-4bfc-95fa-11a1fa151b54"
    - link "诚信核查":
      - /url: "#integrity?project=8a87ea3f-e8fd-4bfc-95fa-11a1fa151b54&from=projects&return_project=8a87ea3f-e8fd-4bfc-95fa-11a1fa151b54"
    - link "项目问答":
      - /url: "#qa?project=8a87ea3f-e8fd-4bfc-95fa-11a1fa151b54&from=projects&return_project=8a87ea3f-e8fd-4bfc-95fa-11a1fa151b54"
  - region "积分余额":
    - text: 积分余额
    - button "刷新积分余额": 刷新
    - strong: 4,586
    - link "查看积分与充值":
      - /url: "#/account?project=8a87ea3f-e8fd-4bfc-95fa-11a1fa151b54&return_project=8a87ea3f-e8fd-4bfc-95fa-11a1fa151b54&return_to=%23%2Fprojects%2F8a87ea3f-e8fd-4bfc-95fa-11a1fa151b54%2Freview%3Ftab%3Dmaking%26run%3D0cfec461-2045-4c2e-b79a-e2555a956334"
      - text: 充值
    - paragraph: 暂无预留积分
  - navigation "账号":
    - button "BondBuddy"
    - link "我的账号":
      - /url: "#/account?project=8a87ea3f-e8fd-4bfc-95fa-11a1fa151b54&return_project=8a87ea3f-e8fd-4bfc-95fa-11a1fa151b54&return_to=%23%2Fprojects%2F8a87ea3f-e8fd-4bfc-95fa-11a1fa151b54%2Freview%3Ftab%3Dmaking%26run%3D0cfec461-2045-4c2e-b79a-e2555a956334"
  - strong: supp_prep_e6fd1b22f1164fda
  - button "退出"
- banner: 工作空间 复核募集书 按任务使用积分
- main:
  - region "当前项目":
    - text: 正在处理
    - strong: Synthetic saved file preparation
    - link "返回本项目文件":
      - /url: "#/projects/8a87ea3f-e8fd-4bfc-95fa-11a1fa151b54/files"
  - strong: Synthetic saved file preparation
  - text: Frozen issuer 上交所 普通私募公司债
  - link "更换项目":
    - /url: "#review"
  - paragraph: PROSPECTUS REVIEW
  - heading "复核募集说明书" [level=1]
  - text: 已完成
  - paragraph: 提供复核材料和要求，复核数据一致性、勾稽、政策要求及格式标点，直接在原文留下修订与批注。
  - navigation "复核流程": ✓ 选择项目 2 材料与要求 3 复核结果
  - tablist "复核内容":
    - tab "材料与要求"
    - tab "复核结果"
    - tab "本轮任务" [selected]
  - tabpanel "本轮任务":
    - heading "本轮复核" [level=2]
    - paragraph: 财务数据 · 勾稽关系 · 政策重点提示 · 格式与标点
    - text: 第 1 轮
    - region "复核进度":
      - status: 本轮任务已完成
      - paragraph: 请结合已登记成果的实际覆盖与依据阅读结论。
      - list "处理流程":
        - listitem: 1 等待开始
        - listitem: 2 准备材料
        - listitem: 3 逐项复核
        - listitem: 4 保存文档
        - listitem: 5 可下载
    - region "积分消耗":
      - text: 本次已扣费
      - status: 4,500 积分
      - text: 可用余额 4,586 积分 有效处理 30秒 结算已完成。
      - group: 计费说明
    - button "查看复核结果"
    - button "准备新任务"
    - region "复核过程":
      - heading "复核过程" [level=3]
      - paragraph: 展示本轮已返回的处理状态，随复核自动更新。
      - list:
        - listitem:
          - time: 10:02:09
          - text: 等待处理
        - listitem:
          - time: 10:02:12
          - text: 准备本次材料
        - listitem:
          - time: 10:02:12
          - text: 读取材料
        - listitem:
          - time: 10:02:13
          - text: 准备复核请求
        - listitem:
          - time: 10:02:13
          - text: 正在复核募集书
        - listitem:
          - time: 10:02:17
          - text: 整理复核结果
    - region "本轮任务的补料准备":
      - heading "本轮任务补料" [level=3]
      - text: 已采用
      - paragraph: 本次补料采用已确认，请查看任务当前进度。
      - group: 查看本轮提交的原材料
      - text: 这份补料的用途
      - combobox "这份补料的用途" [disabled]:
        - option "新增材料" [selected]
        - option "替换：unchanged-first.docx · V1"
        - option "替换：replace-middle.docx · V1"
        - option "替换：unchanged-last.docx · V1"
      - text: 材料类别
      - combobox "材料类别" [disabled]:
        - option "本企业历史募集书"
        - option "相似企业参考募集书"
        - option "审计报告（可含报表及附注）"
        - option "年度财务报表"
        - option "最近一期财务报表"
        - option "财务报表附注"
        - option "财务科目明细与辅助账"
        - option "本期发行方案"
        - option "募集资金使用计划 / 项目方案"
        - option "项目可行性研究报告"
        - option "前次募集资金使用说明"
        - option "受托管理事务报告"
        - option "董事会 / 股东会决议"
        - option "工商及公司资料"
        - option "工商登记 / 企业信息公示材料"
        - option "征信报告"
        - option "诉讼、失信、处罚及信用核查"
        - option "发行人自查 / 专项说明"
        - option "评级报告（主体 / 债项 / 跟踪）"
        - option "法律意见书及其他法律文件"
        - option "债务明细与融资材料"
        - option "银行授信情况表"
        - option "银行授信证明材料"
        - option "存续及历史债券资料"
        - option "本期增信 / 担保合同"
        - option "担保人财务、评级及资质材料"
        - option "抵质押资产资料"
        - option "业务经营资料"
        - option "章程、治理制度与组织架构"
        - option "董监高及其他人员资料"
        - option "行业研究 / 行业统计资料"
        - option "其他材料" [selected]
      - text: 添加并保存文件
      - button "添加并保存文件" [disabled]
      - heading "补料选择" [level=4]
      - list:
        - listitem:
          - strong: added.docx · V1
          - text: 拟新增材料 · 已采用
          - button "移除补料选择" [disabled]
        - listitem:
          - strong: replacement.docx · V2
          - text: 拟替换原材料：replace-middle.docx · V1 · 已采用
          - button "移除补料选择" [disabled]
        - listitem:
          - strong: synthetic-review-browser-evidence.txt · V1
          - text: 拟新增材料 · 已采用
          - button "移除补料选择" [disabled]
      - paragraph: 草稿已保存 · 2026年10月27日 10:02 · V2 · 已采用
      - button "保存补料草稿" [disabled]
      - button "重新读取补料"
      - paragraph: 本次补料已采用；采用记录和当前任务进度可继续核对。
      - heading "已保存工作记录" [level=4]
      - paragraph: 已关联 1 项已保存处理结果。继续前核对可复用文件。
      - heading "补料已采用" [level=4]
      - paragraph: 采用记录已确认 · 2026年10月27日 10:02 · 追加 4500 积分。任务状态以当前进度为准。
      - status: 补料采用已确认，请查看任务当前进度。
- button "打开 BondBuddy"
```

# Test source

```ts
  1   | // Full desktop through real HTTP/PG/production worker and private Word download.
  2   | // Original inputs/credit lots/provider output are synthetic; no supplier or real payment is claimed.
  3   | import {expect,test,type Locator,type Page} from '@playwright/test';
  4   | import {readFile,writeFile} from 'node:fs/promises';
  5   | import {join} from 'node:path';
  6   | import {spawnSync} from 'node:child_process';
  7   | import {digest} from '../../api/dist/data.js';
  8   | import {startProductionSupplementBrowser,type ProductionBrowser} from './run-supplement-production-real-harness';
  9   | 
  10  | test.describe.configure({mode:'serial'});
  11  | const action=(host:Locator,name:string)=>host.locator(`[data-supplement-action="${name}"]`);
  12  | const panel=(page:Page,r:ProductionBrowser)=>page.locator(`[data-run-supplement="${r.runId}"]`);
  13  | const control=(page:Page,r:ProductionBrowser,name:'pause'|'resume')=>r.surface==='m1'?page.locator(`#${name}-run`):
  14  |   r.surface==='m3'?page.locator(`#review-making-panel [data-review-action="${name}"]`):page.locator(`[data-m4-action="${name}"][data-run="${r.runId}"]`);
  15  | async function ready(page:Page,r:ProductionBrowser){
  16  |   const host=panel(page,r);await expect(host).toBeVisible({timeout:15000});
  17  |   const first=host.locator('summary').first();if(await first.count()&&await first.locator('..').evaluate(e=>e.tagName==='DETAILS'&&!(e as HTMLDetailsElement).open))await first.click();
  18  |   await expect(host.locator('[data-supplement-file]')).toBeVisible();return host;
  19  | }
  20  | async function executeWhenAvailable(r:ProductionBrowser,afterStage?:Parameters<typeof r.execute>[0]){
  21  |   const deadline=Date.now()+10000;
  22  |   for(;;){const outcome=await r.execute(afterStage);if(outcome!=='idle')return outcome;
  23  |     expect(Date.now(),'Queued claim can briefly lose to authenticated browser polling locks').toBeLessThan(deadline);await new Promise(resolve=>setTimeout(resolve,30));}
  24  | }
  25  | 
  26  | for(const kind of ['authoring','review','m4'] as const)test(`real desktop ${kind}: saved Word work → browser B1 quote/consent/adoption → real successor worker → private new Word`,async({page,context})=>{
  27  |   test.setTimeout(240000);const r=await startProductionSupplementBrowser(kind);
  28  |   const network:Array<{method:string;path:string;status:number;body?:unknown}>=[];
  29  |   let releaseOriginal:()=>void=()=>{},worker:Promise<unknown>|undefined;
  30  |   const protocol=`/api/v1/runs/${r.runId}`;
  31  |   try{
  32  |     await page.setViewportSize({width:1440,height:960});
  33  |     await context.addCookies([{name:'bb_session',value:r.access,url:r.baseURL,httpOnly:true,sameSite:'Lax'},{name:'bb_csrf',value:r.csrf,url:r.baseURL,sameSite:'Lax'}]);
  34  |     // Egress guard only: no API, worker result, page shell or browser response is mocked.
  35  |     await context.route('**/*',async route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==r.baseURL)throw Error(`Unexpected external request: ${url.origin}`);await route.continue();});
  36  |     page.on('response',response=>{const request=response.request(),url=new URL(response.url());if(url.pathname.startsWith('/api/v1/'))network.push({method:request.method(),path:url.pathname+url.search,status:response.status(),
  37  |       ...(url.pathname.includes('/supplement-')&&request.method()!=='GET'?{body:request.postDataJSON()}: {})});});
  38  |     const original=(await r.pool.query('SELECT * FROM bb_runs WHERE id=$1',[r.runId])).rows[0];
  39  |     expect(original).toMatchObject({state:'queued',channel:'production',test_grant_id:null});expect(original.reservation_id).toBeTruthy();
  40  |     await page.goto(r.baseURL+r.route);await expect(control(page,r,'pause')).toBeVisible({timeout:15000});
  41  |     let atWord=false,workerError:unknown;const release=new Promise<void>(resolve=>{releaseOriginal=resolve;});
  42  |     worker=executeWhenAvailable(r,async stage=>{if(stage==='word_promoted'){atWord=true;await release;}});void worker.catch(error=>{workerError=error;});
  43  |     await expect.poll(()=>{if(workerError)throw workerError;return atWord;},{timeout:90000}).toBe(true);
  44  |     const pauseResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===protocol+'/pause');
  45  |     await control(page,r,'pause').click();const pause=await pauseResponse;expect(pause.status()).toBe(200);expect(pause.request().headers()['x-bb-csrf']).toBe(r.csrf);
  46  |     releaseOriginal();expect(await worker).toBe('paused');worker=undefined;
  47  |     const host=await ready(page,r),before=await r.evidence();
  48  |     const oldArtifacts=(await r.pool.query('SELECT * FROM bb_artifact_versions WHERE run_id=$1 AND execution_version=1 ORDER BY id',[r.runId])).rows;
  49  |     expect(oldArtifacts.length).toBeGreaterThan(0);expect(await r.calls()).toHaveLength(1);
  50  |     const oldObjects=new Map([...r.objects].map(([key,bytes])=>[key,digest(bytes)]));
  51  |     const supplement=Buffer.from(`SYNTHETIC ${kind} desktop evidence, adopted only after explicit B1 consent.`);
  52  |     await host.locator('[data-supplement-intent]').selectOption('');await host.locator('[data-supplement-role]').selectOption('audit');
  53  |     const uploadResponse=page.waitForResponse(response=>response.request().method()==='POST'&&/\/materials\/uploads\/[^/]+\/complete$/.test(new URL(response.url()).pathname));
  54  |     await host.locator('[data-supplement-file]').setInputFiles({name:`synthetic-${kind}-browser-evidence.txt`,mimeType:'text/plain',buffer:supplement});
  55  |     const uploaded=await uploadResponse;expect(uploaded.status()).toBe(200);const material=await uploaded.json();expect(material.sha256).toBe(digest(supplement));
  56  |     const savedResponse=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname===protocol+'/supplement-draft');
  57  |     await expect(action(host,'save')).toBeEnabled();await action(host,'save').click();const savedHttp=await savedResponse;expect(savedHttp.status()).toBe(200);const saved=await savedHttp.json();
  58  |     expect(saved.saved_work.status).toBe('captured');expect(saved.saved_work.result_count).toBeGreaterThan(0);expect(saved.input_preview.status).toBe('prepared');
  59  |     expect(saved.changes.some((change:any)=>change.material.material_id===material.material_id)).toBe(true);
  60  |     const quoteResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===protocol+'/supplement-quotes');
  61  |     await expect(action(host,'quote')).toBeEnabled();await action(host,'quote').click();const quoteHttp=await quoteResponse;expect(quoteHttp.status()).toBe(200);const quote=await quoteHttp.json();
  62  |     expect(quote.quote.total_points).toBe(4500);expect(quote.quote.items).toHaveLength(1);expect(quote.quote.items[0].needs_redo).toBe(true);
  63  |     expect(quoteHttp.request().postDataJSON()).toMatchObject({supplement_revision:saved.revision,saved_request_id:saved.request_id,candidate_input_hash:saved.input_preview.candidate_input_hash});
  64  |     await expect(action(host,'adopt')).toHaveText('确认追加 4500 积分并继续');
  65  |     expect((await r.pool.query('SELECT count(*)::int n FROM bb_run_supplement_adoptions WHERE run_id=$1',[r.runId])).rows[0].n).toBe(0);
  66  |     expect((await r.pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE run_id=$1',[r.runId])).rows[0].n).toBe(1);
  67  |     await page.screenshot({path:join(r.artifactRoot,'b1-quote-full.png'),fullPage:true});
  68  |     const confirmedBefore=(await r.pool.query('SELECT count(*)::int n FROM bb_run_supplement_quote_confirmations WHERE run_id=$1',[r.runId])).rows[0].n;
  69  |     await page.reload();const restored=await ready(page,r);await expect(action(restored,'adopt')).toBeEnabled();
  70  |     expect((await r.pool.query('SELECT count(*)::int n FROM bb_run_supplement_quote_confirmations WHERE run_id=$1',[r.runId])).rows[0].n).toBe(confirmedBefore);
  71  |     expect(await r.calls()).toHaveLength(1);
  72  |     const adoptResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===protocol+'/supplement-adoptions');
  73  |     await action(restored,'adopt').click();const adoptionHttp=await adoptResponse;expect(adoptionHttp.status()).toBe(200);const adoption=(await adoptionHttp.json()).adoption;
  74  |     expect(adoption).toMatchObject({run_id:r.runId,execution_version:2,assignment_kind:'rework',additional_points:4500});expect(adoption.reservation_id).not.toBe(original.reservation_id);
  75  |     const adoptRequest=adoptionHttp.request().postDataJSON();expect(Object.keys(adoptRequest).sort()).toEqual(['confirmation_id','quote_hash','quote_id','request_id']);
  76  |     expect(adoptionHttp.request().headers()['x-bb-csrf']).toBe(r.csrf);
  77  |     expect((await r.pool.query('SELECT state FROM bb_credit_reservations WHERE id=$1',[original.reservation_id])).rows[0].state).toBe('settled');
  78  |     await expect(restored.locator('[data-supplement-adoption]')).toContainText('补料已采用');
  79  |     await page.screenshot({path:join(r.artifactRoot,'adopted-before-worker.png'),fullPage:true});
  80  |     expect(await executeWhenAvailable(r)).toBe('succeeded');
  81  |     const completed=(await r.pool.query('SELECT * FROM bb_runs WHERE id=$1',[r.runId])).rows[0];
  82  |     expect(completed).toMatchObject({state:'succeeded',input_revision:original.input_revision,input_hash:original.input_hash,reservation_id:original.reservation_id,billing_mode:original.billing_mode});
  83  |     const calls=await r.calls();expect(calls).toHaveLength(2);expect(calls[1].input_hash).toBe(adoption.input_hash);expect(calls[1].continuation).toBeTruthy();expect(calls[1].materials).toContain(material.material_id);
  84  |     const attempts=(await r.pool.query(`SELECT a.id,a.status,b.execution_version,b.input_hash FROM bb_model_call_attempts a
  85  |       JOIN bb_model_call_execution_bindings b ON b.attempt_id=a.id WHERE a.job_id=$1 ORDER BY b.execution_version`,[r.jobId])).rows;
  86  |     expect(attempts.map(row=>[row.execution_version,row.status])).toEqual([[1,'completed'],[2,'completed']]);
  87  |     const artifacts=(await r.pool.query('SELECT * FROM bb_artifact_versions WHERE run_id=$1 AND execution_version=2 ORDER BY id',[r.runId])).rows;
  88  |     expect(artifacts.length).toBeGreaterThan(0);for(const artifact of artifacts){expect(artifact.input_hash.trim()).toBe(adoption.input_hash);expect(oldArtifacts.some(old=>old.id===artifact.id)).toBe(false);}
  89  |     expect((await r.pool.query('SELECT * FROM bb_artifact_versions WHERE run_id=$1 AND execution_version=1 ORDER BY id',[r.runId])).rows).toEqual(oldArtifacts);
  90  |     for(const [key,hash] of oldObjects)expect(digest(await r.blobs.get(key)),key).toBe(hash);
  91  |     const fee=(await r.pool.query('SELECT * FROM bb_credit_reservations WHERE id=$1',[adoption.reservation_id])).rows[0];expect(fee.state).toBe('settled');expect(Number(fee.charged_points)).toBe(4500);
  92  |     // Reopen the real current task route; UI downloads choose persisted execution2 artifacts.
  93  |     await page.goto(r.baseURL+r.route);
  94  |     const button=r.surface==='m1'?page.locator('[data-artifact-file="0"]'):
  95  |       r.surface==='m3'?page.locator('[data-review-action="download"]').filter({hasText:'复核报告'}).first():page.locator('[data-m4-action="download"]').filter({hasText:'正文 Word'}).first();
> 96  |     await expect(button).toBeVisible({timeout:20000});
      |                          ^ Error: expect(locator).toBeVisible() failed
  97  |     const bytesResponse=page.waitForResponse(response=>response.request().method()==='GET'&&
  98  |       /^\/api\/v1\/(?:m4\/)?artifacts\/[^/]+\/(?:download|versions\/\d+\/bytes)$/.test(new URL(response.url()).pathname));
  99  |     const downloadEvent=page.waitForEvent('download');await button.click();const download=await downloadEvent;const downloadedPath=join(r.artifactRoot,'browser-downloaded-successor.docx');await download.saveAs(downloadedPath);
  100 |     const deliveredHttp=await bytesResponse;expect(deliveredHttp.status()).toBe(200);
  101 |     const artifactId=new URL(deliveredHttp.url()).pathname.match(/\/artifacts\/([^/]+)\//)![1];
  102 |     const downloaded=await readFile(downloadedPath),downloadedHash=digest(downloaded),artifact=artifacts.find(row=>row.id===artifactId);expect(artifact).toBeTruthy();expect(artifact.sha256.trim()).toBe(downloadedHash);
  103 |     const wordCheck=spawnSync(r.python,['-c','from docx import Document; import sys,json; d=Document(sys.argv[1]); print(json.dumps({"paragraphs":len(d.paragraphs),"text":"\\n".join(p.text for p in d.paragraphs)},ensure_ascii=False))',downloadedPath],{encoding:'utf8'});
  104 |     expect(wordCheck.status,wordCheck.stderr).toBe(0);expect(JSON.parse(wordCheck.stdout).paragraphs).toBeGreaterThan(0);
  105 |     const descriptor=await r.request('GET',`/api/v1/artifacts/${artifact.id}`);expect(descriptor.sha256).toBe(downloadedHash);expect(descriptor.delivery_status).toBe('available');
  106 |     expect((await fetch(r.baseURL+descriptor.download_url)).status).toBe(401);
  107 |     const privateBytes=await fetch(r.baseURL+descriptor.download_url,{headers:r.headers});expect(privateBytes.status).toBe(200);expect(digest(Buffer.from(await privateBytes.arrayBuffer()))).toBe(downloadedHash);
  108 |     const terminalReceipt=await r.request('GET',protocol+'/supplement-adoptions?request_id='+encodeURIComponent(adoptRequest.request_id));expect(terminalReceipt.adoption).toEqual(adoption);expect(await r.calls()).toHaveLength(2);
  109 |     expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  110 |     await page.screenshot({path:join(r.artifactRoot,'successor-word-downloaded-full.png'),fullPage:true});
  111 |     await writeFile(join(r.artifactRoot,'assertions.json'),JSON.stringify({synthetic_provider:true,synthetic_credit_lot:true,real_browser_http_pg_worker:true,
  112 |       cloned_database:r.cloneName,original,uploaded_material:material,saved,quote,adoption,adopt_request:adoptRequest,attempts,downloaded_artifact:artifact,
  113 |       downloaded_sha256:downloadedHash,browser_byte_route:new URL(deliveredHttp.url()).pathname,word_check:JSON.parse(wordCheck.stdout),before,after:await r.evidence(),network},null,2));
  114 |   }finally{
  115 |     releaseOriginal();if(worker)await worker.catch(()=>undefined);await page.goto('about:blank').catch(()=>undefined);
  116 |     await r.request('POST',protocol+'/cancel',{reason:'Private browser fixture cleanup'}).catch(()=>undefined);
  117 |     await writeFile(join(r.artifactRoot,'network.json'),JSON.stringify(network,null,2));await r.close();
  118 |   }
  119 | });
  120 | 
```