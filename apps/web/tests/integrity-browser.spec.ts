import {fixtureBody} from './billing-fixture-wire';
import {test,expect,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {INTEGRITY_PRICE,type IntegrityWorkspace,type IntegrityDiagnostic,type IntegrityFinding} from '@bondbuddy/contracts';
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
  const path=new URL(route.request().url()).pathname,reply=(v:unknown)=>route.fulfill({json:fixtureBody(route,v)});
  if(path==='/api/v1/me')return reply({user_id:'synthetic-owner',session_status:'active'});
  if(path==='/api/v1/account')return reply({user_id:'synthetic-owner',username:'synthetic',phone_masked:null,status:'active',created_at:time,accepted_terms_version:null,current_terms_version:null,password_updated_at:null,self_service_recovery:'unavailable',support_contact:null});
  if(path==='/api/v1/credits/balance')return reply({enabled:true,available:10000,frozen:0});
  if(path==='/api/v1/projects/project')return reply({project_id:'project',name:'合成核查项目',issuer_name:'合成企业',kind:'generation',market:'sse',offering:'private',draft_revision:1,input_revision:null,input_hash:null,updated_at:time});
  if(path==='/api/v1/projects/project/files')return reply({project_id:'project',items:[]});
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
 await expect(page.getByText('搜索无返回结果',{exact:true})).toBeVisible();await expect(page.getByText('需要验证码',{exact:true})).toBeVisible();
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
 await page.getByRole('button',{name:'重新导出底稿 · 免费'}).click();await expect(page.locator('#integrity-export-free-confirm')).toBeVisible();expect(f.exports()).toBe(0);await page.locator('#integrity-export-free-confirm').click();await expect.poll(f.exports).toBe(1);
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
 const f=await fixture(page);f.state.rounds[0].records[1].reason='官网返回 HTTP 403 Forbidden，页面显示 GeoBL，访问已被拦截。';
 await page.goto('/#integrity?project=project&run=round');
 await expect(page.getByText('需要验证码',{exact:true})).toHaveCount(0);
 await expect(page.getByText('网站拒绝访问',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'查看查询记录'}).nth(1).click();
 await expect(page.locator('dialog input[type=file]')).toHaveCount(0);
 await expect(page.getByText('本项未取得可用截图，无需上传补充证据。')).toBeVisible();
 await expect(page.locator('dialog')).not.toContainText(/HTTP|403|Forbidden|GeoBL/);
});

test('export query details read the immutable original record snapshot',async({page})=>{
 const f=await fixture(page),original=f.state.rounds[0];
 const exported={...structuredClone(original),run_id:'export',operation:'export' as const,sequence:2,charged_points:0,records:[],manifest:{...structuredClone(original.manifest),operation:'export' as const,records:structuredClone(original.records),points:0}};
 f.state.rounds.push(exported);
 await page.goto('/#integrity?project=project&run=export');
 await page.getByRole('button',{name:'查看查询记录'}).first().click();
 await expect(page.locator('dialog')).toContainText('实际查询：合成企业');
 await page.getByRole('button',{name:'查看官网截图'}).click();await expect(page.locator('.integrity-browser-evidence img')).toBeVisible();
 await expect(page.locator('dialog input[type=file]')).toHaveCount(0);
});

test('a retained pre-upgrade evidence draft remains recoverable without reopening new upload entry points',async({page})=>{
 const f=await fixture(page),value={revision:1,draft:f.state.draft,evidenceDraft:{roundId:'round',subjectId:'company',siteId:'tax',url:'https://www.chinatax.gov.cn/',time:'',note:'旧版未保存的实际查询说明',conclusion:'unresolved'}};
 await page.addInitScript(value=>localStorage.setItem('bb-integrity-recovery:synthetic-owner:project',JSON.stringify({version:'integrity-recovery-cache-v1',owner:'synthetic-owner',project:'project',value})),value);
 await page.goto('/#integrity?project=project&run=round');
 await page.getByRole('button',{name:'查看查询记录'}).first().click();await expect(page.locator('dialog input[type=file]')).toHaveCount(0);await page.locator('dialog').press('Escape');
 await page.getByRole('button',{name:'继续未保存的补证'}).click();
 await expect(page.locator('#integrity-evidence-form [name=note]')).toHaveValue(value.evidenceDraft.note);
 await expect(page.locator('#integrity-evidence-form [name=time]')).toHaveValue('');
});

