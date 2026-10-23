import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {collectInContext,integrityBrowserEnvironment} from './integrity-browser.js';
import {readFile} from 'node:fs/promises';
import {integrityWebsiteFixture} from './integrity-browser-fixture.js';
import {integrityBrowserUrlAllowed,publicIntegrityAddress,integrityProxy} from './integrity-browser-network.js';
import {createServer,request} from 'node:http';
const site={id:'tax',name:'合成测试官网',topic:'监管公告',group:'test',links:[{label:'官网',url:'https://www.chinatax.gov.cn/'}]};
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
test('private-network worker uses dedicated upstream but cannot widen the selected website',async()=>{
 let upstreamCalls=0;
 const server=createServer((req,res)=>{upstreamCalls++;res.end('official fixture');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const proxy=await integrityProxy(site,{upstreamUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`});
 const get=(url:string)=>new Promise<number>((resolve,reject)=>{const req=request(proxy.server,{path:url},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.end();});
 try{assert.equal(await get('http://www.chinatax.gov.cn/'),200);assert.equal(await get('http://169.254.169.254/'),403);assert.equal(await get('http://www.csrc.gov.cn/'),403);assert.equal(upstreamCalls,1);}finally{await proxy.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('real Chromium on synthetic official-site fixtures: query, screenshot, zero, challenge, stale, failure and continuation',{timeout:120000,skip:!process.env.BB_TEST_INTEGRITY_BROWSER},async t=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const [mode,expected] of [['hits','results'],['zero','no_results'],['zero-ndrc','no_results'],['late','no_results'],['captcha','blocked'],['waf','blocked'],['login','blocked'],['failure','failed'],['stale','unverified']] as const){
   await t.test(mode,async()=>{
    const context=await browser.newContext({viewport:{width:1440,height:1000}});await integrityWebsiteFixture(context,mode);
    const result=await collectInContext(context,site,{name:'合成测试企业',kind:'company',province:'河北',city:'沧州'},new AbortController().signal,{waitMs:5000,maxPages:1});
    assert.equal(result.outcome,expected,JSON.stringify({...result,captures:result.captures.map(c=>({...c,screenshot:c.screenshot.length}))}));assert.equal(result.query,'合成测试企业');
    assert.equal(result.search_performed,mode!=='login');assert.ok(result.captures.length);assert.equal(result.captures[0].screenshot.subarray(1,4).toString(),'PNG');
    if(mode==='hits')assert.ok(result.captures.some(c=>c.kind==='detail'));
    await context.close();
   });
  }
 }finally{await browser.close();}
});
