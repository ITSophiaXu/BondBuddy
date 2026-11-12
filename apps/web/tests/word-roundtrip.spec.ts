import {expect,test,type Locator,type Page} from '@playwright/test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {M4_DOCUMENT_FIXED_PRICE} from '@bondbuddy/contracts';
import {appendMaterial,assertFixture,businessCalls,docx,downloadBytes,editedFile,fixture,hash,ids,
  importCalls,install,openFiles,originalBytes,originalPin,writeCalls,type State} from './word-roundtrip-fixtures';
import {installWordRoundtripReference} from './word-roundtrip-reference';

const referenceMode=process.env.BB_WORD_ROUNDTRIP_REFERENCE==='1';
const row=(page:Page,version=ids.version)=>page.locator(`.collection-file[data-file-version="${version}"]`);
const importDialog=(page:Page)=>page.getByRole('dialog',{name:'上传此文件修改稿',exact:true});
const result=(page:Page)=>page.getByRole('region',{name:'项目文件保存结果'});
const noOverflow=async(page:Page)=>expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
async function prepareImport(page:Page,beforeChoose?:()=>void){
  await row(page).getByRole('button',{name:'上传此文件修改稿',exact:true}).click();
  const dialog=importDialog(page);await expect(dialog).toBeVisible();
  await expect(dialog.locator('#pw-import-target')).toContainText('合成 Word 往返项目');
  await expect(dialog.locator('#pw-import-target')).toContainText('立项报告原稿_V1.docx · V1');
  await expect(dialog.locator('[name=type]')).toHaveValue('init');await expect(dialog.locator('[name=type]')).toBeDisabled();
  beforeChoose?.();await dialog.locator('[name=file]').setInputFiles(editedFile);return dialog;
}
async function saveImport(page:Page){const dialog=await prepareImport(page);await expect(dialog).toHaveCount(0);await expect(result(page)).toContainText('修改稿已保存为 V2，原 V1 保留。');}
async function saveDownload(page:Page,button:Locator){const pending=page.waitForEvent('download');await button.click();return downloadBytes(await pending);}
async function historyDownloads(page:Page,s:State,newVersion=2){
  await result(page).getByRole('button',{name:'查看新旧版本',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'文件版本记录',exact:true});await expect(dialog).toBeVisible();
  const old=dialog.locator('article').filter({hasText:'V1 · 立项报告原稿_V1.docx'});
  const fresh=s.registry.find(v=>v.file_id===ids.family&&v.sequence===newVersion)!;
  const next=dialog.locator('article').filter({hasText:`V${newVersion} · ${fresh.filename}`});
  expect(await saveDownload(page,old.getByRole('button',{name:'下载',exact:true}))).toEqual(originalBytes);
  const bytes=await saveDownload(page,next.getByRole('button',{name:'下载',exact:true}));
  expect(hash(bytes)).toBe(fresh.asset.pin.sha256);expect(bytes).not.toEqual(originalBytes);
  await dialog.getByRole('button',{name:'关闭版本记录',exact:true}).click();return bytes;
}
async function capture(page:Page,name:string,extra:unknown={}){
  const directory=process.env.BB_WORD_ROUNDTRIP_EVIDENCE_DIR;if(!directory)return;
  await mkdir(directory,{recursive:true});await page.screenshot({path:join(directory,name+'.png')});
  const metrics=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,text:document.body.innerText,
    focus:document.activeElement?.getAttribute('aria-label')??document.activeElement?.textContent,
    dialogs:[...document.querySelectorAll('dialog[open]')].map(node=>({text:node.textContent,box:node.getBoundingClientRect().toJSON()}))}));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width+1);
  const sources=[];for(const file of ['project-files.ts','project-workbench.css']){const path='apps/web/src/'+file;const bytes=await readFile(resolve('../..',path));sources.push({path,sha256:hash(bytes)});}
  await writeFile(join(directory,name+'.json'),JSON.stringify({scenario:name,scope:referenceMode?'Exact old R16 component with current surrounding app':'Current ProjectFiles with real application routes',metrics,current_sources:sources,...extra as object},null,2));
}

