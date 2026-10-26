import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {INTEGRITY_SITES,inferIntegrityRegion} from '@bondbuddy/contracts';
import {collectInContext} from './integrity-browser.js';
import {integrityProxy} from './integrity-browser-network.js';
import {createServer,request} from 'node:http';

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

test('page readiness, query conditions, retries and honest results in real Chromium',{skip:!process.env.BB_TEST_INTEGRITY_BROWSER,timeout:90000},async t=>{
 const browser=await chromium.launch({headless:true});
 async function run(body:(url:URL)=>string|Promise<string>,opts=options,selected=site){
  const context=await browser.newContext();
  await context.route('**/*',async route=>route.fulfill({contentType:'text/html; charset=utf-8',body:await body(new URL(route.request().url()))}));
  try{return await collectInContext(context,selected,subject,new AbortController().signal,opts);}finally{await context.close();}
 }
 try{
  await t.test('blank shell becomes a form after DOMContentLoaded',async()=>{
   const r=await run(url=>url.pathname==='/query'?'ok':html('',`setTimeout(()=>{document.body.innerHTML=${JSON.stringify(form)};${submit}},700)`));
   assert.equal(r.outcome,'no_results');assert.match(r.captures[0].text,/河南合成测试企业/);
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
   const r=await run(()=>html(''));assert.equal(r.outcome,'unverified');assert.equal(r.search_performed,false);assert.equal(r.captures.length,0);assert.match(r.reason,/无需.*证据/);
  });
  await t.test('loading-only page does not become an evidence screenshot',async()=>{
   const r=await run(()=>html('加载中…'));assert.equal(r.captures.length,0);assert.equal(r.outcome,'unverified');
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
   assert.equal(r.outcome,'blocked');assert.equal(r.search_performed,false);assert.equal(visits,1);assert.match(r.reason,/验证码或登录/);
  });
  await t.test('unchanged stale zero is never accepted as this query',async()=>{
   const r=await run(url=>url.pathname==='/query'?'ok':html(form.replace('请输入名称','共0条'),`document.querySelector('#submit').onclick=()=>fetch('/query?q='+encodeURIComponent(document.querySelector('input').value));`));assert.equal(r.outcome,'unverified');
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
   try{const r=await collectInContext(context,site,subject,new AbortController().signal,options);assert.equal(r.outcome,'unverified');}finally{await context.close();}
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
