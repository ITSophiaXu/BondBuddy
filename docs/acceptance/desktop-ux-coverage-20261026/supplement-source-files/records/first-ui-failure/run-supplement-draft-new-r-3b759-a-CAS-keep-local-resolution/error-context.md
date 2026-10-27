# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: run-supplement-draft.spec.ts >> new reference information edits retain their exact declaration through a CAS keep-local resolution
- Location: tests\run-supplement-draft.spec.ts:149:1

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: locator.check: Test timeout of 30000ms exceeded.
Call log:
  - waiting for locator('[data-run-supplement="supplement-run"]').locator('[data-supplement-source]').locator('[data-source-field="quarter"][value="12-31"]')
    - locator resolved to <input type="radio" value="12-31" data-source-field="quarter" name="source-quarter-run-supplement:supplement-owner:supplement-project:supplement-run/material-supplement-upload-1/1/103a9da5de89c90068adb38da9ec58f4aff2fbe3f3070aa61d0edb752c52b544"/>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <label class="quarter">…</label> intercepts pointer events
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <label class="quarter">…</label> intercepts pointer events
    - retrying click action
      - waiting 100ms
    54 × waiting for element to be visible, enabled and stable
       - element is visible, enabled and stable
       - scrolling into view if needed
       - done scrolling
       - <label class="quarter">…</label> intercepts pointer events
     - retrying click action
       - waiting 500ms

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
        - combobox "这份补料的用途" [ref=e17]:
          - option "新增材料" [selected]
          - option "替换：原冻结募集书.docx · V1"
          - option "替换：原冻结审计报告.docx · V1"
      - generic [ref=e18]:
        - text: 材料类别
        - combobox "材料类别" [ref=e19]:
          - option "本企业历史募集书"
          - option "相似企业参考募集书" [selected]
          - option "审计报告（可含报表及附注）"
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
        - button "添加并保存文件" [ref=e21]
    - list [ref=e22]:
      - listitem [ref=e23]:
        - strong [ref=e24]: 新参考募集书.docx
        - status [ref=e25]: 文件已保存；补料草稿尚未保存
        - button "核对已保存文件" [ref=e26] [cursor=pointer]
        - button "停止本机文件待办" [ref=e27] [cursor=pointer]
    - heading "补料选择 · 尚未保存" [level=4] [ref=e28]
    - list [ref=e29]:
      - listitem [ref=e30]:
        - strong [ref=e31]: 新参考募集书.docx · V1
        - generic [ref=e32]: 拟新增材料 · 尚未采用
        - group [ref=e34]:
          - group "原稿信息（上传后必填）" [ref=e35]:
            - generic [ref=e37]:
              - generic [ref=e38]:
                - text: 与目标发行人的关系
                - combobox "与目标发行人的关系" [ref=e39]:
                  - option "请选择"
                  - option "同企业"
                  - option "目标发行人的母公司"
                  - option "目标发行人的子公司"
                  - option "相似业务企业" [selected]
              - generic [ref=e40]:
                - text: 原发行市场
                - combobox "原发行市场" [ref=e41]:
                  - option "请选择"
                  - option "上交所" [selected]
                  - option "深交所"
                  - option "交易商协会"
              - generic [ref=e42]:
                - text: 原品种
                - combobox "原品种" [ref=e43]:
                  - option "请选择"
                  - option "普通私募公司债" [selected]
                  - option "小公募"
                  - option "大公募"
            - generic [ref=e44]:
              - generic [ref=e45]:
                - text: 原稿最新报告期
                - combobox "原稿最新报告期年份" [ref=e46]:
                  - option "2027 年"
                  - option "2026 年"
                  - option "2025 年"
                  - option "2024 年" [selected]
                  - option "2023 年"
                  - option "2022 年"
                  - option "2021 年"
                  - option "2020 年"
                  - option "2019 年"
                  - option "2018 年"
                  - option "2017 年"
                  - option "2016 年"
                  - option "2015 年"
                  - option "2014 年"
                  - option "2013 年"
                  - option "2012 年"
                  - option "2011 年"
                  - option "2010 年"
                  - option "2009 年"
                  - option "2008 年"
                  - option "2007 年"
                  - option "2006 年"
                  - option "2005 年"
                  - option "2004 年"
                  - option "2003 年"
                  - option "2002 年"
                  - option "2001 年"
                  - option "2000 年"
              - radiogroup "原稿最新报告期期末" [ref=e47]:
                - generic [ref=e48] [cursor=pointer]:
                  - radio "3月末" [ref=e49]
                  - text: 3月末
                - generic [ref=e50] [cursor=pointer]:
                  - radio "6月末" [ref=e51]
                  - text: 6月末
                - generic [ref=e52] [cursor=pointer]:
                  - radio "9月末" [ref=e53]
                  - text: 9月末
                - generic [ref=e54] [cursor=pointer]:
                  - radio "年末" [ref=e55]
                  - text: 年末
              - generic [ref=e56]: 请选择原稿最新报告期的年份和期末。
            - generic [ref=e57]:
              - generic [ref=e58]: 每份已上传的历史／参考募集书都需填写以上信息，用于选择知识和计算积分；原稿与本次目标分开保存。
              - status [ref=e59]: 请补齐原稿最新报告期后继续。
        - button "移除补料选择" [ref=e60] [cursor=pointer]
    - paragraph [ref=e61]: 补料草稿尚未保存 · 尚未采用
    - generic [ref=e62]:
      - button "保存补料草稿" [ref=e63] [cursor=pointer]
      - button "重新读取补料" [ref=e64] [cursor=pointer]
    - paragraph [ref=e65]: 补料选择尚待核对，请先保存并确认回执，再查看本次材料核对结果。
    - generic [ref=e66]:
      - heading "已保存工作记录" [level=4] [ref=e67]
      - paragraph [ref=e68]: 本页补料或保存结果尚待核对，确认本次保存回执后再查看已保存工作记录。
    - paragraph [ref=e69]: 重做部分另行报价，确认追加金额后继续；计价口径待确认。目前保存的补料尚不能采用到本轮。
    - button "采用补料并继续（待定价规则确认）" [disabled] [ref=e70]
    - status [ref=e71]: 原稿信息已在本页修改，请保存补料草稿确认；尚未采用。