test.describe('finite Word roundtrip contracts',()=>{
  test.skip(referenceMode,'The reference run captures old component differences; new functionality is absent there.');

  for(const width of [1440,390])test(`project file row opens the exact run and native continuation delivers retained old and new drafts at ${width}`,async({page})=>{
    await page.setViewportSize({width,height:960});const s=await install(page);await openFiles(page);
    const before=structuredClone(s.workspace.drafts.init),link=row(page).getByRole('link',{name:'打开此稿继续修改',exact:true});
    const href=await link.getAttribute('href'),query=new URLSearchParams(href!.split('?')[1]);
    expect(query.get('topic')).toBe(ids.topic);expect(query.get('run')).toBe(ids.originalRun);expect(query.get('return_project')).toBe(ids.root);
    await link.click();await expect(page.getByRole('button',{name:'继续修改',exact:true})).toBeVisible();
    await expect(page.locator('.m4-delivery')).toContainText('立项报告原稿_V1.docx');
    expect(s.workspace.drafts.init.edit_base).toBeNull();expect(s.quotes).toEqual([]);expect(s.executions).toEqual([]);
    await page.getByRole('button',{name:'继续修改',exact:true}).click();
    await expect(page.locator('#m4-requirements')).toHaveValue(before.supplemental_requirements!);
    const requirements='原审批口径必须保留。新增本轮董事会决议及2026年10月授信说明。';
    await page.locator('#m4-requirements').fill(requirements);
    // The real continue control, save and generation handler create this pin.
    // No component property or fixture input is preloaded with an edit_base.
    expect(s.executions).toEqual([]);expect(s.quotes).toEqual([]);await noOverflow(page);
    await page.getByRole('button',{name:'生成立项报告',exact:true}).click();
    await expect.poll(()=>s.executions.length).toBe(1);
    await expect(page.locator('.m4-delivery')).toContainText('立项报告新稿_V2.docx');
    expect(s.quotes).toHaveLength(1);expect(s.executions[0].quote_id).toBe('word-quote-1');
    expect(s.executions[0].expected_draft_version).toBe(s.workspace.drafts.init.version);
    const task=s.workspace.tasks.find(t=>t.run.run_id==='word-generated-run')!;expect(task.manifest.kind).toBe('document');
    if(task.manifest.kind!=='document')throw new Error('Missing native document manifest');
    expect(task.manifest.input.edit_base).toEqual(originalPin(s));expect(task.manifest.input.scope).toBe('whole');
    expect(task.manifest.input.source_material).toEqual(before.source_material);expect(task.manifest.input.materials).toEqual(before.materials);
    expect(task.manifest.input.template).toEqual(before.template);expect(task.manifest.input.requirements).toEqual(before.requirements);
    expect(task.manifest.input.supplemental_requirements).toBe(requirements);expect(task.manifest.input.project_file?.project_id).toBe(ids.root);
    expect(task.manifest.input.project_file?.expected_file_version_id).toBe(ids.version);
    expect(M4_DOCUMENT_FIXED_PRICE.points).toBe(4500);await expect(page.locator('dialog[open]')).toHaveCount(0);
    const newBytes=await saveDownload(page,page.getByRole('button',{name:'下载正文 Word',exact:true}));
    expect(newBytes.toString('utf8')).toContain(requirements);expect(hash(newBytes)).not.toBe(hash(originalBytes));
    await page.getByRole('link',{name:'返回本项目文件',exact:true}).click();await expect(page.locator('#file-list')).toBeVisible();
    const current=s.registry.find(v=>v.file_id===ids.family&&v.latest)!;expect(current.sequence).toBe(2);
    await row(page,current.version_id).getByRole('button',{name:'版本记录 (2)',exact:true}).click();
    const history=page.getByRole('dialog',{name:'文件版本记录'});
    expect(await saveDownload(page,history.locator('article').filter({hasText:'V1 · 立项报告原稿_V1.docx'}).getByRole('button',{name:'下载',exact:true}))).toEqual(originalBytes);
    expect(await saveDownload(page,history.locator('article').filter({hasText:'V2 · 立项报告新稿_V2.docx'}).getByRole('button',{name:'下载',exact:true}))).toEqual(newBytes);
    expect(s.executions).toHaveLength(1);expect(s.imports).toEqual([]);assertFixture(s);
  });

  test('same-name mismatches, missing run, file patch, plain topic and unavailable registries never guess a continuation',async({context})=>{
    const options:NonNullable<Parameters<typeof fixture>[0]>[]=[{mismatch:'hash'},{mismatch:'version'},{mismatch:'project'},{mismatch:'missing-run'},
      {mismatch:'file-patch'},{mismatch:'plain-topic'},{registryFailure:true},{workspaceFailure:true}];
    for(const option of options){const page=await context.newPage(),s=await install(page,fixture(option));await openFiles(page);
      const original=page.locator('#file-list>.collection-file').filter({hasText:'立项报告原稿_V1.docx'});
      await expect(original.getByRole('link',{name:'打开此稿继续修改',exact:true})).toHaveCount(0);
      await expect(original).toContainText(option.registryFailure?'文件版本暂未核对':'此稿暂不能直接接续');
      if(!option.registryFailure)await expect(original.getByRole('button',{name:'上传此文件修改稿',exact:true})).toBeVisible();
      const material=page.locator('#file-list>.collection-file').filter({hasText:'发行人基本情况.docx'});
      await expect(material.getByRole('link',{name:'打开此稿继续修改',exact:true})).toHaveCount(0);
      expect(businessCalls(s)).toEqual([]);assertFixture(s);await page.close();
    }
  });

  for(const width of [1440,390])test(`download original DOCX, save an explicit row-targeted Word revision, retain bytes and freely check all current files at ${width}`,async({page})=>{
    await page.setViewportSize({width,height:960});const s=await install(page);await openFiles(page);
    const downloaded=await saveDownload(page,row(page).getByRole('button',{name:'下载',exact:true}));
    expect(downloaded).toEqual(originalBytes);expect(downloaded.subarray(0,4)).toEqual(Buffer.from([0x50,0x4b,0x03,0x04]));
    expect(editedFile.buffer.toString('utf8')).toContain('人工离线修改');expect(hash(editedFile.buffer)).not.toBe(hash(downloaded));
    await saveImport(page);expect(s.imports).toHaveLength(1);expect(s.sessions.size).toBe(1);expect(s.puts).toBe(1);
    const input=s.imports[0],saved=s.registry.find(v=>v.file_id===ids.family&&v.sequence===2)!;
    expect(importCalls(s)[0].path).toBe(`/projects/${ids.root}/project-files/imports`);expect(input.document_type).toBe('init');
    expect(input.expected_latest_version_id).toBe(ids.version);expect(input.material.source_project_id).toBe(ids.root);
    expect(input.material.sha256).toBe(hash(editedFile.buffer));expect(saved.asset).toEqual({kind:'material',pin:input.material});
    await expect(row(page,saved.version_id)).toContainText('待检查');expect(businessCalls(s)).toEqual([]);
    expect(await historyDownloads(page,s)).toEqual(editedFile.buffer);await noOverflow(page);
    const check=result(page).getByRole('link',{name:'检查全部项目文件',exact:true});
    await expect(check).toHaveAttribute('href',new RegExp(`project=${ids.root}`));await check.click();
    await expect(page.getByRole('heading',{name:'准备检查项目文件',exact:true})).toBeVisible();await expect(page.locator('.fc-empty')).toContainText('本次范围：2 份文件');
    expect(s.checkRequests).toEqual([]);await page.getByRole('button',{name:'开始检查（免费）',exact:true}).click();
    await expect.poll(()=>s.checkRequests.length).toBe(1);expect(s.checkRequests[0].expected_source_version_id).toBe(s.source.version_id);
    expect(s.checks[0].files.map(f=>f.file_version_id).sort()).toEqual(s.registry.filter(f=>f.latest).map(f=>f.version_id).sort());
    expect(s.checks[0].files).toHaveLength(2);expect(writeCalls(s).filter(c=>/\/updates(?:\/|$)/.test(c.path))).toEqual([]);
    expect(s.quotes).toEqual([]);expect(s.executions).toEqual([]);assertFixture(s);
  });

  test('a newer file while the original dialog is open rejects the original CAS and retains the selected local file',async({page})=>{
    const s=await install(page);await openFiles(page);let newer!:ReturnType<typeof appendMaterial>;const dialog=await prepareImport(page,()=>{newer=appendMaterial(s);});

    await expect(dialog.locator('[role=status]')).toContainText('刷新后重新选择目标');
    await expect(dialog.getByRole('button',{name:'重试保存项目文件',exact:true})).toBeDisabled();
    expect(await dialog.locator('[name=file]').evaluate((node:HTMLInputElement)=>node.files?.[0]?.name)).toBe(editedFile.name);
    expect(s.imports).toHaveLength(1);expect(s.imports[0].expected_latest_version_id).toBe(ids.version);
    expect(s.importReceipts.size).toBe(0);expect(s.registry.find(v=>v.file_id===ids.family&&v.latest)?.version_id).toBe(newer!.version_id);
    await dialog.getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:'刷新文件',exact:true}).click();
    await expect(row(page,newer!.version_id)).toBeVisible();expect(s.imports).toHaveLength(1);expect(businessCalls(s)).toEqual([]);assertFixture(s);
  });

  test('an accepted import with a lost reply resumes only the original identity and does not mistake a later latest version for this save',async({page})=>{
    const s=await install(page);s.dropImportOnce=true;await openFiles(page);const dialog=await prepareImport(page);
    await expect(dialog.locator('[role=status]')).toContainText('保存结果尚未确认');
    expect(s.importReceipts.size).toBe(1);const first=structuredClone(s.imports[0]),saved=s.registry.find(v=>v.file_id===ids.family&&v.sequence===2)!;
    const third=appendMaterial(s);const writes=writeCalls(s).length;
    await page.reload();await expect(page.locator('[data-resume-project-file]')).toBeVisible();expect(writeCalls(s)).toHaveLength(writes);
    await page.locator('[data-resume-project-file]').click();const recovery=importDialog(page);
    await expect(recovery.locator('#pw-import-target')).toContainText('立项报告原稿_V1.docx · V1');
    await expect(recovery.locator('[name=type]')).toHaveValue('init');await expect(recovery.locator('[name=type]')).toBeDisabled();
    await recovery.getByRole('button',{name:'重试保存项目文件',exact:true}).click();await expect(recovery).toHaveCount(0);
    await expect(result(page)).toContainText('修改稿已保存为 V2，原 V1 保留。');await expect(result(page)).toContainText('当前文件已有后续版本');
    expect(s.imports).toEqual([first,first]);expect(s.importReceipts.size).toBe(1);expect(s.puts).toBe(1);expect(s.sessions.size).toBe(1);
    expect(s.registry.filter(v=>v.file_id===ids.family)).toHaveLength(3);expect(s.registry.find(v=>v.file_id===ids.family&&v.latest)?.version_id).toBe(third.version_id);
    expect(saved.asset).toEqual({kind:'material',pin:first.material});expect(await historyDownloads(page,s)).toEqual(editedFile.buffer);
    await expect(page.locator('[data-resume-project-file]')).toHaveCount(0);expect(businessCalls(s)).toEqual([]);assertFixture(s);
  });

  test('confirmed save followed by list failure stays confirmed and a read-only refresh locates the exact saved version even after a third draft',async({page})=>{
    const s=await install(page);s.failFilesAfterImport=true;await openFiles(page);const dialog=await prepareImport(page);
    await expect(dialog).toHaveCount(0);
    await expect(result(page)).toContainText('文件已保存，列表暂未同步');await expect(page.locator('[data-resume-project-file]')).toHaveCount(0);
    expect(s.importReceipts.size).toBe(1);const imports=s.imports.length,writes=writeCalls(s).length;appendMaterial(s);s.filesFailure=false;
    await page.getByRole('button',{name:'刷新文件',exact:true}).click();await expect(result(page)).toContainText('修改稿已保存为 V2，原 V1 保留。');
    await expect(result(page)).toContainText('当前文件已有后续版本');expect(s.imports).toHaveLength(imports);expect(writeCalls(s)).toHaveLength(writes);
    expect(await historyDownloads(page,s)).toEqual(editedFile.buffer);expect(businessCalls(s)).toEqual([]);assertFixture(s);
  });

  test('an unresolved original import is isolated from another signed-in owner and remains available to the original owner',async({page})=>{
    const s=await install(page);s.dropImportOnce=true;await openFiles(page);const dialog=await prepareImport(page);
    await expect(dialog.locator('[role=status]')).toContainText('尚未确认');
    const first=structuredClone(s.imports[0]),writes=writeCalls(s).length;s.owner=ids.otherOwner;
    await page.goto(`/?word-owner=b#/projects/${ids.otherRoot}/files`);await expect(page.getByRole('heading',{name:'另一个账号的项目',exact:true})).toBeVisible();
    await expect(page.locator('[data-resume-project-file]')).toHaveCount(0);await expect(page.getByText(editedFile.name,{exact:false})).toHaveCount(0);
    expect(writeCalls(s)).toHaveLength(writes);expect(s.calls.filter(c=>c.owner===ids.otherOwner&&c.method!=='GET')).toEqual([]);
    s.owner=ids.owner;await page.goto(`/?word-owner=a#/projects/${ids.root}/files`);await expect(page.locator('[data-resume-project-file]')).toBeVisible();
    expect(s.imports).toEqual([first]);await page.locator('[data-resume-project-file]').click();await importDialog(page).getByRole('button',{name:'重试保存项目文件',exact:true}).click();
    await expect(result(page)).toContainText('修改稿已保存为 V2');expect(s.imports).toEqual([first,first]);expect(s.puts).toBe(1);assertFixture(s);
  });
});

