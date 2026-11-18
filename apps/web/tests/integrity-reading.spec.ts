import {test,expect,type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fixture,install,assertFixture,projectId,checkId,exportId,writes} from './integrity-continuation-fixtures';
const route=(run=exportId)=>`/#integrity?project=${projectId}&run=${run}`;
const modal=(page:Page)=>page.locator('.integrity-modal[open]');
function readingFixture(){
 const s=fixture(),check=s.workspace.rounds.find(r=>r.run_id===checkId)!,copy=s.workspace.rounds.find(r=>r.run_id===exportId)!;
 check.state='cancelled';check.charged_points=0;check.artifact_id=null;check.artifacts=[];
 const original=check.records.find(r=>r.status==='public_matches')!;
 original.findings=[{capture_id:original.sources[0].tool_call_id,quote:original.sources[0].quote,title:'合成公开事项A',explanation:'主体与事项仍需人工核对',nature:'adverse',subject_match:'unconfirmed'}];
 const second=check.records.find(r=>r.subject_id==='company-b'&&r.site_id==='credit-china')!;second.status='public_matches';second.reason='一般信息待审阅';second.search_performed=true;second.sources=[{...original.sources[0],quote:'第二主体一般信息原文。',tool_call_id:'second-capture'}];second.findings=[{capture_id:'second-capture',quote:'第二主体一般信息原文。',title:'合成一般公告B',explanation:'一般信息，不是风险结论',nature:'information',subject_match:'company_name'}];
 check.records=check.records.filter(r=>!(r.subject_id==='company-b'&&r.site_id==='local-tax'));
 copy.manifest.records=structuredClone(check.records);copy.records=structuredClone(check.records);
 return s;
}
test.afterEach(async({page})=>assertFixture(page));
for(const width of [1440,390])test(`reading priorities and same-viewport prototype ${width}`,async({page})=>{
 const s=readingFixture(),before=JSON.stringify(s.workspace.rounds);await install(page,s);await page.setViewportSize({width,height:1000});await page.goto(route());
 await expect(page.locator('.integrity-reading-counts strong')).toHaveText(['2','4','1','3','2']);await expect(page.locator('.integrity-reading')).toContainText('不等于确认风险');
 const evidence=process.env.BB_UX_965_EVIDENCE;if(evidence){await mkdir(evidence,{recursive:true});await page.locator('.integrity-reading').evaluate(e=>window.scrollTo({top:e.getBoundingClientRect().top+scrollY-90,behavior:'instant'}));await page.screenshot({path:join(evidence,`implementation-${width}.png`)});}
 await page.locator('[data-reading-filter="results"]').click();await expect(page.locator('#integrity-filter')).toHaveValue('results');await expect(page.locator('[data-evidence]')).toHaveCount(2);await expect(page.locator('[data-evidence]:visible')).toHaveCount(2);
 await page.locator('#integrity-next-found').click();await expect(modal(page)).toContainText('合成公开事项A');await expect(modal(page)).toContainText('主体未确认');await expect(modal(page)).toContainText('仅用于界面测试的公开记录摘要。');await expect(modal(page)).toContainText('查询时间');await expect(modal(page).locator('#integrity-evidence-form')).toHaveCount(0);
 const reading=await page.evaluate(()=>({y:scrollY,run:new URLSearchParams(location.hash.split('?')[1]).get('run')}));await modal(page).getByRole('button',{name:'关闭',exact:true}).click();await expect(page.locator('#integrity-next-found')).toBeFocused();expect(await page.evaluate(()=>scrollY)).toBe(reading.y);expect(reading.run).toBe(exportId);
 await page.locator('#integrity-next-found').click();await expect(modal(page)).toContainText('合成一般公告B');await expect(modal(page)).toContainText('一般信息 · 企业全称匹配');await modal(page).getByRole('button',{name:'关闭',exact:true}).click();
 await page.reload();await expect(page.locator('#integrity-filter')).toHaveValue('results');await expect(page.locator('[data-reading-current="true"]')).toContainText('合成子公司有限公司');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(writes(s)).toEqual([]);expect(JSON.stringify(s.workspace.rounds)).toBe(before);
 if(evidence){await page.goto('/@fs/'+resolve('../../product-prototype/public/integrity-reading-priority.html'));await page.locator('.integrity-reading').evaluate(e=>window.scrollTo({top:e.getBoundingClientRect().top+scrollY-90,behavior:'instant'}));await page.screenshot({path:join(evidence,`prototype-${width}.png`)});}
});
test('incomplete, unexecuted and no-result filters keep distinct original pairs',async({page})=>{const s=readingFixture();await install(page,s);await page.goto(route());for(const [group,count] of [['incomplete',4],['unqueried',1],['no_results',3],['not_applicable',2]] as const){await page.locator('#integrity-filter').selectOption(group);await expect(page.locator('[data-evidence]')).toHaveCount(count);}await page.locator('#integrity-filter').selectOption('unqueried');await expect(page.locator('#integrity-records')).toContainText('未执行');expect(writes(s)).toEqual([]);});
test('reading an export snapshot never borrows a later original observation',async({page})=>{const s=readingFixture(),original=s.workspace.rounds.find(r=>r.run_id===checkId)!;original.records=original.records.map(r=>({...r,status:'no_public_results',findings:[],reason:'后来状态',sources:[]}));await install(page,s);await page.goto(route());await expect(page.locator('[data-reading-filter=results] strong')).toHaveText('2');await page.locator('#integrity-next-found').click();await expect(modal(page)).toContainText('合成公开事项A');expect(writes(s)).toEqual([]);});
test('unknown URL reading pair cannot select another round or invent a record',async({page})=>{const s=readingFixture();await install(page,s);await page.goto(route()+'&read_filter=bogus&read_subject=foreign&read_site=foreign');await expect(page.locator('#integrity-filter')).toHaveValue('all');await expect(page.locator('[data-reading-current=true]')).toHaveCount(0);await expect(page.locator('[data-evidence]')).toHaveCount(12);expect(writes(s)).toEqual([]);});
test('invalid observation mapping displays an unavailable summary instead of zero risk',async({page})=>{const s=readingFixture(),copy=s.workspace.rounds.find(r=>r.run_id===exportId)!;copy.manifest.records.push(structuredClone(copy.manifest.records[0]));copy.records=structuredClone(copy.manifest.records);await install(page,s);await page.goto(route());await expect(page.locator('.integrity-reading')).toContainText('暂不统计为零项或无异常');await expect(page.locator('[data-reading-filter]')).toHaveCount(0);expect(writes(s)).toEqual([]);});
