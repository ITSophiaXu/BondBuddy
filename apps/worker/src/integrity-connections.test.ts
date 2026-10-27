import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {INTEGRITY_SITES} from '@bondbuddy/contracts';
import {collectInContext,retryIntegrityCollection,type BrowserCollection} from './integrity-browser.js';

const site=INTEGRITY_SITES.find(s=>s.id==='pbc')!;
const subject={name:'河南合成测试企业',kind:'company' as const,province:'河南',city:''};
const html=(body:string,script='')=>`<!doctype html><meta charset="utf-8"><title>synthetic official fixture</title><body>${body}<script>${script}</script>`;
const form='<input placeholder="企业名称"><button>查询</button><main>请输入名称</main>';
const navigate=(popup:boolean)=>`document.querySelector('button').onclick=()=>{const q=document.querySelector('input').value;${popup?"window.open('/query?q='+encodeURIComponent(q))":"location.href='/query?q='+encodeURIComponent(q)"};};`;
const options={waitMs:4500,maxPages:1,attempts:2};

test('certificate and policy failures stop while transient transport failures remain retryable',()=>{
 const result:BrowserCollection={query:'合成企业',search_performed:false,outcome:'failed',scope:'synthetic',limitation:'synthetic',reason:'synthetic',captures:[]};
 for(const detail of ['net::ERR_CERT_DATE_INVALID','net::ERR_CERT_AUTHORITY_INVALID','net::ERR_BLOCKED_BY_CLIENT','OFFICIAL_STYLESHEET_LOAD_FAILED net::ERR_CERT_DATE_INVALID https://example.test/a.css']){
  assert.equal(retryIntegrityCollection({...result,diagnostic:{code:'network_error',phase:'open',detail}}),false);
 }
 assert.equal(retryIntegrityCollection({...result,diagnostic:{code:'network_error',phase:'results',detail:'net::ERR_CONNECTION_RESET'}}),true);
 assert.equal(retryIntegrityCollection({...result,diagnostic:{code:'http_error',phase:'open',http_status:503}}),true);
 assert.equal(retryIntegrityCollection({...result,diagnostic:{code:'access_denied',phase:'open'}}),false);
});

