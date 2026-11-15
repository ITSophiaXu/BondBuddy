# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: prospectus-panel.spec.ts >> unknown upload receipt retries the original session and keeps the automatically adopted source
- Location: tests\prospectus-panel.spec.ts:216:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('[data-resume-prospectus]')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" locator('[data-resume-prospectus]') with timeout 5000ms
  - waiting for locator('[data-resume-prospectus]')

```

```yaml
- main:
  - region "历史／参考募集书（必填）":
    - heading "历史／参考募集书（必填）" [level=2]
    - paragraph: 上传本企业历史稿或相似企业募集书，作为本次更新的原稿或结构参考。
    - paragraph: 仅支持 Word（.docx） · 每次一份，单份不超过 100 MB · 选择或拖入后自动保存并采用为原稿。
    - button "上传历史／参考稿":
      - strong: 选择文件
      - text: 或将文件拖到这里
    - region "已上传文件":
      - heading "已上传文件 1" [level=3]
      - strong: 合成新稿.docx
      - text: 本次更新已选用 DOCX · V3 · 2026年10月25日 10:00
      - button "下载原文件"
      - button "删除"
    - status: 已保存并自动采用 V3 · 合成新稿.docx，将在原文基础上修改。
```

# Test source

```ts
  117 |   const out=process.env.BB_REFERENCE_DROP_EVIDENCE;if(out)await mkdir(out,{recursive:true});
  118 |   for(const width of [1440,390,320]){
  119 |     await page.setViewportSize({width,height:960});
  120 |     const bounds=await picker.boundingBox(),files=await page.locator('[data-prospectus-files]').boundingBox();
  121 |     expect(bounds!.width).toBeCloseTo(files!.width,0);expect(bounds!.height).toBeGreaterThanOrEqual(90);
  122 |     expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  123 |     if(out)await page.locator('.prospectus-panel').screenshot({path:`${out}/implementation-empty-${width}.png`});
  124 |   }
  125 |   const [chooser]=await Promise.all([page.waitForEvent('filechooser'),picker.press('Enter')]);
  126 |   await chooser.setFiles({name:'键盘选择募集书.docx',mimeType:mime,buffer:bytes});
  127 |   await expect(page.locator('.reference-file.is-selected')).toContainText('键盘选择募集书.docx');
  128 |   await expect(picker).toBeEnabled();
  129 | });
  130 | 
  131 | test('reference drag feedback survives child transitions and clears on leaving or dropping',async({page})=>{
  132 |   const f=await setup(page),panel=page.locator('.reference-prospectus'),picker=page.locator('.reference-upload-picker');
  133 |   const text=await page.evaluateHandle(()=>{const data=new DataTransfer();data.setData('text/plain','not a file');return data;});
  134 |   await picker.dispatchEvent('dragover',{dataTransfer:text});await expect(panel).not.toHaveClass(/is-dragging/);await text.dispose();
  135 |   const data=await dragFiles(page,['拖入募集书.docx']);
  136 |   await picker.dispatchEvent('dragover',{dataTransfer:data});await expect(panel).toHaveClass(/is-dragging/);
  137 |   await expect(picker).toHaveCSS('background-color','rgb(237, 244, 229)');
  138 |   await picker.evaluate(el=>el.dispatchEvent(new DragEvent('dragleave',{bubbles:true,relatedTarget:el.querySelector('span')})));
  139 |   await expect(panel).toHaveClass(/is-dragging/);
  140 |   const out=process.env.BB_REFERENCE_DROP_EVIDENCE;if(out)await panel.screenshot({path:`${out}/implementation-dragging.png`});
  141 |   await panel.dispatchEvent('dragleave',{relatedTarget:null});await expect(panel).not.toHaveClass(/is-dragging/);
  142 |   // The whole reference card remains a drop target, including the file-list empty state.
  143 |   await page.locator('.reference-empty').dispatchEvent('drop',{dataTransfer:data});await data.dispose();
  144 |   await expect(page.locator('.reference-file.is-selected')).toContainText('拖入募集书.docx');
  145 |   await expect(panel).not.toHaveClass(/is-dragging/);
  146 |   expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
  147 |   expect(f.calls.filter(c=>/runs|authoring|wallet/.test(c.path))).toEqual([]);
  148 | });
  149 | 
  150 | test('reference drops reject invalid files and suppress a second upload while saving',async({page})=>{
  151 |   const f=await setup(page),picker=page.locator('.reference-upload-picker');
  152 |   for(const [names,empty,message] of [[['a.pdf','b.pdf'],false,'每次请选择一份'],[['错误.txt'],false,'仅支持 Word'],[['历史稿.pdf'],false,'仅支持 Word'],[['旧稿.doc'],false,'仅支持 Word'],[['空文件.docx'],true,'请上传不超过 100 MB']] as const){
  153 |     const data=await dragFiles(page,[...names],empty);await picker.dispatchEvent('drop',{dataTransfer:data});await data.dispose();
  154 |     await expect(page.getByRole('alert')).toContainText(message);expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);
  155 |   }
  156 |   let release!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve);
  157 |   await page.route('**/materials/uploads/*/bytes',async route=>{await blocked;await route.fallback();});
  158 |   const data=await dragFiles(page,['正确参考稿.docx']);
  159 |   try{
  160 |     await picker.dispatchEvent('drop',{dataTransfer:data});await expect(picker).toBeDisabled();
  161 |     await expect.poll(()=>f.calls.filter(c=>c.path.endsWith('/materials/uploads')).length).toBe(1);
  162 |     await picker.dispatchEvent('dragover',{dataTransfer:data});await expect(page.locator('.reference-prospectus')).not.toHaveClass(/is-dragging/);
  163 |     await picker.dispatchEvent('drop',{dataTransfer:data});
  164 |     expect(f.calls.filter(c=>c.path.endsWith('/materials/uploads'))).toHaveLength(1);
  165 |   }finally{release();await data.dispose();}
  166 |   await expect(page.locator('.reference-file.is-selected')).toContainText('正确参考稿.docx');
  167 |   await expect(picker).toBeEnabled();expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
  168 | });
  169 | 
  170 | async function selectFile(page:Page,name='合成新稿.docx'){const chooser=page.waitForEvent('filechooser'),replace=page.locator('#replace-prospectus-version');await(await replace.isVisible()?replace:page.locator('#choose-prospectus-version')).click();await(await chooser).setFiles({name,mimeType:name.endsWith('.txt')?'text/plain':mime,buffer:bytes});}
  171 | 
  172 | for(const purpose of ['update','project','generation','qa'])test(purpose+' enforces the owning update project Word-only policy',async({page})=>{
  173 |   const f=await setup(page,{purpose,docxOnly:true});
  174 |   await expect(page.locator('#prospectus-version-file')).toHaveAttribute('accept','.docx');
  175 |   for(const name of ['历史稿.pdf','旧版Word.doc']){
  176 |     await selectFile(page,name);
  177 |     await expect(page.getByRole('alert')).toContainText('仅支持 Word（.docx）');
  178 |     expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);
  179 |   }
  180 |   await selectFile(page,'历史稿.DOCX');
  181 |   await expect.poll(()=>f.state.versions.some(v=>v.filename==='历史稿.DOCX')).toBe(true);
  182 |   expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
  183 | });
  184 | 
  185 | test('non-update projects still upload PDF through the shared panel',async({page})=>{
  186 |   const f=await setup(page,{purpose:'consistency'});
  187 |   await expect(page.locator('#prospectus-version-file')).toHaveAttribute('accept','.docx,.pdf');
  188 |   await selectFile(page,'一致性检查稿.pdf');
  189 |   await expect.poll(()=>f.state.versions.some(v=>v.filename==='一致性检查稿.pdf')).toBe(true);
  190 |   expect(f.calls.find(c=>c.path.endsWith('/materials/uploads'))?.body.media_type).toBe('application/pdf');
  191 | });
  192 | async function adopt(page:Page,id:string){await history(page).evaluate(el=>(el as HTMLDetailsElement).open=true);await page.locator('[data-use-version="'+id+'"]').click();await expect(page.locator('dialog[open]')).toBeVisible();}
  193 | 
  194 | test('empty state exposes upload, has no saved history entries, and fits phone widths',async({page})=>{
  195 |   await setup(page);await expect(page.getByRole('button',{name:/^(上传募集说明书|上传历史／参考稿)$/})).toBeVisible();await expect(history(page).locator('[data-prospectus-version]')).toHaveCount(0);await expect(page.locator('.reference-empty')).toContainText('请上传一份历史／参考募集书');
  196 |   const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:/^(上传募集说明书|上传历史／参考稿)$/}).click();await chooser;
  197 |   for(const width of [1440,390,320]){await page.setViewportSize({width,height:960});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const card=await page.locator('.prospectus-panel').boundingBox(),heading=await page.locator('[data-prospectus-heading]').boundingBox();expect(heading!.x-card!.x).toBeGreaterThanOrEqual(18);}
  198 | });
  199 | 
  200 | for(const purpose of ['update','consistency'])test(purpose+' uploads a corrected selection with purpose-specific adoption and no task execution',async({page})=>{
  201 |   const f=await setup(page,{purpose});await selectFile(page,'错误.txt');await page.evaluate(()=>window.panelFixture.refresh());await expect(page.getByRole('alert')).toContainText(purpose==='update'?'仅支持 Word':'请上传不超过 100 MB');expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);
  202 |   await expect(page.getByRole('button',{name:'上传并保存',exact:true})).toHaveCount(0);
  203 |   const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'重新选择',exact:true}).click();await(await chooser).setFiles({name:'合成新稿.docx',mimeType:mime,buffer:bytes});
  204 |   await expect(page.locator('#prospectus-status')).toContainText(purpose==='update'?/已保存并自动采用/:/已保存.*尚未采用/);await page.evaluate(()=>window.panelFixture.refresh());
  205 |   expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(1);expect(f.state.current_version_id).toBe(purpose==='update'?'v3':null);await expect(page.locator('#save-prospectus-version')).toBeHidden();
  206 |   expect(await page.evaluate(()=>window.panelFixture.sourceSelectionMessage())).toBe('');
  207 |   if(process.env.BB_UPLOAD_EVIDENCE){await mkdir(process.env.BB_UPLOAD_EVIDENCE,{recursive:true});for(const width of [1440,390]){await page.setViewportSize({width,height:960});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.locator('.prospectus-panel').screenshot({path:`${process.env.BB_UPLOAD_EVIDENCE}/${purpose}-uploaded-${width}.png`});}}
  208 | });
  209 | 
  210 | for(const purpose of ['update','consistency'])test(purpose+' drops one file and ignores a second selection event while uploading',async({page})=>{
  211 |   const f=await setup(page,{purpose});
  212 |   await page.evaluate(bytes=>{const input=document.querySelector<HTMLInputElement>('#prospectus-version-file')!,data=new DataTransfer();data.items.add(new File([new Uint8Array(bytes)],'拖入募集书.docx',{type:'application/pdf'}));document.querySelector('.prospectus-upload-editor')!.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data}));input.dispatchEvent(new Event('change',{bubbles:true}));},[...bytes]);
  213 |   await expect(page.locator('#prospectus-status')).toContainText(purpose==='update'?/已保存并自动采用/:/已保存.*尚未采用/);expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(1);expect(f.calls.filter(c=>c.path.endsWith('/materials/uploads'))).toHaveLength(1);expect(f.state.current_version_id).toBe(purpose==='update'?'v3':null);
  214 | });
  215 | 
  216 | test('unknown upload receipt retries the original session and keeps the automatically adopted source',async({page})=>{
> 217 |   const f=await setup(page,{retry:true});await selectFile(page);await expect(page.locator('[data-resume-prospectus]')).toBeVisible();await expect(page.locator('.prospectus-selected-file')).toContainText('合成新稿.docx');
      |                                                                                                                        ^ Error: expect(locator).toBeVisible() failed
  218 |   await page.getByRole('button',{name:'确认原上传',exact:true}).click();await expect(page.locator('#prospectus-status')).toContainText(/已保存并自动采用/);expect(f.state.current_version_id).toBe('v3');expect(f.state.selection_revision).toBe(1);expect(f.calls.filter(c=>c.path.endsWith('/prospectus-versions/current'))).toHaveLength(0);
  219 |   expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(1);expect(f.calls.filter(c=>c.path.endsWith('/materials/uploads'))).toHaveLength(1);const completions=f.calls.filter(c=>c.path.endsWith('/complete'));expect(completions).toHaveLength(2);expect(completions[0].body).toEqual(completions[1].body);
  220 |   await expect(page.locator('.reference-file.is-selected')).toContainText('本次更新已选用');await expect(page.locator('[data-use-version="v3"]')).toHaveCount(0);
  221 |   expect(await page.evaluate(()=>window.panelFixture.sourceSelectionMessage())).toBe('');
  222 | });
  223 | 
  224 | test('current version downloads, uploaded file list survives refresh, and adoption needs confirmation',async({page})=>{
  225 |   const f=await setup(page,{versions:true});const download=page.waitForEvent('download');await page.locator('.reference-file.is-selected').getByRole('button',{name:'下载清洁版'}).click();expect((await download).suggestedFilename()).toBe('募集说明书_V2_清洁版.docx');
  226 |   await expect(history(page)).toBeHidden();await page.evaluate(()=>window.panelFixture.refresh());await expect(page.locator('[data-prospectus-version="v1"] .prospectus-version-info > strong')).toHaveText('合成历史募集书.docx');await expect(page.locator('.reference-file.is-selected')).toContainText('本次更新已选用');await expect(page.getByText('文件版本详情',{exact:true})).toHaveCount(0);
  227 |   await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await adopt(page,'v1');expect(f.calls.filter(c=>c.path.endsWith('/prospectus-versions/current'))).toHaveLength(0);await page.locator('#confirm-prospectus-selection').click();await expect(page.locator('.reference-file.is-selected')).toContainText('本次更新已选用');expect(f.calls.find(c=>c.path.endsWith('/prospectus-versions/current'))!.body).toMatchObject({version_id:'v1',expected_selection_revision:2});
  228 | });
  229 | 
  230 | test('generation guidance and same-size visual evidence',async({page})=>{
  231 |   await setup(page,{purpose:'generation'});await expect(page.locator('#choose-prospectus-version')).toBeVisible();await expect(history(page)).toBeHidden();await expect(page.getByText('上传募集书新版本',{exact:true})).toHaveCount(0);await expect(page.locator('.pf-source-modes')).toBeHidden();
  232 |   const out=process.env.BB_PANEL_EVIDENCE;if(!out)return;await mkdir(out,{recursive:true});
  233 |   for(const state of ['empty','current'])for(const width of [1440,390]){await page.setViewportSize({width,height:960});await setup(page,{versions:state==='current'});await page.locator('.prospectus-panel').screenshot({path:`${out}/implementation-${state}-${width}.png`});await page.goto(prototypeRoot+'prospectus-panel.html?state='+state);await page.locator('.prospectus-panel').screenshot({path:`${out}/prototype-${state}-${width}.png`});}
  234 | });
  235 | 
  236 | for(const width of [1440,390,320])test(`generation empty project only exposes upload, ${width}px`,async({page})=>{
  237 |   await page.setViewportSize({width,height:960});const f=await setup(page,{purpose:'generation'});
  238 |   const out=process.env.BB_EMPTY_SOURCE_EVIDENCE;
  239 |   if(out){await mkdir(out,{recursive:true});await page.screenshot({path:`${out}/implementation-empty-${width}.png`,fullPage:true});}
  240 |   await expect(page.getByRole('radio',{name:'选择项目已有募集说明书',exact:true})).toBeHidden();
  241 |   await expect(page.locator('.pf-source-modes')).toBeHidden();await expect(page.locator('#pf-source-existing')).toBeHidden();
  242 |   await expect(page.locator('#choose-prospectus-version')).toBeVisible();
  243 |   await expect(page.locator('.pf-source-picker')).not.toContainText('选择一种方式');
  244 |   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  245 |   expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);
  246 | });
  247 | 
  248 | test('generation refresh removes stale project choice and restores it for saved unselected versions',async({page})=>{
  249 |   const f=await setup(page,{purpose:'generation',versions:true});
  250 |   const existing=page.getByRole('radio',{name:'选择项目已有募集说明书',exact:true});
  251 |   await page.getByRole('radio',{name:'上传新募集说明书',exact:true}).check();await existing.check();
  252 |   f.state.versions=[];f.state.current_version_id=null;f.state.selection_revision++;
  253 |   await page.evaluate(()=>window.panelFixture.refresh());
  254 |   await expect(existing).toBeHidden();await expect(page.locator('#pf-source-existing')).toBeHidden();
  255 |   await expect(page.locator('#choose-prospectus-version')).toBeVisible();
  256 |   f.state.versions=[version(1)];await page.evaluate(()=>window.panelFixture.refresh());
  257 |   await expect(existing).toBeVisible();await existing.check();
  258 |   await expect(page.locator('#pf-project-source option')).toHaveText(['请选择募集说明书版本','V1 · 合成历史募集书.docx']);
  259 |   await expect(page.locator('.pf-selected-source')).toHaveCount(0);
  260 |   expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);
  261 | });
  262 | 
  263 | test('generation does not offer unverified versions as existing project sources',async({page})=>{
  264 |   const f=await setup(page,{purpose:'generation',versions:true});f.state.project_id='another-project';
  265 |   await page.evaluate(()=>window.panelFixture.refresh());
  266 |   await expect(page.getByRole('radio',{name:'选择项目已有募集说明书',exact:true})).toBeHidden();
  267 |   await expect(page.locator('#pf-source-existing')).toBeHidden();await expect(page.locator('#choose-prospectus-version')).toBeVisible();
  268 |   expect(f.calls.filter(c=>c.method!=='GET')).toEqual([]);
  269 | });
  270 | 
  271 | test('generation drop zone validates files and automatically saves one valid file',async({page})=>{
  272 |   const f=await setup(page,{purpose:'generation'});
  273 |   const drop=async(names:string[])=>{const data=await page.evaluateHandle(({names,bytes})=>{const data=new DataTransfer();for(const name of names)data.items.add(new File([new Uint8Array(bytes)],name,{type:'application/pdf'}));return data;},{names,bytes:[...bytes]});await page.locator('#choose-prospectus-version').dispatchEvent('drop',{dataTransfer:data});await data.dispose();};
  274 |   await drop(['a.pdf','b.pdf']);await expect(page.locator('#prospectus-status')).toContainText('每次请选择一份');
  275 |   await drop(['错误.txt']);await expect(page.locator('#save-prospectus-version')).toBeDisabled();
  276 |   await page.locator('#cancel-prospectus-version').click();await drop(['拖放募集书.pdf']);
  277 |   await expect(page.locator('.pf-selected-source')).toContainText('拖放募集书.pdf');
  278 |   await page.evaluate(()=>window.panelFixture.refresh());
  279 |   await expect(page.locator('.pf-selected-source')).toBeVisible();
  280 |   await expect(page.locator('.pf-source-upload-state')).toHaveCount(0);
  281 |   await expect(page.locator('#save-prospectus-version')).toBeHidden();
  282 |   expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
  283 |   expect(f.state.current_version_id).toBe('v3');
  284 | });
  285 | 
  286 | test('generation lost upload acknowledgement automatically selects the saved source',async({page})=>{
  287 |   const f=await setup(page,{purpose:'generation',retry:true});await selectFile(page);
  288 |   await expect(page.locator('.pf-selected-source')).toContainText('合成新稿.docx',{timeout:15000});
  289 |   expect(f.state.current_version_id).toBe('v3');expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
  290 |   await expect(page.locator('dialog[open]')).toHaveCount(0);
  291 |   await expect(page.locator('.pf-selected-source')).toContainText('V3');
  292 |   expect(f.calls.filter(c=>c.path.endsWith('/prospectus-versions/current'))).toHaveLength(1);
  293 | });
  294 | declare global{interface Window{panelFixture:{refresh:()=>Promise<void>;setReadOnly:(value:boolean)=>void;sourceSelectionMessage:()=>string;hasUnconfirmed:()=>boolean}}}
  295 | 
  296 | test('mistaken saved upload can be cancelled, deleted, refreshed away and replaced',async({page})=>{
  297 |   const f=await setup(page);await expect(page.locator('[data-prospectus-heading]')).toHaveText('历史／参考募集书（必填）');
  298 |   await expect(page.getByRole('button',{name:'先提供发行人材料'})).toHaveCount(0);
  299 |   await selectFile(page,'误上传的历史稿.docx');
  300 |   const row=page.locator('[data-prospectus-version="v3"]');await expect(row).toContainText('本次更新已选用');await expect(row.locator('[data-use-version]')).toHaveCount(0);
  301 |   await row.getByRole('button',{name:'删除',exact:true}).click();await page.locator('[data-cancel-delete]').click();expect(f.calls.filter(c=>c.method==='DELETE')).toHaveLength(0);
  302 |   await row.getByRole('button',{name:'删除',exact:true}).click();await page.locator('[data-confirm-delete]').click();
  303 |   await expect(row).toHaveCount(0);await page.evaluate(()=>window.panelFixture.refresh());await expect(history(page).locator('[data-prospectus-version]')).toHaveCount(0);
  304 |   expect(f.calls.filter(c=>c.method==='DELETE')).toHaveLength(1);expect(f.state.current_version_id).toBeNull();
  305 |   expect(await page.evaluate(()=>window.panelFixture.sourceSelectionMessage())).toBe('');
  306 |   await selectFile(page,'正确参考稿.docx');await expect(page.locator('[data-prospectus-version="v3"]')).toContainText('正确参考稿.docx');
  307 |   expect(f.calls.filter(c=>c.path.endsWith('/prospectus-versions/current'))).toHaveLength(0);
  308 | });
  309 | 
  310 | test('used and current uploads explain why deletion is unavailable',async({page})=>{
  311 |   const f=await setup(page,{versions:true});f.state.versions[1].delete_block_reason='used';await page.evaluate(()=>window.panelFixture.refresh());
  312 |   await history(page).evaluate(el=>(el as HTMLDetailsElement).open=true);
  313 |   await expect(page.locator('[data-prospectus-version="v1"]')).toContainText('已作为编制依据保留');await expect(page.locator('[data-delete-version]')).toHaveCount(0);
  314 |   f.state.current_version_id='v1';f.state.selection_revision++;f.state.versions[1].delete_block_reason='current';await page.evaluate(()=>window.panelFixture.refresh());
  315 |   await expect(page.locator('[data-prospectus-version="v1"]')).toContainText('本次更新已选用');await expect(page.locator('[data-delete-version]')).toHaveCount(0);
  316 | });
  317 | 
```