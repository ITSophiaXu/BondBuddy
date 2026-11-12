import { expect, test } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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
  const uploadBytes=pdfSample();
  const persisted=page.waitForResponse(response=>response.url().includes(`/projects/${project}/materials/uploads/`) && response.url().endsWith('/complete') && response.request().method()==='POST' && response.status()===200);
  const fileInput=page.getByLabel('为审计报告（可含报表及附注）选择文件');
  // setInputFiles can select a disabled control; wait until the real user can upload.
  await expect(fileInput).toBeEnabled();
  await fileInput.setInputFiles({name:'archive-recovery.pdf',mimeType:PDF,buffer:uploadBytes});
  const completed=await persisted;
  expect(completed.status()).toBe(200);
  const material=await completed.json();
  expect(material).toMatchObject({material_id:expect.any(String),material_version:1,upload_id:expect.any(String),
    sha256:createHash('sha256').update(uploadBytes).digest('hex'),byte_size:uploadBytes.length});
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
    const saved=await next.evaluate(async path=>{
      const response=await fetch(path);
      return {status:response.status,body:await response.json()};
    },`/api/v1/projects/${project}/materials/${material.material_id}?version=${material.material_version}`);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({material_id:material.material_id,material_version:material.material_version,
      upload_id:material.upload_id,sha256:material.sha256,byte_size:material.byte_size});
    expect(await next.evaluate(()=>({local:localStorage.length,session:sessionStorage.length}))).toEqual({local:0,session:0});
  } finally {await reopened.close();}
});

