import {test,expect,type Page} from '@playwright/test';
import {INTEGRITY_COMMERCIAL_RULE,INTEGRITY_SITES,commerceMetadata,integrityScopeMeasurement,type IntegrityRecord} from '@bondbuddy/contracts';
import {fixture,install,assertFixture,projectId,checkId,exportId,writes} from './integrity-continuation-fixtures';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';

// Real browser/component, synthetic HTTP/settlement. No website, model or ledger writes.
const sites=['pbc','nfra','csrc','sse','szse'];
function state(){
 const value=fixture(),round=value.workspace.rounds.find(r=>r.run_id===checkId)!;
 const draft={subjects:[{id:'issuer',kind:'company' as const,name:'合成发行人有限公司',identifier:'',role:'发行人',province:'',city:''}],site_ids:sites,notes:''};
 round.manifest={...round.manifest,...commerceMetadata(2425,2425,1,INTEGRITY_COMMERCIAL_RULE.version),draft,scope_measurement:integrityScopeMeasurement(draft),price_version:INTEGRITY_COMMERCIAL_RULE.version,points:2425,records:[]};
 round.records=sites.map((site,index):IntegrityRecord=>({subject_id:'issuer',site_id:site,site_name:INTEGRITY_SITES.find(s=>s.id===site)!.name,urls:[],query:'合成发行人有限公司',status:index<2?'no_public_results':'query_failed',reason:index<2?'官网查询明确零结果。':'官网访问受限，未获得有效查询结果。',checked_at:round.created_at,sources:[],search_performed:index<2}));
 round.evidence=[];round.artifacts=[];round.artifact_id=null;round.charged_points=2170;round.reserved_points=0;
 round.settlement={version:'integrity-settlement-v1',outcome:'delivered',quoted_points:2425,charged_points:2170,released_points:255,verified_query_pairs:sites.slice(0,2).map(site=>({subject_id:'issuer',site_id:site}))};
 return {value,round};
}
const url=(run=checkId)=>`/#integrity?project=${projectId}&run=${run}`;
async function open(page:Page,s=state()){await install(page,s.value);await page.goto(url());await expect(page.locator('#integrity-records')).toBeVisible();return s;}
const explanation=(page:Page)=>page.locator('[data-integrity-settlement]');
async function capture(page:Page,name:string){const directory=test.info().outputPath('comparison');await mkdir(directory,{recursive:true});await page.screenshot({path:join(directory,name+'.png'),fullPage:true});await writeFile(join(directory,name+'.json'),JSON.stringify({name,url:page.url(),width:await page.evaluate(()=>innerWidth),text:await page.locator('.integrity-panel').first().innerText(),layout:await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,offenders:[...document.querySelectorAll('body *')].map(e=>({tag:e.tagName,id:e.id,className:e.className,text:e.textContent?.slice(0,100),left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,width:e.getBoundingClientRect().width,overflow:getComputedStyle(e).overflowX})).filter(e=>e.width>0&&(e.left<0||e.right>innerWidth+1))}))},null,2));}
test.afterEach(async({page})=>assertFixture(page));

