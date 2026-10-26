import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {INTEGRITY_SITES,inferIntegrityRegion} from '@bondbuddy/contracts';
import {collectInContext} from './integrity-browser.js';
import {integrityProxy} from './integrity-browser-network.js';
import {createServer,request,Agent} from 'node:http';

const subject={name:'河南合成测试企业',kind:'company' as const,province:'',city:''};
const site=INTEGRITY_SITES.find(s=>s.id==='credit-china')!;
const form='<input id="keyword" placeholder="企业名称"><a id="submit">查询</a><main>请输入名称</main>';
const submit=`document.querySelector('#submit').onclick=async()=>{const q=document.querySelector('input').value;await fetch('/query?q='+encodeURIComponent(q));document.querySelector('main').textContent='本次查询 '+q+' 共0条';};`;
const html=(body:string,script='')=>`<!doctype html><html><meta charset="utf-8"><title>synthetic official fixture</title><body>${body}<script>${script}</script></body></html>`;
const options={waitMs:2200,maxPages:1,attempts:1};

test('region inference reuses explicit registration and does not infer from personal names',()=>{
 assert.deepEqual(inferIntegrityRegion(subject),{province:'河南',city:''});
 assert.equal(inferIntegrityRegion({...subject,province:'河北省'}).province,'河北');
 assert.equal(inferIntegrityRegion({...subject,name:'无地区名称企业',city:'深圳市'}).province,'广东');
 assert.equal(inferIntegrityRegion({...subject,kind:'person',name:'河南生'}).province,'');
 assert.equal(inferIntegrityRegion({...subject,name:'无地区名称企业'}).province,'');
});

test('reused HTTP proxy sockets do not accumulate cleanup or timeout listeners',async()=>{
 const upstream=createServer((_req,res)=>res.end('ok')),agent=new Agent({keepAlive:true,maxSockets:1});
 await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
 const proxy=await integrityProxy(site,{upstreamUrl:`http://127.0.0.1:${(upstream.address() as {port:number}).port}`});
 const warnings:Error[]=[],onWarning=(e:Error)=>{if(e.name==='MaxListenersExceededWarning')warnings.push(e);};process.on('warning',onWarning);
 try{for(let i=0;i<24;i++)await new Promise<void>((resolve,reject)=>{const req=request(proxy.server,{agent,path:'http://www.creditchina.gov.cn/'},res=>{res.resume();res.on('end',resolve);});req.on('error',reject);req.end();});await new Promise(r=>setImmediate(r));assert.deepEqual(warnings,[]);}
 finally{process.off('warning',onWarning);agent.destroy();await proxy.close();await new Promise<void>(r=>upstream.close(()=>r()));}
});

