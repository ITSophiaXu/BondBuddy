import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.BB_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BB_TEMPLATE_DESIGN_URL || 'http://127.0.0.1:4379';
const output = resolve(process.env.BB_TEMPLATE_DESIGN_EVIDENCE || 'test-evidence/file-template-design');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BB_E2E_BROWSER_CHANNEL || 'msedge', headless: true });
const passed = [], failures = [], networkErrors = [], mutations = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', error => failures.push(error.message));
page.on('response', response => { if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) networkErrors.push(response.url()); });
page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method()) || /\/api\//.test(request.url())) mutations.push(request.url()); });
const click = selector => page.locator(selector).click();
const check = async (name, fn) => { await fn(); passed.push(name); console.log(`PASS ${name}`); };
const body = () => page.locator('body').innerText();
const reset = () => click('#reset-demo');
const demoSource = async () => { await click('.source-strip [data-action="source"]'); await click('[data-action="demo-source"]'); };
const capture = async (name, fullPage = false) => {
  await page.locator('#toast').waitFor({state:'hidden',timeout:6000});
  if(fullPage)await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:`${output}/${name}.png`,fullPage});
};
try {
  await page.goto(`${base}/file-templates-v2.html`);
  const fixture = await page.evaluate(() => ({ real: window.BB_TEMPLATE_DATA.real, entries: window.BB_TEMPLATE_DATA.entries }));
  await check('目录保留全部原编号条目，歧义候选不默认取第一份', async () => {
    assert.equal(await page.locator('[data-row]').count(), fixture.entries.length);
    for (const e of fixture.entries.filter(e => e.candidates.length > 1)) assert.equal(await page.locator(`[data-map="${e.id}"]`).inputValue(), '');
  });
  await capture('prepare-1440',true);
  await page.locator('#pack-setup').scrollIntoViewIfNeeded();
  await capture('selection-1440');
  await check('整套入口明确提供目录和模板两张卡片，匹配明细默认折叠',async()=>{
    assert.equal(await page.locator('[data-source-card]').count(),2);
    assert.equal(await page.locator('#scope-review').getAttribute('open'),null);
    await click('[data-action="preview-directory"]');
    assert.equal(await page.locator('.catalogue-row').count(),fixture.entries.length);
    assert.equal(await page.locator('.preview-pages').count(),0);
    await click('#done-catalogue');
    await click('#scope-review > summary');
  });
  await check('集中查看待指定项并保持选中范围', async () => {
    await click('[data-filter="unresolved"]');
    assert.equal(await page.locator('[data-row]').count(), fixture.entries.filter(e=>e.candidates.length !== 1).length);
    assert.equal(Number(await page.locator('#scope-selected').innerText()), fixture.entries.length);
    await click('[data-filter="all"]');
    const firstRow=page.locator('[data-row]').first();
    await firstRow.uncheck();
    assert.match(await page.locator('#scope-summary-count').innerText(),new RegExp(`已选 ${fixture.entries.length-1} 项`));
    await firstRow.check();
  });
  await check('模板正文预览及为单个条目指定模板', async () => {
    const row=fixture.entries.find(e=>e.candidates.length>1);
    await click(`[data-choose-template="${row.id}"]`);
    await click('[data-preview-tab="text"]');
    assert.ok((await page.locator('.text-preview').innerText()).length>5);
    await click(`[data-template-id="${row.candidates[1]}"]`);
    await click('#use-template');
    assert.equal(await page.locator(`[data-map="${row.id}"]`).inputValue(), row.candidates[1]);
    assert.equal(await page.locator('dialog[open]').count(),0);
  });
  await check('仅更换目录时保留光大模板，来源分别标明',async()=>{
    await click('[data-action="replace-directory"]');
    assert.equal(await page.locator('#directory-rows').count(),0);
    assert.ok(await page.locator('#directory-file').count());
    assert.match(await page.locator('[data-source-card="templates"]').innerText(),/光大证券 · 公司债底稿模板/);
    assert.match(await page.locator('.setup-summary').innerText(),/当前目录：尚未选择/);
    await click('[data-part="directory"][data-mode="builtin"]');
    assert.equal(await page.locator('[data-row]').count(),fixture.entries.length);
    await click('[data-action="replace-templates"]');
    assert.match(await page.locator('[data-source-card="directory"]').innerText(),/光大证券 · 尽职调查目录/);
    assert.equal(await page.locator('#archive-file').count(),1);
  });
  await check('目录与模板包同页选择，未解析状态不能进入生成',async()=>{
    await click('[data-library="custom"]');
    await page.locator('#directory-file').setInputFiles({name:'synthetic-catalogue.xlsx',mimeType:'application/octet-stream',buffer:Buffer.from('synthetic UI filename only')});
    await page.locator('#archive-file').setInputFiles({name:'synthetic-templates.zip',mimeType:'application/zip',buffer:Buffer.from('synthetic UI filename only')});
    assert.match(await body(),/synthetic-catalogue.xlsx/);
    assert.match(await body(),/synthetic-templates.zip/);
    assert.equal(await page.locator('#directory-rows').count(),0);
    await demoSource();await click('[data-action="next"]');
    assert.match(await page.locator('[role="alert"]').innerText(),/尚未读取/);
    await capture('upload-1440',true);
    await click('.prototype-controls > summary');
    await click('[data-action="simulate-match"]');
    assert.equal(await page.locator('[data-row]').count(), fixture.entries.length);
    assert.match(await body(),/非上传结果/);
    await page.locator('#directory-file').setInputFiles({name:'synthetic-next-catalogue.xlsx',mimeType:'application/octet-stream',buffer:Buffer.from('next synthetic UI filename only')});
    assert.equal(await page.locator('#directory-rows').count(),0);
    assert.doesNotMatch(await body(),/非上传结果/);
    assert.match(await body(),/synthetic-next-catalogue.xlsx/);
    assert.match(await body(),/synthetic-templates.zip/);
  });
  await check('缺模板保留条目，不静默进入下一步',async()=>{
    await reset();await demoSource();await click('[data-action="next"]');
    assert.match(await page.locator('[role="alert"]').innerText(),/没有模板/);
    assert.equal(await page.locator('[data-row]').count(),fixture.entries.length);
  });
  await check('混合选择、年报目标年、补充资料、明确未纳入范围',async()=>{
    await click('[data-action="select-matched"]');
    await click('[data-type="annual_report"]');
    await click('[data-type="underwriter"]');
    await click('[data-action="next"]');
    assert.match(await page.locator('[role="alert"]').innerText(),/目标年度/);
    await page.locator('#report-year').selectOption('2026');
    await page.locator('#support-files').setInputFiles({name:'synthetic-financials.pdf',mimeType:'application/pdf',buffer:Buffer.from('synthetic UI filename only')});
    assert.equal(await page.locator('[data-remove-material]').count(),1);
    await page.locator('#requirements').fill('目标年度 2026；金额单位万元。');
    await click('[data-action="next"]');
    assert.match(await body(),/本批暂未纳入/);
    assert.match(await body(),/目标期间：2026/);
    assert.match(await body(),/本批补充资料：1/);
    await capture('confirm-1440',true);
  });
  await check('更换其他文种 Word 保留待解析状态，可恢复内置模板',async()=>{
    await click('[data-action="prepare"]');
    await page.locator('[data-general-upload="annual_report"]').setInputFiles({name:'synthetic-annual.docx',mimeType:'application/octet-stream',buffer:Buffer.from('synthetic UI filename only')});
    await click('[data-action="next"]');
    assert.match(await page.locator('[role="alert"]').innerText(),/尚未解析/);
    await click('[data-reset-general="annual_report"]');
    await click('[data-action="next"]');
    assert.ok(await page.locator('[data-action="start-demo"]').isVisible());
  });
  await check('生成和暂停仅演示，无真实成果或计费请求',async()=>{
    await click('[data-action="start-demo"]');
    assert.match(await body(),/未运行真实生成/);
    await click('[data-action="pause"]');assert.match(await body(),/已暂停演示/);
    await click('[data-action="demo-download"]');assert.match(await page.locator('#toast').innerText(),/尚未生成成果/);
  });
  await check('只选单份业务文件也走同一确认入口',async()=>{
    await reset();await demoSource();await click('[data-type="pack"]');await click('[data-type="application"]');
    await click('[data-action="next"]');assert.match(await body(),/1 份其他文件/);
  });
  await check('390px 手机准备与模板预览无页面水平溢出',async()=>{
    await page.setViewportSize({width:390,height:844});await reset();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await capture('prepare-390',true);
    await click('[data-action="preview-pack"]');
    const images=page.locator('.preview-pages img');
    if(await images.count()) await images.evaluateAll(els=>Promise.all(els.map(el=>el.decode())));
    await capture('preview-390');
    assert.ok(await page.locator('#close-preview').isVisible());
    await click('#close-preview');
    assert.equal(await page.locator('dialog[open]').count(),0);
  });
  await check('真实来源样页成功加载；正文视图与页面预览分别标识',async()=>{
    await page.setViewportSize({width:1440,height:1000});
    await click('[data-type="annual_report"]');
    await click('[data-general-preview="annual_report"]');
    if(fixture.real){
      await page.locator('.preview-pages img').evaluate(el=>el.decode());
      assert.match(await body(),/非全文/);
      await click('#next-page');
      await page.locator('.preview-pages img').evaluate(el=>el.decode());
    }else assert.match(await body(),/尚未转换/);
    await capture('preview-1440');
    await click('[data-preview-tab="text"]');
    assert.ok((await page.locator('.text-preview').innerText()).length>20);
    await capture('text-1440');
  });
  await check('真实预览只接收脱敏数据，旧原文图片地址不可访问',async()=>{
    if(fixture.real){
      const clean=await page.evaluate(()=>window.BB_TEMPLATE_DATA);
      assert.equal(clean.redacted,true);
      assert.ok([...clean.templates,...clean.general].every(t=>t.redacted===true));
      const published=JSON.stringify(clean);
      assert.doesNotMatch(published,/浙江省交通投资|浙江交通投资|中汇会计师|国浩律师|杭州市/);
      assert.ok([...clean.templates,...clean.general].flatMap(t=>t.pages).every(s=>s.startsWith('assets/redacted-')));
      const old=await page.request.get(`${base}/assets/annual_report-1.png`);
      assert.equal(old.status(),404);
      const raw=await page.request.get(`${base}/data.js`);
      assert.equal(raw.status(),404);
    }
  });
  assert.deepEqual(failures,[]);assert.deepEqual(networkErrors,[]);assert.deepEqual(mutations,[]);
  await writeFile(`${output}/result.json`,JSON.stringify({passed:passed.length,cases:passed,realIntake:fixture.real,pageErrors:failures,httpErrors:networkErrors,mutationRequests:mutations},null,2));
  console.log(`${passed.length} checks passed; no product API or mutation requests.`);
} finally {await browser.close();}
