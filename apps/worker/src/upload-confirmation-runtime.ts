// Independent entry: no run/parse, sweeps, model adapters or model credentials.
import {pathToFileURL} from 'node:url';
import {isAbsolute,normalize} from 'node:path';
import {Pool} from 'pg';
import {azureBlobs,type PrivateBlobs} from '@bondbuddy/api/data';
import {runUploadConfirmationOnce,type UploadConfirmationLane} from '@bondbuddy/api/upload-confirmation';
import {acquireConfirmationSpool} from './upload-confirmation-spool.js';

const SPOOL_BYTES=128*1024*1024;
export function confirmationConfig(env:NodeJS.ProcessEnv){
  if(env.BB_UPLOAD_CONFIRMATION_ENABLED!=='1')throw new Error('Upload confirmation requires explicit enablement');
  for(const [key,value] of Object.entries(env))if(value&&/^(BB_(CODEX|MODEL|DEEPSEEK|WORKER_JOB_KINDS|WORKER_RUN_KINDS|PLATFORM_PROBE)|CODEX_|COPILOT_|OPENAI_|DEEPSEEK_|ANTHROPIC_)/.test(key))
    throw new Error('Upload confirmation cannot inherit execution or model configuration');
  if(!env.DATABASE_URL||!env.AZURE_STORAGE_CONNECTION_STRING)throw new Error('Upload confirmation storage configuration is required');
  const db=new URL(env.DATABASE_URL);
  if(!['postgres:','postgresql:'].includes(db.protocol))throw new Error('Invalid confirmation database');
  const root=env.BB_UPLOAD_SPOOL_DIR;
  if(!root||!isAbsolute(root)||normalize(root)!==root||root==='/'||Number(env.BB_UPLOAD_SPOOL_MAX_BYTES)!==SPOOL_BYTES)
    throw new Error('Upload confirmation requires a dedicated absolute spool and 128 MiB budget');
  const small=env.BB_UPLOAD_CONFIRMATION_SMALL_SLOT??'0';
  if(!['0','1'].includes(small))throw new Error('Invalid small confirmation slot');
  const lane=env.BB_UPLOAD_CONFIRMATION_LANE??'general';
  if(!['general','large'].includes(lane)||lane==='large'&&small!=='0')throw new Error('Large-only confirmation requires one large loop');
  const rawPoll=env.BB_UPLOAD_CONFIRMATION_POLL_MS??'1000',pollMs=Number(rawPoll);
  if(!/^\d+$/.test(rawPoll)||!Number.isSafeInteger(pollMs)||pollMs<100||pollMs>60000)throw new Error('Invalid confirmation poll interval');
  // This is the material container, independently selectable for isolated tests.
  // BB_LIBRARY_CONTAINER belongs to the reference library and is not consulted.
  const container=env.BB_UPLOAD_CONFIRMATION_CONTAINER??'bondbuddy-private';
  if(!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(container)||container.includes('--'))throw new Error('Invalid confirmation material container');
  return {root,budget:SPOOL_BYTES,lane:lane as 'general'|'large',smallSlot:small==='1',pollMs,container};
}

export class UploadConfirmationRuntime{
  private stopping=false;
  private loops:Promise<void>[]=[];
  private readonly wake=new AbortController();
  constructor(private readonly options:{pool:Pool;blobs:PrivateBlobs;lane?:'general'|'large';smallSlot:boolean;pollMs:number;log?:(event:Record<string,unknown>)=>void}){
    if(!['general','large'].includes(options.lane??'general')||options.lane==='large'&&options.smallSlot)throw new Error('Invalid standalone confirmation lane');
  }
  private emit(event:Record<string,unknown>){try{this.options.log?.({at:new Date().toISOString(),...event});}catch{/* telemetry only */}}
  start(){
    if(this.stopping||this.loops.length)throw new Error('Confirmation runtime already started or stopped');
    this.loops.push(this.loop(this.options.lane??'general'));
    if(this.options.smallSlot)this.loops.push(this.loop('small'));
    return this;
  }
  private async loop(lane:UploadConfirmationLane){
    while(!this.stopping){
      const started=performance.now();let outcome='error';
      try{outcome=await runUploadConfirmationOnce(this.options.pool,this.options.blobs,lane,event=>this.emit({kind:'upload_confirmation_phase',lane,...event}));}catch{/* never log storage errors/URLs */}
      if(outcome!=='idle')this.emit({kind:'upload_confirmation',lane,outcome,elapsed_ms:performance.now()-started});
      if((outcome==='idle'||outcome==='error')&&!this.stopping)await new Promise<void>(resolve=>{
        const done=()=>{clearTimeout(timer);this.wake.signal.removeEventListener('abort',done);resolve();};
        const timer=setTimeout(done,this.options.pollMs);this.wake.signal.addEventListener('abort',done,{once:true});
      });
    }
  }
  /** Do not release a live confirmation or its spool while a read/commit is in flight.
   * Lease renewal belongs to runUploadConfirmationOnce and continues during drain. */
  async stop(){this.stopping=true;this.wake.abort();await Promise.all(this.loops);}
}

export async function confirmationMain(){
  const config=confirmationConfig(process.env);
  const log=(event:Record<string,unknown>)=>process.stdout.write(`${JSON.stringify(event)}\n`);
  let stopping=false,runtime:UploadConfirmationRuntime|undefined;
  const stop=()=>{stopping=true;void runtime?.stop();};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  let release:(()=>Promise<void>)|undefined,pool:Pool|undefined;
  try{
    release=await acquireConfirmationSpool(config.root,config.budget);
    if(stopping)return;
    pool=new Pool({connectionString:process.env.DATABASE_URL,max:6,connectionTimeoutMillis:10000});
    await pool.query('SELECT 1');
    if(stopping)return;
    runtime=new UploadConfirmationRuntime({pool,blobs:azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING!,config.container),lane:config.lane,smallSlot:config.smallSlot,pollMs:config.pollMs,log}).start();
    log({kind:'started',service:'upload-confirmation',lane:config.lane,general_slots:config.lane==='general'?1:0,large_slots:config.lane==='large'?1:0,small_slots:config.smallSlot?1:0,spool_budget_bytes:config.budget});
    await new Promise<void>(resolve=>{
      if(stopping)return resolve();
      const done=()=>{process.removeListener('SIGTERM',done);process.removeListener('SIGINT',done);resolve();};
      process.once('SIGTERM',done);process.once('SIGINT',done);
    });
    await runtime.stop();
    log({kind:'stopped',service:'upload-confirmation'});
  }finally{
    await runtime?.stop();await pool?.end();await release?.();
    process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{await confirmationMain();}catch{process.stderr.write('Upload confirmation stopped: verify protected configuration, dedicated spool and storage connectivity\n');process.exitCode=1;}
}