```

# Test source

```ts
  60  |   await add(page);await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);
  61  |   const work=host.locator('[data-supplement-saved-work]');
  62  |   await expect(work).toContainText('已关联 2 项已保存处理结果。继续前核对可复用文件。');
  63  |   await expect(host.getByRole('button',{name:'采用补料并继续（待定价规则确认）'})).toBeDisabled();
  64  |   expect(s.receipts.get(s.saves[0].request_id)!.saved_work).toEqual({status:'captured',stage_count:3,result_count:2});
  65  |   await add(page,'新的待确认材料.txt','new synthetic evidence');
  66  |   await expect(work).toContainText('确认本次保存回执后再查看');await expect(work).not.toContainText('已关联 2 项');
  67  |   s.dropUnacceptedSaveOnce=true;await action(host,'save').click();await expect(action(host,'receipt')).toBeEnabled();
  68  |   await expect(work).toContainText('确认本次保存回执后再查看');await expect(work).not.toContainText('已关联 2 项');
  69  |   expect(s.revision).toBe(1);expect(s.controls).toEqual([]);expect(s.unexpectedMutations).toEqual([]);
  70  | });
  71  | 
  72  | test('a changed pause boundary requires a new explicit save even when the material choices are unchanged',async({page})=>{
  73  |   const s=supplementFixture();s.workStageCount=2;s.workResultCount=1;
  74  |   await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);
  75  |   await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);const first=structuredClone(s.saves[0]);
  76  |   s.savedWork={status:'stale_boundary',stage_count:2,result_count:1};
  77  |   await action(host,'reload').click();const work=host.locator('[data-supplement-saved-work]');
  78  |   await expect(work).toContainText('暂停进度已有变化');await expect(work).toContainText('重新保存补料草稿，更新进度关联');
  79  |   await expect(work).not.toContainText('已关联 1 项');await expect(action(host,'save')).toBeEnabled();
  80  |   s.workStageCount=4;s.workResultCount=3;await action(host,'save').click();await expect.poll(()=>s.revision).toBe(2);
  81  |   await expect(work).toContainText('已关联 3 项已保存处理结果');await expect(work).not.toContainText('暂停进度已有变化');
  82  |   expect(s.saves).toHaveLength(2);expect(s.saves[1].request_id).not.toBe(first.request_id);
  83  |   expect(s.saves[1].expected_revision).toBe(1);expect(s.saves[1].changes).toEqual(first.changes);
  84  |   expect(s.uploads).toHaveLength(1);expect(s.controls).toEqual([]);expect(s.unexpectedMutations).toEqual([]);
  85  | });
  86  | 
  87  | test('an old saved draft can capture work on a new save without changing its empty material selection',async({page})=>{
  88  |   const s=supplementFixture();s.revision=1;s.savedWork={status:'not_captured',stage_count:0,result_count:0};s.workStageCount=2;
  89  |   await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await ready(page),work=host.locator('[data-supplement-saved-work]');
  90  |   await expect(work).toContainText('旧补料草稿尚未记录进度');await expect(work).toContainText('请再次保存补料草稿');
  91  |   await expect(action(host,'save')).toBeEnabled();await action(host,'save').click();await expect.poll(()=>s.revision).toBe(2);
  92  |   await expect(work).toContainText('已记录暂停位置。继续时核对已有进度。');await expect(work).not.toContainText('尚未记录进度');
  93  |   expect(s.saves[0]).toMatchObject({expected_revision:1,changes:[]});
  94  |   expect(s.receipts.get(s.saves[0].request_id)!.saved_work).toEqual({status:'captured',stage_count:2,result_count:0});
  95  |   expect(s.controls).toEqual([]);expect(s.unexpectedMutations).toEqual([]);
  96  | });
  97  | 
  98  | test('saved material issues remain distinct from adoption, and local edits hide stale check results',async({page})=>{
  99  |   const s=supplementFixture();await installSupplementHttp(page,s);await mountSupplementSurface(page,s);
  100 |   const host=await add(page);await action(host,'save').click();await expect(host.locator('[data-supplement-input-preview]')).toContainText('材料关联已核对');
  101 |   s.inputPreview={compiler_version:'run-supplement-input-v1',status:'needs_information',candidate_input_hash:null,
  102 |     issues:[{code:'source_information_required',material_id:null,message:'原稿信息需要重新填写。'}]};
  103 |   await action(host,'reload').click();await expect(host.locator('[data-supplement-input-preview]')).toContainText('原稿信息需要重新填写');
  104 |   await expect(host.locator('[data-supplement-input-preview]')).not.toContainText('材料关联已核对');
  105 |   await expect(host).toContainText('补料选择已保存');expect(s.controls).toEqual([]);expect(s.saves).toHaveLength(1);
  106 |   await add(page,'另一份补充证据.txt','Different synthetic bytes');
  107 |   await expect(host.locator('[data-supplement-input-preview]')).toContainText('请先保存并确认回执');
  108 |   await expect(host.locator('[data-supplement-input-preview]')).not.toContainText('原稿信息需要重新填写');
  109 |   expect(s.saves).toHaveLength(1);expect(s.controls).toEqual([]);
  110 | });
  111 | 
  112 | test('replacement source declarations start empty and survive source-only edits, an unknown receipt and refresh',async({page})=>{
  113 |   const s=supplementFixture(),old=s.materials[0];
  114 |   s.sourceContext={kind:'m1_authoring',previous_output_bound:true};
  115 |   s.project.update_details!.source_prospectuses=[{...supplementPin(old),issuer_name:'不得复制的旧原稿发行人',relation:'parent',market:'sse',offering:'private',
  116 |     reporting_periods:[{start:'2024-01-01',end:'2024-12-31',period_kind:'annual',scope:'parent',status:'user_asserted',evidence_refs:[]}],status:'user_asserted'}];
  117 |   const replacement={...old,material_version:2,upload_id:'synthetic-new-source-version',filename:'新版原稿.docx'};
  118 |   s.materials.push(replacement);s.changes=[{material:supplementPin(replacement),replaces:supplementPin(old)}];s.revision=1;
  119 |   await installSupplementHttp(page,s);await mountSupplementSurface(page,s);
  120 |   const host=await ready(page),source=host.locator('[data-supplement-source]');
  121 |   await expect(source.locator('[data-source-field="relation"]')).toHaveValue('');
  122 |   await expect(source.locator('[data-source-field="market"]')).toHaveValue('');
  123 |   await expect(source.locator('[data-source-field="quarter"]:checked')).toHaveCount(0);
  124 |   await expect(source).not.toContainText('不得复制的旧原稿发行人');
  125 |   await expect(source.locator('[data-supplement-discard-output]')).not.toBeChecked();
  126 |   await source.locator('[data-source-field="relation"]').selectOption('subsidiary');
  127 |   await source.locator('[data-source-field="market"]').selectOption('nafmii');
  128 |   await source.locator('[data-source-field="offering"]').selectOption('mtn');
  129 |   await source.locator('[data-source-field="year"]').selectOption('2025');
  130 |   await source.locator('[data-source-field="quarter"][value="09-30"]').check();
  131 |   await source.locator('[data-supplement-discard-output]').check();
  132 |   await expect(source).toContainText('原稿信息已填写完整');await expect(action(host,'save')).toBeEnabled();
  133 |   expect(s.saves).toEqual([]);expect(s.changes[0].source_prospectus).toBeUndefined();
  134 |   const restored=await remount(page,s,'panel'),restoredSource=restored.locator('[data-supplement-source]');
  135 |   await expect(restoredSource.locator('[data-source-field="relation"]')).toHaveValue('subsidiary');
  136 |   await expect(restoredSource.locator('[data-source-field="offering"]')).toHaveValue('mtn');
  137 |   await expect(restoredSource.locator('[data-supplement-discard-output]')).toBeChecked();
  138 |   s.dropSaveOnce=true;s.failReceiptReads=true;await action(restored,'save').click();
  139 |   await expect(restored).toContainText('原保存结果尚未确认');await expect(restoredSource.locator('[data-source-field="relation"]')).toBeDisabled();
  140 |   expect(s.saves).toHaveLength(1);expect(s.saves[0].expected_revision).toBe(1);
  141 |   expect(s.saves[0].changes[0]).toMatchObject({material:supplementPin(replacement),replaces:supplementPin(old),discard_previous_output:true,
  142 |     source_prospectus:{...supplementPin(replacement),issuer_name:null,relation:'subsidiary',market:'nafmii',offering:'mtn',status:'user_asserted'}});
  143 |   expect(s.saves[0].changes[0].source_prospectus!.reporting_periods.map(p=>p.end)).toContain('2025-09-30');
  144 |   await remount(page,s,'panel');s.failReceiptReads=false;await action(panel(page),'receipt').click();
  145 |   await expect(panel(page)).toContainText('草稿已保存');expect(s.saves).toHaveLength(1);
  146 |   expect(s.changes).toEqual(s.saves[0].changes);expect(s.run.input_revision).toBe(7);expect(s.controls).toEqual([]);expect(s.unexpectedMutations).toEqual([]);
  147 | });
  148 | 
  149 | test('new reference information edits retain their exact declaration through a CAS keep-local resolution',async({page})=>{
  150 |   const s=supplementFixture();s.sourceContext={kind:'m1_authoring',previous_output_bound:false};
  151 |   await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await ready(page);
  152 |   await host.locator('[data-supplement-role]').selectOption('reference');
  153 |   await host.locator('[data-supplement-file]').setInputFiles(file('新参考募集书.docx','Synthetic source bytes only'));
  154 |   const source=host.locator('[data-supplement-source]');await expect(source).toBeVisible();
  155 |   await expect(source.locator('[data-supplement-discard-output]')).toHaveCount(0);
  156 |   await source.locator('[data-source-field="relation"]').selectOption('similar_business');
  157 |   await source.locator('[data-source-field="market"]').selectOption('sse');
  158 |   await source.locator('[data-source-field="offering"]').selectOption('private');
  159 |   await source.locator('[data-source-field="year"]').selectOption('2024');
> 160 |   await source.locator('[data-source-field="quarter"][value="12-31"]').check();
      |                                                                        ^ Error: locator.check: Test timeout of 30000ms exceeded.
  161 |   await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);
  162 |   const first=structuredClone(s.saves[0]);
  163 |   await source.locator('[data-source-field="relation"]').selectOption('parent');await expect(action(host,'save')).toBeEnabled();
  164 |   s.revision=2;s.changes[0].source_prospectus!.relation='same_issuer';
  165 |   await action(host,'save').click();await expect(action(host,'keep-local')).toBeVisible();
  166 |   await action(host,'keep-local').click();
  167 |   await expect(source.locator('[data-source-field="relation"]')).toHaveValue('parent');
  168 |   await action(host,'save').click();await expect.poll(()=>s.revision).toBe(3);
  169 |   expect(s.saves[2].expected_revision).toBe(2);expect(s.saves[2].changes[0].material).toEqual(first.changes[0].material);
  170 |   expect(s.saves[2].changes[0].source_prospectus).toEqual({...first.changes[0].source_prospectus!,relation:'parent'});
  171 |   expect(s.saves[2].changes[0].discard_previous_output).toBeUndefined();expect(s.byteWrites).toBe(1);expect(s.controls).toEqual([]);expect(s.unexpectedMutations).toEqual([]);
  172 | });
  173 | 
  174 | test('replacement intent keeps the frozen role, exact source pin and uploaded bytes separate from saving',async({page})=>{
  175 |   const s=supplementFixture();s.holdComplete=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s);
  176 |   const host=await ready(page),audit=s.base[1],intent=host.locator('[data-supplement-intent]');
  177 |   const replacement=await intent.locator('option').filter({hasText:audit.filename}).getAttribute('value');expect(replacement).toBeTruthy();await intent.selectOption(replacement!);
  178 |   await expect(host.locator('[data-supplement-role]')).toHaveValue('audit');await expect(host.locator('[data-supplement-role]')).toBeDisabled();
  179 |   await host.locator('[data-supplement-file]').setInputFiles(file('替换审计报告.txt','synthetic replacement bytes'));
  180 |   await expect.poll(()=>s.byteWrites).toBe(1);await expect.poll(()=>s.completions.length).toBe(1);expect(s.materials).toHaveLength(2);expect(s.saves).toEqual([]);
  181 |   await expect(action(host,'save')).toBeDisabled();s.releaseComplete!();await expect(action(host,'save')).toBeEnabled();
  182 |   expect(s.uploads[0].role).toBe('audit');expect(s.controls).toEqual([]);expect(s.saves).toEqual([]);
  183 |   await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);
  184 |   expect(s.saves[0].changes).toEqual([{material:supplementPin(s.materials[2]),replaces:supplementPin(audit)}]);
  185 |   expect(s.receipts.get(s.saves[0].request_id)!.result_materials.map(m=>m.material_id)).toEqual([s.base[0].material_id,s.materials[2].material_id]);
  186 |   expect(s.input.material_versions).toEqual(s.base.map(supplementPin));expect(s.run.state).toBe('paused');expect(s.unexpectedMutations).toEqual([]);
  187 | });
  188 | 
  189 | test('unsaved completed upload and add intent survive reload without silently creating a draft revision',async({page})=>{
  190 |   const s=supplementFixture();await installSupplementHttp(page,s);await mountSupplementSurface(page,s);await add(page);
  191 |   const host=await remount(page,s,'panel');await expect(host).toContainText('补充审计证据.txt');expect(s.revision).toBe(0);expect(s.uploads).toHaveLength(1);expect(s.saves).toEqual([]);
  192 |   await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);expect(s.saves[0].changes[0].replaces).toBeNull();expect(s.byteWrites).toBe(1);
  193 | });
  194 | 
  195 | test('CAS conflict preserves the local selection until the user chooses how to resolve it',async({page})=>{
  196 |   const s=supplementFixture();await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);
  197 |   s.revision=1;s.changes=[];await action(host,'save').click();await expect(action(host,'keep-local')).toBeVisible();
  198 |   await expect(host).toContainText('补充审计证据.txt');expect(s.saves).toHaveLength(1);expect(s.saves[0].expected_revision).toBe(0);expect(s.revision).toBe(1);
  199 |   await action(host,'keep-local').click();expect(s.saves).toHaveLength(1);await expect(host).toContainText('补充审计证据.txt');
  200 |   await action(host,'save').click();await expect.poll(()=>s.revision).toBe(2);expect(s.saves).toHaveLength(2);
  201 |   expect(s.saves[1].expected_revision).toBe(1);expect(s.saves[1].request_id).not.toBe(s.saves[0].request_id);expect(s.saves[1].changes).toEqual(s.saves[0].changes);
  202 |   expect(s.controls).toEqual([]);expect(s.unexpectedMutations).toEqual([]);
  203 | });
  204 | 
  205 | test('CAS use-latest choice discards local choices only after explicit selection',async({page})=>{
  206 |   const s=supplementFixture();await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);
  207 |   s.revision=1;s.changes=[];await action(host,'save').click();await expect(action(host,'use-latest')).toBeVisible();await expect(host).toContainText('补充审计证据.txt');
  208 |   await action(host,'use-latest').click();await expect(host).not.toContainText('补充审计证据.txt');expect(s.saves).toHaveLength(1);expect(s.revision).toBe(1);expect(s.materials).toHaveLength(3);
  209 |   const restored=await remount(page,s,'panel');await expect(restored).not.toContainText('补充审计证据.txt');expect(s.saves).toHaveLength(1);
  210 | });
  211 | 
  212 | test('accepted PUT with a lost response is recovered by its exact receipt without a second save',async({page})=>{
  213 |   const s=supplementFixture();s.dropSaveOnce=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);
  214 |   await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);const id=s.saves[0].request_id;
  215 |   await expect.poll(()=>s.reads.includes(id)).toBe(true);await expect(host).toContainText('草稿已保存');expect(s.saves).toHaveLength(1);
  216 |   expect(s.receipts.get(id)!.changes).toEqual(s.saves[0].changes);expect(s.run.state).toBe('paused');expect(s.controls).toEqual([]);
  217 | });
  218 | 
  219 | test('unaccepted PUT with a lost response retries the identical request only after receipt says not found',async({page})=>{
  220 |   const s=supplementFixture();s.dropUnacceptedSaveOnce=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);
  221 |   await action(host,'save').click();await expect(action(host,'retry-save')).toBeVisible();
  222 |   // The pending controls render before fetch dispatch. Wait for the actual HTTP
  223 |   // boundary before asserting that the intentionally unaccepted PUT was sent.
  224 |   await expect.poll(()=>s.saves).toHaveLength(1);expect(s.revision).toBe(0);
  225 |   const original=structuredClone(s.saves[0]);await expect.poll(()=>s.reads.includes(original.request_id)).toBe(true);await expect(action(host,'retry-save')).toBeEnabled();
  226 |   await action(host,'retry-save').click();await expect.poll(()=>s.revision).toBe(1);expect(s.saves).toEqual([original,original]);expect(s.uploads).toHaveLength(1);expect(s.byteWrites).toBe(1);
  227 | });
  228 | 
  229 | test('unknown save persists through refresh and reads the original receipt even when a newer revision exists',async({page})=>{
  230 |   const s=supplementFixture();s.dropSaveOnce=true;s.failReceiptReads=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=await add(page);
  231 |   await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);const sent=structuredClone(s.saves[0]);await expect.poll(()=>s.reads.includes(sent.request_id)).toBe(true);
  232 |   s.revision=2;s.changes=[];s.failReceiptReads=false;const restored=await remount(page,s,'panel');
  233 |   await expect.poll(()=>s.reads.filter(id=>id===sent.request_id).length).toBeGreaterThan(1);expect(s.saves).toEqual([sent]);expect(s.revision).toBe(2);
  234 |   await expect(restored).toContainText('补充审计证据.txt');expect(s.receipts.get(sent.request_id)!.revision).toBe(1);expect(s.controls).toEqual([]);
  235 | });
  236 | 
  237 | test('server can_save prevents a save while still showing the exact frozen base and explicit blocked reason',async({page})=>{
  238 |   const s=supplementFixture();s.canSave=false;s.blockedReason='正在核对上次模型调用，暂停完成后才能保存补料。';
  239 |   await installSupplementHttp(page,s);await mountSupplementSurface(page,s);const host=panel(page);await expect(host).toBeVisible();await expect(host).toContainText(s.blockedReason);
  240 |   await expect(action(host,'save')).toBeDisabled();expect(s.saves).toEqual([]);expect(s.controls).toEqual([]);
  241 | });
  242 | 
  243 | test('a lost upload completion receipt is recovered before saving the preparation without resending bytes',async({page})=>{
  244 |   const s=supplementFixture();s.dropCompleteOnce=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s);
  245 |   const host=await ready(page);await host.locator('[data-supplement-role]').selectOption('audit');await host.locator('[data-supplement-file]').setInputFiles(file());
  246 |   await expect.poll(()=>s.completions.length).toBe(1);await expect(action(host,'upload-resume')).toBeEnabled();expect(s.saves).toEqual([]);await expect(action(host,'save')).toBeDisabled();
  247 |   await action(host,'upload-resume').click();await expect(action(host,'save')).toBeEnabled();expect(s.completions).toHaveLength(2);expect(s.uploads).toHaveLength(1);expect(s.byteWrites).toBe(1);
  248 |   await action(host,'save').click();await expect.poll(()=>s.revision).toBe(1);expect(s.saves).toHaveLength(1);expect(s.controls).toEqual([]);
  249 | });
  250 | 
  251 | test('an upload completion after leaving its owner/run surface cannot attach or save to the new view',async({page})=>{
  252 |   const s=supplementFixture();s.holdComplete=true;await installSupplementHttp(page,s);await mountSupplementSurface(page,s);
  253 |   const host=await ready(page);await host.locator('[data-supplement-role]').selectOption('audit');await host.locator('[data-supplement-file]').setInputFiles(file());
  254 |   await expect.poll(()=>typeof s.releaseComplete).toBe('function');
  255 |   await page.evaluate(()=>{const holder=window as unknown as {supplementActive:boolean;supplementComponent:{dispose():void}};holder.supplementActive=false;holder.supplementComponent.dispose();document.querySelector('.shell')!.innerHTML='<h1>另一账号的任务</h1>';});
  256 |   s.releaseComplete!();await expect(page.getByRole('heading',{name:'另一账号的任务'})).toBeVisible();await expect(panel(page)).toHaveCount(0);
  257 |   expect(s.saves).toEqual([]);expect(s.controls).toEqual([]);expect(s.revision).toBe(0);
  258 | });
  259 | 
  260 | test('mismatched exact receipt keeps the original request pending and prevents original-material resume until verified',async({page})=>{
```