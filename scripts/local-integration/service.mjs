import {existsSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {Pool} from 'pg';
import {environment,runtime,ports} from './config.mjs';
Object.assign(process.env,environment());
// Windows PostgreSQL cold connections can exceed the product's unchanged 2 s probe.
// Establish the local pool before readiness and keep it open until graceful shutdown.
const launchId=process.env.BB_LOCAL_LAUNCH_ID;
if(!launchId)throw Error('Start this service through the local lifecycle launcher');
const name=process.argv[2],pool=new Pool({connectionString:process.env.DATABASE_URL,max:8,idleTimeoutMillis:0,connectionTimeoutMillis:10000});
await pool.query('SELECT 1');
const stopFile=join(runtime,`${name}.${launchId}.stop`);
let stop;
if(name==='api'){
  const {createProductionServer}=await import('../../apps/api/dist/server.js');
  const app=createProductionServer({pool});
  await app.listen({host:'127.0.0.1',port:ports.api});
  stop=async()=>{await app.close();await pool.end();};
}else if(name==='worker'){
  const {WorkerRuntime,workerRuntimeOptionsFromEnv}=await import('../../apps/worker/dist/runtime.js');
  const {azureBlobs}=await import('../../apps/api/dist/data.js');
  const worker=new WorkerRuntime({...workerRuntimeOptionsFromEnv(pool,azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING)),log:e=>console.log(JSON.stringify(e))}).start();
  stop=async()=>{await worker.stop();await pool.end();};
}else throw Error('Unknown local service');
writeFileSync(join(runtime,`${name}.ready.json`),JSON.stringify({pid:process.pid,launchId,startedAt:new Date().toISOString()}));
console.log(JSON.stringify({service:name,pid:process.pid,ready:true,modelCredentialsConfigured:false}));
let stopping=false;
const shutdown=async()=>{if(stopping)return;stopping=true;clearInterval(timer);await stop();if(existsSync(stopFile))unlinkSync(stopFile);process.exit(0);};
const timer=setInterval(()=>{if(existsSync(stopFile))void shutdown();},500);
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
