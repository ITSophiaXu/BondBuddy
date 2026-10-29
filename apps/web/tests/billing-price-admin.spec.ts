import {mkdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {expect,test,type Page,type Route} from '@playwright/test';
import {AUTOMATIC_TASK_TARIFF,AUTOMATIC_TASK_SKUS,AUTOMATIC_PRICE_VERSION,standardCostBaseFen,standardCostPoints,type BillingCostVersion,type BillingPriceVersion,type BillingPermission} from '@bondbuddy/contracts';

// All costs and operator actions in this suite are synthetic. No production tariff is published.
const now='2026-10-29T04:00:00Z',hash='a'.repeat(64),owner='synthetic-price-operator';
const seed:BillingCostVersion={id:'synthetic-complete-cost',checksum:hash,complete:true,created_at:now,created_by:owner,change_reason:'Synthetic fixture',
  rows:AUTOMATIC_TASK_SKUS.map(sku=>({sku,planned_cost_cny:'1.000000000001',base_price_fen:standardCostBaseFen('1.000000000001'),source:'Synthetic test only'}))};
function draft(id='synthetic-price-draft'):BillingPriceVersion{return{id,base_cost_version:seed.id,base_cost_checksum:hash,multiplier_bps:'17000',comparison_version:AUTOMATIC_PRICE_VERSION,change_reason:'合成价格联调',state:'DRAFT',checksum:hash,validated_checksum:null,validation_checks:[],effective_at:null,created_at:now,created_by:owner,published_at:null,published_by:null,rollback_of:null,
  rows:seed.rows.map(c=>{const old=AUTOMATIC_TASK_TARIFF[c.sku],points=standardCostPoints(c.base_price_fen,'17000');return{sku:c.sku,planned_cost_cny:c.planned_cost_cny,base_price_fen:c.base_price_fen,label:old.label,unit:old.unit,previous_points:String(old.points),points,delta_points:(BigInt(points)-BigInt(old.points)).toString()};})};}
const json=(route:Route,status:number,value:unknown)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
async function setup(page:Page,options:{permissions?:BillingPermission[];legacy?:boolean;uncertainCreate?:boolean;rejectCreate?:boolean}={}){
  const calls:{path:string;body:any}[]=[],costs=[structuredClone(seed)],versions=[draft()];let first=true;
  if(options.legacy){costs[0].complete=false;costs[0].rows[0].planned_cost_cny=null;versions[0].rows[0].planned_cost_cny=null;}
  await page.clock.install({time:new Date(now)});
  await page.route('**/api/v1/**',async r=>{
    const req=r.request(),path=new URL(req.url()).pathname.replace('/api/v1',''),method=req.method(),body=req.postData()?req.postDataJSON():undefined;
    if(method==='POST')calls.push({path,body});
    if(path==='/me')return json(r,200,{user_id:owner,session_status:'active'});
    if(path==='/billing/permissions')return json(r,200,{permissions:options.permissions??['price_draft','price_publish']});
    if(path==='/admin/cost-versions'&&method==='GET')return json(r,200,{items:costs});
    if(path==='/admin/price-versions'&&method==='GET')return json(r,200,{current_version:AUTOMATIC_PRICE_VERSION,items:versions});
    if(path==='/admin/cost-versions'&&method==='POST')return json(r,201,{cost_version:{...seed,id:'synthetic-created-cost'}});
    if(path==='/admin/price-versions'&&method==='POST'){
      if(options.rejectCreate)return json(r,422,{code:'VALIDATION_FAILED',message:'Synthetic definitive rejection'});
      if(first){versions.unshift({...draft('synthetic-created-draft'),change_reason:body.change_reason,multiplier_bps:body.multiplier_bps});first=false;
        if(options.uncertainCreate)return json(r,503,{code:'DATA_UNAVAILABLE'});}
      return json(r,201,{version:versions[0]});
    }
    const match=path.match(/^\/admin\/price-versions\/([^/]+)\/(validate|publish)$/);
    if(match){const version=versions.find(v=>v.id===match[1])!;
      if(match[2]==='validate'){version.validation_checks=[{code:'complete_cost_source',passed:!options.legacy,message:options.legacy?'原始成本来源未补齐，不能发布':'全部来源与算术校验通过'}];version.validated_checksum=options.legacy?null:hash;}
      else{version.state='PUBLISHED';version.published_at=now;version.published_by=owner;version.effective_at=body.effective_at;}
      return json(r,200,{version});
    }
    return json(r,404,{code:'NOT_FOUND'});
  });
  return{calls,versions};
}
async function screenshot(page:Page,name:string){if(process.env.BB_UX_EVIDENCE_DIR){await mkdir(process.env.BB_UX_EVIDENCE_DIR,{recursive:true});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:join(process.env.BB_UX_EVIDENCE_DIR,name),fullPage:true});}}