for(const width of [1440,390])test(`component comparison: row and import dialog are keyboard reachable at ${width}; sealed R16 captures the actual old generic dialog`,async({page})=>{
  await page.setViewportSize({width,height:960});
  const verifyReference=referenceMode?await installWordRoundtripReference(page):undefined;
  const s=await install(page);await openFiles(page);const prefix=referenceMode?'reference':'implementation';
  const original=page.locator('#file-list>.collection-file').filter({hasText:'立项报告原稿_V1.docx'});
  await original.scrollIntoViewIfNeeded();await noOverflow(page);await capture(page,`${prefix}-row-${width}`);
  if(referenceMode){
    await expect(original.getByRole('button',{name:'上传此文件修改稿',exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'上传关联文件',exact:true}).click();
    const dialog=page.locator('dialog.pf-modal[open]');await dialog.locator('[name=type]').selectOption('init');
    await expect(dialog.locator('[name=type]')).toBeEnabled();await dialog.locator('[name=file]').setInputFiles(editedFile);
    await capture(page,`${prefix}-dialog-${width}`,{comparison:'R16 has only a generic type-selectable import dialog; no original-row target summary or locked type.'});
    const provenance=await verifyReference!();const directory=process.env.BB_WORD_ROUNDTRIP_EVIDENCE_DIR;
    if(directory)await writeFile(join(directory,`${prefix}-provenance-${width}.json`),JSON.stringify(provenance,null,2));
  }else{
    const opener=original.getByRole('button',{name:'上传此文件修改稿',exact:true});await opener.focus();await page.keyboard.press('Enter');
    const dialog=importDialog(page);await expect(dialog).toBeVisible();await expect(dialog.locator('[name=type]')).toBeDisabled();
    await expect(dialog.locator('#pw-import-target')).toContainText('立项报告原稿_V1.docx · V1');await noOverflow(page);
    const close=dialog.locator('[data-close]'),file=dialog.locator('[name=file]');
    await close.focus();await page.keyboard.press('Tab');await expect(file).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(close).toBeFocused();
    await capture(page,`${prefix}-dialog-${width}`,{comparison:'Current dialog fixes root/type/original version and preserves the original file.'});
    await page.keyboard.press('Enter');await expect(dialog).toHaveCount(0);await expect(opener).toBeFocused();
    expect(writeCalls(s)).toEqual([]);
  }
  expect(businessCalls(s)).toEqual([]);assertFixture(s);
});
