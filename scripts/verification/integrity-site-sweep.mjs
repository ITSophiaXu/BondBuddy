/** Explicit diagnostic runner: real public websites, no database, account or model calls. */
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {collectIntegrityWebsite} from '../../apps/worker/dist/integrity-browser.js';
import {collectIntegritySite} from '../../apps/worker/dist/integrity-browser-stage.js';
const root=process.env.BB_SITE_SWEEP_OUTPUT;
const lane=Number(process.env.BB_SITE_SWEEP_LANE);
const deadlineMs=Number(process.env.BB_SITE_SWEEP_TIMEOUT_MS??420000);
if(!Number.isInteger(deadlineMs)||deadlineMs<240000||deadlineMs>900000)throw Error('Invalid diagnostic deadline');
if(!root||!Number.isInteger(lane)||lane<0||lane>7)throw Error('Explicit BB_SITE_SWEEP_OUTPUT and lane 0..7 required');
const plan=JSON.parse(await readFile(root+'/plan.json','utf8'));
if(plan.version!=='integrity-site-sweep-v1'||!Array.isArray(plan.jobs)||!/^[a-f0-9]{40}$/.test(plan.collector_source))throw Error('Invalid pinned plan');
await mkdir(root+'/results',{recursive:true});await mkdir(root+'/captures',{recursive:true});
const save=async(path,value)=>{await writeFile(path+'.tmp',JSON.stringify(value,null,2));await rename(path+'.tmp',path);};
for(const job of plan.jobs.filter(j=>j.lane===lane)){
 const dest=root+'/results/'+job.key+'.json';try{const prior=JSON.parse(await readFile(dest,'utf8'));if(!prior.pending||prior.assigned_lane!==lane)continue;}catch{}
 const started=Date.now();const controller=new AbortController();const timer=setTimeout(()=>controller.abort(Error('SITE_SWEEP_OVERALL_DEADLINE')),deadlineMs);
 await save(root+`/lane-${lane}.json`,{state:'running',key:job.key,started_at:new Date(started).toISOString()});
 let row;
 try{
  const result=await collectIntegritySite(collectIntegrityWebsite,job.site,job.subject,controller.signal);
  const captures=[];
  for(const [index,{screenshot,...capture}]of result.captures.entries()){
   const file=`captures/${job.key}-${index}.png`;await writeFile(root+'/'+file,screenshot);
   captures.push({...capture,file,screenshot_bytes:screenshot.length,sha256:createHash('sha256').update(screenshot).digest('hex')});
  }
  row={...job,started_at:new Date(started).toISOString(),checked_at:new Date().toISOString(),elapsed_ms:Date.now()-started,...result,captures};
 }catch(error){row={...job,started_at:new Date(started).toISOString(),checked_at:new Date().toISOString(),elapsed_ms:Date.now()-started,search_performed:false,outcome:'failed',captures:[],test_error:error instanceof Error?error.message:String(error)};}
 finally{clearTimeout(timer);}
 row.verified_query=row.search_performed&&['results','no_results'].includes(row.outcome)&&row.captures.some(c=>c.kind==='result'&&c.screenshot_bytes>0)&&!row.runtime_failure;
 await save(dest,row);
 console.log(JSON.stringify({key:job.key,elapsed_ms:row.elapsed_ms,outcome:row.outcome,verified_query:row.verified_query,diagnostic:row.diagnostic,error:row.test_error}));
}
await save(root+`/lane-${lane}.json`,{state:'complete',finished_at:new Date().toISOString()});
