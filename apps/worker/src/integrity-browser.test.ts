// Accelerated observation windows for legacy fixtures; production durations have dedicated regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {collectInContext,integrityBrowserEnvironment,integritySearchQuery} from './integrity-browser.js';
import {integrityEgressListen} from './integrity-egress-config.js';
import {INTEGRITY_SITES} from '@bondbuddy/contracts';
import {readFile} from 'node:fs/promises';
import {integrityWebsiteFixture} from './integrity-browser-fixture.js';
import {integrityBrowserUrlAllowed,publicIntegrityAddress,integrityProxy} from './integrity-browser-network.js';
import {createServer,request} from 'node:http';
const site={id:'tax',name:'合成测试官网',topic:'监管公告',group:'test',links:[{label:'官网',url:'https://www.chinatax.gov.cn/'}]};
test('Beijing host egress defaults to loopback and rejects accidental public host configuration',()=>{
 assert.deepEqual(integrityEgressListen({}),{host:'127.0.0.1',port:3129});
 assert.deepEqual(integrityEgressListen({BB_INTEGRITY_EGRESS_BIND_HOST:'0.0.0.0'}),{host:'0.0.0.0',port:3129});
 assert.throws(()=>integrityEgressListen({BB_INTEGRITY_EGRESS_BIND_HOST:'49.233.75.207'}));
});
test('court exact-name forms do not append topic keywords; general searches retain them',()=>{
 const subject={name:'中国石油化工股份有限公司',province:'北京'};
 for(const id of ['execution-dishonest','execution-debtor','execution-restriction'])assert.equal(integritySearchQuery(INTEGRITY_SITES.find(s=>s.id===id)!,subject),subject.name);
 assert.equal(integritySearchQuery(INTEGRITY_SITES.find(s=>s.id==='tax-dishonest')!,subject),subject.name+' 重大税收违法');
 assert.ok(integritySearchQuery(INTEGRITY_SITES.find(s=>s.id==='local-csrc')!,subject).endsWith(' 北京'));
});
test('browser process receives no business credentials and Linux policy only adds renderer PID namespace',async()=>{
 const environment=integrityBrowserEnvironment('/tmp/synthetic-browser-cache');
 assert.deepEqual(Object.keys(environment).filter(k=>!['XDG_CACHE_HOME','PATH','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL'].includes(k)),[]);
 const base=JSON.parse(await readFile(new URL('../../../deploy/m1/security/codex-seccomp.json',import.meta.url),'utf8'));
 const browser=JSON.parse(await readFile(new URL('../../../deploy/m1/security/integrity-browser-seccomp.json',import.meta.url),'utf8'));
 const extra=browser.syscalls.pop();assert.deepEqual(browser,base);assert.deepEqual(extra.names,['clone']);assert.equal(extra.args[0].value,0x5e020000);assert.equal(extra.args[0].valueTwo,0);
});
test('browser egress only permits selected official domains and public pinned IPv4',()=>{
 for(const url of ['http://127.0.0.1','https://169.254.169.254','https://www.chinatax.gov.cn.evil.test','https://user:pass@www.chinatax.gov.cn','https://www.chinatax.gov.cn:9999'])assert.equal(integrityBrowserUrlAllowed(site,url),false,url);
 assert.equal(integrityBrowserUrlAllowed(site,'https://search.chinatax.gov.cn/'),true);
 for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.0.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','::1','::ffff:127.0.0.1'])assert.equal(publicIntegrityAddress(ip),false,ip);
 assert.equal(publicIntegrityAddress('8.8.8.8'),true);
});
test('MOT search provider is scoped to that site, host, tenant assets and query path',()=>{
 const mot=INTEGRITY_SITES.find(s=>s.id==='transport')!;
 for(const path of ['/web/pc/enterprise/js/jquery.min.js','/custom/bm19000004_zck/js/query.js'])assert.equal(integrityBrowserUrlAllowed(mot,'https://p.so-gov.cn'+path),true);
 for(const url of ['https://p.so-gov.cn/api/search','https://p.so-gov.cn/custom/other/js/query.js','https://p.so-gov.cn/web/index.html','https://p.so-gov.cn.evil.test/web/x.js','http://p.so-gov.cn/web/x.js'])assert.equal(integrityBrowserUrlAllowed(mot,url),false);
 assert.equal(integrityBrowserUrlAllowed(site,'https://p.so-gov.cn/web/x.js'),false);
 for(const url of ['https://p.so-gov.cn/custom/BM19000004/css/search.css','https://p.so-gov.cn/common/js/ieTips.js','https://p.so-gov.cn/pc/js/marked.min.js','https://file.so-gov.cn/cps/pro/bm19000004/css/govSearchPc.css','https://api.so-gov.cn/query/s']){
  assert.equal(integrityBrowserUrlAllowed(mot,url),true,url);assert.equal(integrityBrowserUrlAllowed(site,url),false,url);
  assert.equal(integrityBrowserUrlAllowed({...site,id:'official-directory'},url),true,url);
 }
 for(const url of ['https://api.so-gov.cn/feedback','https://api.so-gov.cn/query/other','https://chatapi.so-gov.cn/ask/v4/token','https://file.so-gov.cn/cps/pro/other/css/govSearchPc.css','http://api.so-gov.cn/query/s','https://api.so-gov.cn.evil.test/query/s'])assert.equal(integrityBrowserUrlAllowed(mot,url),false,url);
});
test('MOA resources share provider assets but cannot access another tenant',()=>{
 const moa=INTEGRITY_SITES.find(s=>s.id==='agriculture')!,mot=INTEGRITY_SITES.find(s=>s.id==='transport')!;
 for(const url of ['https://p.so-gov.cn/custom/bm21000007zw/css/search.css','https://file.so-gov.cn/cps/pro/bm21000007/css/govSearchPc.css','https://file.so-gov.cn/cps/pro/bgt_moa/css/image/cover.png']){
  assert.equal(integrityBrowserUrlAllowed(moa,url),true);assert.equal(integrityBrowserUrlAllowed({...site,id:'official-directory'},url),true);assert.equal(integrityBrowserUrlAllowed(mot,url),false);
 }
 assert.equal(integrityBrowserUrlAllowed(moa,'https://p.so-gov.cn/custom/BM19000004/css/search.css'),false);
});
test('observed MOT/MOA search initialization dependencies stay restricted to exact paths and tenants',()=>{
 const mot=INTEGRITY_SITES.find(s=>s.id==='transport')!,moa=INTEGRITY_SITES.find(s=>s.id==='agriculture')!;
 for(const current of [mot,moa])for(const url of ['https://p.so-gov.cn/web/i18n/zh/lang.json','https://api.so-gov.cn/query/site']){
  assert.equal(integrityBrowserUrlAllowed(current,url),true,url);assert.equal(integrityBrowserUrlAllowed(site,url),false,url);
 }
 const motImage='https://file.so-gov.cn/cps/pro/bm19000004new/css/2c9331a3121145c3af0b29915ca26ff0/2c9331a3121145c3af0b29915ca26ff0.png';
 const moaImage='https://file.so-gov.cn/cps/pro/zwbm21000007/css/51e0660b41134dfb86bab00e0be42184/51e0660b41134dfb86bab00e0be42184.png';
 assert.equal(integrityBrowserUrlAllowed(mot,motImage),true);assert.equal(integrityBrowserUrlAllowed(moa,motImage),false);
 assert.equal(integrityBrowserUrlAllowed(moa,moaImage),true);assert.equal(integrityBrowserUrlAllowed(mot,moaImage),false);
 const md5='https://cdn.bootcss.com/blueimp-md5/2.10.0/js/md5.js';
 assert.equal(integrityBrowserUrlAllowed(moa,md5),true);assert.equal(integrityBrowserUrlAllowed({...site,id:'official-directory'},md5),true);
 assert.equal(integrityBrowserUrlAllowed(mot,md5),false);assert.equal(integrityBrowserUrlAllowed(site,md5),false);
 for(const url of ['https://p.so-gov.cn/web/private.json','https://api.so-gov.cn/query/site/other','http://api.so-gov.cn/query/site','https://api.so-gov.cn.evil.test/query/site','https://cdn.bootcss.com/other.js','http://cdn.bootcss.com/blueimp-md5/2.10.0/js/md5.js','https://chatapi.so-gov.cn/ask/v4/token'])assert.equal(integrityBrowserUrlAllowed(moa,url),false,url);
});

