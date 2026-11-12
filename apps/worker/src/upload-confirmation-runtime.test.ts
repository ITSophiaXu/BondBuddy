import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {confirmationConfig} from './upload-confirmation-runtime.js';
import {acquireConfirmationSpool} from './upload-confirmation-spool.js';
import {WorkerRuntime,workerRuntimeOptionsFromEnv} from './runtime.js';
import type {Pool} from 'pg';
import type {PrivateBlobs} from '@bondbuddy/api/data';

const env={DATABASE_URL:'postgresql://synthetic@127.0.0.1/synthetic',AZURE_STORAGE_CONNECTION_STRING:'synthetic',BB_UPLOAD_CONFIRMATION_ENABLED:'1',BB_UPLOAD_SPOOL_DIR:'/synthetic/confirmation',BB_UPLOAD_SPOOL_MAX_BYTES:'134217728'};
test('confirmation entry is opt-in, bounded and rejects execution/model settings',()=>{
  assert.throws(()=>confirmationConfig({}));
  assert.equal(confirmationConfig(env).smallSlot,false);
  assert.equal(confirmationConfig(env).lane,'general');
  assert.equal(confirmationConfig({...env,BB_UPLOAD_CONFIRMATION_LANE:'large'}).lane,'large');
  assert.equal(confirmationConfig({...env,BB_UPLOAD_CONFIRMATION_SMALL_SLOT:'1'}).smallSlot,true);
  assert.equal(confirmationConfig({...env,BB_LIBRARY_CONTAINER:'unrelated-library'}).container,'bondbuddy-private');
  assert.equal(confirmationConfig({...env,BB_UPLOAD_CONFIRMATION_CONTAINER:'synthetic-materials'}).container,'synthetic-materials');
  for(const change of [{BB_UPLOAD_CONFIRMATION_LANE:'small'},{BB_UPLOAD_CONFIRMATION_LANE:'other'},{BB_UPLOAD_CONFIRMATION_LANE:'large',BB_UPLOAD_CONFIRMATION_SMALL_SLOT:'1'},{BB_UPLOAD_CONFIRMATION_ENABLED:'0'},{DATABASE_URL:''},{AZURE_STORAGE_CONNECTION_STRING:''},{BB_UPLOAD_CONFIRMATION_SMALL_SLOT:'yes'},{BB_UPLOAD_SPOOL_MAX_BYTES:'1073741824'},{BB_UPLOAD_SPOOL_DIR:'relative'},{BB_UPLOAD_CONFIRMATION_POLL_MS:'0'},{BB_UPLOAD_CONFIRMATION_CONTAINER:'invalid--name'},{BB_WORKER_JOB_KINDS:'parse'},{BB_WORKER_RUN_KINDS:'update'},{BB_CODEX_BIN:'synthetic'},{OPENAI_API_KEY:'synthetic'},{COPILOT_TOKEN:'synthetic'}])
    assert.throws(()=>confirmationConfig({...env,...change}),JSON.stringify(Object.keys(change)));
});

test('main factory defaults general and accepts exactly one bounded small confirmation loop',()=>{
  const base={...env,BB_WORKER_JOB_KINDS:'parse',BB_PARSE_CACHE_OCR_VERSION:'synthetic',BB_PARSE_CACHE_BASIS_VERSION:'synthetic'};
  const options=(change:NodeJS.ProcessEnv={})=>workerRuntimeOptionsFromEnv({} as Pool,{} as PrivateBlobs,{...base,...change});
  assert.equal(options().uploadConfirmationLane,'general');
  const small=options({BB_UPLOAD_CONFIRMATION_LANE:'small'});
  assert.equal(small.uploadConfirmationLane,'small');assert.equal(small.uploadConfirmationSmallSlot,false);assert.ok(small.parse);
  assert.doesNotThrow(()=>new WorkerRuntime(small));
  for(const change of [{BB_UPLOAD_CONFIRMATION_LANE:'other'},{BB_UPLOAD_CONFIRMATION_LANE:'small',BB_UPLOAD_CONFIRMATION_SMALL_SLOT:'1'},
    {BB_UPLOAD_CONFIRMATION_LANE:'small',BB_UPLOAD_CONFIRMATION_ENABLED:'0'}, {BB_UPLOAD_CONFIRMATION_LANE:'small',BB_WORKER_JOB_KINDS:'run,parse'},
    {BB_UPLOAD_CONFIRMATION_LANE:'small',BB_UPLOAD_SPOOL_MAX_BYTES:'268435456'}])assert.throws(()=>options(change));
  assert.throws(()=>new WorkerRuntime({...small,uploadConfirmationSmallSlot:true}));
});

