# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: prospectus-saved-reentry.spec.ts >> prospectus saved reentry native desktop journeys >> saved prospectus reentry: the native generation source step discovers the same retained candidate without preparing drafts or starting generation
- Location: tests\prospectus-saved-reentry.spec.ts:92:3

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: locator.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for getByRole('link', { name: '项目文件', exact: true })

```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - link "跳到主要内容" [ref=e2] [cursor=pointer]:
    - /url: "#main"
  - generic [ref=e4]:
    - complementary [ref=e5]:
      - link "bondbuddy" [ref=e6] [cursor=pointer]:
        - /url: "#tasks"
      - strong [ref=e12]: 我的工作空间
      - navigation "主导航" [ref=e13]:
        - link "任务进度与结果" [ref=e14] [cursor=pointer]:
          - /url: "#tasks"
        - generic [ref=e18]: 开始工作
        - link "更新募集书" [ref=e19] [cursor=pointer]:
          - /url: "#update"
        - link "复核募集书" [ref=e23] [cursor=pointer]:
          - /url: "#review"
        - link "文件生成" [ref=e27] [cursor=pointer]:
          - /url: "#generate"
        - link "诚信核查" [ref=e31] [cursor=pointer]:
          - /url: "#integrity"
        - link "项目问答" [ref=e35] [cursor=pointer]:
          - /url: "#qa"
      - generic [ref=e40]:
        - link "我的账号" [ref=e41] [cursor=pointer]:
          - /url: "#/account?project=saved-reentry-project&return_project=saved-reentry-project&return_to=%23generate%3Fproject%3Dsaved-reentry-project%26return_project%3Dsaved-reentry-project"
          - generic [aria-hidden] [ref=e42]: 我
          - strong [ref=e43]: synthetic_saved_source
        - button "退出" [ref=e44] [cursor=pointer]
    - generic [ref=e45]:
      - banner [ref=e46]:
        - generic [ref=e47]:
          - generic [ref=e48]: 工作空间
          - generic [ref=e51]: 文件生成
      - main [ref=e52]:
        - region "当前项目" [ref=e53]:
          - generic [ref=e54]:
            - generic [ref=e55]: 当前项目
            - strong [ref=e56]: 合成保存新稿后重入项目
          - link "返回本项目文件" [ref=e57] [cursor=pointer]:
            - /url: "#/projects/saved-reentry-project/files"
        - generic [ref=e59]:
          - heading "生成文件" [level=1] [ref=e61]
          - navigation "文件生成导航" [ref=e62]:
            - link "生成记录" [ref=e63] [cursor=pointer]:
              - /url: "#generate?project=saved-reentry-project&step=results&return_project=saved-reentry-project"
        - navigation "文件生成步骤" [ref=e64]:
          - generic [ref=e65]:
            - generic [ref=e66]: "1"
            - text: 选择募集说明书
          - generic [ref=e67]:
            - generic [ref=e68]: "2"
            - text: 选择生成内容
          - generic [ref=e69]:
            - generic [ref=e70]: "3"
            - text: 确认并生成
          - generic [ref=e71]:
            - generic [ref=e72]: "4"
            - text: 查看成果
        - generic [ref=e73]:
          - generic [ref=e75]:
            - heading "选择募集说明书" [level=2] [ref=e76]
            - group "提供募集说明书的方式" [ref=e77]:
              - generic [ref=e79] [cursor=pointer]:
                - radio "上传新募集说明书" [ref=e80]
                - text: 上传新募集说明书
              - generic [ref=e81] [cursor=pointer]:
                - radio "选择项目已有募集说明书" [checked] [ref=e82]
                - text: 选择项目已有募集说明书
            - generic [ref=e83]:
              - generic [ref=e84]: 选择募集说明书版本
              - combobox "选择募集说明书版本" [ref=e85]:
                - option "请选择募集说明书版本"
                - option "V2 · 合成募集说明书_新稿.docx"
                - option "V1 · 合成募集说明书_原稿.docx · 项目当前版本" [selected]
            - region "本次生成依据" [ref=e86]:
              - generic [ref=e87]: 已选择 · V1
              - strong [ref=e88]: 合成募集说明书_原稿.docx
          - button "下一步：选择生成内容" [ref=e90] [cursor=pointer]
  - button "打开 BondBuddy" [ref=e93] [cursor=pointer]
```

# Test source

