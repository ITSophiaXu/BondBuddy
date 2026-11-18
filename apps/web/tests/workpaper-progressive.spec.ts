import {test,expect,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {AUTOMATIC_PRICE_VERSION,emptyFileGenerationPreparation,workpaperChapters,workpaperProgressiveSelection,type WorkpaperEntry,type WorkpaperBatch,type WorkpaperWorkspace,type FileGenerationWorkspace} from '@bondbuddy/contracts';
import {fixture,ids,now,sha} from './generation-entry-fixtures';
import {fixtureBody,fixtureRequest} from './billing-fixture-wire';

// Real page/controller, synthetic owner-scoped HTTP only. No backend, model or billing execution.
async function setup(page:Page,chapterCount=10,filesPerChapter=2){
 const original=await fixture(page),source=original.workspaces.get(ids.api)!.source!;
 const names=['发行人设立与存续','组织结构与治理','业务经营情况','财务会计资料','重大债权债务','关联交易与往来','募集资金运用','偿债能力与保障','重大事项与诉讼','其他需要核查的事项'];
 const entries:WorkpaperEntry[]=Array.from({length:chapterCount},(_,c)=>Array.from({length:filesPerChapter},(_,f)=>({id:`item-${c+1}-${f+1}`,code:`${c+1}.${f+1}`,title:`${names[c]??'核查事项'}${f+1===1?'核查记录':'补充说明'}`,folder:`尽职调查文件/${c+1} ${names[c]??'核查事项'}`,kind:'file' as const,sheet:'尽职调查目录',row:c*filesPerChapter+f+2,instructions:'',path:`${c+1}/${f+1}.docx`}))).flat();
 const catalogue={catalogue_id:'progressive-cat',filename:'合成尽职调查目录.xlsx',sha256:sha,created_at:now,warnings:[],entries};
 const work:WorkpaperWorkspace={catalogues:[catalogue],batches:[],assessments:[],price:{version:AUTOMATIC_PRICE_VERSION,points:10,auto_charge:true}};
 const fg:FileGenerationWorkspace={revision:1,preparation:{...emptyFileGenerationPreparation(),workpaper_template_mode:'automatic',catalogue_id:catalogue.catalogue_id,item_ids:entries.map(e=>e.id)},sets:[],builtin:{name:'模板',version:'synthetic-v1',available:true},batches:[],pricing:{mode:'automatic',price_version:AUTOMATIC_PRICE_VERSION,workpaper_points:10,document_points:10}};
 const calls:{path:string;method:string;body:any}[]=[],controls={dropContinue:false,previewError:false,zipReads:0};
 const createBatch=(itemIds=entries.map(e=>e.id),chapterOrder=workpaperChapters(entries).map(c=>c.id))=>{
  const selection=workpaperProgressiveSelection(entries,itemIds,chapterOrder);
  const batch:WorkpaperBatch={batch_id:'progressive-batch',topic_id:'topic',catalogue_id:catalogue.catalogue_id,revision:1,state:'running',start_mode:'direct',source,total_points:itemIds.length*10,charged_points:0,created_at:now,error:null,progressive:{phase:'trial',chapters:selection.chapters,trial_item_ids:selection.trial_item_ids,max_parallel:2},items:selection.ordered_item_ids.map((id,index)=>({entry:entries.find(e=>e.id===id)!,run_id:index<2?`run-${id}`:null,state:index<2?'running':'queued',stage:null,attempt:1,error:null,artifacts:[]}))};
  work.batches=[batch];return batch;
 };
 const finish=(batch:WorkpaperBatch,id:string,failed=false)=>{const item=batch.items.find(i=>i.entry.id===id)!;item.run_id??=`run-${id}`;item.state=failed?'failed':'succeeded';item.error=failed?'合成可重试错误':null;if(!failed)item.explanation={filename:item.entry.title+'.docx',sha256:sha};batch.revision++;};
 await page.route('**/api/v1/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1',''),method=request.method();
  if(!path.includes('/workpapers')&&!path.includes('/file-generation'))return route.fallback();
  const body=request.postData()?fixtureRequest(request):undefined;calls.push({path,method,body});
  const json=(value:unknown,status=200)=>route.fulfill({status,json:fixtureBody(route,value)});
  if(path.endsWith('/file-generation')&&method==='GET')return json(fg);
  if(path.endsWith('/file-generation/preparation')){expect(body.expected_revision).toBe(fg.revision);fg.revision++;fg.preparation=body.preparation;return json({revision:fg.revision,preparation:fg.preparation});}
  if(path.endsWith('/file-generation/quote'))return json({count:fg.preparation.item_ids.length,points:fg.preparation.item_ids.length*10,price_version:AUTOMATIC_PRICE_VERSION,omitted:[],auto_charge:true,quote_status:'ready'});
  if(path.endsWith('/file-generation/batches')){const batch=createBatch(fg.preparation.item_ids,body.progressive.chapter_order),result={batch_id:'file-batch',created_at:now,points:batch.total_points,workpapers:batch,documents:null};fg.batches=[result];return json(result);}
  if(path.endsWith('/workpapers')&&method==='GET')return json(work);
  if(path.endsWith('/workpapers/catalogues/'+catalogue.catalogue_id))return json(catalogue);
  if(path.endsWith('/workpapers/checks'))return json({checks:[]});
  if(path.endsWith('/workpapers/batches')&&method==='POST')return json(createBatch(body.item_ids,body.progressive.chapter_order));
  if(path.endsWith('/progress'))return json({revision:createHash('sha256').update(JSON.stringify(work.batches)).digest('hex'),active:work.batches.some(b=>b.state==='running')});
  if(path.endsWith('/workpapers/batches/progressive-batch'))return json(work.batches[0]);
  if(path.endsWith('/actions')){const batch=work.batches[0];
   if(body.action==='continue_remaining'&&controls.dropContinue){controls.dropContinue=false;return route.abort('failed');}
   expect(body.expected_revision).toBe(batch.revision);batch.revision++;
   if(body.action==='continue_remaining'){expect(body.request_id).toBeTruthy();batch.progressive!.phase='remaining';batch.state='running';}
   if(body.action==='pause')batch.state='paused';
   if(body.action==='cancel'){batch.state='cancelled';batch.items.filter(i=>!i.run_id).forEach(i=>i.state='cancelled');}
   if(body.action==='resume')batch.state='running';
   if(body.action==='retry_failed'){if(batch.pause_reason!=='shared_blocked')batch.progressive!.phase='retry_failed';batch.state='running';batch.pause_reason=null;batch.items.filter(i=>i.state==='failed').forEach(i=>{i.state='queued';i.run_id=null;});}
   return json(batch);
  }
  if(path.endsWith('/preview'))return controls.previewError?json({code:'DATA_UNAVAILABLE'},503):json({text:'合成核查成果\n<script>window.previewUnsafe=true</script>\n本预览无真实项目数据。'});
  if(path.includes('/explanations/'))return route.fulfill({contentType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',body:Buffer.concat([Buffer.from('PK'),Buffer.alloc(100)])});
  if(path.endsWith('/download')){controls.zipReads++;return route.fulfill({status:202,headers:{'retry-after':'1'},json:{status:'preparing',progress:{phase:'retrieving',completed_files:0,total_files:1}}});}
  return route.fallback();
 });
 return {original,work,fg,entries,calls,controls,createBatch,finish,prepare:`/#workpapers?project=${ids.api}&step=prepare`,results:`/#generate?project=${ids.api}&step=workpapers&view=results&batch=progressive-batch`};
}
async function capture(page:Page,name:string){const dir=resolve('../../work/generation-compact-ui-20261113/screenshots');await mkdir(dir,{recursive:true});await page.screenshot({path:resolve(dir,name+'.png'),fullPage:true});}
const current=(page:Page)=>page.locator('[data-wp-batch-id="progressive-batch"]');

test('live workpaper phases change before the first completed file without inflating counts',async({page})=>{
 const s=await setup(page),b=s.createBatch();await page.setViewportSize({width:1440,height:960});
 b.items[0].progress={phase:'preparing_materials',started_at:now,updated_at:now,interrupted:false};
 b.items[1].state='queued';b.items[1].progress={phase:'queued',started_at:now,updated_at:now,interrupted:false};
 await page.clock.install();await page.goto(s.results);
 const live=current(page).getByRole('status',{name:'当前处理进度'});
 await expect(live).toContainText('读取和准备募集说明书资料');await expect(live).toContainText('排队等待');
 await expect(current(page).getByRole('progressbar',{name:'底稿完成进度',exact:true})).toHaveAttribute('value','0');
 await expect(current(page)).toContainText('0 / 8 份已处理');
 await expect(current(page).locator('.wpg-chapter-progress').nth(1)).toContainText('排队等待');
 b.items[0].progress={...b.items[0].progress,phase:'generating',updated_at:new Date(Date.parse(now)+60000).toISOString()};
 await page.clock.fastForward(11000);await expect(live).toContainText('模型正在编制');
 await expect(live).not.toContainText('读取和准备募集说明书资料');await expect(current(page)).toContainText('0 / 8 份已处理');
 b.items[0].progress.phase='writing_files';await page.clock.fastForward(11000);await expect(live).toContainText('正在生成 Word 文件');
 expect(s.calls.filter(c=>c.method==='POST')).toHaveLength(0);
 await capture(page,'live-progress-desktop');
 await page.setViewportSize({width:390,height:960});await capture(page,'live-progress-mobile');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('interrupted execution stays explicit until recovered and never resubmits a task',async({page})=>{
 const s=await setup(page,2),b=s.createBatch();
 b.items[0].progress={phase:'delivering',started_at:now,updated_at:now,interrupted:true};b.items[1].state='queued';
 await page.clock.install();await page.goto(s.results);
 await expect(current(page).locator('.wpg-phase')).toHaveText('执行待恢复');await expect(current(page).getByRole('heading',{name:'试生成等待恢复'})).toBeVisible();
 await expect(current(page).getByRole('status',{name:'当前处理进度'})).toContainText('执行暂时中断，等待恢复');
 await expect(current(page).locator('.wpg-chapter-progress').first()).toContainText('执行待恢复');
 await capture(page,'live-progress-interrupted');
 await page.reload();await expect(current(page)).toContainText('无需重复提交');
 b.items[0].progress.interrupted=false;await page.clock.fastForward(11000);
 await expect(current(page).getByRole('status',{name:'当前处理进度'})).toContainText('正在保存成果');
 await expect(current(page).locator('.wpg-phase')).toHaveText('试生成中');
 expect(s.calls.filter(c=>c.method==='POST')).toHaveLength(0);
});

test('queued trials and legacy responses avoid claiming that a model has started',async({page})=>{
 const s=await setup(page,2),b=s.createBatch();b.items.filter(i=>!!i.run_id).forEach(i=>i.state='queued');
 await page.goto(s.results);await expect(current(page)).toContainText('等待开始试生成 2 份文件');
 await expect(current(page).getByRole('status',{name:'当前处理进度'})).toContainText('排队等待');
 await expect(current(page)).not.toContainText('模型正在编制');
 b.items[0].state='running';await page.reload();await expect(current(page)).toContainText('正在处理文件');
});

test('mobile preparation keeps the footer below the catalogue and clear of the assistant',async({page})=>{
 const s=await setup(page);await page.setViewportSize({width:390,height:960});await page.goto(s.prepare);
 await expect(page.locator('[data-chapter-select]')).toHaveCount(10);
 const dir=resolve('../../work/generation-compact-ui-20261113/screenshots');await mkdir(dir,{recursive:true});
 await page.screenshot({path:resolve(dir,'prepare-390-viewport-top.png')});
 const footer=page.locator('.fg-footer');
 const layout=await footer.evaluate(el=>({position:getComputedStyle(el).position,top:el.getBoundingClientRect().top,controlsBottom:document.querySelector('#fg-controls')!.getBoundingClientRect().bottom}));
 expect(layout.top).toBeGreaterThanOrEqual(layout.controlsBottom);
 expect(layout.position).toBe('static');
 await page.locator('#fg-confirm').evaluate(el=>el.scrollIntoView({block:'end'}));
 await expect(page.locator('#fg-confirm')).toBeInViewport();
 const button=await page.locator('#fg-confirm').boundingBox(),dock=await page.locator('.ba-dock').boundingBox();
 expect(button&&dock&&(button.x+button.width<=dock.x||button.x>=dock.x+dock.width||button.y+button.height<=dock.y||button.y>=dock.y+dock.height)).toBe(true);
 await page.screenshot({path:resolve(dir,'prepare-390-viewport-submit.png')});
 await page.locator('#fg-confirm').click();await expect(page).toHaveURL(/batch=progressive-batch/);
});

for(const width of [1440,390])test(`five progressive phases use actual dynamic counts and responsive UI ${width}`,async({page})=>{
 const s=await setup(page);await page.setViewportSize({width,height:960});await page.goto(s.prepare);
 await expect(page.locator('[data-chapter-select]')).toHaveCount(10);await expect(page.locator('#fg-chapters')).toContainText('先试生成前 8 个');
 await expect(page.locator('[data-chapter-item],[data-chapter-files]')).toHaveCount(0);
 await capture(page,`prepare-${width}`);await page.locator('#fg-confirm').click();await expect(page).toHaveURL(/batch=progressive-batch/);
 const b=s.work.batches[0];await expect(current(page)).toContainText('正在试生成 8 份文件');
 await expect(current(page).locator('[data-result-item],.wpg-item-state')).toHaveCount(0);
 await expect(current(page)).not.toContainText('逐份成果与状态');await capture(page,`trial-${width}`);
 for(const id of b.progressive!.trial_item_ids)s.finish(b,id);b.state='paused';b.progressive!.phase='awaiting_confirmation';await page.reload();
 await expect(current(page).getByRole('button',{name:'继续生成其余 12 份'})).toBeVisible();await expect(current(page).getByRole('button',{name:'查看',exact:true})).toHaveCount(8);await capture(page,`confirmation-${width}`);
 await current(page).getByRole('button',{name:'继续生成其余 12 份'}).click();await expect(current(page)).toContainText('等待开始生成');
 const remaining=b.items.filter(i=>i.state==='queued');remaining[0].state='running';remaining[0].run_id='remaining-run';await page.reload();await expect(current(page)).toContainText('当前章节');await capture(page,`remaining-${width}`);
 for(const [index,item] of b.items.entries())s.finish(b,item.entry.id,index===b.items.length-1);b.state='partial';await page.reload();
 await expect(current(page)).toContainText('19 / 20 份完成');await expect(current(page).getByRole('button',{name:'仅重试失败的 1 份'})).toBeVisible();await capture(page,`partial-${width}`);
 await expect(current(page).locator('[data-result-item]')).toHaveCount(8);
 expect(await current(page).locator('[data-result-item]').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-result-item')))).toEqual(b.progressive!.trial_item_ids);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(s.original.errors).toEqual([]);
});

test('chapter choices and keyboard order preserve partial saved file scope through reload and submission',async({page})=>{
 const s=await setup(page,4);
 s.fg.preparation.item_ids=s.fg.preparation.item_ids.filter(id=>id!=='item-1-1');
 await page.goto(s.prepare);
 await expect(page.locator('[data-chapter-select="chapter-1"]')).toHaveJSProperty('indeterminate',true);
 await expect(page.locator('[data-chapter-item],[data-chapter-files]')).toHaveCount(0);
 await page.locator('[data-chapter-select="chapter-4"]').uncheck();
 const move=page.locator('[data-chapter-move="chapter-3"][data-direction="-1"]');await move.focus();await page.keyboard.press('Enter');await expect(move).toBeFocused();
 await expect(page.locator('[data-chapter-select="chapter-1"]')).toHaveJSProperty('indeterminate',true);
 await expect.poll(()=>s.fg.preparation.progressive?.chapter_order).toEqual(['chapter-1','chapter-3','chapter-2']);await page.reload();
 expect(s.fg.preparation.item_ids).not.toContain('item-1-1');
 await expect(page.locator('[data-chapter-select="chapter-1"]')).toHaveJSProperty('indeterminate',true);
 await expect(page.locator('[data-chapter-id]').first()).toHaveAttribute('data-chapter-id','chapter-1');await expect(page.locator('[data-chapter-id]').nth(1)).toHaveAttribute('data-chapter-id','chapter-3');
 await page.locator('#fg-confirm').click();await expect(page).toHaveURL(/batch=progressive-batch/);
 expect(s.work.batches[0].progressive!.trial_item_ids).toEqual(['item-1-2','item-3-1','item-2-1']);
 const request=s.calls.find(c=>c.path.endsWith('/file-generation/batches'))!.body;expect(request.progressive.chapter_order).toEqual(['chapter-1','chapter-3','chapter-2']);
 expect(s.work.batches[0].items.map(item=>item.entry.id).sort()).toEqual(['item-1-2','item-2-1','item-2-2','item-3-1','item-3-2']);
});

for(const width of [1440,390])test(`large catalogue stays at chapter granularity through selection and progress ${width}`,async({page})=>{
 const s=await setup(page,10,25);await page.setViewportSize({width,height:960});await page.goto(s.prepare);
 const chapters=page.locator('#fg-chapters');
 await expect(chapters.locator('[data-chapter-select]')).toHaveCount(10);
 await expect(chapters.locator('input[type="checkbox"]')).toHaveCount(10);
 await expect(chapters.locator('[data-chapter-item],[data-chapter-files]')).toHaveCount(0);
 await expect(chapters).toContainText('250 份文件');
 await expect(chapters).not.toContainText(s.entries[0].title);
 const bounds=await chapters.boundingBox();expect(bounds!.height).toBeLessThan(width>=1200?1200:1800);
 await page.locator('[data-chapter-select="chapter-2"]').uncheck();
 await expect.poll(()=>s.fg.preparation.item_ids.length).toBe(225);
 expect(s.fg.preparation.item_ids.some(id=>id.startsWith('item-2-'))).toBe(false);
 await page.locator('[data-chapter-select="chapter-2"]').check();
 await expect.poll(()=>s.fg.preparation.item_ids.length).toBe(250);
 await page.locator('#fg-confirm').click();await expect(page).toHaveURL(/batch=progressive-batch/);
 const b=s.work.batches[0],panel=current(page);
 await expect(panel.locator('[data-progress-chapter]')).toHaveCount(10);
 await expect(panel.locator('[data-result-item],.wpg-item-state')).toHaveCount(0);
 await expect(panel).not.toContainText('尚未开始');await expect(panel).not.toContainText('逐份成果与状态');
 for(const item of b.items)s.finish(b,item.entry.id);
 b.state='complete';b.progressive!.phase='remaining';await page.reload();
 await expect(panel).toContainText('250 / 250 份完成');
 await expect(panel.locator('[data-result-item]')).toHaveCount(8);
 expect(await panel.locator('[data-result-item]').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-result-item')))).toEqual(b.progressive!.trial_item_ids);
 await expect(panel.locator('[data-wp-zip]')).toBeEnabled();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await capture(page,`large-complete-${width}`);expect(s.original.errors).toEqual([]);
});

for(const width of [768,320])test(`small selection and empty selection remain usable ${width}`,async({page})=>{
 const s=await setup(page,1,1);await page.setViewportSize({width,height:960});await page.goto(s.prepare);
 await expect(page.locator('#fg-chapters')).toContainText('先试生成前 1 个');await page.locator('[data-chapter-select]').uncheck();await expect(page.locator('#fg-confirm')).toBeDisabled();await expect(page.locator('#fg-chapters')).toContainText('已选 0 个章节、0 份文件');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.locator('[data-chapter-select]').check();await page.locator('#fg-confirm').click();await expect(page).toHaveURL(/batch=progressive-batch/);const b=s.work.batches[0];s.finish(b,b.items[0].entry.id);b.state='complete';await page.reload();
 await expect(current(page)).toContainText('全部文件已生成');await expect(current(page).locator('[data-wp-action="continue_remaining"]')).toHaveCount(0);
});

test('legacy prepare starts progressive with the selected chapter order',async({page})=>{
 const s=await setup(page,3);await page.goto(`/#generate?project=${ids.api}&step=workpapers&legacy=1`);await expect(page.locator('[data-chapter-select]')).toHaveCount(3);
 await page.locator('[data-chapter-move="chapter-2"][data-direction="-1"]').click();await page.locator('#wp-start').click();await expect(page).toHaveURL(/batch=progressive-batch/);
 const request=s.calls.find(c=>c.path.endsWith('/workpapers/batches'))!.body;expect(request.progressive.chapter_order).toEqual(['chapter-2','chapter-1','chapter-3']);
});

test('completed trial files are immediately viewable and downloadable, escaped preview failure leaves download available',async({page})=>{
 const s=await setup(page,3),b=s.createBatch();s.finish(b,b.progressive!.trial_item_ids[0]);await page.goto(s.results);
 const row=current(page).locator('[data-result-item]').first();await expect(row.getByRole('button',{name:'查看',exact:true})).toBeVisible();
 await current(page).getByRole('button',{name:'查看试生成成果'}).click();await expect(current(page).locator('.wpg-results')).toBeFocused();
 await row.getByRole('button',{name:'查看',exact:true}).click();await expect(page.locator('dialog pre')).toContainText('<script>');expect(await page.evaluate(()=>(window as any).previewUnsafe)).toBeUndefined();await page.getByRole('button',{name:'关闭',exact:true}).click();
 const download=page.waitForEvent('download');await row.getByRole('button',{name:'下载说明'}).click();expect((await download).suggestedFilename()).toContain('核查记录');
 s.controls.previewError=true;await row.getByRole('button',{name:'查看',exact:true}).click();await expect(page.locator('dialog')).toContainText('下载原文件');await page.getByRole('button',{name:'关闭',exact:true}).click();await expect(row.getByRole('button',{name:'下载说明'})).toBeEnabled();
});

test('one continuation identity survives a failed request and refresh never creates a new batch',async({page})=>{
 const s=await setup(page,3),b=s.createBatch();for(const id of b.progressive!.trial_item_ids)s.finish(b,id);b.state='paused';b.progressive!.phase='awaiting_confirmation';s.controls.dropContinue=true;await page.goto(s.results);
 await current(page).getByRole('button',{name:'继续生成其余 3 份'}).click();await expect(page.locator('#wp-results-status')).not.toBeEmpty();await current(page).getByRole('button',{name:'继续生成其余 3 份'}).click();await expect(current(page)).toContainText('等待开始生成');
 const actions=s.calls.filter(c=>c.path.endsWith('/actions'));expect(actions).toHaveLength(2);expect(actions[0].body).toEqual(actions[1].body);await page.reload();await expect(current(page)).toContainText('等待开始生成');expect(s.calls.filter(c=>c.path.endsWith('/batches')&&c.method==='POST')).toHaveLength(0);
});

test('UX #1308: ZIP preparation keeps progress polling and pause/stop available, paused active files settle',async({page})=>{
 const s=await setup(page,3),b=s.createBatch();s.finish(b,b.progressive!.trial_item_ids[0]);await page.clock.install();await page.goto(s.results);
 await current(page).locator('[data-wp-zip]').click();await expect(page.locator('#wp-download-feedback')).toContainText('正在准备下载');await expect(current(page).getByRole('button',{name:'暂停',exact:true})).toBeEnabled();
 s.finish(b,b.progressive!.trial_item_ids[1]);await page.clock.fastForward(11000);await expect(current(page)).toContainText('2 / 6 份完成');await expect(page.locator('#wp-download-feedback')).toBeVisible();
 await current(page).getByRole('button',{name:'暂停',exact:true}).click();const item=b.items.find(i=>i.state==='queued')!;item.state='running';item.run_id='settling-run';await page.reload();await expect(current(page)).toContainText('当前 1 份仍在收尾');s.finish(b,item.entry.id);await page.clock.fastForward(11000);await expect(current(page)).toContainText('3 / 6 份完成');
 await current(page).getByRole('button',{name:'停止后续生成'}).click();await expect(current(page)).toContainText('3 份未生成');await expect(current(page).locator('[data-wp-action="retry_failed"]')).toHaveCount(0);
});

test('trial failures stay explicit and retry does not regenerate successes; restarting only opens preparation',async({page})=>{
 const s=await setup(page,3),b=s.createBatch();b.progressive!.trial_item_ids.forEach((id,index)=>s.finish(b,id,index===2));b.state='paused';b.progressive!.phase='awaiting_confirmation';await page.goto(s.results);
 await expect(current(page)).toContainText('2 份完成，1 份失败');await current(page).getByRole('button',{name:'仅重试失败的 1 份'}).click();await expect(current(page)).toContainText('等待开始重试失败文件');expect(b.items.filter(i=>i.state==='succeeded')).toHaveLength(2);
 b.state='partial';await page.reload();const before=s.calls.filter(c=>c.method==='POST').length;await current(page).getByRole('button',{name:'重新开始'}).click();await expect(page).toHaveURL(/step=prepare/);expect(s.calls.filter(c=>c.method==='POST')).toHaveLength(before);
});

test('outcomes distinguish documents and explanation reasons, stopped tasks finish before retry',async({page})=>{
 const s=await setup(page,4),b=s.createBatch();s.finish(b,b.items[0].entry.id);s.finish(b,b.items[1].entry.id);s.finish(b,b.items[2].entry.id,true);
 b.items[0].decision={item_id:b.items[0].entry.id,status:'not_applicable',reason:'无适用业务',missing_materials:[],citations:[]};b.items[1].decision={item_id:b.items[1].entry.id,status:'missing_information',reason:'缺少资料',missing_materials:['原始凭证'],citations:[]};
 s.finish(b,b.items[3].entry.id);delete b.items[3].explanation;b.items[3].artifacts=[{kind:'document',filename:'合成底稿.docx',pin:{source_project_id:ids.api,artifact_id:'completed-document',artifact_version:1,sha256:sha}}];
 b.items[4].state='paused';b.items[4].run_id='paused-task';b.state='cancelled';await page.goto(s.results);
 await expect(current(page)).toContainText('已生成底稿 1 份 · 说明 2 份 · 失败 1 份');await expect(current(page)).toContainText('业务不适用');await expect(current(page)).toContainText('资料不足，暂无法生成');await expect(current(page)).toContainText('等待处理条件恢复或补充信息');
 await expect(current(page).getByRole('link',{name:'查看任务'})).toHaveAttribute('href',/run=paused-task/);await expect(current(page).getByRole('button',{name:'仅重试失败的 1 份'})).toBeDisabled();await expect(current(page).locator('[data-wp-zip]')).toBeEnabled();
 b.items[4].state='running';await page.reload();await expect(current(page)).toContainText('仍在收尾');await expect(current(page).getByRole('button',{name:'仅重试失败的 1 份'})).toBeDisabled();
});

test('shared blocked failures offer retry after active and attention files settle',async({page})=>{
 const s=await setup(page,3),b=s.createBatch();s.finish(b,b.items[0].entry.id);s.finish(b,b.items[1].entry.id,true);
 b.state='paused';b.pause_reason='shared_blocked';b.items[2].state='paused';b.items[2].run_id='attention-task';await page.goto(s.results);
 const retry=current(page).getByRole('button',{name:'重试受阻文件并继续'});
 await expect(retry).toBeDisabled();await expect(current(page)).toContainText('生成遇到阻碍，已保留成果');
 await expect(current(page).getByRole('button',{name:'继续本批',exact:true})).toHaveCount(0);
 await expect(current(page).getByRole('link',{name:'查看任务'})).toHaveAttribute('href',/run=attention-task/);
 b.items[2].state='awaiting_input';await page.reload();await expect(retry).toBeDisabled();
 b.items[2].state='running';await page.reload();await expect(retry).toBeDisabled();
 s.finish(b,b.items[2].entry.id,true);await page.reload();await expect(retry).toBeEnabled();await retry.click();
 await expect(current(page)).toContainText('等待开始试生成 3 份文件');expect(b.items[0].state).toBe('succeeded');
 expect(s.calls.filter(c=>c.path.endsWith('/actions')).map(c=>c.body.action)).toEqual(['retry_failed']);
});

test('shared blocked batch can resume after all blocked tasks recover successfully',async({page})=>{
 const s=await setup(page,3),b=s.createBatch();s.finish(b,b.items[0].entry.id);
 b.state='paused';b.pause_reason='shared_blocked';await page.goto(s.results);
 const resume=current(page).getByRole('button',{name:'继续本批',exact:true});
 await expect(resume).toBeDisabled();await expect(current(page).getByRole('button',{name:'重试受阻文件并继续'})).toHaveCount(0);
 s.finish(b,b.items[1].entry.id);await page.reload();await expect(resume).toBeEnabled();await expect(current(page)).toContainText('受阻文件已处理，可继续本批任务');
 await resume.click();await expect(current(page)).toContainText('等待开始试生成 3 份文件');
 expect(b.items.filter(i=>i.state==='succeeded')).toHaveLength(2);expect(s.calls.filter(c=>c.path.endsWith('/actions')).map(c=>c.body.action)).toEqual(['resume']);
});
