import {Pool} from 'pg';
import {WorkerRuntime,workerRuntimeOptionsFromEnv} from '../../apps/worker/dist/runtime.js';
import {azureBlobs} from '../../apps/api/dist/data.js';
const database=new URL(process.env.DATABASE_URL);
const instance=process.env.BB_LOCAL_INSTANCE||'20261012';
const allowed=instance==='20261012'?{db:'55438',path:'/bb_integration_20261012',blob:'10018'}:
  instance==='qa-20261021'?{db:'15447',path:'/bb_integration_qa_20261021',blob:'10027'}:
  instance==='integrity-20261021'?{db:'15445',path:'/bb_integration_integrity_20261021',blob:'10025'}:
  instance==='files-20261021'?{db:'15444',path:'/bb_integration_files_20261021',blob:'10024'}:
  instance==='update-20261020'?{db:'55440',path:'/bb_integration_update_20261020',blob:'10020'}:
  instance==='projects-20261020'?{db:'15443',path:'/bb_integration_projects_20261020',blob:'10023'}:
  instance==='review-20261020'?{db:'15441',path:'/bb_integration_review_20261020',blob:'10021'}:null;
if(!allowed||database.hostname!=='host.docker.internal'||database.port!==allowed.db||database.pathname!==allowed.path)throw Error('Local integration database required');
if(!process.env.AZURE_STORAGE_CONNECTION_STRING?.includes(`http://host.docker.internal:${allowed.blob}/`))throw Error('Local integration Blob required');
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:8,idleTimeoutMillis:0,connectionTimeoutMillis:10000});
await pool.query('SELECT 1');
const worker=new WorkerRuntime({...workerRuntimeOptionsFromEnv(pool,azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING)),log:e=>console.log(JSON.stringify(e))}).start();
console.log(JSON.stringify({service:'linux-worker',ready:true,modelConfigured:true}));
let stopping=false;
const stop=async()=>{if(stopping)return;stopping=true;await worker.stop();await pool.end();process.exit(0);};
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