test('release harness builds valid business and isolated parser roles through the real runtime factory',async()=>{
 const {workerParseService,configureConfirmationMode,describeConfirmationRuntime}=await import(new URL('../../../scripts/release-smoke/upload-confirmation-preflight.mjs',import.meta.url).href);
 const business={...env,BB_PARSE_CACHE_OCR_VERSION:'synthetic',BB_PARSE_CACHE_BASIS_VERSION:'synthetic',BB_WORKER_CONCURRENCY:'2',BB_WORKER_PARSE_SLOTS:'1',BB_CODEX_MODEL:'synthetic-real-model-config',BB_CODEX_AUTHORING_TIMEOUT_MS:'18000000',BB_COPILOT_OAUTH_FILE:'/run/secrets/bb-copilot-oauth'};
 const parser=workerParseService('tested-worker',business,business),compose={services:{worker:{environment:{...business},volumes:['parse:/var/lib/bondbuddy/parse-staging','auth:/run/secrets/bb-copilot-oauth:ro']},'worker-parse':parser,'upload-confirmation':{}}};
 const factory=(environment:NodeJS.ProcessEnv)=>workerRuntimeOptionsFromEnv({} as Pool,{} as PrivateBlobs,environment);
 configureConfirmationMode(compose,'legacy');const legacy=factory(compose.services.worker.environment);
 assert.deepEqual(legacy.kinds,['run','parse']);assert.equal(legacy.uploadConfirmationEnabled,true);assert.equal(legacy.uploadConfirmationLane,'general');assert.equal(legacy.uploadConfirmationSmallSlot,false);assert.doesNotThrow(()=>new WorkerRuntime(legacy));
 configureConfirmationMode(compose,'size-split');const run=factory(compose.services.worker.environment),small=factory(parser.environment);
 assert.deepEqual(run.kinds,['run']);assert.equal(run.uploadConfirmationEnabled,false);assert.equal(run.uploadConfirmationLane,'general');assert.equal(run.uploadConfirmationSmallSlot,false);assert.doesNotThrow(()=>new WorkerRuntime(run));
 assert.deepEqual(small.kinds,['parse']);assert.equal(small.concurrency,1);assert.equal(small.parseSlots,0);assert.equal(small.interactiveSlots,0);assert.equal(small.uploadConfirmationEnabled,true);assert.equal(small.uploadConfirmationLane,'small');assert.equal(small.uploadConfirmationSmallSlot,false);assert.doesNotThrow(()=>new WorkerRuntime(small));
 for(const key of ['BB_CODEX_MODEL','BB_CODEX_AUTHORING_TIMEOUT_MS','BB_COPILOT_OAUTH_FILE'] as const){assert.equal(compose.services.worker.environment[key],business[key]);assert.equal(parser.environment[key],undefined);}
 assert.equal(parser.image,'tested-worker');assert.deepEqual(parser.volumes,['confirmation-small:/var/lib/bondbuddy/parse-staging']);assert.deepEqual(compose.services.worker.volumes,['parse:/var/lib/bondbuddy/parse-staging','auth:/run/secrets/bb-copilot-oauth:ro']);
 assert.throws(()=>factory({...parser.environment,BB_WORKER_JOB_KINDS:'run,parse'}),/filtered confirmation lane/);
 assert.throws(()=>factory({...compose.services.worker.environment,BB_UPLOAD_CONFIRMATION_ENABLED:'1',BB_UPLOAD_CONFIRMATION_SMALL_SLOT:'1'}),/Reserved upload confirmation slot/);
 const command=['sh','-c','/usr/local/bin/bb-verify-ocr-runtime && exec node apps/worker/dist/runtime.js'],image={Id:'tested-worker',Config:{Cmd:command}},actual={Image:image.Id,Config:{Cmd:command,Env:Object.entries(parser.environment).map(([k,v])=>k+'='+v)},HostConfig:{ReadonlyRootfs:true,Memory:1024*1024*1024},Mounts:[{Type:'volume',Name:'synthetic-confirmation-small',Destination:'/var/lib/bondbuddy/parse-staging'}]};
 const observed=describeConfirmationRuntime('worker-parse',actual,image);assert.equal(observed.jobKinds,'parse');assert.equal(observed.modelConfiguration,false);assert.equal(observed.credentialMounts,false);assert.equal(observed.spoolDirectory,parser.environment.BB_UPLOAD_SPOOL_DIR);assert.equal(observed.stagingVolume,'synthetic-confirmation-small');
 for(const credential of ['COPILOT_TOKEN','BB_COPILOT_OAUTH_FILE','BB_OPENAI_API_KEY','BB_ANTHROPIC_API_KEY'])assert.equal(describeConfirmationRuntime('worker-parse',{...actual,Config:{...actual.Config,Env:[...actual.Config.Env,credential+'=synthetic']}},image).modelConfiguration,true);
 assert.equal(describeConfirmationRuntime('worker-parse',{...actual,Mounts:[...actual.Mounts,{Type:'bind',Destination:'/run/secrets/bb-copilot-oauth'}]},image).credentialMounts,true);
});

test('dedicated spool locks exclude a second process and only clean managed private files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'bb-confirmation-lock-'));
  let release:(()=>Promise<void>)|undefined;
  try{
    const stale=join(root,randomUUID()+'.blob');await writeFile(stale,'synthetic',{mode:0o600});
    release=await acquireConfirmationSpool(root,128*1024*1024);
    await assert.rejects(readFile(stale),{code:'ENOENT'});
    const active=join(root,randomUUID()+'.blob');await writeFile(active,'synthetic-active',{mode:0o600});
    await assert.rejects(acquireConfirmationSpool(root,128*1024*1024));
    assert.equal(await readFile(active,'utf8'),'synthetic-active');
    await release();release=undefined;
    const foreign=join(root,'parser-owned.data');await writeFile(foreign,'synthetic-foreign',{mode:0o600});
    await assert.rejects(acquireConfirmationSpool(root,128*1024*1024));
    assert.equal(await readFile(active,'utf8'),'synthetic-active','validate all files before any cleanup');
    assert.equal(await readFile(foreign,'utf8'),'synthetic-foreign');
  }finally{await release?.();await rm(root,{recursive:true,force:true});}
});
