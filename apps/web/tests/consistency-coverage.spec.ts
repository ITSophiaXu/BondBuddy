import {expect,test,type Page} from '@playwright/test';
import type {ProjectFileCheck} from '@bondbuddy/contracts';
import {fixture,open,assertFixture,writes,serverSnapshot,fileIds,checkId,base,cacheKey,replaceCurrent,changeSource,type State} from './consistency-selection-fixtures';
import {hash} from './consistency-task-fixtures';

const fallback='本轮记录未提供具体核对范围，请结合差异与人工事项逐项核实。';
const row=(page:Page,version=fileIds.issuer)=>page.locator(`[data-fc-result-version="${version}"]`);
const detail=(page:Page,version=fileIds.issuer)=>row(page,version).locator(`[data-fc-detail="${version}"]`);
const coverage=(page:Page,version=fileIds.issuer)=>detail(page,version).locator(`[data-fc-coverage="${version}"]`);
const text=(page:Page,version=fileIds.issuer)=>coverage(page,version).locator('[data-fc-coverage-text]');
const dialog=(page:Page)=>page.locator('dialog.fc-confirm[open]');
function setCoverage(s:State,version:string,value:string){s.checks[0].result!.files.find(f=>f.file_version_id===version)!.coverage=value;}
async function reveal(page:Page,version=fileIds.issuer){
  const target=detail(page,version);if(await target.getAttribute('open')===null){await target.locator('summary').focus();await page.keyboard.press('Enter');}
  await expect(target).toHaveAttribute('open');await expect(coverage(page,version)).toBeVisible();
}
async function unchanged(page:Page,s:State,before:ReturnType<typeof serverSnapshot>){expect(writes(s)).toEqual([]);expect(serverSnapshot(s)).toEqual(before);await assertFixture(page);}

// This remains an explicit synthetic HTTP producer. It does not execute the
// model, inspect a customer's document, or prove that coverage prose is true.
function newerCheck(s:State,raw:string){
  const original=s.checks[0],newest:ProjectFileCheck=structuredClone(original);
  newest.run_id='consistency-coverage-new-check';newest.created_at=new Date(Date.parse(original.created_at)+60000).toISOString();
  newest.source=structuredClone(s.source);newest.stale=false;newest.sha256=hash('consistency-coverage-new-result');newest.updates=[];
  const latest=s.files.filter(v=>v.latest);
  newest.files=latest.map(v=>({file_id:v.file_id,file_version_id:v.version_id,filename:v.filename,sequence:v.sequence}));
  newest.result!.files=latest.map(v=>{
    const prior=original.files.find(f=>f.file_id===v.file_id)!;
    return {...structuredClone(original.result!.files.find(f=>f.file_version_id===prior.file_version_id)!),file_version_id:v.version_id,coverage:raw};
  });
  s.checks.unshift(newest);return newest;
}

