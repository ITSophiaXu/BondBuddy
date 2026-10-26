import {expect,test,type Locator,type Page} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {M4_DOCUMENT_BILLING_TASKS,M4_DOCUMENT_FIXED_PRICE} from '@bondbuddy/contracts';
import {batches,choose,documents,drafts,entry,fault,href,ids,installStorageControl,query,selected,writes} from './generation-entry-fixtures';
import {actionCalls,artifacts,assertDeliveryFixture,batch,deliveryFixture,queue,seed,setItemState,types,workspace,type State} from './batch-delivery-fixtures';
import {downloadBytes,hash} from './word-roundtrip-fixtures';
import {installBatchDeliveryReference} from './batch-delivery-reference';

// R21 closes one synthetic native-route business journey. Real worker/model,
// storage, fees and business-user acceptance remain separate verification.
const row=(page:Page,type:string)=>page.locator(`[data-pf-document="${type}"]`);
const batchCard=(page:Page)=>page.locator('[data-pf-batch]').first();
const refresh=(page:Page)=>page.locator('#pf-refresh-results');
async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual((await page.viewportSize())!.width+1);}
async function nextRead(s:State,after=s.delivery.reads){await expect.poll(()=>s.delivery.reads,{timeout:7500}).toBeGreaterThan(after);}
async function openResults(page:Page){await page.goto('/'+href({step:'results'}));await expect(page.getByRole('heading',{name:'文件生成任务',exact:true})).toBeVisible();}
async function stop(page:Page){await page.locator('[data-batch-cancel]').click();await expect(batchCard(page)).toHaveAttribute('data-pf-batch-state','cancelled');}
async function exactDownload(page:Page,button:Locator){const pending=page.waitForEvent('download');await button.click();const download=await pending;return {filename:download.suggestedFilename(),bytes:await downloadBytes(download)};}
function addDecoy(s:State){
  const w=workspace(s).workspace,task=structuredClone(w.tasks[0]);
  task.run.run_id='unrelated-same-type-run';task.run.execution_request_id='unrelated-same-type-request';task.run.artifact_id='decoy-document';
  if(task.manifest.kind==='document'){task.manifest.input.document_type='underwriter';task.manifest.billing_task=M4_DOCUMENT_BILLING_TASKS.underwriter;}
  task.run.input_hash=hash(JSON.stringify(task.manifest));
  task.artifacts=task.artifacts.map(a=>({...a,artifact_id:'decoy-'+a.kind,run_id:task.run.run_id,input_hash:task.run.input_hash,document_type:'underwriter' as const,filename:'其他任务_'+a.filename}));
  w.tasks.push(task);w.artifacts.push(...task.artifacts);
}