for(const width of [1440,390,320])test(`partial integrity settlement explains its exact original scope at ${width}px without writes`,async({page})=>{
 await page.setViewportSize({width,height:960});const s=await open(page),before=structuredClone(s.value.workspace);
 await expect(explanation(page).locator('[data-integrity-settlement-amounts]')).toHaveText('原预留 2,425 积分，实际扣除 2,170 积分，已释放 255 积分。');
 await expect(explanation(page).locator('[data-integrity-settlement-reason]')).toContainText('5 项可查询范围中，2 项完成查询并保留官网证据；其余 3 项未完成有效查询，不计费。');
 await expect(explanation(page)).toContainText('官网明确零结果也计为完成查询。');
 await explanation(page).locator('summary').click();await expect(page.locator('[data-integrity-billed-site]')).toHaveCount(2);
 for(const site of sites.slice(0,2))await expect(page.locator(`[data-integrity-billed-site="${site}"]`)).toHaveText('合成发行人有限公司 · '+INTEGRITY_SITES.find(s=>s.id===site)!.name);
 await expect(page.locator('[data-evidence]')).toHaveCount(5);await expect(page.locator('.integrity-panel').first()).not.toContainText('原核查轮次与收费快照不一致');await capture(page,`implementation-${width}`);await expect(explanation(page)).not.toContainText(/verified|v4|pair|measurement|bb-task/);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);

 await page.reload();await expect(explanation(page)).toContainText('已释放 255 积分');expect(s.value.workspace).toEqual(before);expect(writes(s.value)).toEqual([]);
});
test('all completed queries and a failed fully released round use their own actual settlement',async({page})=>{
 const s=state();s.round.charged_points=2425;s.round.settlement={...s.round.settlement!,charged_points:2425,released_points:0,verified_query_pairs:sites.map(site=>({subject_id:'issuer',site_id:site}))};await open(page,s);
 await expect(explanation(page)).toContainText('5 项完成查询并保留官网证据；已全部完成有效查询。');await expect(explanation(page)).toContainText('已释放 0 积分');
 s.round.state='failed';s.round.charged_points=0;s.round.settlement={...s.round.settlement!,outcome:'not_delivered',charged_points:0,released_points:2425,verified_query_pairs:[]};await page.reload();
 await expect(explanation(page)).toContainText('本轮未完成交付，未扣费，原预留已全部释放。');await expect(explanation(page)).toContainText('实际扣除 0 积分，已释放 2,425 积分');await expect(page.locator('.integrity-panel').first()).not.toContainText('预留费用会释放');await expect(page.locator('[data-integrity-settlement-scope]')).toHaveCount(0);expect(writes(s.value)).toEqual([]);
});
test('missing evidence stays unresolved, and running/legacy/free exports retain their prior fee descriptions',async({page})=>{
 const s=state();s.round.settlement=null;await open(page,s);await expect(page.locator('[data-integrity-settlement-unavailable]')).toContainText('本轮费用明细暂无法核对');await expect(explanation(page)).toHaveCount(0);
 s.round.state='running';s.round.reserved_points=2425;s.round.charged_points=0;await page.reload();await expect(page.locator('.integrity-panel').first()).toContainText('已预留 2,425 积分，交付后结算');await expect(page.locator('[data-integrity-settlement-unavailable]')).toHaveCount(0);
 Object.assign(s.round,structuredClone(fixture().workspace.rounds.find(r=>r.run_id===checkId)!));delete s.round.settlement;await page.reload();await expect(page.locator('.integrity-panel').first()).toContainText('本轮已结算 5,000 积分');await expect(explanation(page)).toHaveCount(0);
 await page.goto(url(exportId));await expect(page.locator('.integrity-panel').first()).toContainText('同轮重新导出 · 包含在原任务内');await expect(explanation(page)).toHaveCount(0);expect(writes(s.value)).toEqual([]);
});

for(const width of [1440,390,320])test(`unchanged result component baseline comparison at ${width}px`,async({page})=>{
 const root=resolve(process.cwd(),'../..'),directory=join(root,'apps/web/tests/reference/integrity-settlement'),source=await readFile(join(directory,'integrity-workspace.txt'),'utf8'),provenance=JSON.parse(await readFile(join(directory,'provenance.json'),'utf8'));
 expect(createHash('sha256').update(source).digest('hex')).toBe(provenance.sha256);let loads=0;
 const body=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/from ['"]@bondbuddy\/contracts['"]/g,`from "/@fs/${root.replaceAll('\\','/')}/packages/contracts/dist/index.js"`).replace(/from ['"]@sinclair\/typebox\/value['"]/g,'from "/node_modules/.vite/deps/@sinclair_typebox_value.js"').replace(/(['"])\.\/([^'"]+)\1/g,(_match,quote,name:string)=>quote+'/src/'+(name.endsWith('.css')||name.endsWith('.ts')?name:name.replace(/\.js$/,'')+'.ts')+quote);
 await page.route('**/src/integrity-workspace.ts*',route=>{loads++;return route.fulfill({contentType:'text/javascript',body});});
 await page.setViewportSize({width,height:960});const s=await open(page);await expect(page.locator('.integrity-panel').first()).toContainText('本轮已结算 2,170 积分');await expect(explanation(page)).toHaveCount(0);await capture(page,`baseline-${width}`);expect(loads).toBeGreaterThan(0);expect(writes(s.value)).toEqual([]);expect(await readFile(join(directory,'integrity-workspace.txt'),'utf8')).toBe(source);
});
