# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: run-supplement-draft.spec.ts >> unaccepted PUT with a lost response retries the identical request only after receipt says not found
- Location: tests\run-supplement-draft.spec.ts:114:1

# Error details

```
Error: expect(received).toHaveLength(expected)

Expected length: 1
Received length: 0
Received array:  []
```

# Page snapshot

```yaml
- main [ref=e3]:
  - region "本轮任务的补料准备" [ref=e4]:
    - generic [ref=e5]:
      - heading "本轮任务补料" [level=3] [ref=e6]
      - generic [ref=e7]: 尚未采用
    - paragraph [ref=e8]: 先保存文件，再保存本轮补料草稿。保存不会继续任务或扣取重做费用。
    - group [ref=e9]:
      - generic "查看本轮提交的原材料" [ref=e10]
      - paragraph [ref=e11]: 以下为本轮提交时固定的材料。
      - list [ref=e12]:
        - listitem [ref=e13]: 原冻结募集书.docx · V1
        - listitem [ref=e14]: 原冻结审计报告.docx · V1
    - generic [ref=e15]:
      - generic [ref=e16]:
        - text: 这份补料的用途
        - combobox "这份补料的用途" [disabled] [ref=e17]:
          - option "新增材料" [selected]
          - option "替换：原冻结募集书.docx · V1"
          - option "替换：原冻结审计报告.docx · V1"
      - generic [ref=e18]:
        - text: 材料类别
        - combobox "材料类别" [disabled] [ref=e19]:
          - option "本企业历史募集书"
          - option "相似企业参考募集书"
          - option "审计报告（可含报表及附注）" [selected]
          - option "年度财务报表"
          - option "最近一期财务报表"
          - option "财务报表附注"
          - option "财务科目明细与辅助账"
          - option "本期发行方案"
          - option "募集资金使用计划 / 项目方案"
          - option "项目可行性研究报告"
          - option "前次募集资金使用说明"
          - option "受托管理事务报告"
          - option "董事会 / 股东会决议"
          - option "工商及公司资料"
          - option "工商登记 / 企业信息公示材料"
          - option "征信报告"
          - option "诉讼、失信、处罚及信用核查"
          - option "发行人自查 / 专项说明"
          - option "评级报告（主体 / 债项 / 跟踪）"
          - option "法律意见书及其他法律文件"
          - option "债务明细与融资材料"
          - option "银行授信情况表"
          - option "银行授信证明材料"
          - option "存续及历史债券资料"
          - option "本期增信 / 担保合同"
          - option "担保人财务、评级及资质材料"
          - option "抵质押资产资料"
          - option "业务经营资料"
          - option "章程、治理制度与组织架构"
          - option "董监高及其他人员资料"
          - option "行业研究 / 行业统计资料"
          - option "其他材料"
      - generic [ref=e20]:
        - text: 添加并保存文件
        - button "添加并保存文件" [disabled] [ref=e21]
    - list [ref=e22]:
      - listitem [ref=e23]:
        - strong [ref=e24]: 补充审计证据.txt
        - status [ref=e25]: 文件已保存；补料草稿尚未保存
        - button "核对已保存文件" [disabled] [ref=e26]
        - button "停止本机文件待办" [disabled] [ref=e27]
    - heading "补料选择 · 尚未保存" [level=4] [ref=e28]
    - list [ref=e29]:
      - listitem [ref=e30]:
        - strong [ref=e31]: 补充审计证据.txt · V1
        - generic [ref=e32]: 拟新增材料 · 尚未采用
        - button "移除补料选择" [disabled] [ref=e33]
    - paragraph [ref=e34]: 补料草稿尚未保存 · 尚未采用
    - generic [ref=e35]:
      - button "保存补料草稿" [disabled] [ref=e36]
      - button "重新读取补料" [disabled] [ref=e37]
      - button "核对原保存回执" [disabled] [ref=e38]
      - button "重试原保存请求" [disabled] [ref=e39]
    - paragraph [ref=e40]: 补料选择尚待核对，请先保存并确认回执，再查看本次材料核对结果。
    - paragraph [ref=e41]: 重做部分另行报价，确认追加金额后继续；计价口径待确认。目前保存的补料尚不能采用到本轮。
    - button "采用补料并继续（待定价规则确认）" [disabled] [ref=e42]
    - status [ref=e43]: 文件已保存。请保存补料草稿；本轮任务尚未采用。
```