for(const width of [1440,390])test(`batch delivery: explicit three-file package, stopped later work, exact paired Word and next preparation at ${width}px`,async({page})=>{
  test.setTimeout(60000);await page.setViewportSize({width,height:900});const s=await deliveryFixture(page),w=workspace(s),before=structuredClone(w.workspace.drafts),source=structuredClone(w.source!);
  await entry(page,'init');await documents(page);const directory=page.locator('#pf-document-directory');
  if(!await directory.evaluate(node=>(node as HTMLDetailsElement).open))await directory.locator('summary').click();
  await choose(page,types);await expect(page.locator('#pf-price')).toContainText((3*M4_DOCUMENT_FIXED_PRICE.points).toLocaleString());
  await page.locator('#pf-generate').click();await expect(page.locator('.pf-confirm-files li')).toHaveCount(3);expect(batches(s)).toEqual([]);
  await page.locator('#pf-confirm-generation').click();await expect(page.getByRole('heading',{name:'文件生成任务',exact:true})).toBeVisible();
  expect(batches(s)).toHaveLength(1);expect(batches(s)[0].body).toEqual({request_id:expect.any(String),source_version_id:source.version_id,expected_selection_revision:source.selection_revision,
    documents:types.map(document_type=>({document_type,draft_version:before[document_type].version}))});expect(drafts(s)).toEqual([]);
  setItemState(s,0,'succeeded');setItemState(s,1,'running');
  await expect(row(page,'init').locator('[data-pf-download]')).toHaveCount(2,{timeout:7500});await expect(row(page,'underwriter')).toHaveAttribute('data-pf-run',batch(s).items[1].run_id!);
  const runId=batch(s).items[1].run_id!,run=structuredClone(w.workspace.tasks.find(t=>t.run.run_id===runId)!.run),frozen=structuredClone([...s.delivery.requests.values()][0].manifests);
  await stop(page);expect(actionCalls(s).map(c=>c.body)).toEqual([{action:'cancel'}]);expect(batch(s).items.map(i=>i.run_id)).toEqual([batch(s).items[0].run_id,runId,null]);
  await expect(batchCard(page)).toContainText('已停止后续生成');await expect(row(page,'legal')).toContainText('本轮未启动，不会继续生成');
  await expect(row(page,'underwriter').getByRole('link',{name:'查看任务',exact:true})).toHaveAttribute('href',new RegExp('run='+runId));
  expect(w.workspace.tasks.find(t=>t.run.run_id===runId)!.run).toEqual(run);
  setItemState(s,1,'succeeded');const exact=w.workspace.tasks.find(t=>t.run.run_id===runId)!,delivered=structuredClone(exact.artifacts);addDecoy(s);
  // The API reads tasks/artifacts before batchDto. Both bounded non-atomic
  // snapshots must converge on the original run rather than another same type.
  if(width===1440){exact.run.state='running';exact.run.artifact_id=null;exact.artifacts=[];}
  else exact.artifacts=exact.artifacts.filter(a=>a.kind==='document');
  await nextRead(s);await expect(row(page,'underwriter').locator('[data-pf-download]')).toHaveCount(width===1440?0:1);
  await expect(page.locator('[data-pf-download^="decoy-"]')).toHaveCount(0);expect(batches(s)).toHaveLength(1);expect(actionCalls(s)).toHaveLength(1);
  exact.run.state='succeeded';exact.run.artifact_id=delivered.find(a=>a.kind==='document')!.artifact_id;exact.artifacts=delivered;
  await expect(row(page,'underwriter').locator('[data-pf-download]')).toHaveCount(2,{timeout:7500});await expect(row(page,'legal').locator('[data-pf-download]')).toHaveCount(0);
  for(const stored of artifacts(s)){
    const a=stored.artifact,receipt=await exactDownload(page,page.locator(`[data-pf-download="${a.artifact_id}"]`));
    expect(receipt.filename).toBe(a.filename);expect(receipt.bytes).toEqual(stored.bytes);expect(hash(receipt.bytes)).toBe(a.sha256);expect(a.artifact_version).toBe(1);
    expect(receipt.bytes.subarray(0,4)).toEqual(Buffer.from([0x50,0x4b,0x03,0x04]));const content=receipt.bytes.toString('utf8');
    expect(content).toContain(a.run_id);expect(content).toContain(source.version_id);expect(content).toContain(source.asset.pin.sha256);expect(content).toContain(before[a.document_type!].template!.sha256);
    expect(content).toContain(before[a.document_type!].supplemental_requirements!);expect(content).toContain(a.input_hash);
    expect(s.calls.filter(c=>c.method==='GET'&&c.path===`/artifacts/${a.artifact_id}/download`)).toHaveLength(1);
  }
  expect(artifacts(s)).toHaveLength(4);expect(w.files.map(f=>({type:f.document_type,run:f.run_id,version:f.asset.pin}))).toEqual(artifacts(s).filter(a=>a.artifact.kind==='document').map(a=>({type:a.artifact.document_type,run:a.artifact.run_id,
    version:{source_project_id:a.artifact.source_project_id,artifact_id:a.artifact.artifact_id,artifact_version:1,sha256:a.artifact.sha256}})));
  const reads=s.delivery.reads;await page.waitForTimeout(3400);expect(s.delivery.reads).toBe(reads);const accepted=batches(s).length,actions=actionCalls(s).length;
  await page.getByRole('link',{name:'准备下一轮文件',exact:true}).click();await expect(page.locator('#pf-generate')).toBeVisible();expect(await selected(page)).toEqual(types);
  const preparationReads=s.delivery.reads;await page.waitForTimeout(3400);await expect(page.locator('#pf-generate')).toBeVisible();expect((await query(page)).step).toBe('documents');expect(s.delivery.reads).toBe(preparationReads);
  expect(batches(s)).toHaveLength(accepted);expect(actionCalls(s)).toHaveLength(actions);expect(w.workspace.drafts).toEqual(before);expect([...s.delivery.requests.values()][0].manifests).toEqual(frozen);
  expect((await query(page)).project).toBe(ids.api);await noOverflow(page);assertDeliveryFixture(s);
});

