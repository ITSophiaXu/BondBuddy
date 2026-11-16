import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fixture,install,route,historical,word} from './qa-result-next-fixtures';
import {answerId,prepareId,writes} from './project-qa-continuation-fixtures';

for(const width of [1440,390])test(`document QA: upload and delivery at ${width}`,async({page})=>{
  const s=fixture();
  s.workspace.draft={preparation_id:null,questions:[],materials:[],requirements:'',use_knowledge:false};
  const answers=structuredClone(s.workspace.runs);
  s.workspace.runs=s.workspace.runs.filter(run=>run.run_id===prepareId);
  await install(page,s);await page.setViewportSize({width,height:width===390?844:960});
  await page.goto(route(null));
  await expect(page.getByRole('heading',{name:'上传问题清单',exact:true})).toBeVisible();
  await expect(page.locator('#qa-upload')).toHaveAttribute('accept','.docx,.doc,.pdf');
  await expect(page.locator('.qa-document')).toHaveCount(0);
  await expect(page.locator('#qa-history')).toBeHidden();
  await expect(page.locator('#qa-history option')).toHaveCount(1);
  await expect(page.locator('#qa-history')).not.toContainText('识别问题');
  await expect(page.locator('.qa-page .pf-source-strip')).toHaveCount(0);
  await expect(page.locator('.qa-page #qa-assistant,.qa-page .bb-assistant,.qa-page #qa-agent')).toHaveCount(0);
  await expect(page.locator('.qa-page')).not.toContainText('与 BondBuddy 讨论');
  await expect(page.getByRole('button',{name:'打开 BondBuddy',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  const dir=process.env.BB_UX_EVIDENCE_DIR;
  if(dir){
    await mkdir(dir,{recursive:true});await page.screenshot({path:join(dir,`qa-upload-${width}.png`),fullPage:true});
    await page.locator('.qa-page').screenshot({path:join(dir,`qa-upload-component-${width}.png`)});
    const componentWidth=(await page.locator('.qa-page').boundingBox())!.width,reference=await page.context().newPage();
    await reference.setViewportSize({width,height:width===390?844:960});
    await reference.goto('/@fs/'+resolve(process.cwd(),'../../product-prototype/public/qa-document.html').replaceAll('\\','/'));
    await reference.locator('main').evaluate((node,w)=>{node.style.width=w+'px';node.style.maxWidth='none';node.style.padding='0';},componentWidth);
    await reference.locator('[data-view="upload"]').screenshot({path:join(dir,`qa-upload-prototype-${width}.png`)});
    await reference.close();
  }
  await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();
  await expect(page.locator('.bb-assistant')).not.toHaveClass(/ba-embedded/);
  await expect(page.locator('#ba-panel')).toBeVisible();
  await page.getByRole('button',{name:'收起助手',exact:true}).click();
  await expect(page.locator('#ba-panel')).toBeHidden();
  s.workspace.runs=answers;await page.goto(route(answerId));
  await expect(page.getByRole('button',{name:'下载回答文档（Word）',exact:true})).toBeVisible();
  const missing=page.getByRole('region',{name:'待补材料清单'});
  await expect(missing).toContainText('2 个问题待补充');
  await expect(missing).toContainText('请补充偿债资金与现金流安排。');
  await expect(missing).toContainText('请补充关联交易明细及定价依据。');
  await expect(missing.locator('h4')).toHaveText([/问题 1.*偿债资金来源/s,/问题 3.*关联交易/s]);
  expect((await missing.boundingBox())!.y).toBeLessThan((await page.locator('.qa-answer').first().boundingBox())!.y);
  await expect(page.locator('.qa-answer[open]')).toHaveCount(0);
  await expect(page.locator('.qa-followup')).not.toHaveAttribute('open');
  const download=page.waitForEvent('download');await page.locator('#qa-download').click();
  expect((await download).suggestedFilename()).toBe(word(s).metadata.filename);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  if(dir){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:join(dir,`qa-result-${width}.png`),fullPage:true});}
  await page.locator('#qa-prepare-next').click();await expect(page.locator('.qa-followup')).toHaveAttribute('open');
  await expect(page.locator('#qa-followup-heading')).toBeFocused();
  expect(writes(s)).toEqual([]);expect(s.errors).toEqual([]);expect(s.unexpected).toEqual([]);
});

test('document QA: PDF source upload starts only free preparation',async({page})=>{
  const s=fixture();s.allowUploads=true;
  s.workspace.draft={preparation_id:null,questions:[],materials:[],requirements:'',use_knowledge:false};
  await install(page,s);await page.goto(route(null));
  await page.locator('#qa-upload').setInputFiles({name:'合成问题清单.PDF',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 synthetic browser transport fixture')});
  await expect.poll(()=>s.prepares.length).toBe(1);
  expect(s.uploads[0].media_type).toBe('application/pdf');
  expect(s.prepares[0].source.pin.sha256).toBe(s.uploads[0].sha256);
  expect(s.answers).toEqual([]);expect(s.drafts).toEqual([]);
  await expect(page.locator('.qa-run-head')).toContainText('问题整理，包含在回复任务内');
  await expect(page.locator('.qa-run-head')).toContainText('本次尚未扣费');
  expect(s.accepted.get(`prepare:${s.prepares[0].request_id}`)).toMatchObject({
    run:{operation:'prepare',manifest:{operation:'prepare',points:0},reserved_points:0,charged_points:0},
    generic:{reservation_id:null}
  });
  await expect(page.locator('.qa-missing-list')).toHaveCount(0);
  expect(s.errors).toEqual([]);expect(s.unexpected).toEqual([]);
});

test('document QA: missing checklist includes unresolved drafts and unanswered questions',async({page})=>{
  const s=fixture(),run=historical(s);
  run.result!.answers=run.result!.answers.filter(a=>a.question_id!=='q2');
  const draft=run.result!.answers.find(a=>a.question_id==='q4')!;draft.missing_materials=['请补充收入明细表。'];
  await install(page,s);await page.goto(route());
  const missing=page.getByRole('region',{name:'待补材料清单'});
  await expect(missing).toContainText('3 个问题待补充');
  await expect(missing).toContainText('本题尚未形成具体材料建议');
  await expect(missing).toContainText('请补充收入明细表。');
  expect(writes(s)).toEqual([]);
});
