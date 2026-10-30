import {test,expect,type Page} from '@playwright/test';
import {AUTOMATIC_PRICE_VERSION,AUTOMATIC_TASK_TARIFF,type WorkpaperLibraryItem,type WorkpaperPaidCheckBatch} from '@bondbuddy/contracts';
import {fixture,install,openFiles,ids,now,hash,docx} from './word-roundtrip-fixtures';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';

async function setup(page:Page,shortage=false){
  const s=fixture();await install(page,s);const starts:any[]=[],quotes:any[]=[],paid:WorkpaperPaidCheckBatch[]=[];
  const entries:WorkpaperLibraryItem[]=Array.from({length:3},(_,n)=>{
    const version={...structuredClone(s.registry[0]),document_type:'workpaper' as const,version_id:'workpaper-version-'+n,file_id:'workpaper-family-'+n,filename:`1-${n} 合成底稿.docx`,consistency:{status:'unchecked' as const,count:0,check_run_id:null}};
    if(n<2)s.registry.push(version);
    return {entry:{id:'wp-'+n,code:'1-'+n,title:'合成底稿'+n,folder:'1 尽职调查',kind:'file',row:n+2,sheet:'1 尽职调查',instructions:'Synthetic only',path:'1 尽职调查/'+version.filename},
      batch_id:'original-workpaper-batch',catalogue_id:'synthetic-catalogue',created_at:now,source:s.source!,latest:true,version_count:1,links_count:1,impact:null,check_stale:false,
      run_id:n<2?'generation-'+n:null,state:'succeeded',stage:null,attempt:1,error:null,
      ...(n<2?{file:{original:version,current:version},artifacts:[{kind:'document' as const,filename:version.filename,pin:s.artifact}]}:{artifacts:[],explanation:{filename:'1-2 不适用说明.docx',sha256:hash(docx('合成不适用说明'))}})};
  });
  await page.route('**/api/v1/commerce/**',route=>route.fulfill({json:{enabled:true,currency:'CNY',version:AUTOMATIC_PRICE_VERSION,model:'subscription_and_topup',items:[],rules:[]}}));
  await page.route('**/api/v1/projects/*/workpapers/**',async route=>{
    const url=new URL(route.request().url()),body=route.request().method()==='POST'?route.request().postDataJSON():null;
    if(url.pathname.endsWith('/library'))return route.fulfill({json:{items:entries,total:3,offset:0,limit:50,source:s.source,checks:[],paid_checks:paid,check_capability:{enabled:true,reason:'',mode:'per_file'}}});
    if(url.pathname.endsWith('/check-batches/quote')){
      quotes.push(body);const targets=entries.filter(i=>i.file&&(!body.file_version_ids||body.file_version_ids.includes(i.file.current.version_id)));
      return route.fulfill({json:{points:targets.length*AUTOMATIC_TASK_TARIFF.check.points,price_version:AUTOMATIC_PRICE_VERSION,auto_charge:true,source:s.source,
        items:targets.map(i=>({item_id:i.entry.id,file_version_id:i.file!.current.version_id,filename:i.file!.current.filename,points:AUTOMATIC_TASK_TARIFF.check.points,price_version:AUTOMATIC_PRICE_VERSION,auto_charge:true,scope_quote_id:'scope-'+i.entry.id,quote_status:'ready',scope_lines:[]})),
        excluded:[{item_id:'wp-2',filename:'1-2 不适用说明.docx',reason:'尚无可独立检查的已交付 Word 版本。'}]}});
    }
    if(url.pathname.endsWith('/check-batches')){
      starts.push(body);if(shortage&&starts.length===1)return route.fulfill({status:402,json:{code:'CREDITS_INSUFFICIENT',message:'本次需补足积分后继续原范围。'}});
      const batch:WorkpaperPaidCheckBatch={batch_id:'paid-check-batch',workpaper_batch_id:body.workpaper_batch_id,created_at:now,source:s.source!,points:body.expected_points,state:'queued',
        items:body.file_version_ids.map((version:string,n:number)=>({file_version_id:version,item_id:'wp-'+n,filename:`1-${n} 合成底稿.docx`,run_id:'file-check-'+n,state:'queued',points:AUTOMATIC_TASK_TARIFF.check.points,charged_points:0,scope_quote_id:'scope-wp-'+n}))};
      paid.splice(0,paid.length,batch);return route.fulfill({json:batch});
    }
    if(url.pathname.endsWith('/preview'))return route.fulfill({json:{text:'合成底稿真实文本预览'}});
    return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
  });return {s,entries,starts,quotes,paid};
}