test('recent Word button downloads the previous successful bytes while the latest run failed',async({page,playwright})=>{
  test.skip(!process.env.BB_TEST_DATABASE_URL || !process.env.BB_TEST_AZURITE_CONNECTION_STRING,'Requires the dedicated DB/Blob writer for a synthetic successful Word fixture; no model is called.');
  const { Pool }=await import('pg');
  const { createServer }=await import('../../api/dist/server.js');
  const { azureBlobs,digest,transaction }=await import('../../api/dist/data.js');
  const { claim,finish,promoteWordArtifact,checkpointStage }=await import('../../api/dist/queue.js');
  const { grantCredits }=await import('../../api/dist/billing.js');
  const { emptyUpdateDetails,reportingWindow }=await import('@bondbuddy/contracts');
  const { makeSyntheticDocxFixture }=await import('../../api/dist/docx-fixtures.js');
  const { readFile }=await import('node:fs/promises');
  const { randomUUID }=await import('node:crypto');
  await login(page,await account(playwright));
  const user=(await (await page.request.get('/api/v1/me')).json()).user_id;
  const pool=new Pool({connectionString:process.env.BB_TEST_DATABASE_URL});
  const blobs=azureBlobs(process.env.BB_TEST_AZURITE_CONNECTION_STRING!);
  const synthetic=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:user,csrfVerified:true}),enableSyntheticQueue:true,enableRunRuntime:false});
  const send=(url:string,payload:unknown)=>synthetic.inject({method:'POST',url,headers:{origin},payload});
  const get=(url:string)=>synthetic.inject({method:'GET',url});
  try {
    // The fixture uses the real API, queue, DB and Azurite. Its DOCX bytes and
    // test-only wallet grant are synthetic; no provider/model or payment is called.
    const created=await send('/api/v1/projects',{name:'合成成果下载验收',kind:'update',issuer_name:'合成发行人',market:'sse',offering:'private',
      update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1',reporting_cutoff:'2026-09-30'}});
    expect(created.statusCode,created.body).toBe(201);
    const project=created.json(),projectPath=`/api/v1/projects/${project.project_id}`;
    const sourceBytes=makeSyntheticDocxFixture({text:'Synthetic historical prospectus for previous-result download'});
    const declaration={byte_size:sourceBytes.length,sha256:digest(sourceBytes)};
    const upload=await send(`${projectPath}/materials/uploads`,{...declaration,filename:'synthetic-history.docx',
      media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',role:'historical'});
    expect(upload.statusCode,upload.body).toBe(201);
    const put=await synthetic.inject({method:'PUT',url:upload.json().upload_url,
      headers:{origin,'content-type':'application/octet-stream'},payload:sourceBytes});
    expect(put.statusCode,put.body).toBe(204);
    const completed=await send(`${projectPath}/materials/uploads/${upload.json().upload_id}/complete`,declaration);
    expect(completed.statusCode,completed.body).toBe(200);
    const source=completed.json();
    expect(source).toMatchObject({...declaration,material_id:expect.any(String),material_version:1,upload_id:upload.json().upload_id});
    const current=await get(projectPath);expect(current.statusCode,current.body).toBe(200);
    const saved=await synthetic.inject({method:'PATCH',url:projectPath,
      headers:{origin,'if-match':String(current.json().draft_revision)},payload:{update_details:{...current.json().update_details,
        source_prospectuses:[{material_id:source.material_id,material_version:source.material_version,sha256:source.sha256,
          issuer_name:'合成发行人',relation:'same_issuer',market:'sse',offering:'private',
          reporting_periods:reportingWindow('sse','private','2025-12-31'),status:'user_asserted'}]}}});
    expect(saved.statusCode,saved.body).toBe(200);
    const prepareExecution=async()=>{
      const current=await get(projectPath);expect(current.statusCode,current.body).toBe(200);
      const selection=await get(`${projectPath}/prospectus-versions`);expect(selection.statusCode,selection.body).toBe(200);
      const locked=await send(`${projectPath}/input-revisions`,{draft_revision:current.json().draft_revision,
        prospectus_selection_revision:selection.json().selection_revision,
        material_versions:[{material_id:source.material_id,material_version:source.material_version}],requirement_message_ids:[]});
      expect(locked.statusCode,locked.body).toBe(201);
      const input=locked.json();
      const quoted=await send(`${projectPath}/credit-quote`,{input_revision:input.input_revision,input_hash:input.input_hash});
      expect(quoted.statusCode,quoted.body).toBe(200);
      const quote=quoted.json().quote;
      expect(quote).toMatchObject({project_id:project.project_id,input_revision:input.input_revision,input_hash:input.input_hash,
        auto_charge:true,quote_status:'ready'});
      expect(quote.points).toMatch(/^[1-9][0-9]*$/);
      await transaction(pool,c=>grantCredits(c,{owner:user,source:'existing_grant',key:`synthetic-download-${input.input_hash}`,
        points:quote.points,expiresAt:null,actor:'synthetic-browser-test',reason:'Dedicated local previous-result download fixture; no real payment'}));
      return {execution_request_id:randomUUID(),project_id:project.project_id,input_revision:input.input_revision,input_hash:input.input_hash,
        task_kind:'update',input_manifest_ref:input.input_hash,storage_origin:'cloud',workspace_id:project.project_id,quote_id:quote.quote_id};
    };
    const execution=await prepareExecution();
    const submitted=await send('/api/v1/runs/execute',execution);expect(submitted.statusCode,submitted.body).toBe(202);
    const lease=await claim(pool,30);expect(lease?.runId).toBe(submitted.json().run_id);
    const bytes=makeSyntheticDocxFixture();
    const artifact=await promoteWordArtifact(pool,lease!,bytes,blobs);
    const clean=await promoteWordArtifact(pool,lease!,makeSyntheticDocxFixture({text:'Synthetic clean previous result'}),blobs);
    const baseline=await promoteWordArtifact(pool,lease!,sourceBytes,blobs);
    expect(artifact.status).toBe('available');expect(clean.status).toBe('available');expect(baseline.status).toBe('available');
    // Schema-compatible synthetic pair metadata, not writer/model acceptance evidence.
    await checkpointStage(pool,lease!,'word_delivery_pair',{revision_artifact_id:artifact.artifactId,clean_artifact_id:clean.artifactId,
      baseline_artifact_id:baseline.artifactId,writer_version:'bondbuddy-word-delivery-1.0.0',source_sha256:source.sha256,
      baseline_hash:null,effective_baseline_sha256:null,plan_hash:null,replacements:null,columns:null,pending:0,pending_review:[],
      baseline_kind:'uploaded_source',source_issuer:'合成发行人',authoring_summary:['纯合成下载回归数据，未调用模型或生成 writer。']});
    await finish(pool,lease!,'succeeded',{artifactId:artifact.artifactId,artifactVersion:artifact.artifactVersion,blobs});
    const successful=await get(`/api/v1/runs/${submitted.json().run_id}`);expect(successful.statusCode,successful.body).toBe(200);
    expect(successful.json()).toMatchObject({state:'succeeded',artifact_id:artifact.artifactId,channel:'production'});
    // Successful completion adopts the clean output. Lock and quote the current
    // selection for the next run instead of replaying the now-stale input/quote.
    const failed=await send('/api/v1/runs/execute',await prepareExecution());expect(failed.statusCode,failed.body).toBe(202);
    const nextLease=await claim(pool,30);expect(nextLease?.runId).toBe(failed.json().run_id);
    await finish(pool,nextLease!,'failed',{errorCode:'DATA_UNAVAILABLE'});
    const latest=await get(`/api/v1/runs/${failed.json().run_id}`);expect(latest.statusCode,latest.body).toBe(200);
    expect(latest.json()).toMatchObject({state:'failed',artifact_id:null});
    await page.reload();await expect(page.getByRole('link',{name:'合成成果下载验收',exact:true})).toBeVisible();
    const row=page.locator(`.collection-project[data-project-id="${project.project_id}"]`);
    await expect(row.locator('.collection-recent').first()).toContainText('本次未完成');
    const result=row.getByRole('link',{name:'查看结果',exact:true});
    await expect(result).toHaveAttribute('href',`#/artifacts/${artifact.artifactId}`);
    await result.click();
    await expect(page).toHaveURL(new RegExp(`#/artifacts/${artifact.artifactId}$`));
    const downloading=page.waitForEvent('download');
    await page.getByRole('button',{name:'下载修订版',exact:true}).click();
    const download=await downloading;expect(await download.failure()).toBeNull();
    expect(await readFile((await download.path())!)).toEqual(bytes);
    expect((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1',[user])).rows[0].n).toBe(2);
  } finally {await synthetic.close();await pool.end();}
});
