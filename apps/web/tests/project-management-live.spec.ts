import { expect, test } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { account, login, origin } from './live-helpers';

test.skip(process.env.BB_E2E_LIVE !== '1','Requires the dedicated real API, PostgreSQL and Azurite.');

test('global issuer search beyond first page, filters, archive and saved material survive a new browser session',async({page,playwright,browser})=>{
  test.setTimeout(90_000);
  const user=await account(playwright);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await login(page,user);
  const csrf=(await page.context().cookies()).find(cookie=>cookie.name==='bb_csrf')!.value;
  const headers={Origin:origin,'X-BB-CSRF':csrf};
  const target=await page.request.post('/api/v1/projects',{headers,data:{name:'合成验收 · 历史项目',kind:'update',issuer_name:'远页目标发行人有限公司',market:'sse',offering:'private'}});
  expect(target.status()).toBe(201);const project=(await target.json()).project_id;
  for(let i=0;i<51;i++){
    const created=await page.request.post('/api/v1/projects',{headers,data:{name:`分页验收 ${i}`,kind:'update',issuer_name:'普通合成发行人',market:null,offering:null}});
    expect(created.status()).toBe(201);
  }
  await page.reload();
  await expect(page.locator('#list-count')).toContainText('显示 30 / 52 个项目');
  await expect(page.getByRole('link',{name:'合成验收 · 历史项目',exact:true})).toHaveCount(0);
  await page.getByLabel('搜索项目名称或发行人').fill('远页目标');
  await expect(page.getByRole('link',{name:'合成验收 · 历史项目',exact:true})).toBeVisible();
  await expect(page.locator('#list-count')).toContainText('显示 1 / 1 个项目');
  await page.locator('[data-group=active]').click();
  await expect(page.getByRole('heading',{name:'没有找到匹配的项目'})).toBeVisible();
  await page.locator('[data-group=attention]').click();
  await expect(page.getByRole('link',{name:'合成验收 · 历史项目',exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('搜索项目名称或发行人')).toHaveValue('远页目标');
  await expect(page.locator('[data-group=attention]')).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('link',{name:'合成验收 · 历史项目',exact:true})).toBeVisible();
  await page.locator('[data-work]').click();await page.getByRole('menuitem',{name:'更新募集书'}).click();
  const { pdfSample, PDF }=await import('../../api/dist/upload-safety.samples.js');
  const persisted=page.waitForResponse(response=>response.url().includes(`/projects/${project}/materials/uploads/`) && response.url().endsWith('/complete') && response.request().method()==='POST');
  const fileInput=page.getByLabel('为审计报告（可含报表及附注）选择文件');
  // setInputFiles can select a disabled control; wait until the real user can upload.
  await expect(fileInput).toBeEnabled();
  await fileInput.setInputFiles({name:'archive-recovery.pdf',mimeType:PDF,buffer:pdfSample()});
  expect((await persisted).status()).toBe(200);
  await expect(page.locator('.material-file-row').filter({hasText:'archive-recovery.pdf'})).toContainText('服务器已确认保存');
  await page.getByRole('link',{name:'任务进度与结果',exact:true}).click();
  await page.getByLabel('搜索项目名称或发行人').fill('远页目标');
  await page.locator('[data-work]').click();await page.getByRole('menuitem',{name:'归档项目'}).click();
  await expect(page.getByRole('heading',{name:'没有找到匹配的项目'})).toBeVisible();
  await page.getByLabel('项目范围',{exact:true}).selectOption('archived');
  await expect(page.getByRole('link',{name:'合成验收 · 历史项目',exact:true})).toBeVisible();
  await page.setViewportSize({width:1440,height:960});
  await page.screenshot({path:join(tmpdir(),'bondbuddy-issue10-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:join(tmpdir(),'bondbuddy-issue10-mobile.png'),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.context().close();
  const reopened=await browser.newContext({baseURL:origin,ignoreHTTPSErrors:true});
  try {
    const next=await reopened.newPage();await login(next,user);
    await next.getByLabel('项目范围',{exact:true}).selectOption('archived');
    await expect(next.getByRole('link',{name:'合成验收 · 历史项目',exact:true})).toBeVisible();
    await next.locator('[data-work]').click();await next.getByRole('menuitem',{name:'恢复项目'}).click();
    await expect(next.getByRole('heading',{name:'没有找到匹配的项目'})).toBeVisible();
    await next.getByLabel('项目范围',{exact:true}).selectOption('active');
    await next.getByLabel('搜索项目名称或发行人').fill('远页目标');
    await next.locator('[data-work]').click();await next.getByRole('menuitem',{name:'更新募集书'}).click();
    await expect(next.getByLabel('发行人全称')).toHaveValue('远页目标发行人有限公司');
    await expect(next.locator('.persisted-material')).toContainText('archive-recovery.pdf');
    expect(await next.evaluate(()=>({local:localStorage.length,session:sessionStorage.length}))).toEqual({local:0,session:0});
  } finally {await reopened.close();}
});

test('recent Word button downloads the previous successful bytes while the latest run failed',async({page,playwright})=>{
  test.skip(!process.env.BB_TEST_DATABASE_URL || !process.env.BB_TEST_AZURITE_CONNECTION_STRING,'Requires the dedicated DB/Blob writer for a synthetic successful Word fixture; no model is called.');
  const { Pool }=await import('pg');
  const { createServer }=await import('../../api/dist/server.js');
  const { azureBlobs }=await import('../../api/dist/data.js');
  const { claim,finish,promoteWordArtifact }=await import('../../api/dist/queue.js');
  const { makeSyntheticDocxFixture }=await import('../../api/dist/docx-fixtures.js');
  const { readFile }=await import('node:fs/promises');
  const { randomUUID }=await import('node:crypto');
  await login(page,await account(playwright));
  const user=(await (await page.request.get('/api/v1/me')).json()).user_id;
  const pool=new Pool({connectionString:process.env.BB_TEST_DATABASE_URL});
  const blobs=azureBlobs(process.env.BB_TEST_AZURITE_CONNECTION_STRING!);
  const synthetic=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:user,csrfVerified:true}),enableSyntheticQueue:true});
  const send=(url:string,payload:unknown)=>synthetic.inject({method:'POST',url,headers:{origin},payload});
  try {
    const project=(await send('/api/v1/projects',{name:'合成成果下载验收',kind:'update',issuer_name:'合成发行人',market:null,offering:null})).json();
    const input=(await send(`/api/v1/projects/${project.project_id}/input-revisions`,{draft_revision:1,material_versions:[],requirement_message_ids:[]})).json();
    const execution={execution_request_id:randomUUID(),project_id:project.project_id,input_revision:1,input_hash:input.input_hash,task_kind:'update',input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic'};
    const submitted=await send('/api/v1/runs/execute',execution);expect(submitted.statusCode).toBe(202);
    const lease=await claim(pool,30);expect(lease?.runId).toBe(submitted.json().run_id);
    const bytes=makeSyntheticDocxFixture();
    const artifact=await promoteWordArtifact(pool,lease!,bytes,blobs);
    await finish(pool,lease!,'succeeded',{artifactId:artifact.artifactId,artifactVersion:artifact.artifactVersion,blobs});
    const failed=await send('/api/v1/runs/execute',{...execution,execution_request_id:randomUUID()});expect(failed.statusCode).toBe(202);
    const nextLease=await claim(pool,30);expect(nextLease?.runId).toBe(failed.json().run_id);
    await finish(pool,nextLease!,'failed',{errorCode:'DATA_UNAVAILABLE'});
    await page.reload();await expect(page.getByRole('link',{name:'合成成果下载验收',exact:true})).toBeVisible();
    await expect(page.locator('.collection-recent')).toContainText('本次未完成');await page.getByRole('link',{name:'项目文件',exact:true}).click();
    const downloading=page.waitForEvent('download');
    await page.getByRole('button',{name:'下载',exact:true}).click();
    const download=await downloading;expect(await download.failure()).toBeNull();
    expect(await readFile((await download.path())!)).toEqual(bytes);
    expect((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1',[user])).rows[0].n).toBe(2);
  } finally {await synthetic.close();await pool.end();}
});