test('connection failures and resource lifetime in real Chromium',{skip:!process.env.BB_TEST_INTEGRITY_BROWSER,timeout:90000},async t=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const status of [400,404,429])await t.test(`terminal HTTP ${status} ends promptly without repeating the same request`,async()=>{
   const context=await browser.newContext();let visits=0;
   await context.route('**/*',route=>{visits++;return route.fulfill({status,contentType:'text/html',body:html('')});});
   try{const r=await collectInContext(context,site,subject,new AbortController().signal,options);
    assert.equal(r.diagnostic?.http_status,status);assert.equal(r.diagnostic?.attempts,1);assert.equal(visits,1);
    assert.ok(r.diagnostic!.elapsed_ms!<options.waitMs,`spent ${r.diagnostic!.elapsed_ms}ms on a terminal response`);
    assert.equal(r.search_performed,false);assert.equal(r.captures.length,0);
   }finally{await context.close();}
  });
  await t.test('transient HTTP 503 can recover on the next attempt',async()=>{
   const context=await browser.newContext();let visits=0;
   await context.route('**/*',route=>{const query=new URL(route.request().url()).pathname==='/query';return route.fulfill({status:query||++visits>1?200:503,contentType:'text/html',body:query?html('共0条'):visits===1?html(''):html(form,navigate(false))});});
   try{const r=await collectInContext(context,site,subject,new AbortController().signal,options);
    assert.equal(r.outcome,'no_results');assert.equal(r.diagnostic?.attempts,2);assert.equal(visits,2);assert.equal(r.captures[0].kind,'result');
   }finally{await context.close();}
  });
  for(const popup of [false,true])await t.test(`failed stylesheet belonging to the old document does not reject a valid ${popup?'popup':'navigation'} result`,async()=>{
   const context=await browser.newContext();
   await context.route('**/*',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/old.css'){await route.abort('failed');return;}
    if(path==='/query'){await new Promise(r=>setTimeout(r,200));await route.fulfill({contentType:'text/html',body:html('共0条')});return;}
    // The failed resource starts after submission, just before the new result document.
    await route.fulfill({contentType:'text/html',body:html(form,`document.querySelector('button').onclick=()=>{const l=document.createElement('link');l.rel='stylesheet';l.href='/old.css';document.head.append(l);setTimeout(()=>{const q=document.querySelector('input').value;${popup?"window.open('/query?q='+encodeURIComponent(q))":"location.href='/query?q='+encodeURIComponent(q)"}},100);};`)});
   });
   try{const r=await collectInContext(context,site,subject,new AbortController().signal,{...options,attempts:1});
    assert.equal(r.outcome,'no_results');assert.equal(r.captures[0].kind,'result');assert.match(r.captures[0].url,/\/query\?/);
   }finally{await context.close();}
  });
  await t.test('a failed stylesheet still required by the visible result remains a failure',async()=>{
   const context=await browser.newContext();
   await context.route('**/*',route=>{const path=new URL(route.request().url()).pathname;return path==='/current.css'?route.fulfill({status:503,body:''}):route.fulfill({contentType:'text/html',body:path==='/query'?html('<link rel="stylesheet" href="/current.css">共0条'):html(form,navigate(false))});});
   try{const r=await collectInContext(context,site,subject,new AbortController().signal,{...options,attempts:1});
    assert.equal(r.outcome,'failed');assert.match(r.diagnostic?.detail??'',/^OFFICIAL_STYLESHEET_LOAD_FAILED/);assert.match(r.diagnostic?.detail??'',/\/current\.css/);assert.ok(r.captures.every(c=>c.kind!=='result'));
   }finally{await context.close();}
  });
  await t.test('a failed imported stylesheet still required by the result remains a failure',async()=>{
   const context=await browser.newContext();
   await context.route('**/*',route=>{const path=new URL(route.request().url()).pathname;return path==='/imported.css'?route.fulfill({status:404,body:''}):route.fulfill({contentType:'text/html',body:path==='/query'?html('<style>@import url("/imported.css");</style>共0条'):html(form,navigate(false))});});
   try{const r=await collectInContext(context,site,subject,new AbortController().signal,{...options,attempts:1});
    assert.equal(r.outcome,'failed');assert.match(r.diagnostic?.detail??'',/OFFICIAL_STYLESHEET_LOAD_FAILED.*\/imported\.css/);
   }finally{await context.close();}
  });
  for(const status of [200,404])await t.test(`a stylesheet redirect is judged by its final HTTP ${status} response`,async()=>{
   // A local HTTP proxy fixture also serves redirected requests; Playwright's
   // route.fulfill redirect handler only intercepts the first URL in the chain.
   const server=createServer((req,res)=>{const url=new URL(req.url!);if(url.hostname!=='www.pbc.gov.cn'){res.writeHead(403);res.end();return;}
    if(url.pathname==='/style.css'){res.writeHead(302,{location:'/final.css'});res.end();return;}
    if(url.pathname==='/final.css'){res.writeHead(status,{'content-type':'text/css'});res.end(status===200?'body { color: black; }':'');return;}
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(url.pathname==='/query'?html('<link rel="stylesheet" href="/style.css">共0条'):html(form,navigate(false)));
   });
   await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
   const context=await browser.newContext({proxy:{server:`http://127.0.0.1:${(server.address() as {port:number}).port}`}});
   try{const r=await collectInContext(context,{...site,links:[{label:'synthetic proxy fixture',url:'http://www.pbc.gov.cn/'}]},subject,new AbortController().signal,{...options,attempts:1});
    assert.equal(r.outcome,status===200?'no_results':'failed',JSON.stringify(r.diagnostic));
    if(status===404)assert.match(r.diagnostic?.detail??'',/OFFICIAL_STYLESHEET_LOAD_FAILED.*\/final\.css/);
   }finally{await context.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  await t.test('a successful replacement request clears the old failure for the same stylesheet',async()=>{
   const context=await browser.newContext();let styles=0;
   await context.route('**/*',route=>{const path=new URL(route.request().url()).pathname;return path==='/current.css'?++styles===1?route.fulfill({status:503,body:''}):route.fulfill({contentType:'text/css',body:'body { color: black; }'}):route.fulfill({contentType:'text/html',body:path==='/query'?html('<link rel="stylesheet" href="/current.css" onerror="this.remove();const l=document.createElement(\'link\');l.rel=\'stylesheet\';l.href=\'/current.css\';document.head.append(l)">共0条'):html(form,navigate(false))});});
   try{const r=await collectInContext(context,site,subject,new AbortController().signal,{...options,attempts:1});
    assert.equal(styles,2);assert.equal(r.outcome,'no_results');
   }finally{await context.close();}
  });
  for(const variant of ['intact','missing-main-css','widget-present','wrong-template'] as const)await t.test(`PBC missing optional widget stylesheet: ${variant}`,async()=>{
   const context=await browser.newContext();
   const widget='/search/fileDir/template/system/pageTemp/pc/commonresult/96e3f317e7f8427aa584841e0a84b8ed/fuwuxiang/fuwuxiang.css',main='/search/fileDir/sites/main/rmyh/rmyh.css';
   await context.route('**/*',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path===widget||path===main&&variant==='missing-main-css')return route.fulfill({status:404,body:''});
    if(path===main)return route.fulfill({contentType:'text/css',body:'.default-result-list { color: black; min-height: 30px; }'});
    return route.fulfill({contentType:'text/html',body:path==='/search/pcRender'?html(`<link rel="stylesheet" href="${widget}"><link rel="stylesheet" href="${main}"><span class="result-count">0条结果</span><div class="default-result-list">共0条</div>${variant==='widget-present'?'<div class="fuwuxiang">服务项</div>':''}`):html(form,`document.querySelector('button').onclick=()=>{location.href='https://wzdig.pbc.gov.cn/search/pcRender?pageId=${variant==='wrong-template'?'unknown':'c177a85bd02b4114bebebd210809f691'}&q='+encodeURIComponent(document.querySelector('input').value);};`)});
   });
   try{const r=await collectInContext(context,site,subject,new AbortController().signal,{...options,attempts:1});
    assert.equal(r.outcome,variant==='intact'?'no_results':'failed');
    assert.match(r.diagnostic?.detail??'',variant==='intact'?/^OPTIONAL_PBC_WIDGET_STYLESHEET_HTTP_404$/:/^OFFICIAL_STYLESHEET_LOAD_FAILED/);
    assert.equal(r.captures[0].kind,variant==='intact'?'result':'blocker');
   }finally{await context.close();}
  });
  await t.test('query-bearing analytics image failure cannot erase a successful query response',async()=>{
   const context=await browser.newContext();
   await context.route('**/*',route=>{const path=new URL(route.request().url()).pathname;
    return path==='/pixel'?route.abort('connectionreset'):path==='/query'?route.fulfill({body:'ok'}):route.fulfill({contentType:'text/html',body:html(form,"document.querySelector('button').onclick=async()=>{const q=document.querySelector('input').value;await fetch('/query?q='+encodeURIComponent(q));document.querySelector('main').textContent='本次查询 '+q+' 共0条';new Image().src='/pixel?q='+encodeURIComponent(q);};")});
   });
   try{const r=await collectInContext(context,site,subject,new AbortController().signal,{...options,attempts:1});assert.equal(r.outcome,'no_results');assert.equal(r.search_performed,true);}finally{await context.close();}
  });
  await t.test('a failed result request retries promptly and recovers without repeating an in-flight query',async()=>{
   const context=await browser.newContext();let queries=0;const waitMs=15000;
   await context.route('**/*',route=>new URL(route.request().url()).pathname==='/query'?(++queries===1?route.abort('connectionreset'):route.fulfill({body:'ok'})):route.fulfill({contentType:'text/html',body:html(form,"document.querySelector('button').onclick=async()=>{const q=document.querySelector('input').value;await fetch('/query?q='+encodeURIComponent(q));document.querySelector('main').textContent='本次查询 '+q+' 共0条';};")}));
   try{const r=await collectInContext(context,site,subject,new AbortController().signal,{...options,waitMs});
    assert.equal(r.outcome,'no_results');assert.equal(queries,2);assert.equal(r.diagnostic?.attempts,2);
    assert.ok(r.diagnostic!.elapsed_ms!<waitMs,'a completed failed request must not consume the full result wait');assert.equal(r.captures.length,1);
   }finally{await context.close();}
  });
 }finally{await browser.close();}
});
