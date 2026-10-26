import {test,expect,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {INTEGRITY_PRICE,type IntegrityWorkspace} from '@bondbuddy/contracts';
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex'),time='2026-10-23T00:00:00Z';
async function fixture(page:Page){
 const evidence=await page.context().newPage();await evidence.setContent('<h1>合成官网查询结果</h1><p>合成企业 共 0 条相关结果</p>');const png=await evidence.screenshot();await evidence.close();
 const subject={id:'company',kind:'company' as const,name:'合成企业',identifier:'',role:'发行人',province:'河北',city:'沧州'};
 const draft={subjects:[subject],site_ids:['tax','csrc'],notes:''};
 const state:IntegrityWorkspace={draft,revision:1,price:INTEGRITY_PRICE,rounds:[{run_id:'round',round_id:'round',operation:'check',sequence:1,state:'succeeded',stage:null,created_at:time,
  manifest:{version:'integrity-round-v1',collector:'official-browser-v1',operation:'check',round_id:'round',project_name:'合成核查项目',draft,price_version:INTEGRITY_PRICE.version,points:5000,records:[],evidence_ids:[]},
  records:[{subject_id:'company',site_id:'tax',site_name:'国家税务总局',urls:['https://www.chinatax.gov.cn/'],query:'合成企业',status:'no_public_results',reason:'本次官网站内查询未检索到相关结果；不代表无风险。',checked_at:time,sources:[],search_performed:true,
   browser:{version:'official-browser-v1',outcome:'no_results',scope:'官网站内查询：合成企业',limitation:'仅覆盖本次所列查询范围，不等同于专项数据库核查。',captures:[{id:'capture',kind:'result',url:'https://www.chinatax.gov.cn/',title:'合成查询页面',captured_at:time,page:1,screenshot_sha256:hash(png),text_sha256:hash('synthetic'),byte_size:png.length}]}},
   {subject_id:'company',site_id:'csrc',site_name:'证券期货市场失信记录查询平台',urls:['https://neris.csrc.gov.cn/shixinchaxun/'],query:'合成企业',status:'needs_manual',reason:'官网要求验证码，自动查询已停止，其他网站继续。',checked_at:time,sources:[],search_performed:true,browser:{version:'official-browser-v1',outcome:'blocked',scope:'证券期货市场失信查询',limitation:'未获得数据库查询结果。',captures:[]}}],evidence:[],artifact_id:null,artifacts:[],charged_points:5000,reserved_points:0}]};
 let corrupt=false,exported=0;
 await page.route('**/api/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname,reply=(v:unknown)=>route.fulfill({json:v});
  if(path==='/api/v1/me')return reply({user_id:'synthetic-owner',username:'synthetic'});
  if(path==='/api/v1/credits/balance')return reply({enabled:true,available:10000,frozen:0});
  if(path==='/api/v1/projects/project')return reply({project_id:'project',name:'合成核查项目',issuer_name:'合成企业',kind:'generation',market:'sse',offering:'private',draft_revision:1,input_revision:null,input_hash:null,updated_at:time});
  if(path.endsWith('/captures/capture'))return route.fulfill({contentType:'image/png',body:corrupt?Buffer.from('corrupt'):png});
  if(path.endsWith('/exports')){expect(route.request().postDataJSON().expected_evidence_ids).toEqual([]);exported++;return reply({run_id:'round'});}
  if(path.endsWith('/integrity/draft')){state.draft=route.request().postDataJSON().draft;state.revision++;return reply(state);}
  if(path.endsWith('/integrity'))return reply(state);
  return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
 });
 return {state,corrupt:()=>{corrupt=true;},exports:()=>exported};
}
for(const width of [1440,390,1265])test(`integrity official evidence preserves compact result flow at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:width===1265?712:960});const f=await fixture(page);
 await page.goto('/#integrity?project=project&run=round');
 await expect(page.getByText('本次未检索到',{exact:true})).toBeVisible();await expect(page.getByText('需要验证码 / 登录',{exact:true})).toBeVisible();
 await expect(page.getByText('1 张官网截图')).toBeVisible();
 const out=resolve('../../docs/acceptance/integrity-readiness-20261026');await mkdir(out,{recursive:true});
 await page.screenshot({path:resolve(out,`results-${width}.png`),fullPage:true});
 await page.getByRole('button',{name:'查看查询记录'}).first().click();await expect(page.getByRole('heading',{name:'官网自动取证'})).toBeVisible();
 await expect(page.locator('dialog input[type=file]')).toHaveCount(0);await expect(page.getByRole('heading',{name:'人工补充证据'})).toHaveCount(0);
 await page.getByRole('button',{name:'查看官网截图'}).click();await expect(page.locator('.integrity-browser-evidence img')).toBeVisible();
 expect(await page.locator('.integrity-browser-evidence img').evaluate((e:HTMLImageElement)=>e.naturalWidth)).toBeGreaterThan(0);
 await expect(page.getByRole('link',{name:'下载原始截图'})).toBeVisible();
 await page.screenshot({path:resolve(out,`evidence-${width}.png`)});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.locator('dialog').press('Escape');
 await page.getByRole('button',{name:'重新导出底稿 · 免费'}).click();await expect.poll(f.exports).toBe(1);
 f.corrupt();await page.getByRole('button',{name:'查看查询记录'}).first().click();await page.getByRole('button',{name:'查看官网截图'}).click();await expect(page.getByText('截图读取失败，请重试。')).toBeVisible();await expect(page.locator('.integrity-browser-evidence img')).toHaveCount(0);
 await page.locator('dialog').press('Escape');await page.goto('/#integrity?project=project');
 await page.getByRole('button',{name:'＋ 添加人员',exact:true}).click();await expect(page.locator('dialog[open]')).toHaveCount(0);await expect(page.locator('#integrity-roster input[data-field="name"]')).toHaveCount(2);
 await page.screenshot({path:resolve(out,`roster-${width}.png`),fullPage:width!==1265});
});

test('company region is inferred from a clear province prefix and existing values are retained',async({page})=>{
 const f=await fixture(page);f.state.draft.subjects[0].name='河南合成企业';f.state.draft.subjects[0].province='';f.state.draft.subjects[0].city='';
 await page.goto('/#integrity?project=project');
 const province=page.locator('select[data-field=province]');await expect(province).toHaveValue('河南');
 await province.selectOption('河北');await page.getByRole('button',{name:'保存名单与范围'}).click();
 await page.reload();await expect(province).toHaveValue('河北');
 await page.getByRole('button',{name:'＋ 添加企业',exact:true}).click();
 await page.getByRole('textbox',{name:'对象 2 名称',exact:true}).fill('河南新增测试企业');
 await page.getByRole('textbox',{name:'对象 2 关系',exact:true}).focus();
 await expect(page.locator('select[data-field=province]').nth(1)).toHaveValue('河南');
});

test('historical access restrictions are not relabeled as captcha and require no upload',async({page})=>{
 const f=await fixture(page);f.state.rounds[0].records[1].reason='官网访问已被拦截。';
 await page.goto('/#integrity?project=project&run=round');
 await expect(page.getByText('需要验证码 / 登录',{exact:true})).toHaveCount(0);
 await expect(page.getByText('查询未完成',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'查看查询记录'}).nth(1).click();
 await expect(page.locator('dialog input[type=file]')).toHaveCount(0);
 await expect(page.getByText('本项未取得可用截图，无需上传补充证据。')).toBeVisible();
});