for(const width of [1440,390])test(`workpaper paid batch ${width}: visible exact files and total, single action, independent result links`,async({page})=>{
  const state=await setup(page);await page.setViewportSize({width,height:960});await openFiles(page);
  const panel=page.locator('#pw-workpaper-library');await panel.locator('.wl-file > summary').first().click();
  const row=panel.locator('.wl-file').first();await expect(row.getByRole('button',{name:'检查本批底稿',exact:true})).toBeEnabled();
  await expect(row).toContainText('本批检查范围：2 份');await expect(row).toContainText((2*AUTOMATIC_TASK_TARIFF.check.points).toLocaleString('zh-CN')+' 积分');
  await row.locator('.wl-price > summary').click();await expect(row).toContainText('1-2 不适用说明.docx');await expect(row).toContainText('尚无可独立检查的已交付 Word 版本');
  expect(state.starts).toEqual([]);await row.getByRole('button',{name:'检查本批底稿',exact:true}).click();await expect.poll(()=>state.starts.length).toBe(1);
  expect(state.starts[0]).toMatchObject({workpaper_batch_id:'original-workpaper-batch',file_version_ids:['workpaper-version-0','workpaper-version-1'],expected_points:2*AUTOMATIC_TASK_TARIFF.check.points,price_version:AUTOMATIC_PRICE_VERSION});
  await expect(page.locator('dialog[open],[data-commerce-confirm]')).toHaveCount(0);
  const receipt=panel.locator('.wl-paid-check');await receipt.locator('summary').click();await expect(receipt.getByRole('link',{name:'1-0 合成底稿.docx'})).toHaveAttribute('href',/run=file-check-0/);
  await expect(receipt.getByRole('link',{name:'1-1 合成底稿.docx'})).toHaveAttribute('href',/run=file-check-1/);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  if(process.env.BB_UX_EVIDENCE_DIR){await mkdir(process.env.BB_UX_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:join(process.env.BB_UX_EVIDENCE_DIR,`workpaper-paid-batch-${width}.png`),fullPage:true});}
});

test('workpaper batch shortage preserves the exact parent request and automatically resumes only that request',async({page})=>{
  const state=await setup(page,true);await openFiles(page);const panel=page.locator('#pw-workpaper-library');await panel.locator('.wl-file > summary').first().click();
  await panel.getByRole('button',{name:'检查本批底稿',exact:true}).first().click();await expect(page.locator('#billing-task-notice')).toContainText('原任务尚未开始');
  expect(state.starts).toHaveLength(1);const returnTo=await page.evaluate(async()=>{const key=Object.keys(localStorage).find(k=>k.startsWith('bondbuddy:billing-task:v1:'))!,row=JSON.parse(localStorage.getItem(key)!);const recovery=await import('/src/'+'billing-task-recovery.ts');return recovery.billingTaskReturnTo(row.owner,row.id);});
  expect(returnTo).toBeTruthy();await page.goto('/'+returnTo);await expect.poll(()=>state.starts.length).toBe(2);expect(state.starts[1]).toEqual(state.starts[0]);
  await page.reload();await expect(page.locator('#pw-workpaper-library')).toBeVisible();expect(state.starts).toHaveLength(2);
});

test('a single workpaper action pins exactly that version and never charges the explanation sibling',async({page})=>{
  const state=await setup(page);await openFiles(page);const panel=page.locator('#pw-workpaper-library');await panel.locator('.wl-file > summary').nth(1).click();
  await panel.locator('.wl-file').nth(1).getByRole('button',{name:/检查此份底稿/}).click();await expect.poll(()=>state.starts.length).toBe(1);
  expect(state.starts[0].file_version_ids).toEqual(['workpaper-version-1']);expect(state.starts[0].expected_points).toBe(AUTOMATIC_TASK_TARIFF.check.points);
  await panel.locator('.wl-file > summary').nth(2).click();await expect(panel.locator('.wl-file').nth(2).getByRole('button',{name:/检查此份底稿/})).toBeDisabled();
  expect(state.s.errors).toEqual([]);
});

test('historical workpaper recheck uses only that family current version and excludes ordinary project documents',async({page})=>{
  const state=await setup(page),original=state.s.registry.find(v=>v.version_id==='workpaper-version-0')!;original.latest=false;
  const current={...structuredClone(original),version_id:'workpaper-version-0-v2',sequence:2,latest:true};state.s.registry.push(current);
  state.s.checks.push({run_id:'original-workpaper-check',state:'succeeded',stage:'completed',created_at:now,source:state.s.source!,stale:false,sha256:hash('Synthetic original workpaper check'),
    files:[{file_id:original.file_id,file_version_id:original.version_id,filename:original.filename,sequence:1}],updates:[],result:{version:'project-file-check-v1',files:[{file_version_id:original.version_id,status:'consistent',coverage:'Synthetic complete original version',findings:[],links:[]}]}});
  const starts:any[]=[],quotes:any[]=[];
  await page.route('**/api/v1/projects/*/project-files/checks/quote',route=>{const body=route.request().postDataJSON();quotes.push(body);return route.fulfill({json:{pricing_mode:'outcome_cny_v1',currency:'CNY',auto_charge:true,amount_fen:AUTOMATIC_TASK_TARIFF.check.points,points:AUTOMATIC_TASK_TARIFF.check.points,price_version:AUTOMATIC_PRICE_VERSION,quote_status:'ready',scope_quote_id:'recheck-scope',scope_lines:[],source_version_id:state.s.source!.version_id,file_version_ids:body.file_version_ids}});});
  await page.route('**/api/v1/projects/*/project-files/checks',route=>{if(route.request().method()==='GET')return route.fallback();starts.push(route.request().postDataJSON());return route.fulfill({json:{run_id:'rechecked-workpaper'}});});
  await page.goto(`/#consistency?project=${ids.root}&run=original-workpaper-check&file=${original.version_id}`);
  await expect(page.locator('.fc-freshness')).toContainText('本份底稿的当前版本');await expect(page.locator('.fc-freshness')).not.toContainText('份新增文件未在本轮检查');
  await page.getByRole('button',{name:'重新检查此份底稿',exact:true}).first().click();await expect.poll(()=>starts.length).toBe(1);
  expect(quotes[0].file_version_ids).toEqual([current.version_id]);expect(starts[0].file_version_ids).toEqual([current.version_id]);
  await expect(page.locator('dialog[open],[data-commerce-confirm]')).toHaveCount(0);
});