test('explicit permission denial hides all price mutations',async({page})=>{
  const {calls}=await setup(page,{permissions:[]});await page.goto('/#/billing/prices');
  await expect(page.getByText('当前账号没有价格管理权限。')).toBeVisible();await expect(page.locator('#price-draft')).toHaveCount(0);expect(calls).toEqual([]);
});
test('complete twelve-row comparison publishes the reviewed checksum at a future time',async({page})=>{
  const {calls}=await setup(page);await page.setViewportSize({width:1440,height:960});await page.goto('/#/billing/prices');
  await expect(page.locator('.billing-price-table tbody tr')).toHaveCount(12);await expect(page.locator('#price-publish')).toBeDisabled();
  await page.locator('#price-validate').click();await expect(page.locator('.price-admin-checks')).toContainText('全部来源与算术校验通过');
  await screenshot(page,'price-admin-1440.png');await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await screenshot(page,'price-admin-390.png');
  await page.locator('#price-effective').fill('2026-10-30T14:00');await page.locator('#price-publish').click();
  await expect(page.getByText('该价格已发布，将在指定时间用于新任务。')).toBeVisible();
  const published=calls.find(c=>c.path.endsWith('/publish'))!;expect(published.body.expected_checksum).toBe(hash);expect(Date.parse(published.body.effective_at)).toBeGreaterThan(Date.parse(now));
  await expect(page.locator('#price-publish')).toHaveCount(0);await expect(page.locator('#price-rollback')).toBeVisible();
});
test('incomplete original cost evidence fails validation and cannot publish',async({page})=>{
  const {calls}=await setup(page,{legacy:true});await page.goto('/#/billing/prices');await page.locator('#price-validate').click();
  await expect(page.locator('.price-admin-checks')).toContainText('原始成本来源未补齐');await expect(page.locator('#price-publish')).toBeDisabled();expect(calls.some(c=>c.path.endsWith('/publish'))).toBe(false);
});
test('draft-only authority freezes complete costs but never sees a publish control',async({page})=>{
  const {calls}=await setup(page,{permissions:['price_draft']});await page.goto('/#/billing/prices');
  await page.getByText('录入并冻结完整标准成本',{exact:true}).click();
  await page.locator('#cost-json').fill(JSON.stringify({rows:seed.rows.map(({sku,planned_cost_cny,source})=>({sku,planned_cost_cny,source})),change_reason:'合成成本更新'}));
  await page.locator('#cost-freeze').click();await expect(page.getByText('版本已保存，原始内容与来源保持冻结。')).toBeVisible();
  expect(calls[0].body.request_id).toMatch(/^[a-f0-9-]{36}$/);expect(calls[0].body.rows[0].planned_cost_cny).toBe('1.000000000001');await expect(page.locator('#price-publish')).toHaveCount(0);
});
test('unknown creation survives reload and replays the original key and unchanged content',async({page})=>{
  const {calls}=await setup(page,{uncertainCreate:true});await page.goto('/#/billing/prices');
  await page.locator('#price-reason').fill('合成未知状态，必须重试原请求');await page.locator('#price-multiplier').fill('1.7001');await page.locator('#price-draft').click();
  await expect(page.locator('#price-retry')).toBeVisible();expect(calls[0].body.multiplier_bps).toBe('17001');await page.reload();await page.locator('#price-retry').click();
  await expect(page.locator('#price-retry')).toHaveCount(0);expect(calls).toHaveLength(2);expect(calls[1]).toEqual(calls[0]);
});
test('definitive rejected draft preserves editable form content',async({page})=>{
  await setup(page,{rejectCreate:true});await page.goto('/#/billing/prices');await page.locator('#price-reason').fill('保留这个原因');await page.locator('#price-multiplier').fill('1.75');await page.locator('#price-draft').click();
  await expect(page.getByText('服务端已拒绝此操作，输入保留，请修正后提交。')).toBeVisible();await expect(page.locator('#price-retry')).toHaveCount(0);await expect(page.locator('#price-reason')).toHaveValue('保留这个原因');await expect(page.locator('#price-multiplier')).toHaveValue('1.75');
});
test('read-only account design supplement matches the twelve-row management layout',async({page})=>{
  const directory=resolve('../../product-prototype/public');let mutations=0;
  await page.route('**/api/v1/**',r=>{mutations++;return r.abort();});
  await page.route('**/prototype-price-admin/**',async route=>{
    const filename=new URL(route.request().url()).pathname.split('/').at(-1)!;
    if(!['account-credits.html','commerce-account-prototype.js','subscription-account-prototype.js','billing-price-admin-prototype.js','billing-price-admin.css'].includes(filename))return route.abort();
    return route.fulfill({contentType:filename.endsWith('.html')?'text/html':filename.endsWith('.css')?'text/css':'text/javascript',body:await readFile(join(directory,filename),'utf8')});
  });
  await page.setViewportSize({width:1440,height:960});await page.goto('/prototype-price-admin/account-credits.html?billing_admin=prices');
  await expect(page.locator('.billing-price-table tbody tr')).toHaveCount(12);await screenshot(page,'price-admin-prototype-1440.png');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await screenshot(page,'price-admin-prototype-390.png');expect(mutations).toBe(0);
});