test.afterEach(async({page})=>assertFixture(page));
test.describe('consistency coverage desktop journeys',()=>{
  test('consistency coverage: the original multiline record stays text inside the existing keyboard-opened file detail',async({page})=>{
    const raw='合成核对记录：发行规模及2025年度数据。\n未核对附表，需人工核实。\n<script>window.__coverageExecuted=true</script>\n<img src=x onerror="window.__coverageExecuted=true"> & 原文 <范围>';
    const s=fixture();setCoverage(s,fileIds.issuer,raw);const before=serverSnapshot(s);await open(page,s);await reveal(page);
    await expect(coverage(page).getByRole('heading',{name:'本轮核对范围与限制',exact:true})).toBeVisible();
    await expect(coverage(page)).toContainText('以下为本轮检查记录中的范围说明，需结合下方差异和人工事项核对。');
    expect(await text(page).textContent()).toBe(raw);
    expect(await text(page).evaluate(e=>getComputedStyle(e).whiteSpace)).toBe('pre-wrap');
    await expect(coverage(page).locator('script,img')).toHaveCount(0);
    expect(await page.evaluate(()=>('__coverageExecuted' in window))).toBe(false);
    await expect(row(page).locator('[data-fc-coverage]')).toHaveCount(1);await expect(row(page).locator('.pf-chip')).toContainText('不一致');
    await unchanged(page,s,before);
  });

  test('consistency coverage: empty and whitespace-only historical records get a neutral fallback',async({page})=>{
    const s=fixture();setCoverage(s,fileIds.issuer,'');setCoverage(s,fileIds.financial,' \t\n　');const before=serverSnapshot(s);await open(page,s);
    for(const version of [fileIds.issuer,fileIds.financial]){
      await reveal(page,version);await expect(text(page,version)).toHaveText(fallback);await expect(row(page,version).locator('.pf-chip')).toContainText('不一致');
      await expect(coverage(page,version).locator('progress,meter,[role="progressbar"]')).toHaveCount(0);
    }
    await unchanged(page,s,before);
  });

  test('consistency coverage: an explicit old check keeps its source and original file coverage while newer versions and a newer check exist',async({page})=>{
    const oldRaw='合成旧检查仅以募集书 V3 核对原文件 V1；原授信证明仍待人工确认。';
    const newRaw='合成新检查改用募集书 V4 与当前文件 V2，不能借给旧检查。';
    const s=fixture();setCoverage(s,fileIds.issuer,oldRaw);const oldSource=s.checks[0].source.sequence;
    const current=replaceCurrent(s);changeSource(s);const latest=newerCheck(s,newRaw),before=serverSnapshot(s);
    await open(page,s);await expect(page.locator('#fc-history')).toHaveValue(checkId);await reveal(page);
    expect(await text(page).textContent()).toBe(oldRaw);await expect(row(page)).toContainText(`检查时 V1 · 基于募集书 V${oldSource}`);
    await expect(row(page).locator('.fc-file-freshness')).toContainText('V2');await expect(row(page,current.version_id)).toHaveCount(0);
    expect(await page.locator('[data-fc-coverage-text]').allTextContents()).not.toContain(newRaw);
    await page.locator('#fc-history').selectOption(latest.run_id);await reveal(page,current.version_id);
    expect(await text(page,current.version_id).textContent()).toBe(newRaw);await expect(row(page,current.version_id)).toContainText('检查时 V2 · 基于募集书 V4');
    await expect(row(page)).toHaveCount(0);await page.locator('#fc-history').selectOption(checkId);await reveal(page);
    expect(await text(page).textContent()).toBe(oldRaw);await unchanged(page,s,before);
  });

  test('consistency coverage: partial and unreviewed content remains manual alongside confirmed conflicts',async({page})=>{
    const raw='合成检查范围：发行规模及财务表可读取部分；扫描附页与未核正文尚未覆盖。';
    const s=fixture();setCoverage(s,fileIds.issuer,raw);const result=s.checks[0].result!.files.find(f=>f.file_version_id===fileIds.issuer)!;
    const manual=structuredClone(result.findings.find(f=>f.kind==='manual')!);
    result.findings.push({...manual,id:'coverage-unreviewed-body',target_span_id:'unresolved',original:'',target_location:'',field:'',reason:'部分文件正文尚未完成核对，不能据此认定整份文件一致。'},
      {...manual,id:'coverage-partial-extraction',target_span_id:'unresolved',original:'',target_location:'',field:'',reason:'文件只能部分提取，需人工核对未读取内容。'});
    const before=serverSnapshot(s);await open(page,s);await reveal(page);expect(await text(page).textContent()).toBe(raw);
    await expect(row(page)).toContainText('部分文件正文尚未完成核对');await expect(row(page)).toContainText('需人工核对未读取内容');
    await expect(row(page).locator('.pf-chip')).toContainText('不一致');await expect(row(page).locator('[data-fc-select]')).toBeEnabled();
    await page.locator('.fc-summary [data-fc-filter="manual"]').click();await expect(row(page)).toBeVisible();await reveal(page);
    expect(await text(page).textContent()).toBe(raw);await expect(row(page,fileIds.credit).locator('[data-fc-select]')).toBeDisabled();
    await expect(page.locator('.fc-history-scope')).toContainText('各类数量不相加');
    await expect(page.locator('.fc-summary [data-fc-filter="manual"] strong')).toContainText('2');
    await unchanged(page,s,before);
  });

  test('consistency coverage: a near-limit record stays readable without inventing a percentage or clearing the result status',async({page})=>{
    const end='合成范围记录终点：最后一页仍需核对原始证明。';
    const lead='记录原文中的“100%完整覆盖”和“3/4”是待核口述，不能当作系统进度或确认结论。\n';
    const line='合成范围说明：核对同期间披露与可读取附表，未获取的原始证明仍需人工核实。\n';
    const raw=lead+line.repeat(Math.floor((11950-lead.length-end.length)/line.length))+end;
    expect(raw.length).toBeGreaterThan(11000);expect(raw.length).toBeLessThanOrEqual(12000);
    const s=fixture();setCoverage(s,fileIds.issuer,raw);const before=serverSnapshot(s);await open(page,s);await reveal(page);
    expect(await text(page).textContent()).toBe(raw);await expect(coverage(page).locator('progress,meter,[role="progressbar"],[aria-valuenow]')).toHaveCount(0);
    await expect(row(page).locator('.pf-chip')).toContainText('不一致');
    expect(await text(page).evaluate(node=>({whiteSpace:getComputedStyle(node).whiteSpace,wrapped:node.scrollWidth<=node.clientWidth+1}))).toEqual({whiteSpace:'pre-wrap',wrapped:true});
    const tail=await text(page).evaluate((node,marker)=>{const range=document.createRange(),content=node.firstChild!;range.setStart(content,node.textContent!.lastIndexOf(marker));range.setEnd(content,node.textContent!.length);const before=range.getBoundingClientRect();window.scrollBy(0,before.bottom-innerHeight+64);const rect=range.getBoundingClientRect();return {visible:rect.bottom>0&&rect.top<innerHeight,height:node.getBoundingClientRect().height};},end);
    expect(tail.visible).toBe(true);expect(tail.height).toBeGreaterThan(960);await unchanged(page,s,before);
  });

  test('consistency coverage: reading and filtering while an update receipt is unknown preserves the original update envelope',async({page})=>{
    const raw='合成范围说明：仅本轮原文件；原人工事项在自动更新后仍需核实。';
    const s=fixture({dropUpdateOnce:true});setCoverage(s,fileIds.issuer,raw);const before=serverSnapshot(s);await open(page,s);await reveal(page);
    await row(page).locator('[data-fc-select]').check();await page.locator('#fc-accept-top').click();await dialog(page).locator('#fc-confirm-update').click();
    await expect.poll(()=>s.posts.length).toBe(1);await expect(page.locator('#fc-pending-action')).toBeVisible();const original=structuredClone(s.posts[0]);
    await dialog(page).getByRole('button',{name:'返回调整',exact:true}).click();await page.locator('.fc-summary [data-fc-filter="manual"]').click();await reveal(page);
    expect(await text(page).textContent()).toBe(raw);await expect(row(page).locator('[data-fc-file]')).toBeDisabled();await expect(page.locator('#fc-accept-top')).toBeDisabled();
    const cached=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)??'null'),cacheKey);expect(cached.pendingUpdate.body).toEqual(original.body);expect(cached.pendingUpdate.checkId).toBe(checkId);
    expect(s.posts).toHaveLength(1);await page.locator('#fc-pending-action').click();await dialog(page).locator('#fc-confirm-update').click();
    await expect.poll(()=>s.posts.length).toBe(2);await expect(dialog(page)).toHaveCount(0);await reveal(page);
    expect(s.posts[1]).toEqual(original);expect(s.receipts.size).toBe(1);expect(s.batches).toHaveLength(1);expect(await text(page).textContent()).toBe(raw);
    expect(writes(s).map(c=>c.path)).toEqual([base+'/checks/'+checkId+'/updates',base+'/checks/'+checkId+'/updates']);
    expect(s.checks).toEqual(before.checks);expect(s.source).toEqual(before.source);expect(s.files).toEqual(before.files);await assertFixture(page);
  });
});