test('private-network worker uses dedicated upstream but cannot widen the selected website',async()=>{
 let upstreamCalls=0;
 const server=createServer((req,res)=>{upstreamCalls++;res.end('official fixture');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const proxy=await integrityProxy(site,{upstreamUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`});
 const get=(url:string)=>new Promise<number>((resolve,reject)=>{const req=request(proxy.server,{path:url},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.end();});
 try{assert.equal(await get('http://www.chinatax.gov.cn/'),200);assert.equal(await get('http://169.254.169.254/'),403);assert.equal(await get('http://www.csrc.gov.cn/'),403);assert.equal(upstreamCalls,1);}finally{await proxy.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('unavailable Beijing tunnel fails closed without a direct website fallback',async()=>{
 const unused=createServer();await new Promise<void>(r=>unused.listen(0,'127.0.0.1',r));
 const port=(unused.address() as {port:number}).port;await new Promise<void>(r=>unused.close(()=>r()));
 const proxy=await integrityProxy(site,{upstreamUrl:`http://127.0.0.1:${port}`});
 try{const status=await new Promise<number>((resolve,reject)=>{const req=request(proxy.server,{path:'http://www.chinatax.gov.cn/'},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.end();});assert.equal(status,502);}finally{await proxy.close();}
});
test('search-provider HTTPS uses the configured upstream and preserves its denial',async()=>{
 const requested:string[]=[],upstream=createServer();
 upstream.on('connect',(req,socket)=>{requested.push(req.url!);socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');});
 await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
 const proxy=await integrityProxy(INTEGRITY_SITES.find(s=>s.id==='transport')!,{upstreamUrl:`http://127.0.0.1:${(upstream.address() as {port:number}).port}`});
 try{const status=await new Promise<number>((resolve,reject)=>{const req=request(proxy.server,{method:'CONNECT',path:'api.so-gov.cn:443'});req.on('connect',(response,socket)=>{socket.destroy();resolve(response.statusCode!);});req.on('error',reject);req.end();});assert.equal(status,403);assert.deepEqual(requested,['api.so-gov.cn:443']);}
 finally{await proxy.close();await new Promise<void>(r=>upstream.close(()=>r()));}
});
test('real Chromium on synthetic official-site fixtures: query, screenshot, zero, challenge, stale, failure and continuation',{timeout:120000,skip:!process.env.BB_TEST_INTEGRITY_BROWSER},async t=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const [mode,expected] of [['hits','results'],['zero','no_results'],['zero-ndrc','no_results'],['late','no_results'],['captcha','blocked'],['waf','failed'],['login','blocked'],['failure','failed'],['stale','unverified']] as const){
   await t.test(mode,async()=>{
    const context=await browser.newContext({viewport:{width:1440,height:1000}});await integrityWebsiteFixture(context,mode);
    const result=await collectInContext(context,site,{name:'合成测试企业',kind:'company',province:'河北',city:'沧州'},new AbortController().signal,{resultStableMs:150,zeroConfirmMs:300,waitMs:5000,maxPages:1});
    assert.equal(result.outcome,expected,JSON.stringify({...result,captures:result.captures.map(c=>({...c,screenshot:c.screenshot.length}))}));assert.equal(result.query,'合成测试企业');
    assert.equal(result.search_performed,mode!=='login');assert.ok(result.captures.length);assert.equal(result.captures[0].screenshot.subarray(1,4).toString(),'PNG');
    if(mode==='hits')assert.ok(result.captures.some(c=>c.kind==='detail'));
    await context.close();
   });
  }
 }finally{await browser.close();}
});

test('observed MOT list without totals requires fresh visible structured results and survives capture recheck',{timeout:90000,skip:!process.env.BB_TEST_INTEGRITY_BROWSER},async t=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const mode of ['hits','stale','shell','wrong-host','hidden','missing-href','capture-cleared'])await t.test(mode,async()=>{
   const context=await browser.newContext();
   const current={...INTEGRITY_SITES.find(s=>s.id==='transport')!,links:[{label:'synthetic MOT fixture',url:mode==='wrong-host'?'https://www.chinatax.gov.cn/mot/s':'https://zs.mot.gov.cn/mot/s'}]};
   const item=`<div class="search-result-header" ${mode==='hidden'?'style="display:none"':''}><div class="search-result-left"><div class="result-header-title"><a ${mode==='missing-href'?'':'href="https://www.mot.gov.cn/synthetic-article.html"'}>合成公告：道路维护招标</a></div></div></div>`;
   await context.route('**/*',route=>{
    if(new URL(route.request().url()).pathname==='/search')return route.fulfill({body:'synthetic query response'});
    return route.fulfill({contentType:'text/html; charset=utf-8',body:`<input type="search"><button>搜索</button><main>${mode==='stale'?item:'请输入查询词'}</main><script>
     document.querySelector('button').onclick=async()=>{await fetch('/search?q='+encodeURIComponent(document.querySelector('input').value));document.querySelector('main').innerHTML=${JSON.stringify(mode==='shell'?'结果排序：按相关度 搜索位置：全文':item)};};
    </script>`});
   });
   const result=await collectInContext(context,current,{name:'合成测试企业',kind:'company',province:'北京',city:''},new AbortController().signal,{resultStableMs:150,zeroConfirmMs:300,waitMs:4200,maxPages:1,attempts:1,...(mode==='capture-cleared'?{screenCapture:async(page:import('playwright').Page)=>{const png=await page.screenshot();await page.locator('main').evaluate(e=>e.textContent='结果排序：按相关度');return png;}}:{})});
   assert.equal(result.search_performed,true);
   assert.equal(result.outcome,mode==='hits'?'results':'unverified');
   assert.equal(result.captures.some(c=>c.kind==='result'),mode==='hits');
   await context.close();
  });
 }finally{await browser.close();}
});

test('observed tax next-page label advances before a second result screenshot',{timeout:30000,skip:!process.env.BB_TEST_INTEGRITY_BROWSER},async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const context=await browser.newContext();
  await context.route('**/*',route=>{
   if(new URL(route.request().url()).pathname==='/search')return route.fulfill({body:'synthetic query response'});
   return route.fulfill({contentType:'text/html; charset=utf-8',body:`<input type="search"><button id="submit">搜索</button><main>请输入查询词</main><script>
    const input=document.querySelector('input');
    const show=n=>document.querySelector('main').innerHTML='相关结果30个 '+input.value+' 第'+n+'页 <button id="next">下一页&gt;&gt;</button>';
    document.querySelector('#submit').onclick=async()=>{await fetch('/search?q='+encodeURIComponent(input.value));show(1);};
    document.addEventListener('click',e=>{if(e.target.id==='next')show(2);});
   </script>`});
  });
  const result=await collectInContext(context,site,{name:'合成测试企业',kind:'company',province:'北京',city:'北京'},new AbortController().signal,{resultStableMs:150,zeroConfirmMs:300,waitMs:5000,maxPages:2});
  assert.equal(result.outcome,'results');
  assert.deepEqual(result.captures.map(c=>[c.kind,c.page]),[['result',1],['result',2]]);
  assert.match(result.captures[1].text,/第2页/);
 }finally{await browser.close();}
});

test('default collection waits for official search responses beyond the former 18s limit',{timeout:60000,skip:!process.env.BB_TEST_INTEGRITY_BROWSER},async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const context=await browser.newContext();
  await context.route('**/*',async route=>{
   if(new URL(route.request().url()).pathname==='/search'){
    await new Promise(resolve=>setTimeout(resolve,19500));
    return route.fulfill({body:'synthetic delayed official response'});
   }
   return route.fulfill({contentType:'text/html; charset=utf-8',body:`<input type="search"><button>搜索</button><main>请输入查询词</main><script>
    document.querySelector('button').onclick=async()=>{await fetch('/search?q='+encodeURIComponent(document.querySelector('input').value));document.querySelector('main').textContent='相关结果0个';};
   </script>`});
  });
  const result=await collectInContext(context,site,{name:'合成测试企业',kind:'company',province:'河北',city:'沧州'},new AbortController().signal);
  assert.equal(result.outcome,'no_results');assert.equal(result.search_performed,true);
  assert.equal(result.captures[0].kind,'result');assert.match(result.captures[0].text,/相关结果0个/);
 }finally{await browser.close();}
});