test('batch delivery: an older in-flight workspace GET cannot restore running after stopping later files',async({page})=>{
  const s=await deliveryFixture(page);seed(s);await openResults(page);s.delivery.holdNextRead=true;await expect.poll(()=>s.delivery.held.length,{timeout:7500}).toBe(1);
  const stale=s.delivery.held[0];try{expect(stale.snapshot.batches[0].state).toBe('running');await stop(page);await expect(row(page,'legal')).toContainText('本轮未启动，不会继续生成');
  const response=page.waitForResponse(r=>r.request().method()==='GET'&&new URL(r.url()).pathname.endsWith('/project-files/workspace'));stale.release();await response;
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(batchCard(page)).toHaveAttribute('data-pf-batch-state','cancelled');await expect(row(page,'init').locator('[data-pf-download]')).toHaveCount(2);
  await expect(row(page,'underwriter')).toHaveAttribute('data-pf-run',batch(s).items[1].run_id!);expect(actionCalls(s)).toHaveLength(1);expect(batches(s)).toEqual([]);assertDeliveryFixture(s);
  }finally{stale.release();}
});

test('batch delivery: failed read keeps delivered files and stopped state, and explicit refresh only rereads',async({page})=>{
  const s=await deliveryFixture(page);seed(s,'cancelled');await openResults(page);const initial=structuredClone(batch(s)),delivered=artifacts(s).map(a=>a.artifact);s.delivery.failReads=1;
  await refresh(page).click();await expect.poll(()=>s.delivery.failReads).toBe(0);await expect(page.locator('#pf-status')).toContainText('刷新未成功，已保留上次读取的状态与成果');
  await expect(batchCard(page)).toHaveAttribute('data-pf-batch-state','cancelled');await expect(row(page,'init').locator('[data-pf-download]')).toHaveCount(2);await expect(row(page,'legal')).toContainText('本轮未启动，不会继续生成');
  expect(batch(s)).toEqual(initial);expect(artifacts(s).map(a=>a.artifact)).toEqual(delivered);expect(writes(s)).toEqual([]);
  setItemState(s,1,'succeeded');const reads=s.delivery.reads;await refresh(page).click();await expect.poll(()=>s.delivery.reads).toBeGreaterThan(reads);
  await expect(row(page,'underwriter').locator('[data-pf-download]')).toHaveCount(2);expect(writes(s)).toEqual([]);
  const stored=artifacts(s)[0],id=stored.artifact.artifact_id,downloads:string[]=[];page.on('download',d=>downloads.push(d.suggestedFilename()));stored.metadata.version=2;
  await page.locator(`[data-pf-download="${id}"]`).click();await expect(page.locator('#pf-status')).toContainText('文件版本已变化');expect(downloads).toEqual([]);
  expect(s.calls.filter(c=>c.path===`/artifacts/${id}/download`)).toEqual([]);stored.metadata.version=1;
  const receipt=await exactDownload(page,page.locator(`[data-pf-download="${id}"]`));expect(hash(receipt.bytes)).toBe(stored.artifact.sha256);expect(receipt.filename).toBe(stored.artifact.filename);
  expect(writes(s)).toEqual([]);assertDeliveryFixture(s);
});

test('batch delivery: paused batch and exact paused or awaiting-input run remain readable through explicit stop and resumed completion',async({page})=>{
  test.setTimeout(45000);const s=await deliveryFixture(page);seed(s,'paused','awaiting_input');await openResults(page);const id=batch(s).items[1].run_id!;
  await expect(row(page,'underwriter').getByRole('link',{name:'查看任务',exact:true})).toHaveAttribute('href',new RegExp('run='+id));await nextRead(s);
  setItemState(s,1,'paused');await nextRead(s);await expect(row(page,'underwriter')).toHaveAttribute('data-pf-item-state','paused');await stop(page);
  setItemState(s,1,'awaiting_input');await nextRead(s);await expect(row(page,'underwriter')).toHaveAttribute('data-pf-item-state','awaiting_input');await expect(row(page,'legal')).toContainText('本轮未启动，不会继续生成');
  setItemState(s,1,'running');await nextRead(s);await expect(row(page,'underwriter')).toHaveAttribute('data-pf-item-state','running');
  setItemState(s,1,'succeeded');await expect(row(page,'underwriter').locator('[data-pf-download]')).toHaveCount(2,{timeout:7500});
  await expect(row(page,'underwriter')).toHaveAttribute('data-pf-run',id);const reads=s.delivery.reads;await page.waitForTimeout(3400);expect(s.delivery.reads).toBe(reads);
  expect(actionCalls(s).map(c=>c.body)).toEqual([{action:'cancel'}]);expect(batches(s)).toEqual([]);
  queue(s,'all-not-started-package');await refresh(page).click();await expect(batchCard(page)).toHaveAttribute('data-pf-batch-state','queued');await stop(page);
  expect(batch(s).items.every(i=>i.run_id===null)).toBe(true);await expect(batchCard(page).locator('[data-pf-run=""]')).toHaveCount(3);await expect(batchCard(page)).toContainText('本轮未启动，不会继续生成');
  await expect(batchCard(page).locator('[data-pf-download]')).toHaveCount(0);const settledReads=s.delivery.reads;await page.waitForTimeout(3400);expect(s.delivery.reads).toBe(settledReads);
  expect(actionCalls(s).map(c=>c.body)).toEqual([{action:'cancel'},{action:'cancel'}]);expect(batches(s)).toEqual([]);assertDeliveryFixture(s);
});

