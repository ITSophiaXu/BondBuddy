# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: project-execution.spec.ts >> deduplicated first draft is revalidated before another input is submitted
- Location: tests\project-execution.spec.ts:1356:50

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('#execution-progress')
Timeout: 5000ms
- Expected substring  - 1
+ Received string     + 2

- 任务已暂停
+
+       

Call log:
  - Expect "toContainText" locator('#execution-progress') with timeout 5000ms
  - waiting for locator('#execution-progress')
    13 × locator resolved to <div aria-live="polite" id="execution-progress">↵      </div>
       - unexpected value "
      "

```

```yaml
- link "跳到主要内容":
  - /url: "#main"
- complementary:
  - link "bondbuddy":
    - /url: "#tasks"
  - strong: 我的工作空间
  - navigation "主导航":
    - link "任务进度与结果":
      - /url: "#tasks"
    - text: 开始工作
    - link "更新募集书":
      - /url: "#update"
    - link "复核募集书":
      - /url: "#review"
    - link "文件生成":
      - /url: "#generate"
    - link "诚信核查":
      - /url: "#integrity"
    - link "项目问答":
      - /url: "#qa"
  - link "我的账号":
    - /url: "#/account?project=synthetic-execution-project&return_project=synthetic-execution-project&return_to=%23%2Fprojects%2Fsynthetic-execution-project"
    - strong: synthetic
  - button "退出"