test('precise result states and adverse facts are visible without an evidence upload flow',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});const f=await fixture(page),round=f.state.rounds[0],base=round.records[0];
 const diagnostics:[string,IntegrityDiagnostic['code'],string][]=[['credit-china','blank_page_timeout','页面空白（加载超时）'],['execution-debtor','access_denied','网站拒绝访问'],['execution-dishonest','result_load_timeout','查询结果加载超时'],['gsxt','login_required','需要登录']];
 const finding:IntegrityFinding={capture_id:'capture',quote:'合成企业 因未按规定披露信息，于2026年10月1日被测试机关罚款10万元，决定书合成〔2026〕1号。',title:'行政处罚：未按规定披露信息',explanation:'记录显示罚款10万元，决定书合成〔2026〕1号；原文未载明整改情况。',nature:'adverse',subject_match:'company_name'};
 round.records.push(...diagnostics.map(([site_id,code])=>({...base,site_id,status:'query_failed' as const,reason:code==='access_denied'?'官网返回 HTTP 403 Forbidden，页面显示 GeoBL。':'已尝试等待和重试，未取得查询结果。',browser:{...base.browser!,outcome:'failed' as const,captures:[],diagnostic:{code,phase:'results' as const,attempts:2,elapsed_ms:180000,...(code==='access_denied'?{http_status:403,detail:'HTTP 403 Forbidden GeoBL'}:{})}}})),
 {...base,site_id:'sse',status:'public_matches',reason:'官网返回具体记录，企业全称匹配。',browser:{...base.browser!,outcome:'results'},findings:[finding],sources:[{url:'https://www.chinatax.gov.cn/',title:'合成行政处罚决定',quote:finding.quote,retrieved_at:time,tool_call_id:'capture',sha256:hash(finding.quote)}]},
 {...base,site_id:'szse',status:'public_matches',browser:{...base.browser!,outcome:'results'},findings:[{...finding,subject_match:'unconfirmed'}]},
 {...base,site_id:'nafmii-discipline',status:'public_matches',browser:{...base.browser!,outcome:'results'},findings:[{...finding,nature:'information',title:'一般公告：申报进展',explanation:'官网公告披露申报进展。'}]});
 const denied=round.records.find(r=>r.site_id==='execution-debtor')!;denied.browser!.captures=[{...base.browser!.captures[0],kind:'blocker',title:'HTTP 403 Forbidden GeoBL'}];round.records.find(r=>r.site_id==='sse')!.browser!.limitation='后续页面采集未完成（net::ERR_CONNECTION_RESET），已取得的查询结果仍保留。';
 round.manifest.draft.site_ids=round.records.map(r=>r.site_id);
 await page.goto('/#integrity?project=project&run=round');
 for(const label of ['搜索无返回结果',...diagnostics.map(d=>d[2]),'发现不利记录（企业全称匹配）','发现不利线索（主体未确认）','搜索返回一般信息'])await expect(page.getByText(label,{exact:true})).toBeVisible();
 await expect(page.locator('.integrity-status-danger')).toHaveCount(1);
 await expect(page.locator('#integrity-records')).not.toContainText(/待人工补证|HTTP|403|Forbidden|GeoBL|net::|ERR_/);
 const out=resolve('../../docs/acceptance/integrity-readiness-20261026');await page.screenshot({path:resolve(out,'precise-statuses-1440.png'),fullPage:true});
 await page.locator('tr').filter({has:page.getByText('网站拒绝访问',{exact:true})}).getByRole('button',{name:'查看查询记录'}).click();
 await expect(page.locator('dialog')).toContainText('网站拒绝了本次访问');await expect(page.locator('dialog')).not.toContainText(/HTTP|403|Forbidden|GeoBL|net::|ERR_/);
 await page.screenshot({path:resolve(out,'access-denied-1440.png')});await page.locator('dialog').press('Escape');
 await page.locator('tr').filter({has:page.getByText('发现不利记录（企业全称匹配）',{exact:true})}).getByRole('button',{name:'查看查询记录'}).click();
 await expect(page.locator('dialog')).toContainText('罚款10万元');await expect(page.locator('dialog')).toContainText('合成〔2026〕1号');await expect(page.locator('dialog')).not.toContainText(/HTTP|403|Forbidden|GeoBL|net::|ERR_/);
 await expect(page.getByRole('link',{name:'合成行政处罚决定 ↗'})).toBeVisible();
 await expect(page.locator('dialog input[type=file]')).toHaveCount(0);
 await page.screenshot({path:resolve(out,'adverse-record-1440.png')});
});

