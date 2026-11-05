import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture,install,route,historical,registerWord} from './qa-result-next-fixtures';
import {writes} from './project-qa-continuation-fixtures';

for(const width of [1440,390])test(`prospectus answer table retains facts and only its local gap at ${width}`,async({page})=>{
 const s=fixture(),run=historical(s),answer=run.result!.answers.find(a=>a.question_id==='q4')!;
 answer.answer='募集说明书披露，营业收入由2024年的100万元增至2025年的120万元，增加20万元，增幅20%（20÷100）。\n\n单位：万元\n| 项目 | 2024年 | 2025年 |\n| --- | ---: | ---: |\n| 营业收入 | 100 | 120 |\n| 其他收入 | 0 | - |\n\n附注：主营业务收入增长来自销量增加。\n【待确认：2026年10月末期后回款金额】';
 answer.status='missing';answer.missing_materials=['2026年10月末期后回款金额。'];answer.approach='';registerWord(s);
 await install(page,s);await page.setViewportSize({width,height:960});await page.goto(route());
 const details=page.locator('[data-qa-answer-question="q4"]');await details.locator('summary').click();
 await expect(details.locator('table')).toHaveCount(1);await expect(details.locator('thead')).toContainText('2024年');
 await expect(details.locator('tbody tr')).toHaveCount(2);await expect(details).toContainText('单位：万元');
 await expect(details).toContainText('增幅20%');await expect(details.locator('.qa-warning li')).toHaveCount(1);
 expect(answer.citations.length).toBeGreaterThan(0);
 await expect(details.locator('.qa-citation')).toHaveCount(0);
 await expect(details).not.toContainText(run.result!.evidence[0].snapshot.spans[0].text);
 await expect(details).not.toContainText('回答思路');expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 const dir=process.env.BB_UX_EVIDENCE_DIR;
 if(dir){await mkdir(dir,{recursive:true});await details.screenshot({path:join(dir,`answer-table-${width}.png`)});
  const ref=await page.context().newPage();await ref.setViewportSize({width,height:960});await ref.goto('/@fs/'+fileURLToPath(new URL('../../../product-prototype/public/qa-materials.html',import.meta.url)).replaceAll('\\','/'));
  await ref.getByRole('button',{name:'回答与补件',exact:true}).click();const bounds=await details.boundingBox();await ref.locator('.qa-answer').last().evaluate((el,w)=>el.style.width=w+'px',bounds!.width);await ref.locator('.qa-answer').last().screenshot({path:join(dir,`prototype-table-${width}.png`)});await ref.close();}
 expect(writes(s)).toEqual([]);expect(s.errors).toEqual([]);expect(s.unexpected).toEqual([]);
});

test('answer rendering escapes HTML and does not execute content in a table',async({page})=>{
 const s=fixture(),answer=historical(s).result!.answers.find(a=>a.question_id==='q4')!;
 answer.answer='|项目|金额|\n|---|---|\n|<img src=x onerror=alert(1)>|<script>alert(1)</script>|';registerWord(s);
 let dialogs=0;page.on('dialog',async dialog=>{dialogs++;await dialog.dismiss();});
 await install(page,s);await page.goto(route());const details=page.locator('[data-qa-answer-question="q4"]');await details.locator('summary').click();
 await expect(details.locator('table')).toContainText('<script>alert(1)</script>');await expect(details.locator('img,script')).toHaveCount(0);expect(dialogs).toBe(0);
});
