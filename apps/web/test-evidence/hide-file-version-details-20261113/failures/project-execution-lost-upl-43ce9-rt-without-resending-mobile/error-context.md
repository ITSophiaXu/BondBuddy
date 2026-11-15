# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: project-execution.spec.ts >> lost upload acknowledgement restores start without resending mobile
- Location: tests\project-execution.spec.ts:1457:3

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('.material-file-row').filter({ hasText: 'lost.pdf' })
Expected substring: "服务器已确认保存"
Received string:    "lost.pdf审计报告（可含报表及附注） · 35 B已发送 100%，正在保存…停止等待"
Timeout: 5000ms

Call log:
  - Expect "toContainText" locator('.material-file-row').filter({ hasText: 'lost.pdf' }) with timeout 5000ms
  - waiting for locator('.material-file-row').filter({ hasText: 'lost.pdf' })
    2 × locator resolved to <li data-upload-phase="checking" class="material-file-row bb-upload-file" data-upload-id="b1d5a256-baaa-408a-9b89-9b4b3d26d47e">…</li>
      - unexpected value "lost.pdf审计报告（可含报表及附注） · 35 B正在确认保存结果…取消此文件"
    12 × locator resolved to <li data-upload-phase="saving" class="material-file-row bb-upload-file" data-upload-id="b1d5a256-baaa-408a-9b89-9b4b3d26d47e">…</li>
       - unexpected value "lost.pdf审计报告（可含报表及附注） · 35 B已发送 100%，正在保存…停止等待"

```

```yaml
- listitem:
  - strong: lost.pdf
  - text: 审计报告（可含报表及附注） · 35 B
  - progressbar "lost.pdf 上传进度"
  - status: 已发送 100%，正在保存…
  - button "停止等待"
```

# Test source

```ts
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
  1461 |     let completes = 0, creates = 0;
  1462 |     await page.setViewportSize({ width, height });
  1463 |     await page.route('**/api/v1/**/materials/uploads**', async route => {
  1464 |       const request = route.request(), path = new URL(request.url()).pathname;
  1465 |       if (path.endsWith('/uploads')) {
  1466 |         creates++;
  1467 |         return json(route, 201, { upload_id:'lost-upload', state:'uploading', upload_url:`/api/v1/projects/${id}/materials/uploads/lost-upload/bytes`, expires_at:'2099-01-01T00:00:00Z', max_bytes:100_000_000 });
  1468 |       }
  1469 |       if (path.endsWith('/bytes')) { puts.push(path); return route.fulfill({status:204}); }
  1470 |       if (path.endsWith('/complete')) {
  1471 |         completes++;
  1472 |         const body = fixtureRequest(request);
  1473 |         state.materials.push({material_id:'lost-material', material_version:1, upload_id:'lost-upload', role:'audit', filename:'lost.pdf', media_type:'application/pdf', byte_size:body.byte_size, sha256:body.sha256, state:'persisted', persisted_at:now, error:null});
  1474 |         return route.abort('connectionreset');
  1475 |       }
  1476 |       return route.fallback();
  1477 |     });
  1478 |     await setup(page, state);
  1479 |     await page.getByLabel('为审计报告（可含报表及附注）选择文件').setInputFiles({name:'lost.pdf', mimeType:'application/pdf', buffer:Buffer.from('%PDF synthetic lost acknowledgement')});
  1480 |     const row = page.locator('.material-file-row').filter({hasText:'lost.pdf'});
  1481 |     await expect(row).toHaveCount(1);
