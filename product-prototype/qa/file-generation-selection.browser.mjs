import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.BB_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BB_TEMPLATE_DESIGN_URL || 'http://127.0.0.1:4386';
const output = resolve(process.env.BB_TEMPLATE_DESIGN_EVIDENCE || 'test-evidence/file-generation-selection-20261113/prototype');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BB_E2E_BROWSER_CHANNEL || 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const passed = [], errors = [], mutations = [], measurements = [];
page.on('pageerror', e => errors.push(e.message));
page.on('request', r => { if (!['GET','HEAD'].includes(r.method()) || /\/api\//.test(r.url())) mutations.push(r.url()); });
const check = async (name, fn) => { await fn(); passed.push(name); console.log('PASS '+name); };
try {
  await page.goto(`${base}/file-templates-v2.html`);
  await check('13 choices and four groups are present without expanding menus', async () => {
    assert.equal(await page.locator('[data-type]').count(), 13);
    assert.equal(await page.locator('.choice-group').count(), 4);
    assert.equal(await page.locator('[data-action="more-types"], [data-action="more"]').count(), 0);
    for (const input of await page.locator('[data-type]').all()) assert.equal(await input.isVisible(), true);
  });
  await check('group selection toggles counts and keeps other groups unchanged', async () => {
    await page.locator('[data-group="filing"]').click();
    assert.equal(await page.locator('.choice-group').nth(1).locator('input:checked').count(), 4);
    assert.equal(await page.locator('.choice-group').nth(1).locator('.choice-group-count').innerText(), '4/4');
    assert.equal(await page.locator('[data-group="filing"]').innerText(), '取消全选');
    assert.equal(await page.locator('.choice-group').first().locator('input:checked').count(), 0);
    await page.locator('[data-type="application"]').uncheck();
    assert.equal(await page.locator('.choice-group').nth(1).locator('.choice-group-count').innerText(), '3/4');
    await page.locator('[data-group="filing"]').click();
    await page.locator('[data-group="filing"]').click();
    assert.equal(await page.locator('.choice-group').nth(1).locator('input:checked').count(), 0);
  });
  await check('clear preserves requirements and supporting materials', async () => {
    await page.locator('#requirements').fill('合成验收要求：目标期间 2026 年，金额单位万元。');
    await page.locator('#support-files').setInputFiles({ name:'synthetic-support.pdf',mimeType:'application/pdf',buffer:Buffer.from('synthetic UI filename only') });
    await page.locator('[data-group="diligence"]').click();
    await page.locator('[data-action="clear-types"]').click();
    assert.equal(await page.locator('[data-type]:checked').count(), 0);
    assert.equal(await page.locator('#batch-count').innerText(), '0');
    assert.equal(await page.locator('[data-action="next"]').isDisabled(), true);
    assert.equal(await page.locator('#requirements').inputValue(), '合成验收要求：目标期间 2026 年，金额单位万元。');
    assert.equal(await page.locator('[data-remove-material]').count(), 1);
    assert.equal(await page.locator('[data-action="clear-types"]').isDisabled(), true);
    assert.equal(await page.locator('[data-type]').count(), 13);
  });
  await check('keyboard toggles focused choice without losing focus', async () => {
    await page.locator('[data-type="more-6"]').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('[data-type="more-6"]').isChecked(), true);
    assert.equal(await page.locator('[data-type="more-6"]').evaluate(el=>el===document.activeElement), true);
    await page.keyboard.press('Space');
    assert.equal(await page.locator('[data-type="more-6"]').isChecked(), false);
  });
  await check('all seven formerly hidden types remain selectable with template guidance', async () => {
    for(let i=0;i<7;i++) await page.locator(`[data-type="more-${i}"]`).check();
    assert.equal(await page.locator('.general-row').count(),7);
    assert.equal(await page.locator('[data-general-upload]').count(),7);
    assert.equal(await page.locator('#batch-count').innerText(),'7');
    await page.locator('[data-action="clear-types"]').click();
  });
  for(const width of [1440,1024,768,520,390,320]){
    await page.setViewportSize({width,height:width<600?844:1000});
    await check(`${width}px choice layout, spacing and equal action targets`, async()=>{
      const m = await page.evaluate(()=>{
        const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
        const a=box('.supporting-actions .file-label'),b=box('[data-action="save-preparation"]');
        return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,upload:a,save:b,panelGap:box('.supporting-panel').y-box('.file-choice-panel').bottom,columns:getComputedStyle(document.querySelector('.choice-group .file-choices')).gridTemplateColumns.split(' ').length,choices:[...document.querySelectorAll('.file-choice-panel .choice')].map(e=>{const r=e.getBoundingClientRect();return {height:r.height,right:r.right};})};
      });
      assert.ok(m.scrollWidth<=m.width,JSON.stringify(m));
      assert.equal(m.columns,width<=500?1:2);
      assert.ok(m.panelGap>=16);
      assert.ok(m.upload.height>=44&&m.save.height>=44);
      assert.ok(Math.abs(m.upload.height-m.save.height)<=1);
      if(width>600){assert.ok(Math.abs(m.upload.y-m.save.y)<=1);assert.ok(m.save.x-m.upload.right>=12);}
      assert.ok(m.choices.every(c=>c.height>=44&&c.right<=width));
      measurements.push(m);
      await page.evaluate(()=>window.scrollTo(0,0));
      await page.screenshot({path:`${output}/selection-${width}.png`,fullPage:true});
    });
  }
  assert.deepEqual(errors,[]);assert.deepEqual(mutations,[]);
  await writeFile(`${output}/result.json`,JSON.stringify({passed:passed.length,cases:passed,measurements,pageErrors:errors,mutationRequests:mutations,boundary:'Synthetic prototype only; no API, uploads, model, tasks or billing.'},null,2));
  console.log(`${passed.length} checks passed; no product mutation requests.`);
}finally{await browser.close();}
