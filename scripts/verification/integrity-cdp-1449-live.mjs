import {collectIntegrityWebsite} from '../../apps/worker/dist/integrity-browser.js';
import {collectIntegritySite} from '../../apps/worker/dist/integrity-browser-stage.js';
import {INTEGRITY_SITES} from '../../packages/contracts/dist/index.js';
import {mkdir,writeFile} from 'node:fs/promises';
const source=process.env.BB_VERIFICATION_SOURCE;
if(!/^[a-f0-9]{40}$/.test(source??''))throw Error('BB_VERIFICATION_SOURCE must pin the tested revision');
const out=process.env.BB_INTEGRITY_TEST_OUTPUT_DIRECTORY??'/out/live';await mkdir(out,{recursive:true});
const subject={name:'东营市城市建设发展集团有限公司',kind:'company',province:'山东',city:'东营市'};
const results=[];
for(const id of ['tax','credit-china']){
 const started=Date.now();
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(Error('TEST_OVERALL_DEADLINE')),240000);
 try{
  const site=INTEGRITY_SITES.find(site=>site.id===id);
  const collection=await collectIntegritySite(collectIntegrityWebsite,site,subject,controller.signal);
  for(const [index,capture]of collection.captures.entries())await writeFile(`${out}/${id}-${index}.png`,capture.screenshot);
  const row={id,elapsed_ms:Date.now()-started,...collection,captures:collection.captures.map(({screenshot,...capture})=>({...capture,screenshot_bytes:screenshot.length}))};
  results.push(row);process.stdout.write(JSON.stringify(row)+'\n');
 }catch(error){const row={id,elapsed_ms:Date.now()-started,error:String(error)};results.push(row);process.stdout.write(JSON.stringify(row)+'\n');}
 finally{clearTimeout(timer);}
 await writeFile(out+'/results.json',JSON.stringify({subject,source,network:'local Docker direct public egress; not production Beijing egress',model_calls:0,results},null,2));
}