- banner: 工作空间 更新募集书
- main:
  - region "当前项目":
    - text: 当前项目
    - strong: 合成任务项目
    - link "返回本项目文件":
      - /url: "#/projects/synthetic-execution-project/files"
  - heading "合成任务项目" [level=1]
  - paragraph: 提供项目材料和要求，在同一个工作区完成募集书更新。
  - status: 已保存
  - button "删除项目"
  - navigation "更新流程": ✓ 创建项目 2 材料与要求
  - text: 全文更新
  - button "编辑项目信息"
  - text: 1 份已保存材料
  - region "历史／参考募集书（必填）":
    - heading "历史／参考募集书（必填）" [level=2]
    - paragraph: 上传本企业历史稿或相似企业募集书，作为本次更新的原稿或结构参考。
    - paragraph: 仅支持 Word（.docx） · 每次一份，单份不超过 100 MB · 选择或拖入后自动保存并采用为原稿。
    - button "上传历史／参考稿":
      - strong: 选择文件
      - text: 或将文件拖到这里
    - region "已上传文件":
      - heading "已上传文件 0" [level=3]
      - paragraph: 请上传一份历史／参考募集书，填写原稿信息后再开始更新。
  - group:
    - region "提供项目材料":
      - heading "提供项目材料" [level=2]
      - paragraph: 请在开始更新前补齐材料；开始后材料锁定，仅可查看。
      - paragraph: 按分区添加材料。单份不超过 100 MB，每个项目最多 60 份、合计 500 MB。相同分区重复上传相同内容会复用已保存版本。
      - button "刷新已保存材料"
      - status: 已保存 1 份材料。
      - group "项目材料":
        - region "审计报告 / 财务报表及附注":
          - heading "审计报告 / 财务报表及附注" [level=3]
          - list:
            - listitem:
              - strong: 审计报告（可含报表及附注）
              - text: 必需提供审计报告，或财务报表及附注；报表和附注已包含在报告中时无需重复上传
              - strong: 选择文件
              - text: 或将文件拖到这里
              - button "为审计报告（可含报表及附注）选择文件"
              - complementary "需要准备的财务材料":
                - strong: 需要准备的财务材料
                - list:
                  - listitem: 2024年度审计报告（含财务报表及附注）
                  - listitem: 2025年度审计报告（含财务报表及附注）
                - paragraph: 按当前品种和财务截止日的通常口径准备；报告已包含的报表及附注无需重复上传。成立不足年限、特殊披露或期间调整，请在补充说明中注明。
              - list:
                - listitem:
                  - strong: audit.docx
                  - text: 审计报告（可含报表及附注） · 1.0 KB · 版本 1
                  - paragraph: 服务器已确认保存
                  - status: 处理状态暂不可用
                  - paragraph: 文件已上传，暂未取得处理状态。请稍后刷新；持续未恢复时请联系支持。
                  - button "刷新状态"
                  - status
                  - button "删除"
        - region "募投项目与权证材料（选填）":
          - heading "募投项目与权证材料（选填）" [level=3]
          - list:
            - listitem:
              - strong: 募集资金使用计划 / 项目方案
              - text: 选填 · 按用途提供项目备案、土地及建设许可、基金备案许可或子公司股权投资相关材料
              - strong: 选择文件
              - text: 或将文件拖到这里
              - button "为募集资金使用计划 / 项目方案选择文件"
              - list
        - region "债务、授信与担保（选填）":
          - heading "债务、授信与担保（选填）" [level=3]
          - paragraph: 按实际情况提供，未上传这些可选材料也可继续编制。
          - paragraph: 支持 Word（DOCX）、PDF、Excel（XLSX）、CSV、TXT 和图片（PNG / JPG / JPEG）。每类可多选或拖入多份文件。
          - list:
            - listitem:
              - strong: 有息债务明细表
              - text: 选填 · 借款、债券、非标融资等余额、利率、到期日及担保方式。
              - strong: 选择文件
              - text: 或将文件拖到这里
              - button "为有息债务明细表选择文件"
              - list
            - listitem:
              - strong: 银行授信情况表
              - text: 选填 · 各银行授信总额、已用额度、未用额度及有效期。
              - strong: 选择文件
              - text: 或将文件拖到这里
              - button "为银行授信情况表选择文件"
              - list
            - listitem:
              - strong: 担保明细 / 担保合同
              - text: 选填 · 对外担保明细，或本期债券的担保合同、增信安排。
              - strong: 选择文件
              - text: 或将文件拖到这里
              - button "为担保明细 / 担保合同选择文件"
              - list
            - listitem:
              - strong: 抵质押资产资料
              - text: 选填 · 抵质押资产清单、权属证明、评估报告等。
              - strong: 选择文件
              - text: 或将文件拖到这里
              - button "为抵质押资产资料选择文件"
              - list
        - region "公司、经营与信用（选填）":
          - heading "公司、经营与信用（选填）" [level=3]
          - paragraph: 按实际情况提供，未上传这些可选材料也可继续编制。
          - paragraph: 支持 Word（DOCX）、PDF、Excel（XLSX）、CSV、TXT 和图片（PNG / JPG / JPEG）。每类可多选或拖入多份文件。
          - list:
            - listitem:
              - strong: 业务经营资料
              - text: 选填 · 主营业务介绍、分板块经营数据及重大合同等。
              - strong: 选择文件
              - text: 或将文件拖到这里
              - button "为业务经营资料选择文件"
              - list
            - listitem:
              - strong: 公司章程 / 治理制度
              - text: 选填 · 现行公司章程、章程修正案、治理制度及组织架构。
              - strong: 选择文件
              - text: 或将文件拖到这里
              - button "为公司章程 / 治理制度选择文件"
              - list
            - listitem:
              - strong: 营业执照 / 公司基本资料
              - text: 选填 · 营业执照、公司简介、股权结构及子公司情况。
              - strong: 选择文件
              - text: 或将文件拖到这里
              - button "为营业执照 / 公司基本资料选择文件"
              - list
            - listitem:
              - strong: 评级报告（主体 / 债项 / 跟踪）
              - text: 选填 · 主体评级、债项评级或最新跟踪评级报告。
              - strong: 选择文件
              - text: 或将文件拖到这里
              - button "为评级报告（主体 / 债项 / 跟踪）选择文件"
              - list
        - region "其他补充材料（选填）":
          - heading "其他补充材料（选填）" [level=3]
          - paragraph: 按实际情况提供，未上传这些可选材料也可继续编制。
          - paragraph: 支持 Word（DOCX）、PDF、Excel（XLSX）、CSV、TXT 和图片（PNG / JPG / JPEG）。每类可多选或拖入多份文件。
          - list:
            - listitem:
              - strong: 其他补充材料
              - text: 选填 · 上述类别未涵盖的专项说明、证明文件等。
              - strong: 选择文件
              - text: 或将文件拖到这里
              - button "为其他补充材料选择文件"
              - list
      - paragraph:
        - link "数据保存与删除说明":
          - /url: "#/account?section=data"
      - paragraph: 选中文件后立即上传；未成功的文件可单独重试。
    - region "补充要求":
      - heading "募集书更新补充说明 选填" [level=2]
      - textbox "补充募集书更新说明":
        - /placeholder: 如有额外的募集书更新要求，可在此补充
      - status: 输入后自动保存
  - group
  - button "上一步"
  - status: 请先上传并采用一份历史／参考募集书，填写原稿信息后再开始更新。
  - paragraph: 当前为试用编制，本次不扣积分。
  - button "请先处理材料状态" [disabled]