# Test source

```ts
  16  |   if(await summary.count()){const details=summary.locator('..');if(await details.evaluate(e=>e.tagName==='DETAILS'&&!(e as HTMLDetailsElement).open))await summary.click();}
  17  |   await expect(host.locator('[data-supplement-file]')).toBeVisible();return host;
  18  | }
  19  | async function add(page:Page,name='补充审计证据.txt',text='synthetic supplement evidence'){
  20  |   const host=await ready(page);await host.locator('[data-supplement-intent]').selectOption('');
  21  |   await host.locator('[data-supplement-role]').selectOption('audit');
  22  |   await host.locator('[data-supplement-file]').setInputFiles(file(name,text));
  23  |   await expect(host).toContainText(name);await expect(action(host,'save')).toBeEnabled();return host;
  24  | }
  25  | async function remount(page:Page,s:ReturnType<typeof supplementFixture>,surface:SupplementSurface){await page.reload();await mountSupplementSurface(page,s,surface);return ready(page);}
  26  | 
  27  | for(const surface of ['m1','m3','m4'] as const)test(`desktop ${surface}: paused preparation uploads, saves, reloads and explicitly excludes supplements on original resume`,async({page})=>{
  28  |   const s=supplementFixture(),frozen=structuredClone({run:s.run,input:s.input,project:s.project,reviewDraft:s.review.draft,m4Drafts:s.m4.drafts});
  29  |   await installSupplementHttp(page,s);await mountSupplementSurface(page,s,surface);
  30  |   const host=await add(page);expect(s.uploads).toHaveLength(1);expect(s.byteWrites).toBe(1);expect(s.completions).toHaveLength(1);
  31  |   expect(s.saves).toEqual([]);expect(s.controls).toEqual([]);await expect(host).toContainText('尚未采用');
  32  |   await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);await expect(host).toContainText('草稿已保存');
  33  |   await expect(host.locator('[data-supplement-input-preview]')).toContainText('材料关联已核对');
  34  |   await host.locator('[data-supplement-result] summary').click();
  35  |   await expect(host.locator('[data-supplement-result]')).toContainText('原冻结募集书.docx');
  36  |   await expect(host.locator('[data-supplement-result]')).toContainText('补充审计证据.txt');
  37  |   expect(s.saves[0]).toMatchObject({expected_revision:0,base_input_revision:7,base_input_hash:frozen.run.input_hash,changes:[{replaces:null}]});
  38  |   expect(s.saves[0].changes[0].material.sha256).toBe(supplementHash('synthetic supplement evidence'));
  39  |   expect({run:s.run,input:s.input,project:s.project,reviewDraft:s.review.draft,m4Drafts:s.m4.drafts}).toEqual(frozen);
  40  |   const restored=await remount(page,s,surface);await expect(restored).toContainText('补充审计证据.txt');await expect(restored).toContainText('尚未采用');
  41  |   expect(s.saves).toHaveLength(1);expect(s.controls).toEqual([]);
  42  |   await expect(restored.locator('[data-supplement-file]')).toBeEnabled();await expect(action(restored,'save')).toBeDisabled();
  43  |   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  44  |   if(process.env.BB_SUPPLEMENT_EVIDENCE_DIR){await mkdir(process.env.BB_SUPPLEMENT_EVIDENCE_DIR,{recursive:true});await restored.scrollIntoViewIfNeeded();await page.screenshot({path:join(process.env.BB_SUPPLEMENT_EVIDENCE_DIR,`${surface}-saved-preparation.png`),fullPage:true});await page.screenshot({path:join(process.env.BB_SUPPLEMENT_EVIDENCE_DIR,`${surface}-saved-preparation-viewport.png`)});}
  45  |   const continueButton=surface==='m1'?page.locator('#resume-run'):surface==='m3'?page.locator('#review-making-panel [data-review-action="resume"]'):page.locator(`[data-m4-action="resume"][data-run="${s.run.run_id}"]`);
  46  |   await expect(continueButton).toContainText('按原材料继续');
  47  |   await continueButton.click();const confirm=page.locator('.run-supplement-resume-dialog');await expect(confirm).toBeVisible();
  48  |   await expect(confirm).toContainText('原材料');await expect(confirm).toContainText('补料');expect(s.controls).toEqual([]);
  49  |   await confirm.locator('[data-supplement-resume-cancel]').click();expect(s.controls).toEqual([]);
  50  |   await continueButton.click();await confirm.locator('[data-supplement-resume-confirm]').click();
  51  |   await expect.poll(()=>s.controls).toEqual(['resume']);expect(s.saves).toHaveLength(1);expect(s.unexpectedMutations).toEqual([]);
  52  |   expect(s.run).toMatchObject({run_id:frozen.run.run_id,input_revision:7,input_hash:frozen.run.input_hash,execution_request_id:frozen.run.execution_request_id});
  53  | });
  54  | 
  55  | test('saved material issues remain distinct from adoption, and local edits hide stale check results',async({page})=>{
  56  |   const s=supplementFixture();await installSupplementHttp(page,s);await mountSupplementSurface(page,s);
  57  |   const host=await add(page);await action(host,'save').click();await expect(host.locator('[data-supplement-input-preview]')).toContainText('材料关联已核对');
  58  |   s.inputPreview={compiler_version:'run-supplement-input-v1',status:'needs_information',candidate_input_hash:null,
  59  |     issues:[{code:'source_information_required',material_id:null,message:'原稿信息需要重新填写。'}]};
  60  |   await action(host,'reload').click();await expect(host.locator('[data-supplement-input-preview]')).toContainText('原稿信息需要重新填写');
  61  |   await expect(host.locator('[data-supplement-input-preview]')).not.toContainText('材料关联已核对');
  62  |   await expect(host).toContainText('补料选择已保存');expect(s.controls).toEqual([]);expect(s.saves).toHaveLength(1);
  63  |   await add(page,'另一份补充证据.txt','Different synthetic bytes');
  64  |   await expect(host.locator('[data-supplement-input-preview]')).toContainText('请先保存并确认回执');
  65  |   await expect(host.locator('[data-supplement-input-preview]')).not.toContainText('原稿信息需要重新填写');
  66  |   expect(s.saves).toHaveLength(1);expect(s.controls).toEqual([]);
  67  | });
  68  | 
  69  | test('replacement intent keeps the frozen role, exact source pin and uploaded bytes separate from saving',async({page})=>{
  70  |   const s=supplementFixture();s.holdComplete=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s);
  71  |   const host=await ready(page),audit=s.base[1],intent=host.locator('[data-supplement-intent]');
  72  |   const replacement=await intent.locator('option').filter({hasText:audit.filename}).getAttribute('value');expect(replacement).toBeTruthy();await intent.selectOption(replacement!);
  73  |   await expect(host.locator('[data-supplement-role]')).toHaveValue('audit');await expect(host.locator('[data-supplement-role]')).toBeDisabled();
  74  |   await host.locator('[data-supplement-file]').setInputFiles(file('替换审计报告.txt','synthetic replacement bytes'));
  75  |   await expect.poll(()=>s.byteWrites).toBe(1);await expect.poll(()=>s.completions.length).toBe(1);expect(s.materials).toHaveLength(2);expect(s.saves).toEqual([]);
  76  |   await expect(action(host,'save')).toBeDisabled();s.releaseComplete!();await expect(action(host,'save')).toBeEnabled();
  77  |   expect(s.uploads[0].role).toBe('audit');expect(s.controls).toEqual([]);expect(s.saves).toEqual([]);
  78  |   await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);
  79  |   expect(s.saves[0].changes).toEqual([{material:supplementPin(s.materials[2]),replaces:supplementPin(audit)}]);
  80  |   expect(s.receipts.get(s.saves[0].request_id)!.result_materials.map(m=>m.material_id)).toEqual([s.base[0].material_id,s.materials[2].material_id]);
  81  |   expect(s.input.material_versions).toEqual(s.base.map(supplementPin));expect(s.run.state).toBe('paused');expect(s.unexpectedMutations).toEqual([]);
  82  | });
  83  | 
  84  | test('unsaved completed upload and add intent survive reload without silently creating a draft revision',async({page})=>{
  85  |   const s=supplementFixture();await installSupplementHttp(page,s);await mountSupplementSurface(page,s);await add(page);
  86  |   const host=await remount(page,s,'panel');await expect(host).toContainText('补充审计证据.txt');expect(s.revision).toBe(0);expect(s.uploads).toHaveLength(1);expect(s.saves).toEqual([]);
  87  |   await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);expect(s.saves[0].changes[0].replaces).toBeNull();expect(s.byteWrites).toBe(1);
  88  | });
  89  | 
  90  | test('CAS conflict preserves the local selection until the user chooses how to resolve it',async({page})=>{
  91  |   const s=supplementFixture();await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);
  92  |   s.revision=1;s.changes=[];await action(host,'save').click();await expect(action(host,'keep-local')).toBeVisible();
  93  |   await expect(host).toContainText('补充审计证据.txt');expect(s.saves).toHaveLength(1);expect(s.saves[0].expected_revision).toBe(0);expect(s.revision).toBe(1);
  94  |   await action(host,'keep-local').click();expect(s.saves).toHaveLength(1);await expect(host).toContainText('补充审计证据.txt');
  95  |   await action(host,'save').click();await expect.poll(()=>s.revision).toBe(2);expect(s.saves).toHaveLength(2);
  96  |   expect(s.saves[1].expected_revision).toBe(1);expect(s.saves[1].request_id).not.toBe(s.saves[0].request_id);expect(s.saves[1].changes).toEqual(s.saves[0].changes);
  97  |   expect(s.controls).toEqual([]);expect(s.unexpectedMutations).toEqual([]);
  98  | });
  99  | 
  100 | test('CAS use-latest choice discards local choices only after explicit selection',async({page})=>{
  101 |   const s=supplementFixture();await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);
  102 |   s.revision=1;s.changes=[];await action(host,'save').click();await expect(action(host,'use-latest')).toBeVisible();await expect(host).toContainText('补充审计证据.txt');
  103 |   await action(host,'use-latest').click();await expect(host).not.toContainText('补充审计证据.txt');expect(s.saves).toHaveLength(1);expect(s.revision).toBe(1);expect(s.materials).toHaveLength(3);
  104 |   const restored=await remount(page,s,'panel');await expect(restored).not.toContainText('补充审计证据.txt');expect(s.saves).toHaveLength(1);
  105 | });
  106 | 
  107 | test('accepted PUT with a lost response is recovered by its exact receipt without a second save',async({page})=>{
  108 |   const s=supplementFixture();s.dropSaveOnce=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);
  109 |   await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);const id=s.saves[0].request_id;
  110 |   await expect.poll(()=>s.reads.includes(id)).toBe(true);await expect(host).toContainText('草稿已保存');expect(s.saves).toHaveLength(1);
  111 |   expect(s.receipts.get(id)!.changes).toEqual(s.saves[0].changes);expect(s.run.state).toBe('paused');expect(s.controls).toEqual([]);
  112 | });
  113 | 
  114 | test('unaccepted PUT with a lost response retries the identical request only after receipt says not found',async({page})=>{
  115 |   const s=supplementFixture();s.dropUnacceptedSaveOnce=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);
> 116 |   await action(host,'save').click();await expect(action(host,'retry-save')).toBeVisible();expect(s.revision).toBe(0);expect(s.saves).toHaveLength(1);
      |                                                                                                                                      ^ Error: expect(received).toHaveLength(expected)
  117 |   const original=structuredClone(s.saves[0]);await expect.poll(()=>s.reads.includes(original.request_id)).toBe(true);await expect(action(host,'retry-save')).toBeEnabled();
  118 |   await action(host,'retry-save').click();await expect.poll(()=>s.revision).toBe(1);expect(s.saves).toEqual([original,original]);expect(s.uploads).toHaveLength(1);expect(s.byteWrites).toBe(1);
  119 | });
  120 | 
  121 | test('unknown save persists through refresh and reads the original receipt even when a newer revision exists',async({page})=>{
  122 |   const s=supplementFixture();s.dropSaveOnce=true;s.failReceiptReads=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);
  123 |   await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);const sent=structuredClone(s.saves[0]);await expect.poll(()=>s.reads.includes(sent.request_id)).toBe(true);
  124 |   s.revision=2;s.changes=[];s.failReceiptReads=false;const restored=await remount(page,s,'panel');
  125 |   await expect.poll(()=>s.reads.filter(id=>id===sent.request_id).length).toBeGreaterThan(1);expect(s.saves).toEqual([sent]);expect(s.revision).toBe(2);
  126 |   await expect(restored).toContainText('补充审计证据.txt');expect(s.receipts.get(sent.request_id)!.revision).toBe(1);expect(s.controls).toEqual([]);
  127 | });
  128 | 
  129 | test('server can_save prevents a save while still showing the exact frozen base and explicit blocked reason',async({page})=>{
  130 |   const s=supplementFixture();s.canSave=false;s.blockedReason='正在核对上次模型调用，暂停完成后才能保存补料。';
  131 |   await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=panel(page);await expect(host).toBeVisible();await expect(host).toContainText(s.blockedReason);
  132 |   await expect(action(host,'save')).toBeDisabled();expect(s.saves).toEqual([]);expect(s.controls).toEqual([]);
  133 | });
  134 | 
  135 | test('a lost upload completion receipt is recovered before saving the preparation without resending bytes',async({page})=>{
  136 |   const s=supplementFixture();s.dropCompleteOnce=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s);
  137 |   const host=await ready(page);await host.locator('[data-supplement-role]').selectOption('audit');await host.locator('[data-supplement-file]').setInputFiles(file());
  138 |   await expect.poll(()=>s.completions.length).toBe(1);await expect(action(host,'upload-resume')).toBeEnabled();expect(s.saves).toEqual([]);await expect(action(host,'save')).toBeDisabled();
  139 |   await action(host,'upload-resume').click();await expect(action(host,'save')).toBeEnabled();expect(s.completions).toHaveLength(2);expect(s.uploads).toHaveLength(1);expect(s.byteWrites).toBe(1);
  140 |   await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);expect(s.saves).toHaveLength(1);expect(s.controls).toEqual([]);
  141 | });
  142 | 
  143 | test('an upload completion after leaving its owner/run surface cannot attach or save to the new view',async({page})=>{
  144 |   const s=supplementFixture();s.holdComplete=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s);
  145 |   const host=await ready(page);await host.locator('[data-supplement-role]').selectOption('audit');await host.locator('[data-supplement-file]').setInputFiles(file());
  146 |   await expect.poll(()=>typeof s.releaseComplete).toBe('function');
  147 |   await page.evaluate(()=>{const holder=window as unknown as {supplementActive:boolean;supplementComponent:{dispose():void}};holder.supplementActive=false;holder.supplementComponent.dispose();document.querySelector('.shell')!.innerHTML='<h1>另一账号的任务</h1>';});
  148 |   s.releaseComplete!();await expect(page.getByRole('heading',{name:'另一账号的任务'})).toBeVisible();await expect(panel(page)).toHaveCount(0);
  149 |   expect(s.saves).toEqual([]);expect(s.controls).toEqual([]);expect(s.revision).toBe(0);
  150 | });
  151 | 
  152 | test('mismatched exact receipt keeps the original request pending and prevents original-material resume until verified',async({page})=>{
  153 |   const s=supplementFixture();s.dropSaveOnce=true;s.receiptMismatchOnce=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s,'m1');
  154 |   const host=await add(page);await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);const sent=structuredClone(s.saves[0]);
  155 |   await expect(host).toContainText('回执与本轮原始输入或原保存请求不一致');await expect(host.locator('[data-supplement-saved]')).not.toContainText('草稿已保存');
  156 |   await expect(action(host,'receipt')).toBeEnabled();expect(s.saves).toEqual([sent]);expect(s.reads).toContain(sent.request_id);
  157 |   await page.locator('#resume-run').click();await expect(host).toContainText('请先核对原补料保存回执');expect(s.controls).toEqual([]);await expect(page.locator('.run-supplement-resume-dialog')).toHaveCount(0);
  158 |   await action(host,'receipt').click();await expect(host.locator('[data-supplement-saved]')).toContainText('草稿已保存');await expect(action(host,'receipt')).toHaveCount(0);
  159 |   expect(s.saves).toEqual([sent]);expect(s.reads.filter(id=>id===sent.request_id)).toHaveLength(2);expect(s.controls).toEqual([]);
  160 | });
  161 | 
  162 | test('a delayed availability GET from V0 cannot offer an older draft after save confirms V1',async({page})=>{
  163 |   const s=supplementFixture();await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);s.holdDraftRead=true;
  164 |   await page.evaluate(run=>{const component=(window as unknown as {supplementComponent:{updateRun(run:unknown):void}}).supplementComponent;component.updateRun({...run,state:'running'});component.updateRun(run);},s.run);
  165 |   await expect.poll(()=>typeof s.releaseDraftRead).toBe('function');await action(host,'save').click();await expect(host.locator('[data-supplement-saved]')).toContainText('V1');
  166 |   const delayed=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/supplement-draft')&&!new URL(response.url()).search&&response.request().method()==='GET');
  167 |   s.releaseDraftRead!();await (await delayed).finished();await page.evaluate(async()=>{await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));});
  168 |   await expect(host.locator('[data-supplement-saved]')).toContainText('V1');await expect(host.locator('.run-supplement-conflict')).toHaveCount(0);
  169 |   expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!).expected_revision,`bondbuddy:run-supplement:v1:${supplementIds.owner}:${supplementIds.project}:${supplementIds.run}`)).toBe(1);
  170 |   expect(s.saves).toHaveLength(1);expect(s.controls).toEqual([]);
  171 | });
  172 | 
  173 | test('failure reading a newer draft does not turn an already verified original save receipt back into unknown',async({page})=>{
  174 |   const s=supplementFixture();s.dropSaveOnce=true;s.failReceiptReads=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);
  175 |   await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);const sent=s.saves[0];await expect.poll(()=>s.reads.includes(sent.request_id)).toBe(true);await expect(action(host,'receipt')).toBeEnabled();
  176 |   s.revision=2;s.changes=[];s.failReceiptReads=false;s.failLatestReads=true;await action(host,'receipt').click();
  177 |   await expect(host.locator('[data-supplement-saved]')).toContainText('V1');await expect(host.locator('[data-supplement-saved]')).toContainText('草稿已保存');
  178 |   await expect(action(host,'receipt')).toHaveCount(0);await expect(action(host,'retry-save')).toHaveCount(0);await expect(host).not.toContainText('原保存结果尚未确认');
  179 |   expect(s.saves).toEqual([sent]);expect(s.controls).toEqual([]);
  180 | });
  181 | 
```