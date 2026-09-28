import { expect, test } from '@playwright/test';
import { account, login } from './live-helpers';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { azureBlobs } from '../../api/dist/data.js';
import { processOcrMaterial } from '../../worker/src/ocr';

test.skip(process.env.BB_E2E_OCR !== '1', 'Requires actual Tesseract, Python, PostgreSQL and Azurite.');

test('actual Chinese OCR -> source crop -> versioned user correction -> reload -> foreign account denied', async ({page,playwright})=>{
  test.setTimeout(120000);
  const user=await account(playwright),foreign=await account(playwright);
  await login(page,user);
  const me=await (await page.request.get('/api/v1/me')).json();
  await page.getByRole('link',{name:'新建更新项目',exact:true}).first().click();
  await page.getByLabel('项目名称 必填',{exact:true}).fill('合成 OCR 原页核对');
  await page.getByRole('button',{name:'创建项目，继续提供材料'}).click();
  await expect(page.getByRole('heading',{name:'合成 OCR 原页核对',exact:true})).toBeVisible();
  const projectId=new URL(page.url()).hash.split('/').at(-1)!;
  const root=resolve('../..'),fixture=join(tmpdir(),'bondbuddy-ocr-synthetic.png');
  const python=process.env.BB_PYTHON!;
  execFileSync(python,['-c',`import sys;sys.path.insert(0,${JSON.stringify(join(root,'python/tests'))});from test_ocr import sample_image;sample_image().save(${JSON.stringify(fixture)})`],{cwd:root,env:{...process.env,PYTHONPATH:join(root,'python')}});
  const wait=page.waitForResponse(r=>r.url().endsWith('/complete')&&r.request().method()==='POST');
  await page.getByLabel('为审计报告（可含报表及附注）选择文件').setInputFiles({name:'synthetic-ocr.png',mimeType:'image/png',buffer:readFileSync(fixture)});
  const saved=await wait;expect(saved.status()).toBe(200);const materialId=(await saved.json()).material_id;
  const pool=new Pool({connectionString:process.env.BB_TEST_DATABASE_URL});
  try {
    const result=await processOcrMaterial(pool,azureBlobs(process.env.BB_TEST_AZURITE_CONNECTION_STRING!),{owner:me.user_id,projectId,materialId,version:1,requestId:`ocr-${Date.now()}`,purpose:'source_preflight',language:'chi_sim+eng',maxPages:1},{repoRoot:root,pythonExecutable:python});
    expect(result.pages).toBe(1);expect(result.eligible_for_manuscript).toBe(false);
  } finally {await pool.end();}
  const route=`/#/projects/${projectId}/materials/${materialId}/ocr`;
  await page.goto(route);
  await expect(page.getByRole('heading',{name:'材料识别核对',exact:true})).toBeVisible();
  await page.getByRole('button').filter({hasText:'1,234.50'}).first().click();
  await expect(page.getByText('框线标出本处识别范围。')).toBeVisible();
  await page.getByLabel('校正后文字或数值').fill('(1,234.60)');
  await page.getByLabel('所属期间').fill('2025 年末');
  await page.getByLabel('单位',{exact:true}).fill('万元');
  await page.getByLabel('主体与合并口径').fill('合成发行人合并口径');
  await page.getByLabel('校正依据 / 说明').fill('合成测试：核对原页后记录人工校正示例。');
  await page.getByRole('button',{name:'保存用户校正'}).click();
  await expect(page.getByText('用户校正已保存，原始识别和历史记录已保留。')).toBeVisible();
  let review=await (await page.request.get(`/api/v1/projects/${projectId}/materials/${materialId}/ocr`)).json();
  expect(review.corrections[0].status).toBe('user_asserted');expect(review.corrections[0].eligible_for_manuscript).toBe(false);
  expect(review.records.find((r:any)=>r.record_id===review.corrections[0].record_id).text).toContain('1,234.50');
  await page.reload();await page.getByRole('button').filter({hasText:'1,234.50'}).first().click();
  await expect(page.getByLabel('校正后文字或数值')).toHaveValue('(1,234.60)');
  await expect(page.locator('#ocr-crop')).toBeVisible();
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:join(tmpdir(),'bondbuddy-ocr-desktop.png')});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(tmpdir(),'bondbuddy-ocr-mobile.png'),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  await page.getByRole('button',{name:'退出',exact:true}).click();await login(page,foreign);
  expect((await page.request.get(`/api/v1/projects/${projectId}/materials/${materialId}/ocr`)).status()).toBe(404);
  expect((await page.request.get(review.pages[0].image_url)).status()).toBe(404);
});
