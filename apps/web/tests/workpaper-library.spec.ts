import {test,expect,type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import type {WorkpaperLibrary,WorkpaperLibraryItem} from '@bondbuddy/contracts';
import {fixture,install,openFiles,ids,now,hash,docx} from './word-roundtrip-fixtures';

async function setup(page:Page){
  const s=fixture();await install(page,s);
  const bytes=docx('合成资产核查：2025年末总资产为200万元。'),sha=hash(bytes),source=s.source!;
  const entries:WorkpaperLibraryItem[]=Array.from({length:61},(_,i)=>({
    entry:{id:'wp-'+i,code:'1-'+i,title:'资产核查'+i,folder:'1 尽职调查文件',kind:'file',row:i+2,sheet:'1 尽职调查文件',instructions:'',path:`1 尽职调查文件/1-${i} 资产核查${i}.docx`},
    ...(i%2?{explanation:{filename:`1-${i} 资产核查${i}-不适用说明.docx`,sha256:sha}}:{}),
    run_id:'wp-run-'+i,state:'succeeded',stage:null,attempt:1,error:null,batch_id:'wp-batch',catalogue_id:'old-catalogue',created_at:now,source:{...source,sequence:1},
    artifacts:i%2?[]:[{kind:'document',filename:`1-${i} 资产核查${i}.docx`,pin:{source_project_id:ids.root,artifact_id:'artifact-'+i,artifact_version:1,sha256:sha}}],
    latest:i!==60,version_count:i===60?2:1,links_count:i%2?0:3,check_stale:false,
    impact:{item_id:'wp-'+i,status:i%2?'manual':'needs_update',reason:i%2?'尚缺少签章原件。':'总资产披露已改变。',changes:i%2?[]:[{source_span_id:'p0',before:'总资产100万元',after:'总资产200万元',source_location:'资产负债表',target_locations:['表格1 / 行2 / 列2'],fields:['总资产 · 2025年末 · 万元'],reason:'关联披露变化'}]}
  }));
  const requests:unknown[]=[];let fail=false;const check_capability={enabled:true,reason:''};
  await page.route('**/api/v1/projects/*/workpapers/**',async route=>{
    const url=new URL(route.request().url()),body=route.request().method()==='POST'?route.request().postDataJSON():null;
    if(url.pathname.endsWith('/library')){
      const q=url.searchParams,offset=Number(q.get('offset')),limit=Number(q.get('limit'));
      const rows=entries.filter(i=>(q.get('history')==='true'||i.latest)&&(!q.get('search')||i.entry.path.includes(q.get('search')!))
        &&(q.get('category')==='all'||(q.get('category')==='explanation')===!!i.explanation)
        &&(q.get('status')==='all'||q.get('status')==='stale'&&i.check_stale||q.get('status')===i.impact?.status&&!i.check_stale));
      const result:WorkpaperLibrary={items:rows.slice(offset,offset+limit),offset,limit,total:rows.length,source,checks:[],check_capability};return route.fulfill({json:result});
    }
    if(url.pathname.endsWith('/preview'))return route.fulfill({json:{text:'总资产为200万元。\n<script>window.BAD=true</script>'}});
    if(url.pathname.endsWith('/checks')){requests.push(body);if(fail){fail=false;return route.abort('failed');}return route.fulfill({json:{run_id:'check'}});}
    if(url.pathname.includes('/explanations/')||url.pathname.endsWith('/download'))return route.fulfill({body:bytes,contentType:url.pathname.endsWith('/download')?'application/zip':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
    return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
  });return {s,entries,requests,failOnce(){fail=true;},disableChecks(){check_capability.enabled=false;check_capability.reason='底稿变更检查暂未开放，已有文件和历史检查记录仍可查看、下载。';}};
}
for(const width of [1440,390])test(`library ${width}: paging, classifications, old/new positions, preview and download`,async({page})=>{
  const state=await setup(page);await page.setViewportSize({width,height:960});await openFiles(page);
  const panel=page.locator('#pw-workpaper-library');await expect(panel.locator('.wl-file')).toHaveCount(50);
  await panel.getByRole('button',{name:'下一页'}).click();await expect(panel.locator('.wl-file')).toHaveCount(10);
  await panel.getByLabel('包括历史批次').check();await expect(panel.locator('.wl-message')).toContainText('61 份');
  await panel.getByLabel('查找底稿').fill('资产核查0');await expect(panel.locator('.wl-file')).toHaveCount(1);
  await panel.locator('summary').click();await expect(panel).toContainText('总资产100万元');await expect(panel).toContainText('总资产200万元');await expect(panel).toContainText('表格1 / 行2 / 列2');
  await expect(panel.getByRole('link',{name:'重新编制受影响底稿'})).toHaveAttribute('href',/workpaper_batch=wp-batch/);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const dir=test.info().outputPath('workpaper-library');await mkdir(dir,{recursive:true});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`${dir}/library-${width}.png`,fullPage:true});
  await panel.getByRole('button',{name:'预览正文'}).click();await expect(page.locator('dialog[open]')).toContainText('200万元');
  expect(await page.evaluate(()=>'BAD' in window)).toBe(false);await page.getByRole('button',{name:'关闭',exact:true}).click();
  await panel.getByLabel('查找底稿').fill('');await panel.getByLabel('分类',{exact:true}).selectOption('explanation');await expect(panel.locator('.wl-file')).toHaveCount(30);
  await panel.locator('summary').first().click();const downloaded=page.waitForEvent('download');await panel.getByRole('button',{name:'下载文件'}).first().click();expect((await downloaded).suggestedFilename()).toContain('不适用说明');
  await panel.getByRole('button',{name:'检查本批底稿'}).first().click();expect(state.requests).toHaveLength(1);
  expect(state.requests[0]).toMatchObject({source_version_id:state.s.source!.version_id,source_selection_revision:state.s.source!.selection_revision});
});
test('check request retry is idempotent and prior impact cannot appear current after source changes',async({page})=>{
  const state=await setup(page);state.failOnce();await openFiles(page);const panel=page.locator('#pw-workpaper-library');
  await panel.locator('summary').first().click();await panel.getByRole('button',{name:'检查本批底稿'}).first().click();await panel.getByRole('button',{name:'检查本批底稿'}).first().click();
  expect(state.requests).toHaveLength(2);expect(state.requests[0]).toEqual(state.requests[1]);
  for(const entry of state.entries)entry.check_stale=true;
  await panel.getByRole('button',{name:'刷新',exact:true}).click();await expect(panel.locator('.wl-status').first()).toHaveText('需用新版检查');
  await expect(panel.getByRole('link',{name:'重新编制受影响底稿'})).toHaveCount(0);
  await expect(panel).toContainText('以下为旧检查记录');
});

test('legacy library download uses the corrected metadata filename and retains document bytes',async({page})=>{
  const state=await setup(page),entry=state.entries[0]!;
  entry.entry.title='资产说明（包括明细、原因及偿债影响）';
  entry.entry.path='1 尽职调查文件/1-0 资产说明及明细、原因及偿债影响.docx';
  const expected='1-0 资产说明.docx',bytes=docx('Synthetic retained document bytes.'),sha=hash(bytes);
  await page.route('**/api/v1/artifacts/artifact-0**',route=>route.request().url().includes('/download')
    ?route.fulfill({body:bytes,contentType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'})
    :route.fulfill({json:{artifact_id:'artifact-0',run_id:entry.run_id,version:1,filename:expected,media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',sha256:sha,quality_status:'passed',delivery_status:'available',download_url:'/api/v1/artifacts/artifact-0/download',expires_at:'2099-01-01T00:00:00Z'}}));
  await openFiles(page);const panel=page.locator('#pw-workpaper-library');
  await panel.locator('summary').first().click();
  await expect(panel.locator('.wl-name').first()).toHaveText(expected);
  const downloaded=page.waitForEvent('download');await panel.getByRole('button',{name:'下载文件'}).first().click();
  const file=await downloaded;expect(file.suggestedFilename()).toBe(expected);
  const stream=await file.createReadStream();const chunks:Buffer[]=[];for await(const chunk of stream!)chunks.push(Buffer.from(chunk));
  expect(hash(Buffer.concat(chunks))).toBe(sha);
});

test('unavailable automatic batch checks keep original files and history readable without a free execution',async({page})=>{
  await page.setViewportSize({width:1440,height:960});
  const state=await setup(page);state.disableChecks();await openFiles(page);const panel=page.locator('#pw-workpaper-library');
  await expect(panel.locator('.wl-check-capability')).toContainText('底稿变更检查暂未开放');
  await panel.getByLabel('查找底稿').fill('资产核查0');await expect(panel.locator('.wl-file')).toHaveCount(1);
  await panel.locator('summary').first().click();
  await expect(panel.getByRole('button',{name:'检查本批底稿'}).first()).toBeDisabled();
  await expect(panel.getByRole('button',{name:'预览正文'}).first()).toBeEnabled();await expect(panel.getByRole('button',{name:'下载文件'}).first()).toBeEnabled();
  await expect(panel).toContainText('总资产100万元');await expect(panel).toContainText('总资产200万元');
  if(process.env.BB_UX_EVIDENCE_DIR){await mkdir(process.env.BB_UX_EVIDENCE_DIR,{recursive:true});await page.evaluate(()=>window.scrollTo(0,0));await expect.poll(()=>page.evaluate(()=>scrollY)).toBe(0);await page.screenshot({path:join(process.env.BB_UX_EVIDENCE_DIR,'workpaper-check-unavailable-1440.png'),fullPage:true});}
  await panel.getByRole('button',{name:'预览正文'}).first().click();await expect(page.locator('dialog[open]')).toContainText('200万元');
  expect(state.requests).toEqual([]);
});
