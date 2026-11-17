/** Read-only public portal probe. Accessibility is separate from search completion. */
import {readFile,mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {integrityProxy,integrityBrowserUrlAllowed} from '../../apps/worker/dist/integrity-browser-network.js';
import {classifyIntegrityAccessibility} from './integrity-accessibility-policy.mjs';
import {startIntegrityDesktop} from '../../apps/worker/dist/integrity-desktop.js';
const root=process.env.BB_ACCESSIBILITY_OUTPUT;
if(!root)throw Error('BB_ACCESSIBILITY_OUTPUT required');
const plan=JSON.parse(await readFile(root+'/plan.json','utf8'));
if(plan.jobs.length!==129)throw Error('Full inventory required');
await mkdir(root+'/results',{recursive:true});await mkdir(root+'/captures',{recursive:true});
const retry=process.env.BB_ACCESSIBILITY_RETRY==='1';
const headed=process.env.BB_ACCESSIBILITY_HEADED==='1';
const only=process.env.BB_ACCESSIBILITY_KEYS?.split(',');
const selected=[];
for(const job of plan.jobs){
 if(only&&!only.includes(job.key))continue;
 if(!retry){selected.push(job);continue;}
 const prior=JSON.parse(await readFile(root+'/results/'+job.key+'.json','utf8'));
 if(!prior.accessible&&(job.site.links[0].url.startsWith('http:')||job.key==='nfra'))selected.push(job);
}
const groups=Map.groupBy(selected,j=>j.site.links[0].url);
const jobs=[...groups.entries()];let next=0;
async function probe(url,entries){
 const attempts=[];const key=entries[0].key;
 const testedUrl=retry?url.replace(/^http:/,'https:'):url;
 const testSite={...entries[0].site,links:[{label:'官网入口',url:testedUrl}]};
 for(let attempt=1;attempt<=2;attempt++){
  let browser,proxy,desktop,cache;const row={attempt,started_at:new Date().toISOString(),configured_url:url,tested_url:testedUrl,browser_mode:headed?'headed':'headless'};
  try{
   proxy=await integrityProxy(testSite);
   if(headed){cache=await mkdtemp(join(tmpdir(),'bb-accessibility-'));desktop=await startIntegrityDesktop(cache,{PATH:process.env.PATH,LANG:'C.UTF-8'});}
   browser=await chromium.launch({headless:!headed,chromiumSandbox:true,...(desktop?{env:desktop.env}:{}),proxy:{server:proxy.server},args:['--disable-quic','--window-size=1440,952','--window-position=0,0']});
   const context=await browser.newContext({viewport:headed?null:{width:1440,height:1000},locale:'zh-CN',timezoneId:'Asia/Shanghai',acceptDownloads:false,serviceWorkers:'block'});
   await context.route('**/*',route=>integrityBrowserUrlAllowed(testSite,route.request().url())?route.continue():route.abort());
   const page=await context.newPage();let response;
   page.on('response',r=>{if(r.request().isNavigationRequest()&&r.frame()===page.mainFrame())response=r;});
   try{response=await page.goto(testedUrl,{waitUntil:'domcontentloaded',timeout:30000});}catch(e){row.navigation_error=String(e.message).split('\n')[0];}
   await page.waitForTimeout(3000);
   if(retry&&response?.status()<400)await page.waitForFunction(()=>document.body?.innerText.trim().length>20,{},{timeout:20000}).catch(()=>{});
   row.final_url=page.url();row.title=await page.title();row.http_status=response?.status();
   row.text=(await page.locator('body').innerText({timeout:5000})).slice(0,25000);
   if(/^https?:/.test(row.final_url)){
    const bytes=desktop?await desktop.capture(page):await page.screenshot({type:'png',timeout:10000});
    row.capture=`captures/${key}-${headed?'headed-':retry?'retry-':''}${attempt}.png`;row.screenshot_bytes=bytes.length;row.sha256=createHash('sha256').update(bytes).digest('hex');
    await writeFile(root+'/'+row.capture,bytes);
   }
   Object.assign(row,classifyIntegrityAccessibility(row));
  }catch(e){row.accessible=false;row.reason='probe_failure';row.error=String(e.message).split('\n')[0];}
  finally{await browser?.close().catch(()=>{});await desktop?.close().catch(()=>{});await proxy?.close().catch(()=>{});if(cache)await rm(cache,{recursive:true,force:true});}
  row.finished_at=new Date().toISOString();attempts.push(row);
  if(row.accessible)break;
 }
 const result={keys:entries.map(j=>j.key),configured_url:url,tested_url:testedUrl,accessible:attempts.some(r=>r.accessible),attempts};
 for(const entry of entries){
  const prior=retry?JSON.parse(await readFile(root+'/results/'+entry.key+'.json','utf8')):undefined;
  await writeFile(root+'/results/'+entry.key+'.json',JSON.stringify({...entry,...result,...(prior?{previous:prior}: {})},null,2)+'\n');
 }
 console.log(JSON.stringify({keys:result.keys,accessible:result.accessible,reason:attempts.at(-1).reason}));
}
await Promise.all(Array.from({length:4},async()=>{while(next<jobs.length){const [url,entries]=jobs[next++];await probe(url,entries);}}));
console.log(JSON.stringify({complete:true,entries:plan.jobs.length,unique_urls:jobs.length}));