```ts
  1   | import {readFile,mkdir,writeFile} from 'node:fs/promises';
  2   | import {join} from 'node:path';
  3   | import {expect,test,type Page} from '@playwright/test';
  4   | import type {ProspectusVersion} from '@bondbuddy/contracts';
  5   | import {fixture,open,ready,upload,reenter,history,version,review,projection,currentSource,writes,fixedSnapshot,fixedUnchanged,
  6   |   uploadJournal,verifyInstalled,noBusiness,hash,ids,oldBytes,newBytes,type State} from './prospectus-saved-reentry-fixtures';
  7   | import {captureProspectusSavedReentry,installProspectusSavedReentryReference} from './prospectus-saved-reentry-reference';
  8   | 
  9   | // Native main.ts routes with one synthetic HTTP state, real OOXML bytes and
  10  | // public schemas. No live service, worker, Word/WPS or ledger acceptance claim.
  11  | const reference=!!process.env.BB_PROSPECTUS_REFERENCE_DIR;
  12  | const notice=(page:Page)=>page.locator('[data-prospectus-saved-notice]');
  13  | const state=(page:Page,id:string)=>version(page,id).locator('[data-prospectus-selection-state]');
  14  | const panel=(page:Page)=>page.locator('.prospectus-panel');
  15  | async function visibleVersion(page:Page,v:ProspectusVersion){
  16  |   const row=version(page,v.version_id);
  17  |   await expect(row.locator('.prospectus-version-info > strong')).toHaveText('V'+v.sequence+' · '+v.filename);
  18  |   await expect(row.locator('.prospectus-version-info > small').first()).toContainText(v.origin==='upload'?'用户上传':'BondBuddy 更新');
  19  |   await expect(row.locator('[data-prospectus-ref]')).toHaveCount(0);
  20  |   return row;
  21  | }
  22  | async function cancelAdoption(page:Page,s:State){
  23  |   const before=structuredClone(writes(s)),source=projection(s),project=structuredClone(s.project);
  24  |   await version(page,s.candidate.version_id).locator('[data-use-version]').click();
  25  |   const dialog=page.getByRole('dialog',{name:'采用这版募集书？',exact:true});await expect(dialog).toBeVisible();
  26  |   await expect(dialog).toContainText('V'+s.candidate.sequence+' · '+s.candidate.filename);await expect(dialog).toContainText('已有任务保留原依据');await expect(dialog).toContainText('不启动付费更新');
  27  |   expect(writes(s)).toEqual(before);await dialog.locator('#cancel-prospectus-selection').click();await expect(dialog).toHaveCount(0);
  28  |   expect(writes(s)).toEqual(before);expect(projection(s)).toEqual(source);expect(s.project).toEqual(project);
  29  | }
  30  | async function confirmAdoption(page:Page,s:State){
  31  |   const revision=s.versions.selection_revision,draftRevision=s.project.draft_revision;
  32  |   await version(page,s.candidate.version_id).locator('[data-use-version]').click();
  33  |   const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/v1/projects/'+ids.source+'/prospectus-versions/current');
  34  |   await page.locator('#confirm-prospectus-selection').click();const result=await response;expect(result.ok()).toBe(true);expect(await result.finished()).toBeNull();
  35  |   await expect(page.locator('dialog[open]')).toHaveCount(0);await expect(panel(page).locator('header')).toContainText('项目当前稿：V'+s.candidate.sequence+' · '+s.candidate.filename);
  36  |   expect(s.selections).toHaveLength(1);expect(s.selections[0]).toEqual({request_id:expect.any(String),expected_selection_revision:revision,version_id:s.candidate.version_id});expect(s.selections[0].request_id.length).toBeGreaterThan(0);
  37  |   expect(s.appliedSelections).toBe(1);expect(s.receipts.size).toBe(1);expect(s.versions.selection_revision).toBe(revision+1);expect(s.project.draft_revision).toBe(draftRevision+1);
  38  | }
  39  | async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);}
  40  | async function downloadBytes(page:Page,id:string){const pending=page.waitForEvent('download');await version(page,id).locator('[data-download-version]').click();const file=await pending;expect(await file.failure()).toBeNull();const path=await file.path();expect(path).not.toBeNull();return readFile(path!);}
  41  | const audit=(s:State,action:string)=>({synthetic:true,action,source:currentSource(s),versions:projection(s),http:structuredClone(s.calls),writes:structuredClone(writes(s)),selections:structuredClone(s.selections),selection_applications:s.appliedSelections,original_fixed_input_sha256:hash(JSON.stringify(s.workspace.tasks)),balance:s.balance,
  42  |   limits:'Actual native main route and synthetic owner-scoped HTTP only. No real storage, model, fees, worker, Word/WPS or overall professional acceptance.'});
  43  | async function captureCurrent(page:Page,s:State,name:string,action:string){const output=process.env.BB_PROSPECTUS_CAPTURE_DIR;if(output){await page.locator('#pw-prospectus').evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));await captureProspectusSavedReentry(page,output,'prospectus-saved-reentry-current-'+name,audit(s,action));}}
  44  | 
  45  | test.afterEach(async({page})=>verifyInstalled(page));
  46  | test.describe('prospectus saved reentry native desktop journeys',()=>{
  47  |   test.skip(reference,'Exact R42 reference collects its available native actions separately.');
  48  | 
  49  |   test('saved prospectus reentry: upload V2, leave through all projects, return through the real project title, review and cancel without writes, then explicitly adopt once and reload',async({page})=>{
  50  |     const s=await open(page),fixed=fixedSnapshot(s),project=structuredClone(s.project),originalSource=currentSource(s);
  51  |     await expect(panel(page).locator('header')).toContainText('项目当前稿：V1');await expect(notice(page)).toHaveCount(0);
  52  |     await upload(page,s);const savedWrites=structuredClone(writes(s));expect(savedWrites.map(c=>c.method)).toEqual(['POST','PUT','POST']);expect(s.selections).toEqual([]);expect(s.project).toEqual(project);expect(currentSource(s)).toEqual(originalSource);expect(s.versions.selection_revision).toBe(7);expect(await uploadJournal(page)).toEqual({});
  53  |     await captureCurrent(page,s,'saved-1440','Upload completion and exact version registration are confirmed; V1 remains current and selection has not been requested.');
  54  |     await reenter(page);await expect(notice(page)).toBeVisible();await expect(history(page)).not.toHaveAttribute('open','');await expect(panel(page).locator('header')).toContainText('项目当前稿：V1');expect(currentSource(s)).toEqual(originalSource);expect(writes(s)).toEqual(savedWrites);expect(s.project).toEqual(project);expect(await uploadJournal(page)).toEqual({});
  55  |     await captureCurrent(page,s,'reentered-1440','Native all-projects title reopens the project; server-retained V2 is discoverable while V1 stays current, without an upload recovery envelope.');
  56  |     await review(page);await expect(state(page,s.candidate.version_id)).toHaveText('已保存，未设为项目当前稿');await expect(state(page,s.old.version_id)).toHaveText('项目当前稿');await visibleVersion(page,s.candidate);expect(writes(s)).toEqual(savedWrites);fixedUnchanged(s,fixed);
  57  |     await captureCurrent(page,s,'history-1440','Explicit read-only review opens version history with file names, sequence numbers and selection states.');await cancelAdoption(page,s);expect(s.selections).toEqual([]);fixedUnchanged(s,fixed);
  58  |     await confirmAdoption(page,s);await expect(notice(page)).toHaveCount(0);expect(s.files.every(f=>f.consistency.status==='stale')).toBe(true);expect(currentSource(s)).toEqual({project_id:ids.source,version_id:s.candidate.version_id,selection_revision:8,filename:s.candidate.filename,sequence:2,asset:{kind:'material',pin:{source_project_id:ids.source,material_id:s.candidate.material_id,material_version:s.candidate.material_version,sha256:s.candidate.sha256}}});
  59  |     const adoptedWrites=structuredClone(writes(s));expect(adoptedWrites).toHaveLength(4);await page.reload();await ready(page);await expect(panel(page).locator('header')).toContainText('项目当前稿：V2');await expect(notice(page)).toHaveCount(0);expect(writes(s)).toEqual(adoptedWrites);expect(s.selections).toHaveLength(1);fixedUnchanged(s,fixed);await noOverflow(page);
  60  |   });
  61  | 
  62  |   test('saved prospectus reentry: a first saved version remains without a current selection across native project reentry',async({page})=>{
  63  |     const s=await open(page,fixture({noCurrent:true})),fixed=fixedSnapshot(s),project=structuredClone(s.project);await upload(page,s);await reenter(page);
  64  |     await expect(notice(page)).toContainText('尚未设置项目当前稿');expect(currentSource(s)).toBeNull();expect(s.versions.current_version_id).toBeNull();expect(s.versions.selection_revision).toBe(0);expect(s.selections).toEqual([]);expect(s.project).toEqual(project);
  65  |     await review(page);await expect(state(page,s.candidate.version_id)).toHaveText('已保存，未设为项目当前稿');await visibleVersion(page,s.candidate);await cancelAdoption(page,s);expect(await uploadJournal(page)).toEqual({});fixedUnchanged(s,fixed);
  66  |   });
  67  | 
  68  |   test('saved prospectus reentry: a deliberate rollback keeps V1 current and describes later retained versions as not current without inferring they were never adopted',async({page})=>{
  69  |     const s=await open(page,fixture({rollback:true})),fixed=fixedSnapshot(s),project=structuredClone(s.project),before=projection(s);await reenter(page);
  70  |     await expect(panel(page).locator('header')).toContainText('项目当前稿：V1');await expect(notice(page)).toContainText('2 个之后保存的版本');await review(page);
  71  |     for(const v of s.versions.versions)await expect(state(page,v.version_id)).toHaveText(v.version_id===s.old.version_id?'项目当前稿':'已保存，未设为项目当前稿');
  72  |     expect(projection(s)).toEqual(before);expect(s.project).toEqual(project);expect(writes(s)).toEqual([]);fixedUnchanged(s,fixed);
  73  |   });
  74  | 
  75  |   test('saved prospectus reentry: retaining only earlier versions does not imply a newer saved candidate when the highest sequence is current',async({page})=>{
  76  |     const s=await open(page,fixture({currentLatest:true})),fixed=fixedSnapshot(s);await expect(notice(page)).toHaveCount(0);await reenter(page);await expect(notice(page)).toHaveCount(0);
  77  |     await page.locator('[data-prospectus-history-summary]').click();await expect(state(page,s.candidate.version_id)).toHaveText('项目当前稿');await expect(state(page,s.old.version_id)).toHaveText('已保存，未设为项目当前稿');expect(writes(s)).toEqual([]);fixedUnchanged(s,fixed);
  78  |   });
  79  | 
  80  |   test('saved prospectus reentry: equal filenames show distinct sequence numbers and download the exact old and new OOXML bytes',async({page})=>{
  81  |     const s=await open(page,fixture({sameName:true})),fixed=fixedSnapshot(s);await upload(page,s);await reenter(page);await review(page);
  82  |     expect(s.old.filename).toBe(s.candidate.filename);expect(s.old.sha256).not.toBe(s.candidate.sha256);expect(s.old.material_version).not.toBe(s.candidate.material_version);
  83  |     await visibleVersion(page,s.old);await visibleVersion(page,s.candidate);expect(await downloadBytes(page,s.old.version_id)).toEqual(oldBytes);expect(await downloadBytes(page,s.candidate.version_id)).toEqual(newBytes);
  84  |     expect(s.selections).toEqual([]);expect(s.puts).toBe(1);fixedUnchanged(s,fixed);await noOverflow(page);
  85  |   });
  86  | 
  87  |   test('saved prospectus reentry: a generated saved version shows its file information and downloads the exact OOXML bytes',async({page})=>{
  88  |     const s=await open(page,fixture({generated:true})),fixed=fixedSnapshot(s),before=projection(s);await reenter(page);await expect(notice(page)).toBeVisible();await review(page);await visibleVersion(page,s.candidate);
  89  |     expect(await downloadBytes(page,s.candidate.version_id)).toEqual(newBytes);expect(projection(s)).toEqual(before);expect(writes(s)).toEqual([]);fixedUnchanged(s,fixed);
  90  |   });
  91  | 
  92  |   test('saved prospectus reentry: the native generation source step discovers the same retained candidate without preparing drafts or starting generation',async({page})=>{
  93  |     const s=await open(page,fixture({candidate:true})),fixed=fixedSnapshot(s),before=projection(s);await page.locator('.pw-actions').getByRole('link',{name:'生成文件',exact:true}).click();
  94  |     await expect(page.locator('#pf-prospectus .pf-source-picker')).toBeVisible();await expect(page.locator('.pf-workspace-heading h1')).toHaveText('生成文件');await expect(page.locator('#pf-source-next')).toBeVisible();
  95  |     await expect(page.locator('#pf-project-source option')).toContainText(['请选择募集说明书版本',s.candidate.filename,s.old.filename]);expect(writes(s)).toEqual([]);expect(projection(s)).toEqual(before);fixedUnchanged(s,fixed);
> 96  |     await page.getByRole('link',{name:'项目文件',exact:true}).click();await ready(page);await expect(notice(page)).toBeVisible();expect(writes(s)).toEqual([]);fixedUnchanged(s,fixed);
      |                                                           ^ Error: locator.click: Test timeout of 30000ms exceeded.
  97  |   });
  98  | 
  99  |   test('saved prospectus reentry: unchanged native scheduled refresh retains open history and its keyboard focus',async({page})=>{
  100 |     const s=await open(page,fixture({candidate:true})),fixed=fixedSnapshot(s);await review(page);const summary=history(page).locator(':scope > summary');await summary.focus();
  101 |     const reads=s.versionReads;await page.clock.runFor(30_100);await expect.poll(()=>s.versionReads).toBeGreaterThan(reads);await expect(page.locator('#refresh-files')).toBeEnabled();
  102 |     await expect(history(page)).toHaveAttribute('open','');await visibleVersion(page,s.candidate);await expect(summary).toBeFocused();expect(writes(s)).toEqual([]);fixedUnchanged(s,fixed);
  103 |   });
  104 | 
  105 |   for(const fault of ['foreign-project','duplicate-version'] as const)test(`saved prospectus reentry: a public-schema-valid ${fault} version projection does not claim a verified saved candidate or current version`,async({page})=>{
  106 |     const s=fixture({candidate:true});if(fault==='foreign-project')s.versions.project_id='saved-reentry-foreign-project';else s.versions.versions.push(structuredClone(s.candidate));
  107 |     const fixed=fixedSnapshot(s);await open(page,s);await expect(notice(page)).toHaveCount(0);await expect(panel(page).locator('header')).toContainText('版本记录尚待核对');await page.locator('[data-prospectus-history-summary]').click();
  108 |     await expect(panel(page).locator('[data-prospectus-ref]')).toHaveCount(0);await expect(panel(page).locator('[data-prospectus-selection-state]').first()).toHaveText('当前稿状态待核对');expect(writes(s)).toEqual([]);fixedUnchanged(s,fixed);
  109 |   });
  110 | });
  111 | 
  112 | test('saved prospectus reentry component comparison: exact R42 and current save the same V2 then leave and reenter through native all-projects navigation at 1440',async({page})=>{
  113 |   const verify=reference?await installProspectusSavedReentryReference(page):undefined,s=await open(page),fixed=fixedSnapshot(s),kind=reference?'reference':'current';
  114 |   const output=(reference?process.env.BB_PROSPECTUS_REFERENCE_DIR:process.env.BB_PROSPECTUS_CAPTURE_DIR)??test.info().outputPath(kind);
  115 |   await upload(page,s);const before=structuredClone(writes(s));await reenter(page);await page.locator('#pw-prospectus').evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));
  116 |   await captureProspectusSavedReentry(page,output,'prospectus-saved-reentry-'+kind+'-comparison-reentered-1440',{...audit(s,'Both implementations saved the same new V2, navigated to all projects and clicked the real same-project title to reenter. The old V1 remains selected.'),reference});
  117 |   if(reference){await expect(page.locator('[data-prospectus-saved-notice]')).toHaveCount(0);await panel(page).locator('details').first().locator(':scope > summary').click();}
  118 |   else{await expect(notice(page)).toBeVisible();await review(page);}
  119 |   const target=reference?panel(page).locator('details').first():history(page);await target.locator(':scope > summary').evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));
  120 |   await captureProspectusSavedReentry(page,output,'prospectus-saved-reentry-'+kind+'-comparison-history-1440',{...audit(s,reference?'R42 has no persistent saved-version notice. This screenshot uses its existing history summary, opened explicitly after native reentry.':'Current uses the saved-version review action to open history and focus its summary after native reentry.'),reference});
  121 |   expect(writes(s)).toEqual(before);expect(s.selections).toEqual([]);expect(await uploadJournal(page)).toEqual({});fixedUnchanged(s,fixed);await noOverflow(page);
  122 |   if(verify){await mkdir(output,{recursive:true});await writeFile(join(output,'prospectus-saved-reentry-reference-provenance.json'),JSON.stringify(await verify(),null,2)+'\n');}
  123 | });
  124 | 
```