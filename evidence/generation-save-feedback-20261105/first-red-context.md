# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: generation-save-feedback.spec.ts >> desktop selection stays immediate and editable while saves are serialized and merged
- Location: tests\generation-save-feedback.spec.ts:50:1

# Error details

```
Error: expect(locator).not.toBeChecked() failed

Locator:  locator('[data-fg-item="entry-1"]')
Expected: not checked
Received: checked
Timeout:  5000ms

Call log:
  - Expect "not toBeChecked" locator('[data-fg-item="entry-1"]') with timeout 5000ms
  - waiting for locator('[data-fg-item="entry-1"]')
    14 × locator resolved to <input checked type="checkbox" data-fg-item="entry-1" aria-label="生成 1 基本情况核查记录"/>
       - unexpected value "checked"

```

```yaml
- checkbox "生成 1 基本情况核查记录" [checked]
```

# Test source

```ts
  1   | import {test,expect,type Page,type Route} from '@playwright/test';
  2   | import {fixture,href,ids,sha,now} from './generation-entry-fixtures';
  3   | import {fixtureBody,fixtureRequest} from './billing-fixture-wire';
  4   | import {AUTOMATIC_PRICE_VERSION,emptyFileGenerationPreparation,type FileGenerationWorkspace,type WorkpaperCatalogue} from '@bondbuddy/contracts';
  5   |
  6   | // Real desktop controls and production component; identity, HTTP and catalogue
  7   | // are synthetic. No model, payment provider or account ledger is exercised.
  8   | const catalogue:WorkpaperCatalogue={catalogue_id:'save-feedback-cat',filename:'合成体验底稿目录.xlsx',sha256:sha,created_at:now,warnings:[],entries:['1','2'].map((code,i)=>({id:'entry-'+code,code,title:i?'关联方情况说明':'基本情况核查记录',folder:'',sheet:'尽职调查文件',row:i+2,instructions:'',kind:'file',path:code+'.docx'}))};
  9   | type Save={expected_revision:number;preparation:FileGenerationWorkspace['preparation']};
  10  | const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
  11  | async function setup(page:Page){
  12  |  const transport=await fixture(page);
  13  |  const preparation={...emptyFileGenerationPreparation(),workpaper_template_mode:'automatic' as const,catalogue_id:catalogue.catalogue_id,item_ids:['entry-1','entry-2']};
  14  |  const state={data:{revision:1,preparation,sets:[],builtin:{name:'光大证券模板',version:'synthetic-v1',available:true},pricing:{mode:'automatic',price_version:AUTOMATIC_PRICE_VERSION,workpaper_points:3458,document_points:7965},batches:[]} as FileGenerationWorkspace,saves:[] as Save[],quotes:[] as any[],submissions:[] as any[],transport};
  15  |  await page.route('**/api/v1/projects/*/file-generation**',async route=>{
  16  |   const req=route.request(),path=new URL(req.url()).pathname,body=req.method()==='GET'?undefined:fixtureRequest(req);
  17  |   const reply=(value:unknown)=>route.fulfill({json:fixtureBody(route,value)});
  18  |   if(req.method()==='GET'&&path.endsWith('/file-generation'))return reply(state.data);
  19  |   if(path.endsWith('/preparation')){
  20  |    state.saves.push(structuredClone(body));
  21  |    // Match the existing API's exact retry and revision-conflict semantics.
  22  |    if(state.data.revision===body.expected_revision+1&&same(state.data.preparation,body.preparation))return reply({revision:state.data.revision,preparation:state.data.preparation});
  23  |    if(state.data.revision!==body.expected_revision)return route.fulfill({status:409,json:{code:'INPUT_REVISION_CONFLICT'}});
  24  |    state.data.revision++;state.data.preparation=structuredClone(body.preparation);
  25  |    return reply({revision:state.data.revision,preparation:state.data.preparation});
  26  |   }
  27  |   if(path.endsWith('/quote')){
  28  |    state.quotes.push({...body,preparation:structuredClone(state.data.preparation)});
  29  |    expect(body.expected_revision).toBe(state.data.revision);
  30  |    expect(Number(body.expected_points)).toBe(state.data.preparation.item_ids.length*3458);
  31  |    return reply({count:state.data.preparation.item_ids.length,points:body.expected_points,price_version:AUTOMATIC_PRICE_VERSION,omitted:catalogue.entries.filter(e=>!state.data.preparation.item_ids.includes(e.id)),auto_charge:true,quote_status:'ready',documents:[]});
  32  |   }
  33  |   if(path.endsWith('/batches')){
  34  |    state.submissions.push(body);expect(body.expected_revision).toBe(state.data.revision);
  35  |    const batch={batch_id:'save-feedback-batch',created_at:now,points:body.expected_points,workpapers:null,documents:null};
  36  |    return reply(batch);
  37  |   }
  38  |   return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
  39  |  });
  40  |  await page.route('**/api/v1/projects/*/workpapers/catalogues/*',route=>route.fulfill({json:catalogue}));
  41  |  await page.goto('/'+href({step:'prepare'}));
  42  |  await expect(page.locator('#fg-confirm')).toBeEnabled();
  43  |  await page.getByRole('button',{name:'调整生成范围',exact:true}).click();
  44  |  return state;
  45  | }
  46  | const first=(page:Page)=>page.locator('[data-fg-item="entry-1"]');
  47  | const second=(page:Page)=>page.locator('[data-fg-item="entry-2"]');
  48  | test.use({viewport:{width:1440,height:960}});
  49  |
  50  | test('desktop selection stays immediate and editable while saves are serialized and merged',async({page},info)=>{
  51  |  const state=await setup(page),held:{body:Save;release:()=>void}[]=[];
  52  |  await page.route('**/file-generation/preparation',async route=>{
  53  |   const body=fixtureRequest(route.request());
  54  |   await new Promise<void>(release=>held.push({body:structuredClone(body),release}));
  55  |   return route.fallback();
  56  |  });
  57  |  await page.getByRole('button',{name:'取消全选',exact:true}).click();
  58  |  await expect.poll(()=>held.length).toBe(1);
  59  |  await page.screenshot({path:info.outputPath('first-save-pending.png')});
> 60  |  await expect(first(page)).not.toBeChecked();
      |                                ^ Error: expect(locator).not.toBeChecked() failed
  61  |  await expect(page.locator('.fg-footer')).toContainText('本批 0 份文件');
  62  |  await expect(page.locator('#fg-controls')).toHaveJSProperty('inert',false);
  63  |  await first(page).click();await second(page).click();await first(page).click();
  64  |  await expect(first(page)).not.toBeChecked();await expect(second(page)).toBeChecked();
  65  |  await expect(page.locator('.fg-footer')).toContainText('本批 1 份文件');
  66  |  expect(held).toHaveLength(1);
  67  |  held[0].release();await expect.poll(()=>held.length).toBe(2);
  68  |  expect(held[1].body.preparation.item_ids).toEqual(['entry-2']);
  69  |  await expect(second(page)).toBeChecked();await expect(first(page)).not.toBeChecked();
  70  |  held[1].release();await expect.poll(()=>state.data.preparation.item_ids).toEqual(['entry-2']);
  71  |  await expect(page.locator('#fg-save-state')).toContainText('已保存');
  72  |  expect(state.saves.map(s=>s.expected_revision)).toEqual([1,2]);expect(state.quotes).toEqual([]);expect(state.submissions).toEqual([]);
  73  |  await page.screenshot({path:info.outputPath('latest-selection-saved.png')});
  74  | });
  75  |
  76  | test('late save preserves requirements and caret and generation waits for the newest snapshot',async({page})=>{
  77  |  const state=await setup(page);let release!:()=>void,calls=0;
  78  |  await page.route('**/file-generation/preparation',async route=>{if(++calls===1)await new Promise<void>(r=>release=r);return route.fallback();});
  79  |  await first(page).click();await expect.poll(()=>calls).toBe(1);
  80  |  const note=page.locator('#fg-requirements');await note.fill('保留当前输入与金额单位');await note.focus();
  81  |  await note.evaluate((n:HTMLTextAreaElement)=>n.setSelectionRange(2,5));
  82  |  release();await expect.poll(()=>state.data.preparation.requirements).toBe('保留当前输入与金额单位');
  83  |  await expect(note).toBeFocused();expect(await note.evaluate((n:HTMLTextAreaElement)=>[n.selectionStart,n.selectionEnd])).toEqual([2,5]);
  84  |  let finish!:()=>void;await page.route('**/file-generation/preparation',async route=>{await new Promise<void>(r=>finish=r);return route.fallback();});
  85  |  await first(page).click();await expect.poll(()=>!!finish).toBe(true);
  86  |  await page.locator('#fg-confirm').click();expect(state.quotes).toHaveLength(0);expect(state.submissions).toHaveLength(0);
  87  |  finish();await expect.poll(()=>state.submissions.length).toBe(1);
  88  |  expect(state.quotes).toHaveLength(1);expect(state.quotes[0].preparation.item_ids).toEqual(['entry-2','entry-1']);
  89  |  expect(state.quotes[0].preparation.requirements).toBe('保留当前输入与金额单位');expect(Number(state.submissions[0].expected_points)).toBe(6916);
  90  | });
  91  |
  92  | test('failed save keeps the local range across refresh and retries without quoting unsaved work',async({page})=>{
  93  |  const state=await setup(page);let failing=true;
  94  |  await page.route('**/file-generation/preparation',route=>failing?route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE',retryable:true}}):route.fallback());
  95  |  await first(page).click();await expect(page.locator('#fg-save-retry')).toBeVisible();
  96  |  await expect(first(page)).not.toBeChecked();await page.locator('#fg-confirm').click();
  97  |  expect(state.quotes).toEqual([]);expect(state.submissions).toEqual([]);
  98  |  await page.reload();await page.getByRole('button',{name:'调整生成范围',exact:true}).click();await expect(first(page)).not.toBeChecked();await expect(second(page)).toBeChecked();
  99  |  failing=false;await page.locator('#fg-save-retry').click();await expect(page.locator('#fg-save-state')).toContainText('已保存');
  100 |  expect(state.data.preparation.item_ids).toEqual(['entry-2']);expect(state.quotes).toEqual([]);
  101 | });
  102 |
  103 | for(const refresh of [false,true])test(`unknown save result preserves its original snapshot before newer edits, refresh=${refresh}`,async({page})=>{
  104 |  const state=await setup(page);let calls=0;
  105 |  await page.route('**/file-generation/preparation',async route=>{
  106 |   if(++calls!==1)return route.fallback();
  107 |   const body=fixtureRequest(route.request());state.data.revision++;state.data.preparation=structuredClone(body.preparation);return route.abort('failed');
  108 |  });
  109 |  await first(page).click();await expect(page.locator('#fg-save-retry')).toBeVisible();
  110 |  await second(page).click();await expect(second(page)).not.toBeChecked();
  111 |  if(refresh){await page.reload();await page.getByRole('button',{name:'调整生成范围',exact:true}).click();await expect(first(page)).not.toBeChecked();await expect(second(page)).not.toBeChecked();}
  112 |  await page.locator('#fg-save-retry').click();await expect(page.locator('#fg-save-state')).toContainText('已保存');
  113 |  expect(state.data.revision).toBe(3);expect(state.data.preparation.item_ids).toEqual([]);expect(state.quotes).toEqual([]);expect(state.submissions).toEqual([]);
  114 | });
  115 |
  116 | test('another page revision keeps the local draft and blocks save and generation',async({page})=>{
  117 |  const state=await setup(page);let release!:()=>void;
  118 |  await page.route('**/file-generation/preparation',async route=>{await new Promise<void>(r=>release=r);return route.fallback();});
  119 |  await first(page).click();await expect.poll(()=>!!release).toBe(true);
  120 |  state.data.revision++;state.data.preparation={...state.data.preparation,requirements:'另一页面已保存的要求'};release();
  121 |  await expect(page.locator('#fg-save-state')).toContainText('另一页面');await expect(first(page)).not.toBeChecked();
  122 |  await expect(page.locator('#fg-confirm')).toBeDisabled();
  123 |  await page.reload();await expect(page.locator('#fg-save-state')).toContainText('另一页面');await expect(page.locator('#fg-confirm')).toBeDisabled();
  124 |  expect(state.data.preparation.item_ids).toEqual(['entry-1','entry-2']);expect(state.quotes).toEqual([]);expect(state.submissions).toEqual([]);
  125 | });
  126 |
```