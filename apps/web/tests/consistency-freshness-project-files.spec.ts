import {expect,test} from '@playwright/test';
import type {ProjectFileCheck} from '@bondbuddy/contracts';
import {assertFixture,fixture,hash,ids,install,openFiles,writeCalls} from './word-roundtrip-fixtures';

// Reuse the sealed Word HTTP fixture without changing its original scenarios.
// The link reaches the real consistency route and its original immutable result.
test('consistency freshness: a manual badge opens its exact historical check and family; missing run IDs never create an action',async({page})=>{
  test.skip(process.env.BB_CONSISTENCY_FRESHNESS_REFERENCE==='1','Old reference has no new manual action.');
  const s=fixture(),checkId='freshness-original-manual-check',original=s.registry[0];
  original.consistency={status:'manual',count:0,check_run_id:checkId};
  const check:ProjectFileCheck={run_id:checkId,state:'succeeded',stage:'completed',created_at:original.created_at,
    source:structuredClone(s.source),stale:false,sha256:hash('original manual check'),updates:[],
    files:[{file_id:ids.family,file_version_id:ids.version,filename:original.filename,sequence:1}],
    result:{version:'project-file-check-v1',files:[{file_version_id:ids.version,status:'manual',coverage:'原 V1 的人工事项范围',links:[],
      findings:[{id:'freshness-manual-item',target_span_id:'original-v1-span',source_span_id:null,original:'原 V1 的授信审批口径',replacement:null,
        source_quote:'',target_location:'原 V1 第 3 页',source_location:'募集书依据待补',reason:'请补充原审批依据，人工核对后再决定文件处理。',
        field:'授信审批口径',period:'2026年10月',unit:'',kind:'manual'}]}]}};
  s.checks.push(check);await install(page,s);await openFiles(page);
  const row=page.locator(`.collection-file[data-file-version="${ids.version}"]`),link=row.getByRole('link',{name:'查看需确认事项',exact:true});
  await expect(row).toContainText('需人工确认');const href=await link.getAttribute('href'),query=new URLSearchParams(href!.split('?')[1]);
  expect(query.get('run')).toBe(checkId);expect(query.get('file')).toBe(ids.family);expect(query.get('project')).toBe(ids.root);
  await link.focus();await page.keyboard.press('Enter');await expect(page).toHaveURL(new RegExp('run='+checkId));
  const result=page.locator(`[data-fc-result-version="${ids.version}"]`);await expect(result.locator('details')).toHaveAttribute('open');
  await expect(result).toContainText('原 V1 的授信审批口径');await expect(result).toContainText('人工核对后再决定文件处理');
  await expect(page.locator('#fc-history')).toHaveValue(checkId);expect(writeCalls(s)).toEqual([]);
  original.consistency={status:'manual',count:0,check_run_id:null};await openFiles(page);
  await expect(row).toContainText('需人工确认');await expect(row.getByRole('link',{name:'查看需确认事项',exact:true})).toHaveCount(0);
  original.consistency={status:'conflict',count:1,check_run_id:null};await page.reload();await expect(row).toContainText('发现差异');
  await expect(row.getByRole('link',{name:'查看差异 / 更新',exact:true})).toHaveCount(0);
  expect(writeCalls(s)).toEqual([]);assertFixture(s);
});

test('consistency freshness: a manual deep link stays visible through a real retained selection and a previous consistent or conflict filter',async({context})=>{
  test.skip(process.env.BB_CONSISTENCY_FRESHNESS_REFERENCE==='1','Old reference has no new manual action.');
  for(const filter of ['consistent','conflict']){
    const page=await context.newPage(),s=fixture(),checkId='freshness-cached-filter-check',original=s.registry[0],other=s.registry[1];
    original.consistency={status:'manual',count:0,check_run_id:checkId};other.consistency={status:'conflict',count:1,check_run_id:checkId};
    const finding={id:'cached-filter-manual-item',target_span_id:'original-v1-span',source_span_id:null,original:'原 V1 应保留的人工授信事项',replacement:null,
      source_quote:'',target_location:'原 V1 第 3 页',source_location:'募集书依据待补',reason:'此前筛选不能遮住这个准确的历史人工事项。',field:'授信审批口径',period:'2026年10月',unit:'',kind:'manual' as const};
    s.checks.push({run_id:checkId,state:'succeeded',stage:'completed',created_at:original.created_at,source:structuredClone(s.source),stale:false,
      sha256:hash('cached filter manual check'),updates:[],files:[original,other].map(v=>({file_id:v.file_id,file_version_id:v.version_id,filename:v.filename,sequence:v.sequence})),
      result:{version:'project-file-check-v1',files:[{file_version_id:original.version_id,status:'manual',coverage:'原 V1 人工事项',links:[],findings:[finding]},
        {file_version_id:other.version_id,status:'conflict',coverage:'原发行人文件差异',links:[],findings:[{...finding,id:'cached-filter-actionable-item',kind:'conflict',replacement:'可确认的发行人新文字',field:'发行人数据'}]}]}});
    await install(page,s);await page.goto(`/#consistency?project=${ids.root}&run=${checkId}`);await expect(page.locator('.fc-results')).toBeVisible();
    // Build the cache through native controls. A lone filter without a selection
    // would be removed by production cache(), so that would miss the real bug.
    await page.locator(`[data-fc-select="${other.version_id}"]`).check();
    await page.getByRole('combobox',{name:'筛选文件状态',exact:true}).selectOption(filter);
    const cached=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)??'null'),`bondbuddy:file-consistency:${ids.owner}:${ids.root}`);
    expect(cached.filter).toBe(filter);expect(cached.chosen).toContain(other.version_id);
    await page.getByRole('link',{name:'返回项目文件',exact:true}).click();await expect(page.locator('#file-list')).toBeVisible();
    await page.locator(`.collection-file[data-file-version="${ids.version}"]`).getByRole('link',{name:'查看需确认事项',exact:true}).click();
    const target=page.locator(`[data-fc-result-version="${ids.version}"]`);await expect(target).toBeVisible();await expect(target.locator('details')).toHaveAttribute('open');
    await expect(target).toContainText('原 V1 应保留的人工授信事项');await expect(page.locator('#fc-history')).toHaveValue(checkId);
    const query=new URLSearchParams((await page.evaluate(()=>location.hash)).split('?')[1]);expect(query.get('run')).toBe(checkId);expect(query.get('file')).toBe(ids.family);
    await expect(page.locator(`[data-fc-select="${other.version_id}"]`)).toBeChecked();
    await page.getByRole('combobox',{name:'筛选文件状态',exact:true}).selectOption('conflict');
    await expect(target).toHaveCount(0);await expect(page.locator(`[data-fc-result-version="${other.version_id}"]`)).toBeVisible();
    await expect(page.locator(`[data-fc-select="${other.version_id}"]`)).toBeChecked();
    expect(writeCalls(s)).toEqual([]);assertFixture(s);await page.close();
  }
});
