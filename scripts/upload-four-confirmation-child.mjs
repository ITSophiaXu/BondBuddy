// Isolation instrumentation around the unchanged real Blob reader and runtime.
import {readFile,writeFile,access} from 'node:fs/promises';
import {Pool} from 'pg';
import {azureBlobs} from '../apps/api/dist/data.js';
import {reservedSpoolBytes} from '../apps/api/dist/upload-spool.js';
import {acquireConfirmationSpool} from '../apps/worker/dist/upload-confirmation-spool.js';
import {confirmationConfig,UploadConfirmationRuntime} from '../apps/worker/dist/upload-confirmation-runtime.js';
const fixture=JSON.parse(await readFile('/fixture/child.private.json','utf8'));
for(const [key,value] of Object.entries(fixture.env))process.env[key]=value;
const config=confirmationConfig(process.env),release=await acquireConfirmationSpool(config.root,config.budget);
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:12}),blobs=azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING,config.container);
const log=event=>process.stdout.write(JSON.stringify({at:new Date().toISOString(),...event})+'\n');
await pool.query('SELECT 1');
const read=blobs.readToFile.bind(blobs);let active=0,peak=0;
blobs.readToFile=async(...args)=>{
 active++;peak=Math.max(peak,active);
 try{
  const proof=await read(...args);log({kind:'actual_read',key:args[0],proof,active_reads:active,peak_reads:peak,reserved_bytes:reservedSpoolBytes()});
  if(fixture.gate&&args[2]>16*1024*1024){
   const end=Date.now()+120000;for(;;){try{await access('/fixture/release');break;}catch{}if(Date.now()>end)throw Error('Synthetic gate timeout');await new Promise(r=>setTimeout(r,20));}
  }
  return proof;
 }finally{active--;}
};
const runtime=new UploadConfirmationRuntime({pool,blobs,lane:config.lane,smallSlot:config.smallSlot,concurrency:config.concurrency,pollMs:100,log}).start();
log({kind:'started',general_slots:config.concurrency,small_slots:config.smallSlot?1:0,budget:config.budget});
await new Promise(resolve=>process.once('SIGTERM',resolve));
await runtime.stop();
log({kind:'stopped',reserved_bytes:reservedSpoolBytes(),peak_reads:peak});
await pool.end();await release();