> 1482 |     await expect(row).toContainText('服务器已确认保存');
       |                       ^ Error: expect(locator).toContainText(expected) failed
  1483 |     await expect(page.locator('[data-processing-key]')).toHaveCount(0);
  1484 |     await expect(page.getByText('处理状态不可用', {exact:true})).toHaveCount(0);
  1485 |     await expect(page.getByRole('button',{name:'开始更新',exact:true})).toBeEnabled();
  1486 |     expect({creates, completes, puts:puts.length}).toEqual({creates:1, completes:1, puts:1});
  1487 |     expect(state.inputs).toHaveLength(0); expect(state.executes).toHaveLength(0);
  1488 |     if (process.env.BB_UPLOAD_RECOVERY_EVIDENCE_DIR) {
  1489 |       const output = resolve(process.env.BB_UPLOAD_RECOVERY_EVIDENCE_DIR); await mkdir(output, {recursive:true});
  1490 |       await page.screenshot({path:join(output,`recovered-${label}.png`),fullPage:true});
  1491 |     }
  1492 |   });
  1493 | 
  1494 |   test(`material workflow ${label}: upload, retry, pending evidence, one-click execution and reopen`, async ({ page, context }) => {
  1495 |     const state = fixture(); state.materials = []; state.checkStatus = 'needs_confirmation';
  1496 |     state.runState = 'running'; state.runStage = 'model_generation'; state.runReason = '';
  1497 |     const uploads = new Map<string, { filename: string; role: string; media_type: Dto<'MaterialResponse'>['media_type'] }>();
  1498 |     const unexpected: string[] = []; let failAudit = true, completed = false;
  1499 |     let releaseSave: (() => void) | undefined;
  1500 |     await page.setViewportSize({ width, height });
  1501 |     await context.route('**/api/v1/**/materials/**', async route => {
  1502 |       const request = route.request(), path = new URL(request.url()).pathname;
  1503 |       if (path.endsWith('/source-profile') || path.endsWith('/ocr')) { unexpected.push(path); return json(route, 500, { code: 'UNEXPECTED_REVIEW_REQUEST' }); }
  1504 |       if (path.endsWith('/materials/uploads')) {
  1505 |         const uploadId = `synthetic-upload-${uploads.size + 1}`;
  1506 |         uploads.set(uploadId, fixtureRequest(request));
  1507 |         return json(route, 201, { upload_id: uploadId, state: 'uploading', upload_url: `/api/v1/projects/${id}/materials/uploads/${uploadId}/bytes`, expires_at: '2099-01-01T00:00:00Z', max_bytes: 100_000_000 });
  1508 |       }
  1509 |       if (path.endsWith('/bytes')) return route.fulfill({ status: 204 });
  1510 |       if (path.endsWith('/complete')) {
  1511 |         const uploadId = path.split('/').at(-2)!, upload = uploads.get(uploadId)!;
  1512 |         if (upload.role === 'audit' && failAudit) { failAudit = false; return json(route, 422, { code: 'MATERIAL_UNREADABLE', field_errors: [{field:'material_upload',code:'inspection_timeout'}] }); }
  1513 |         if (upload.role === 'historical' && !releaseSave) await new Promise<void>(resolve => { releaseSave = resolve; });
  1514 |         const body = fixtureRequest(request);
  1515 |         const material: Dto<'MaterialResponse'> = { material_id: `material-${uploadId}`, material_version: 1, upload_id: uploadId,
  1516 |           role: upload.role as Dto<'MaterialResponse'>['role'], filename: upload.filename, media_type: upload.media_type,
  1517 |           byte_size: body.byte_size, sha256: body.sha256, state: 'persisted', persisted_at: now, error: null };
  1518 |         state.materials.push(material); return json(route, 200, material);
  1519 |       }
  1520 |       if (path.endsWith('/parse-job')) {
  1521 |         const material = state.materials.find(m => m.material_id === path.split('/').at(-2))!;
  1522 |         return json(route, 200, { job_id: `job-${material.material_id}`, job_type: 'parse', subtype: 'material_parse', project_id: id,
  1523 |           material_id: material.material_id, material_version: 1, material_sha256: material.sha256, parser_version: 'synthetic-v1',
  1524 |           state: completed ? 'succeeded' : 'running', stage: completed ? 'succeeded' : 'historical_profile',
  1525 |           completed_stages: ['parse_evidence'], attempts: 1, max_attempts: 3, error_code: null,
  1526 |           outcome: completed ? 'needs_confirmation' : null, parse_status: completed ? 'needs_confirmation' : null,
  1527 |           profile_version: completed && material.role === 'historical' ? 1 : null, pending_capabilities: [], updated_at: now });
  1528 |       }
  1529 |       return route.fallback();
  1530 |     });
  1531 |     // setup's catch-all was registered last; it must fall back to the material fixture above.
  1532 |     await setup(page, state, false);
  1533 |     let selectionPosts = 0;
  1534 |     await page.route(`**/api/v1/projects/${id}/prospectus-versions**`, async route => {
  1535 |       if (route.request().method() === 'POST') {
  1536 |         expect(fixtureRequest(route.request()).version_id).toBe('source-version');
  1537 |         selectionPosts++;
  1538 |       }
  1539 |       const material = state.materials.find(m => m.role === 'historical');
  1540 |       const sourceSelected = Boolean(material);
  1541 |       const versions: Dto<'ProspectusVersionsResponse'> = {
  1542 |         project_id:id, current_version_id:sourceSelected?'source-version':null, selection_revision:sourceSelected?1:0,
  1543 |         inactive_material_ids:material&&!sourceSelected?[material.material_id]:[],
  1544 |         versions:material?[{version_id:'source-version',sequence:1,origin:'upload',filename:material.filename,sha256:material.sha256,created_at:now,
  1545 |           material_id:material.material_id,material_version:material.material_version,artifact_id:null,artifact_version:null,revision_artifact_id:null,run_id:null}]:[]
  1546 |       };
  1547 |       return json(route,200,versions);
  1548 |     });
  1549 |     const historyPicker = page.getByLabel('募集书新版本文件');
  1550 |     await expect(historyPicker).toBeEnabled();
  1551 |     await expect(page.locator('#material-recovery-status')).toContainText('尚未添加材料');
  1552 |     await historyPicker.setInputFiles({ name: '合成历史稿.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('%PDF synthetic history') });
  1553 |     const history = page.locator('.material-file-row').filter({ hasText: '合成历史稿.docx' });
  1554 |     await expect(page.locator('#prospectus-status')).toContainText('保存');
  1555 |     await expect.poll(() => releaseSave).toBeDefined(); releaseSave!();
  1556 |     await expect(history).toContainText('处理中');
  1557 |     await expect(page.locator('[data-use-version="source-version"]')).toHaveCount(0);
  1558 |     await expect(page.locator('#confirm-prospectus-selection')).toHaveCount(0);
  1559 |     expect(selectionPosts).toBe(0);
  1560 |     await page.getByLabel('为审计报告（可含报表及附注）选择文件').setInputFiles({ name: '合成财务材料.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF synthetic financial') });
  1561 |     const financial = page.locator('.material-file-row').filter({ hasText: '合成财务材料.pdf' });
  1562 |     await expect(financial.getByRole('button', { name: '重试此文件' })).toBeVisible();
  1563 |     await expect(history).toContainText('服务器已确认保存');
  1564 |     await financial.getByRole('button', { name: '重试此文件' }).click();
  1565 |     await expect(financial).toContainText('服务器已确认保存');
  1566 |     completed = true;
  1567 |     await page.getByRole('button', { name: '刷新已保存材料' }).click();
  1568 |     await expect(page.locator('.processing-title')).toHaveText(['处理完成', '处理完成']);
  1569 |     await expect(page.locator('.source-profile, [data-source-correction], a[href$="/ocr"], .workspace-evidence, .fact-review')).toHaveCount(0);
  1570 |     await expect(page.locator('#material-partitions')).not.toContainText(/evidence-|native_text|历史稿信息|核对识别内容|待确认项/);
  1571 |     expect(state.materials).toHaveLength(2);
  1572 |     expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  1573 |     if (process.env.BB_UX_EVIDENCE_DIR) {
  1574 |       const output = resolve(process.env.BB_UX_EVIDENCE_DIR); await mkdir(output, { recursive: true });
  1575 |       await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); scrollTo(0, 0); });
  1576 |       await page.screenshot({ path: join(output, `materials-${label}.png`), fullPage: true });
  1577 |     }
  1578 |     const source = history.locator('[data-source-material]');
  1579 |     await source.getByLabel('与目标发行人的关系',{exact:true}).selectOption('same_issuer');
  1580 |     await source.getByLabel('原发行市场',{exact:true}).selectOption('sse');
  1581 |     await source.getByLabel('原品种',{exact:true}).selectOption('private');
  1582 |     await source.getByRole('radio',{name:'年末',exact:true}).check();
```