- button "打开 BondBuddy"
```

# Test source

```ts
  1260 |   await expect(page.locator('#execution-progress')).toHaveCount(0); await expect(page.locator('.project-cowork')).toHaveCount(0);
  1261 | });
  1262 | 
  1263 | test('foreign execute response is rejected', async ({ page }) => {
  1264 |   const state=fixture(); state.checkStatus='ready'; await setup(page,state); state.lateRunForeign=true;
  1265 |   await page.locator('#execute-input').click(); await expect(page.locator('#execution-message')).not.toBeEmpty();
  1266 |   await expect(page.locator('#execution-progress')).not.toContainText('任务已暂停');
  1267 | });
  1268 | 
  1269 | test('unknown blockers remain explicit; prototype workspace captures all states without fake progress', async ({ page }) => {
  1270 |   const state=fixture(); state.reason='<img src=x onerror=alert(1)>'; await setup(page,state);
  1271 |   await page.setViewportSize({width:1440,height:960});
  1272 |   await page.evaluate(()=>{ document.activeElement instanceof HTMLElement && document.activeElement.blur(); scrollTo(0,0); });
  1273 |   await page.screenshot({path:join(tmpdir(),'bb361-materials-desktop.png'),fullPage:true});
  1274 |   await page.getByRole('button',{name:'编辑项目信息'}).click();
  1275 |   await page.evaluate(()=>{ document.activeElement instanceof HTMLElement && document.activeElement.blur(); scrollTo(0,0); });
  1276 |   await page.screenshot({path:join(tmpdir(),'bb361-project-details-desktop.png'),fullPage:true});
  1277 |   await page.getByRole('button',{name:'保存并继续'}).click(); await prepare(page);
  1278 |   await expect(page.locator('#execution-preflight')).toContainText('当前处理条件尚未就绪');
  1279 |   await expect(page.locator('#execution-preflight img')).toHaveCount(0);
  1280 |   state.checkStatus='ready'; await page.locator('#recheck-input').click();
  1281 |   await page.locator('#execute-input').click(); await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  1282 |   await page.evaluate(()=>{ document.activeElement instanceof HTMLElement && document.activeElement.blur(); scrollTo(0,0); });
  1283 |   await page.screenshot({path:join(tmpdir(),'bb361-paused-desktop.png'),fullPage:true});
  1284 |   for (const [status, file] of [['running','running'],['awaiting_input','awaiting'],['failed','failed']] as const) {
  1285 |     [...state.runs.values()][0].state=status; await page.getByRole('button',{name:'重新读取',exact:true}).click();
  1286 |     await expect(page.locator('#execution-progress')).toContainText(status==='running'?'正在编制募集书':status==='awaiting_input'?'等待补充信息':'本轮未完成');
  1287 |     await page.evaluate(()=>{ document.activeElement instanceof HTMLElement && document.activeElement.blur(); scrollTo(0,0); });
  1288 |   await page.screenshot({path:join(tmpdir(),`bb361-${file}-desktop.png`),fullPage:true});
  1289 |   }
  1290 |   await page.setViewportSize({width:390,height:844});
  1291 |   await page.evaluate(()=>{ document.activeElement instanceof HTMLElement && document.activeElement.blur(); scrollTo(0,0); });
  1292 |   await page.screenshot({path:join(tmpdir(),'bb361-workspace-mobile.png'),fullPage:true});
  1293 |   expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  1294 | });
  1295 | 
  1296 | test('restored snapshot retains exact user assertion pins in a new version', async ({ page }) => {
  1297 |   const state=await setup(page); await prepare(page);
  1298 |   const pin={supplement_id:'00000000-0000-4000-8000-000000000001',version:2,request_hash:'a'.repeat(64)};
  1299 |   state.snapshots.get(1)!.credit_facility_supplements=[pin];
  1300 |   await page.reload(); await expect(page.locator('#execute-input')).toBeEnabled();
  1301 |   await page.getByRole('button',{name:'编辑项目信息'}).click();
  1302 |   await page.locator('details.update-optional-section[data-update-group=other] > summary').click();
  1303 |   await page.getByLabel('其他已知信息').fill('下一轮补充');
  1304 |   await expect(page.locator('#save-state')).toHaveText('已保存');
  1305 |   await page.getByRole('button',{name:'保存并继续'}).click();
  1306 |   await prepare(page); expect(state.inputs[1].credit_facility_supplements).toEqual([pin]);
  1307 | });
  1308 | 
  1309 | test('failed task recovery cannot enable a new snapshot until the server record is read', async ({page})=>{
  1310 |   const state=await setup(page);
  1311 |   const taskHistoryUrl=(url:URL)=>url.pathname===`/api/v1/projects/${id}/tasks`;
  1312 |   let failedReads=0;
  1313 |   await page.route(taskHistoryUrl,route=>{failedReads++;return json(route,503,{code:'DATA_UNAVAILABLE'});});
  1314 |   await page.reload();
  1315 |   await expect(page.locator('#execution-message')).not.toBeEmpty();
  1316 |   await expect(page.locator('#execute-input')).toBeDisabled();
  1317 |   expect(failedReads).toBeGreaterThan(0);
  1318 |   expect(state.inputs).toHaveLength(0); expect(state.executes).toHaveLength(0);
  1319 |   await page.unroute(taskHistoryUrl); await page.getByRole('button',{name:'重新读取',exact:true}).click();
  1320 |   await expect(page.locator('#execute-input')).toBeEnabled();
  1321 |   expect(state.inputs).toHaveLength(0); expect(state.executes).toHaveLength(0);
  1322 | });
  1323 | 
  1324 | test('a test terminal state in the production channel never exposes a deliverable',async({page})=>{
  1325 |   const state=fixture(); state.checkStatus='ready'; await setup(page,state); await page.locator('#execute-input').click();
  1326 |   await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  1327 |   const run=[...state.runs.values()][0];run.state='test_completed';run.artifact_id='invalid-artifact';
  1328 |   await page.getByRole('button',{name:'重新读取',exact:true}).click();
  1329 |   await expect(page.locator('#execution-delivery')).toBeEmpty();
  1330 |   await expect(page.getByRole('button',{name:'下载修订版',exact:true})).toHaveCount(0);
  1331 | });
  1332 | 
  1333 | test('continuing after completion creates a new input and retains the preceding successful artifact without reload',async({page})=>{
  1334 |   const state=fixture(); state.checkStatus='ready'; await setup(page,state); await page.locator('#execute-input').click();
  1335 |   await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
  1336 |   const first=[...state.runs.values()][0];
  1337 |   const {primary,clean}=registerGeneratedPair(state,first,'first-successful-artifact');
  1338 |   await page.getByRole('button',{name:'重新读取',exact:true}).click();
  1339 |   await expect(page.locator('#execution-progress')).toContainText('已生成');
  1340 |   await continueAuthoring(page);
  1341 |   await expect(page.locator('[data-next-authoring-summary]')).toContainText(clean.filename!);
  1342 |   await page.locator('#execute-input').click();
  1343 |   await expect(page.locator('#execution-progress .task-progress')).toHaveAttribute('data-input-revision','2');
  1344 |   await expect(page.getByRole('link',{name:'查看此前成功成果'})).toHaveAttribute('href',`#/artifacts/first-successful-artifact?return_project=${id}`);
  1345 |   expect(state.runs.size).toBe(2);
  1346 |   expect(state.executes[0].input_hash).toBe(state.snapshots.get(1)!.input_hash);
  1347 |   expect(state.executes[0].execution_request_id).not.toBe(state.executes[1].execution_request_id);
  1348 |   expect(state.inputs[0]).not.toHaveProperty('edit_base');
  1349 |   expect(state.inputs[1].edit_base).toEqual({artifact_id:clean.artifact_id,artifact_version:clean.version,sha256:clean.sha256});
  1350 |   expect(state.inputs[1].prospectus_selection_revision).toBe(2);
  1351 |   expect(state.inputs[1].material_versions).toEqual(state.inputs[0].material_versions);
  1352 |   expect(primary.word_delivery?.clean_artifact_id).toBe(clean.artifact_id);
  1353 |   expect(clean.word_delivery?.revision_artifact_id).toBe(first.artifact_id);
  1354 | });
  1355 | 
  1356 | for(const changeAfterPreparation of [false,true])test(`deduplicated first draft ${changeAfterPreparation?'is revalidated before another input is submitted':'continues from the exact shared clean artifact'}`,async({page})=>{
  1357 |   const state=fixture();state.checkStatus='ready';state.materials=state.materials.filter(material=>material.role!=='historical');
  1358 |   state.project.update_details!.has_historical=false;state.project.update_details!.source_prospectuses=[];state.sourceSelected=false;
  1359 |   await setup(page,state);await page.locator('#execute-input').click();
> 1360 |   await expect(page.locator('#execution-progress')).toContainText('任务已暂停');
       |                                                     ^ Error: expect(locator).toContainText(expected) failed
  1361 |   const first=[...state.runs.values()][0],{primary,clean}=registerGeneratedPair(state,first,'deduplicated-first-draft',true);
  1362 |   expect(primary.word_delivery?.source_sha256).toBeNull();
  1363 |   await page.getByRole('button',{name:'重新读取',exact:true}).click();
  1364 |   await expect(page.locator('#execution-progress')).toContainText('已生成');
  1365 |   await continueAuthoring(page);
  1366 |   await expect(page.locator('[data-next-authoring-summary]')).toContainText(clean.filename!);
  1367 |   if(changeAfterPreparation)clean.sha256=hash('changed-first-draft');
  1368 |   await page.locator('#execute-input').click();
  1369 |   if(changeAfterPreparation){
  1370 |     await expect(page.locator('#execution-message')).toContainText('清洁版成果的准确版本尚未确认');
  1371 |     expect(state.inputs).toHaveLength(1);expect(state.executes).toHaveLength(1);expect(state.runs.size).toBe(1);
  1372 |   }else{
  1373 |     await expect(page.locator('#execution-progress .task-progress')).toHaveAttribute('data-input-revision','2');
  1374 |     expect(state.inputs[1].edit_base).toEqual({artifact_id:clean.artifact_id,artifact_version:clean.version,sha256:clean.sha256});
  1375 |     expect(state.inputs[1].prospectus_selection_revision).toBe(1);expect(state.runs.size).toBe(2);
  1376 |   }
  1377 | });
  1378 | 
  1379 | 
  1380 | for (const [reason, message] of [
  1381 |   ['model_tokens_per_user_per_day', '今日试用额度已用完，额度恢复后自动继续。'],
  1382 |   ['kill_switch', '更新服务暂时停用，服务恢复后自动继续。']]) {
  1383 |   test(`trial pause ${reason}: reload and automatic recovery preserve one run`, async ({ page }) => {
  1384 |     const state = fixture(); state.checkStatus = 'ready'; state.runStage = 'trial_limit'; state.runReason = reason;
  1385 |     // This task belongs to the same project and points to the existing version-1 artifact.
  1386 |     // Keep it out of runs: that map tracks only this test's newly submitted execution.
  1387 |     const priorPage=taskPage(id,[{run_id:priorArtifact.run_id,project_id:id,state:'succeeded',stage:'word_delivery',artifact_id:priorArtifact.artifact_id,updated_at:priorArtifact.created_at}],state.project.kind);
  1388 |     expect(Value.Check(schemas.ProjectTasksResponse,priorPage)).toBe(true);
  1389 |     await setup(page, state);
  1390 |     state.priorTasks=priorPage.items;
  1391 |     await page.locator('#execute-input').click();
  1392 |     await expect(page.locator('.execution-summary')).toHaveText(message);
  1393 |     await page.getByRole('button',{name:'重新读取',exact:true}).click();
  1394 |     await expect(page.locator('.execution-summary')).toHaveText(message);
  1395 |     await expect(page.getByRole('button', { name: '继续更新', exact: true })).toHaveCount(0);
  1396 |     await expect(page.getByRole('button', { name: '查看材料', exact: true })).toBeVisible();
  1397 |     await expect(page.getByRole('link', { name: '查看此前成功成果' })).toBeVisible();
  1398 |     await expect(page.getByRole('link', { name: '查看此前成功成果' })).toHaveAttribute('href',`#/artifacts/${priorArtifact.artifact_id}?return_project=${id}`);
  1399 |     if (reason === 'model_tokens_per_user_per_day' && process.env.BB_TRIAL_UX_DIR) {
  1400 |       for (const [label, width, height] of [['desktop', 1440, 960], ['mobile', 390, 844]] as const) {
  1401 |         await page.setViewportSize({ width, height });
  1402 |         await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); scrollTo(0, 0); });
  1403 |         await page.screenshot({ path: join(process.env.BB_TRIAL_UX_DIR, `trial-${label}.png`), fullPage: true });
  1404 |         expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  1405 |       }
  1406 |     }
  1407 |     await page.reload();
  1408 |     await expect(page.locator('.execution-summary')).toHaveText(message);
  1409 |     await expect(page.getByRole('link', { name: '查看此前成功成果' })).toHaveAttribute('href',`#/artifacts/${priorArtifact.artifact_id}?return_project=${id}`);
  1410 |     await expect(page.locator('#resume-run')).toHaveCount(0);
  1411 |     const run = [...state.runs.values()][0];
  1412 |     const originalInput = run.input_hash;
  1413 |     run.state = 'queued'; state.runReason = 'trial_limit_cleared'; state.eventSeq++;
  1414 |     await expect(page.locator('.execution-summary')).toHaveText('试用限制已解除，任务继续处理。', { timeout: 10000 });
  1415 |     await expect(page.locator('#execution-progress')).toContainText('等待开始');
  1416 |     await expect(page.locator('#cancel-run')).toBeVisible();
  1417 |     expect(state.runActions).toEqual([]); expect(state.executes).toHaveLength(1);
  1418 |     expect(state.inputs).toHaveLength(1); expect(run.input_hash).toBe(originalInput);
  1419 |     expect(state.runs.size).toBe(1); expect(run.project_id).toBe(id); expect(run.run_id).not.toBe(priorArtifact.run_id);
  1420 |   });
  1421 | }
  1422 | 
  1423 | test('trial stage stays honest without events; a different paused stage discards the old limit reason', async ({ page }) => {
  1424 |   const state = fixture(); state.checkStatus = 'ready'; state.runStage = 'trial_limit'; state.failEvents = true;
  1425 |   await setup(page, state); await page.locator('#execute-input').click();
  1426 |   await expect(page.locator('.execution-summary')).toHaveText('当前更新暂受试用限制，限制解除后自动继续。');
  1427 |   await expect(page.locator('#resume-run')).toHaveCount(0);
  1428 |   state.failEvents = false; state.runReason = 'model_tokens_per_user_per_day';
  1429 |   await expect(page.locator('.execution-summary')).toContainText('今日试用额度已用完', { timeout: 10000 });
  1430 |   const run = [...state.runs.values()][0];
  1431 |   run.stage = 'capability_not_ready'; state.eventSeq++; state.eventStage = 'trial_limit';
  1432 |   // A delayed event for the previous paused stage must not describe the new pause.
  1433 |   await expect(page.locator('#recheck-paused')).toBeVisible({ timeout: 10000 });
  1434 |   await expect(page.locator('#resume-run')).toHaveCount(0);
  1435 |   await expect(page.locator('.execution-summary')).toContainText('处理条件尚未就绪');
  1436 |   await page.locator('#recheck-paused').click();
  1437 |   await expect(page.locator('#resume-run')).toBeVisible();
  1438 |   await page.locator('#resume-run').click();
  1439 |   await expect(page.locator('#execution-progress')).toContainText('正在编制募集书');
  1440 |   expect(state.runActions).toEqual([`/runs/${run.run_id}/resume`]);
  1441 |   expect(state.executes).toHaveLength(1);
  1442 | });
  1443 | 
  1444 | test('operator denial remains a failed task without automatic-recovery guidance', async ({ page }) => {
  1445 |   const state = fixture(); state.checkStatus = 'ready'; state.runState = 'failed'; state.runStage = 'model_generation';
  1446 |   state.runReason = ''; state.eventError = 'TRIAL_ACCESS_DENIED';
  1447 |   await setup(page, state); await page.locator('#execute-input').click();
  1448 |   await expect(page.locator('#execution-progress')).toContainText('本轮未完成');
  1449 |   await expect(page.locator('.execution-summary')).toHaveText('当前账号的试用权限已停用，请联系支持。');
  1450 |   await expect(page.locator('#execution-progress')).not.toContainText('自动继续');
  1451 |   await expect(page.locator('#resume-run')).toHaveCount(0);
  1452 |   expect(state.runActions).toEqual([]); expect(state.executes).toHaveLength(1);
  1453 | });
  1454 | 
  1455 | 
  1456 | for (const [label, width, height] of [['desktop', 1440, 960], ['mobile', 390, 844]] as const) {
  1457 |   test(`lost upload acknowledgement restores start without resending ${label}`, async ({ page, context }) => {
  1458 |     const state = fixture();
  1459 |     state.project.update_details!.authoring_mode='unified_v1';
  1460 |     const puts: string[] = [];
```