for(const width of [1440,390])test(`captcha image failures remain specific in the result and detail at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:960});
 const f=await fixture(page),round=f.state.rounds[0],record=round.records[1];
 record.site_id='credit-china';record.site_name='信用中国';record.urls=['https://www.creditchina.gov.cn/'];record.status='query_failed';
 record.browser!.scope='信用中国官网查询：合成企业';
 round.manifest.draft.site_ids=['tax','credit-china'];
 for(const [detail,label] of Object.entries({CAPTCHA_IMAGE_LOAD_FAILED:'验证码图片加载失败',CAPTCHA_IMAGE_LOAD_TIMEOUT:'验证码图片加载超时',CAPTCHA_IMAGE_ACCESS_DENIED:'网站拒绝访问',CAPTCHA_IMAGE_RATE_LIMITED:'网站限制访问频率',CAPTCHA_IMAGE_REFRESH_FAILED:'验证码刷新未完成'})){
  record.reason='HTTP 503 CAPTCHA_IMAGE_LOAD_FAILED';
  record.browser!.diagnostic={code:'captcha_required',phase:'results',detail,http_status:503,attempts:2,elapsed_ms:30000};
  await page.goto('/#integrity?project=project&run=round');await page.reload();
  await expect(page.getByText(label,{exact:true})).toBeVisible();
  await expect(page.locator('#integrity-records')).not.toContainText(/HTTP|503|CAPTCHA_|已尝试自动验证/);
  await page.getByRole('button',{name:'查看查询记录'}).nth(1).click();
  await expect(page.locator('dialog')).toContainText(label);await expect(page.locator('dialog')).toContainText('本次查询未完成');
  await expect(page.locator('dialog input[type=file]')).toHaveCount(0);
  await expect(page.locator('dialog')).not.toContainText(/HTTP|503|CAPTCHA_|已尝试自动验证/);
  if(detail==='CAPTCHA_IMAGE_LOAD_FAILED'&&process.env.BB_CAPTCHA_SCREENSHOT_DIR){
   await mkdir(process.env.BB_CAPTCHA_SCREENSHOT_DIR,{recursive:true});
   await page.screenshot({path:resolve(process.env.BB_CAPTCHA_SCREENSHOT_DIR,`image-failure-${width}.png`),fullPage:false});
  }
  await page.locator('dialog').press('Escape');
 }
});

test('connection errors distinguish certificates and required styles without changing saved observations',async({page})=>{
 await page.setViewportSize({width:1440,height:960});
 const reference=process.env.BB_INTEGRITY_PRESENTATION_REFERENCE;let referenceLoads=0;
 if(reference)await page.route('**/integrity-presentation.js*',async route=>{referenceLoads++;return route.fulfill({contentType:'text/javascript',body:await readFile(reference,'utf8')});});
 const f=await fixture(page),round=f.state.rounds[0],base=round.records[0];
 const samples:[string,string,IntegrityDiagnostic][]=[
  ['industry-credit','全国行业信用公共服务平台',{code:'network_error',phase:'open',detail:'net::ERR_CERT_DATE_INVALID',attempts:1,elapsed_ms:2200}],
  ['pbc','中国人民银行',{code:'network_error',phase:'results',detail:'OFFICIAL_STYLESHEET_LOAD_FAILED net::ERR_ABORTED https://example.test/a.css',attempts:2,elapsed_ms:6000}],
  ['execution-debtor','中国执行信息网-被执行人信息',{code:'http_error',phase:'open',http_status:400,attempts:1,elapsed_ms:1500}],
 ];
 round.records.push(...samples.map(([site_id,site_name,diagnostic])=>({...base,site_id,site_name,status:'query_failed' as const,reason:'未取得可确认的查询结果。',search_performed:diagnostic.phase==='results',browser:{...base.browser!,outcome:'failed' as const,captures:[],diagnostic}})));
 round.manifest.draft.site_ids=round.records.map(r=>r.site_id);const before=JSON.stringify(f.state);
 await page.goto('/#integrity?project=project&run=round');
 if(reference){await expect(page.getByText('网络连接失败',{exact:true})).toHaveCount(2);expect(referenceLoads).toBeGreaterThan(0);}
 else {await expect(page.getByText('网站证书有效期异常',{exact:true})).toBeVisible();await expect(page.getByText('查询页面样式加载失败',{exact:true})).toBeVisible();}
 await expect(page.getByText('网站响应错误',{exact:true})).toBeVisible();await expect(page.getByText('搜索无返回结果',{exact:true})).toBeVisible();
 await expect(page.locator('#integrity-records')).not.toContainText(/net::|ERR_|OFFICIAL_|example\.test/);
 const out=resolve('../../docs/acceptance/integrity-connections-20261027');await mkdir(out,{recursive:true});
 await page.screenshot({path:resolve(out,reference?'before-1440.png':'after-1440.png'),fullPage:true});
 if(!reference){
  await page.locator('tr').filter({has:page.getByText('网站证书有效期异常',{exact:true})}).getByRole('button',{name:'查看查询记录'}).click();
  await expect(page.locator('dialog')).toContainText('网站安全证书已过期或尚未生效');
  await expect(page.locator('dialog')).not.toContainText(/net::|ERR_|OFFICIAL_|example\.test/);
  await expect(page.locator('dialog input[type=file]')).toHaveCount(0);
  await page.screenshot({path:resolve(out,'certificate-detail-1440.png')});
 }
 expect(JSON.stringify(f.state)).toBe(before);
});