test('batch delivery: R19 unknown preparation has priority over an in-flight stopped-batch result read',async({page})=>{
  await installStorageControl(page);const s=await deliveryFixture(page);seed(s,'cancelled');await page.goto('/'+href({step:'results',prepare_document:'credit',prepare_wait:'1'}));
  await expect(page.locator('#pf-entry-continue')).toBeVisible();s.delivery.holdNextRead=true;await expect.poll(()=>s.delivery.held.length,{timeout:7500}).toBe(1);
  const held=s.delivery.held[0];try{
  await fault(page,{read:true});await page.locator('#pf-entry-continue').click();await expect(page.locator('#pf-entry-retry')).toBeVisible();await expect(page.locator('.pf-batch')).toHaveCount(0);
  const reads=s.delivery.reads,response=page.waitForResponse(r=>r.request().method()==='GET'&&new URL(r.url()).pathname.endsWith('/project-files/workspace'));held.release();await response;
  await page.waitForTimeout(3400);await expect(page.locator('#pf-entry-retry')).toBeVisible();await expect(page.locator('.pf-batch')).toHaveCount(0);await expect(refresh(page)).toHaveCount(0);expect(s.delivery.reads).toBe(reads);
  expect(writes(s)).toEqual([]);await fault(page,{read:false});await page.locator('#pf-entry-retry').click();await expect(batchCard(page)).toHaveAttribute('data-pf-batch-state','cancelled');expect(writes(s)).toEqual([]);assertDeliveryFixture(s);
  }finally{held.release();}
});

for(const width of [1440,390])test(`batch delivery component comparison at ${width}px uses the same stopped package and exact task artifacts`,async({page})=>{
  await page.setViewportSize({width,height:900});const reference=process.env.BB_BATCH_DELIVERY_REFERENCE==='1',verify=reference?await installBatchDeliveryReference(page):undefined,s=await deliveryFixture(page);seed(s,'cancelled');await openResults(page);
  const dir=process.env.BB_BATCH_DELIVERY_EVIDENCE_DIR??test.info().outputPath('component-capture');await mkdir(dir,{recursive:true});
  const capture=async(name:string)=>{
    await page.evaluate(()=>scrollTo(0,0));await noOverflow(page);const layout=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,text:document.body.innerText,
      refreshButtons:document.querySelectorAll('#pf-refresh-results').length,downloads:document.querySelectorAll('[data-pf-download]').length}));
    await page.screenshot({path:join(dir!,`batch-delivery-${name}-${width}.png`),fullPage:true});
    await writeFile(join(dir!,`batch-delivery-${name}-${width}.json`),JSON.stringify({...layout,reference,query:await query(page),batch:batch(s),artifacts:artifacts(s).map(a=>({artifact:a.artifact,bytes_sha256:hash(a.bytes)}))},null,2));
  };
  await capture('cancelled-running');setItemState(s,1,'succeeded');await page.reload();await expect(page.getByRole('heading',{name:'文件生成任务',exact:true})).toBeVisible();await capture('cancelled-completed');
  expect(artifacts(s)).toHaveLength(4);expect(writes(s)).toEqual([]);assertDeliveryFixture(s);if(verify)await writeFile(join(dir!,`batch-delivery-reference-${width}.json`),JSON.stringify(await verify(),null,2));
});