test('page readiness, query conditions, retries and honest results in real Chromium',{skip:!process.env.BB_TEST_INTEGRITY_BROWSER,timeout:180000},async t=>{
 const browser=await chromium.launch({headless:true});
 async function run(body:(url:URL)=>string|Promise<string>,opts=options,selected=site){
  const context=await browser.newContext();
  await context.route('**/*',async route=>route.fulfill({contentType:'text/html; charset=utf-8',body:await body(new URL(route.request().url()))}));
  try{return await collectInContext(context,selected,subject,new AbortController().signal,opts);}finally{await context.close();}
 }
 try{
  await t.test('blank shell becomes a form after DOMContentLoaded',async()=>{
   const r=await run(url=>url.pathname==='/query'?'ok':html('',`setTimeout(()=>{document.body.innerHTML=${JSON.stringify(form)};${submit}},700)`));
   assert.equal(r.outcome,'no_results');assert.equal(r.diagnostic?.code,'no_results');assert.match(r.captures[0].text,/河南合成测试企业/);
  });
  await t.test('same-site visible iframe form and results',async()=>{
   const r=await run(url=>url.pathname==='/query'?'ok':url.pathname==='/frame'?html(form,submit):html('<iframe src="/frame" style="width:900px;height:500px"></iframe>'));
   assert.equal(r.outcome,'no_results');assert.match(r.captures[0].text,/共0条/);
  });
  await t.test('automatic interstitial navigation is allowed to finish after a non-200 initial response',async()=>{
   const context=await browser.newContext();
   await context.route('**/*',route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({status:path==='/'?412:200,contentType:'text/html; charset=utf-8',body:path==='/'?html('',"setTimeout(()=>location.href='/ready',700)"):path==='/query'?'ok':html(form,submit)});});
   try{const r=await collectInContext(context,site,subject,new AbortController().signal,options);assert.equal(r.outcome,'no_results');}finally{await context.close();}
  });
  await t.test('popup results with query in URL and no input',async()=>{
   const r=await run(url=>url.pathname==='/query'?html('共0条'):html(form,`document.querySelector('#submit').onclick=()=>window.open('/query?q='+encodeURIComponent(document.querySelector('input').value));`));
   assert.equal(r.outcome,'no_results');assert.match(r.captures[0].url,/query/);
  });
  await t.test('blank first visit is retried automatically without a blank capture',async()=>{
   let visits=0;const r=await run(url=>url.pathname==='/query'?'ok':++visits===1?html(''):html(form,submit),{...options,attempts:2});
   assert.equal(visits,2);assert.equal(r.outcome,'no_results');assert.equal(r.captures.length,1);assert.equal(r.captures[0].kind,'result');
  });
  await t.test('persistent blank remains incomplete and produces no screenshot',async()=>{
   const r=await run(()=>html(''));assert.equal(r.outcome,'unverified');assert.equal(r.diagnostic?.code,'blank_page_timeout');assert.equal(r.search_performed,false);assert.equal(r.captures.length,0);assert.match(r.reason,/无需.*证据/);
  });
  await t.test('loading-only page does not become an evidence screenshot',async()=>{
   const r=await run(()=>html('加载中…'));assert.equal(r.captures.length,0);assert.equal(r.outcome,'unverified');assert.equal(r.diagnostic?.code,'page_load_timeout');
  });
  await t.test('portal header and footer do not make a loading result into evidence',async()=>{
   const r=await run(url=>url.pathname==='/query'?'ok':html(form+'<footer>官网版权信息</footer>',submit.replace("document.querySelector('main').textContent=","document.querySelector('main').setAttribute('aria-busy','true');document.querySelector('main').textContent=")));
   assert.equal(r.diagnostic?.code,'result_load_timeout');assert.equal(r.captures.length,0);
  });
  await t.test('late search handler is retried only when no query request or navigation started',async()=>{
   let queries=0;
   const r=await run(url=>url.pathname==='/query'?(queries++,'ok'):html(form,`setTimeout(()=>{${submit}},900)`),{...options,waitMs:6000});
   assert.equal(r.outcome,'no_results');assert.equal(queries,1);assert.equal(r.search_performed,true);
  });
  await t.test('completed homepage data requests do not suppress an inert search retry',async()=>{
   let queries=0;
   const r=await run(url=>url.pathname==='/query'?(queries++,'ok'):url.pathname==='/feed'?'{}':html(form,`setTimeout(()=>fetch('/feed'),300);setTimeout(()=>{${submit}},900)`),{...options,waitMs:6500});
   assert.equal(r.outcome,'no_results');assert.equal(queries,1);
  });
  for(const mode of ['defer','async'])await t.test(`waits for ${mode} iframe search scripts before retrying an enabled field`,async()=>{
   const context=await browser.newContext();let queries=0;
   await context.route('**/*',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/deferred.js'){await new Promise(r=>setTimeout(r,2400));await route.fulfill({contentType:'application/javascript',body:submit});return;}
    if(path==='/query'){queries++;await route.fulfill({body:'ok'});return;}
    await route.fulfill({contentType:'text/html; charset=utf-8',body:path==='/frame'?html(form+`<script ${mode} src="/deferred.js"></script>`):html('<iframe src="/frame" style="width:900px;height:500px"></iframe>')});
   });
   try{const r=await collectInContext(context,site,subject,new AbortController().signal,{...options,waitMs:6000});assert.equal(r.outcome,'no_results');assert.equal(queries,1);}finally{await context.close();}
  });
  await t.test('MEM search wording and unlabelled query image submit the local search form',async()=>{
   const r=await run(url=>url.pathname==='/query'?'ok':html('<form onsubmit="return false"><input placeholder="请输入检索词" id="iptSword"><img id="query_btn" alt="" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2240%22 height=%2230%22/%3E"></form><main>请输入名称</main>',submit.replaceAll("'#submit'","'#query_btn'")));
   assert.equal(r.outcome,'no_results');assert.equal(r.search_performed,true);
  });
  await t.test('a slow request is never resubmitted while waiting for its response',async()=>{
   let queries=0;
   const r=await run(async url=>{if(url.pathname==='/query'){queries++;await new Promise(r=>setTimeout(r,2800));return 'ok';}return html(form,submit);},{...options,waitMs:6500});
   assert.equal(r.outcome,'no_results');assert.equal(queries,1);
  });
  for(const [label,control] of [['BSE','<button type="button" id="fullsearch"> </button>'],['SSE','<input type="button" class="search_btn js_searchBtn" id="submit">']] as const)await t.test(`${label} unlabelled search button submits once`,async()=>{
   let queries=0;const r=await run(url=>url.pathname==='/query'?(queries++,'ok'):html('<div><input placeholder="输入关键字">'+control+'</div><main>请输入名称</main>',submit.replaceAll("'#submit'",label==='BSE'?"'#fullsearch'":"'#submit'")));
   assert.equal(r.outcome,'no_results');assert.equal(queries,1);
  });
  await t.test('commerce credit selects company-name query type before submitting',async()=>{
   const r=await run(url=>url.pathname==='/query'?'ok':html('<form onsubmit="return false"><select><option>请选择</option><option>企业名称</option><option>证书编号或报告编号</option></select><input placeholder="请输入搜索内容"><button id="submit" onclick="searchForm()"> </button></form><main>请输入名称</main>',submit.replace('const q=',"if(document.querySelector('select').value!=='企业名称')return;const q=")),options,INTEGRITY_SITES.find(s=>s.id==='commerce-credit')!);
   assert.equal(r.outcome,'no_results');assert.equal(r.search_performed,true);
  });
  await t.test('MOA legacy qt field is recognized without a placeholder',async()=>{
   const r=await run(url=>url.pathname==='/query'?'ok':html('<form onsubmit="return false"><input name="qt" id="loginname" value="请输入关键字"><button id="submit">搜索</button></form><main>请输入名称</main>',submit));
   assert.equal(r.outcome,'no_results');
  });
  await t.test('an inert form does not claim that a search was submitted',async()=>{
   const r=await run(()=>html(form),{...options,waitMs:4000});
   assert.equal(r.search_performed,false);assert.equal(r.outcome,'unverified');assert.equal(r.diagnostic?.code,'operation_failed');
  });
  await t.test('a query cleared while the native screen is being captured cannot become valid evidence',async()=>{
   const context=await browser.newContext();await context.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:new URL(route.request().url()).pathname==='/query'?'ok':html(form,submit.replace("'本次查询 '+q+' 共0条'","'共0条'"))}));
   try{const r=await collectInContext(context,site,subject,new AbortController().signal,{...options,screenCapture:async page=>{await page.locator('input').fill('');return Buffer.from('synthetic capture');}});
    assert.notEqual(r.outcome,'no_results');assert.equal(r.captures.some(c=>c.kind==='result'),false);
   }finally{await context.close();}
  });
  for(const [label,text,expected]of [
   ['BSE zero','全部结果 ( 0 ) 您搜索的内容不存在','no_results'],
   ['BSE positive','全部结果 ( 12 )','results'],
   ['MEE positive','符合条件的有82条','results'],
   ['MEE zero','符合条件的有0条','no_results'],
   ['MOHURD multiple result pages','跳转到页共 3 页','results'],
   ['empty list with a default single page','暂无相关数据 共 1 页','no_results'],
   ['SAMR dated result entries',subject.name+'的最新相关信息 来源：国家市场监督管理总局 时间：2022-08-08','results'],
   ['AMAC zero','文章搜索结果(0) 没有数据...','no_results'],
   ['SAFE zero','共有 0 条结果 共约0条结果','no_results'],
   ['NFRA article count','共检索到 4 篇文章 当前第 1页','results'],
   ['PBC count with query only in input','124条结果 发布机构 河南省分行','results'],
   ['SZSE parenthesized count','全部搜索结果（169） 信息披露（164）','results'],
   ['positive results with an empty secondary category','文章搜索结果(3) 政策法规搜索结果(0)','results'],
  ] as const)await t.test(`observed official result wording: ${label}`,async()=>{
   const r=await run(url=>url.pathname==='/query'?'ok':html(form,submit.replace("'本次查询 '+q+' 共0条'",JSON.stringify(text))));
   assert.equal(r.outcome,expected);assert.equal(r.search_performed,true);assert.equal(r.captures[0].kind,'result');
  });
  for(const national of [true,false])await t.test(`court province selector ${national?'keeps nationwide coverage':'uses inferred Henan'}`,async()=>{
   const r=await run(url=>url.pathname==='/query'?'ok':html(form+`<select id="province"><option value="">请选择</option>${national?'<option value="0">全国</option>':''}<option value="41">河南省</option><option value="13">河北省</option></select>`,submit.replace("const q=",`if(document.querySelector('select').value!=='${national?'0':'41'}')return;const q=`)),options,INTEGRITY_SITES.find(s=>s.id==='execution-dishonest')!);
   assert.equal(r.outcome,'no_results');assert.match(r.scope,national?/全国/:/河南省/);
   if(!national)assert.match(r.limitation,/不覆盖其他地区/);
  });
  await t.test('a help article mentioning captcha is not a login gate',async()=>{
   const r=await run(url=>url.pathname==='/query'?'ok':html(form+'<footer>帮助：验证码常见问题 <a>登录</a></footer>',submit));assert.equal(r.outcome,'no_results');
  });
  await t.test('visible captcha is stopped without retries or invented missing information',async()=>{
   let visits=0;const r=await run(()=>{visits++;return html(form+'<input id="captcha" placeholder="验证码">');},{...options,attempts:2});
   assert.equal(r.outcome,'blocked');assert.equal(r.diagnostic?.code,'captcha_required');assert.equal(r.search_performed,false);assert.equal(visits,1);assert.match(r.reason,/需要验证码/);assert.doesNotMatch(r.reason,/登录/);
  });
  for(const mode of ['abort','http-error'])await t.test(`failed stylesheet does not turn an unstyled feedback form into a captcha gate (${mode})`,async()=>{
   const context=await browser.newContext();
   await context.route('**/*',route=>new URL(route.request().url()).pathname==='/style.css'?(mode==='abort'?route.abort():route.fulfill({status:503,body:''})):route.fulfill({contentType:'text/html; charset=utf-8',body:html('<link rel="stylesheet" href="/style.css">'+form+'<aside class="feedback"><input placeholder="请输入验证码"></aside>',submit)}));
   try{const r=await collectInContext(context,site,subject,new AbortController().signal,options);assert.equal(r.outcome,'failed');assert.equal(r.diagnostic?.code,'network_error');assert.equal(r.diagnostic?.detail,'OFFICIAL_STYLESHEET_LOAD_FAILED');assert.equal(r.search_performed,false);}finally{await context.close();}
  });
  await t.test('unchanged stale zero is never accepted as this query',async()=>{
   const r=await run(url=>url.pathname==='/query'?'ok':html(form.replace('请输入名称','共0条'),`document.querySelector('#submit').onclick=()=>fetch('/query?q='+encodeURIComponent(document.querySelector('input').value));`));assert.equal(r.outcome,'unverified');
  });
  await t.test('new official query document can repeat the blank-query zero without an input echo',async()=>{
   const r=await run(url=>url.pathname==='/query'?html('您搜索的内容不存在！'):html(form.replace('请输入名称','您搜索的内容不存在！'),`document.querySelector('#submit').onclick=()=>location.href='/query?q='+encodeURIComponent(document.querySelector('input').value);`));
   assert.equal(r.outcome,'no_results');assert.equal(r.search_performed,true);assert.equal(r.captures[0].kind,'result');
  });
  await t.test('hidden frame navigation cannot validate the visible stale zero',async()=>{
   const r=await run(url=>url.pathname==='/query'?html('共0条'):html(form.replace('请输入名称','共0条')+'<iframe hidden id="hidden-query"></iframe>',`document.querySelector('#submit').onclick=()=>document.querySelector('#hidden-query').src='/query?q='+encodeURIComponent(document.querySelector('input').value);`));
   assert.equal(r.outcome,'unverified');assert.equal(r.captures.some(c=>c.kind==='result'),false);
  });
  await t.test('a changing clock outside stale results cannot prove a new query',async()=>{
   const r=await run(url=>url.pathname==='/query'?'ok':html(form.replace('请输入名称','共0条')+'<p id="clock">0</p>',`let n=0;setInterval(()=>document.querySelector('#clock').textContent=String(++n),200);document.querySelector('#submit').onclick=()=>fetch('/query?q='+encodeURIComponent(document.querySelector('input').value));`));assert.equal(r.outcome,'unverified');
  });
  await t.test('a loading result container cannot be captured as a finished zero',async()=>{
   const r=await run(url=>url.pathname==='/query'?'ok':html(form,submit.replace("document.querySelector('main').textContent=",`document.querySelector('main').setAttribute('aria-busy','true');setTimeout(()=>{document.querySelector('main').removeAttribute('aria-busy');document.querySelector('main').textContent+=' 页面已完成';},2600);document.querySelector('main').textContent=`)),{...options,waitMs:5000});
   assert.equal(r.outcome,'no_results');assert.match(r.captures[0].text,/页面已完成/);
  });
  await t.test('failed response does not verify an apparent zero',async()=>{
   const context=await browser.newContext();await context.route('**/*',route=>new URL(route.request().url()).pathname==='/query'?route.fulfill({status:503,body:'unavailable'}):route.fulfill({contentType:'text/html',body:html(form,submit)}));
   try{const r=await collectInContext(context,site,subject,new AbortController().signal,options);assert.equal(r.outcome,'failed');assert.equal(r.diagnostic?.code,'http_error');assert.equal(r.diagnostic?.http_status,503);assert.equal(r.diagnostic?.phase,'results');}finally{await context.close();}
  });
  await t.test('a result spinner timing out has a different cause from an unchanged unverified zero',async()=>{
   const r=await run(url=>url.pathname==='/query'?'ok':html(form,submit.replace("document.querySelector('main').textContent=","document.querySelector('main').setAttribute('aria-busy','true');document.querySelector('main').textContent=")));
   assert.equal(r.diagnostic?.code,'result_load_timeout');assert.equal(r.search_performed,true);
   const stale=await run(url=>url.pathname==='/query'?'ok':html(form.replace('请输入名称','共0条'),"document.querySelector('#submit').onclick=()=>fetch('/query?q='+encodeURIComponent(document.querySelector('input').value));"));
   assert.equal(stale.diagnostic?.code,'result_unverified');
  });
  await t.test('login gate is distinct from captcha',async()=>{
   const r=await run(()=>html('<h1>请先登录</h1><input type="password">'));
   assert.equal(r.diagnostic?.code,'login_required');assert.doesNotMatch(r.reason,/验证码/);
  });
  for(const status of [403,400,503])await t.test(`HTTP ${status} is preserved even for an empty response`,async()=>{
   const context=await browser.newContext();await context.route('**/*',route=>route.fulfill({status,contentType:'text/html',body:html(status===403?'403 Forbidden GeoBL':'')}));
   try{const r=await collectInContext(context,site,subject,new AbortController().signal,options);assert.equal(r.diagnostic?.http_status,status);assert.equal(r.diagnostic?.code,status===403?'access_denied':'http_error');assert.match(r.reason,status===403?/网站拒绝访问/:/网站响应错误/);assert.doesNotMatch(r.reason,/HTTP|Forbidden|GeoBL/);if(status===403)assert.match(r.diagnostic?.detail??'',/GeoBL/);}finally{await context.close();}
  });
  await t.test('network failure is reported without claiming an empty search',async()=>{
   const context=await browser.newContext();await context.route('**/*',route=>route.abort('namenotresolved'));
   try{const r=await collectInContext(context,site,subject,new AbortController().signal,options);assert.equal(r.diagnostic?.code,'network_error');assert.match(r.diagnostic?.detail??'',/ERR_NAME_NOT_RESOLVED/);assert.equal(r.search_performed,false);}finally{await context.close();}
  });
  await t.test('abort while waiting for a blank homepage stops immediately',async()=>{
   const context=await browser.newContext();await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:html('')}));
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),500);
   try{await assert.rejects(collectInContext(context,site,subject,controller.signal,{...options,waitMs:10000}),{name:'AbortError'});}finally{clearTimeout(timer);await context.close();}
  });
 }finally{await browser.close();}
});

test('proxy allows an official response slower than the former 30 second idle timeout',{skip:!process.env.BB_TEST_INTEGRITY_BROWSER,timeout:45000},async()=>{
 const timers:ReturnType<typeof setTimeout>[]=[];
 const server=createServer((_req,res)=>{timers.push(setTimeout(()=>res.end('delayed synthetic official response'),31000));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const proxy=await integrityProxy(site,{upstreamUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`});
 try{const result=await new Promise<string>((resolve,reject)=>{const req=request(proxy.server,{path:'http://www.creditchina.gov.cn/'},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve(body));});req.on('error',reject);req.end();});assert.equal(result,'delayed synthetic official response');}
 finally{timers.forEach(clearTimeout);await proxy.close();await new Promise<void>(r=>server.close(()=>r()));}
});
