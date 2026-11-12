import {test} from 'node:test';
import assert from 'node:assert/strict';
import {imageContract,candidateImageContract,requiredImageTargets,imageTargetsForRole} from './image-contract.mjs';
import {verifyReport} from './verify.mjs';
import {verifyInstalledImages} from './verify-images.mjs';
import {fiveFlowFixture} from './evidence-fixtures.mjs';
import {CONFIRMATION_BUDGET_MS,SMALL_MAX_BYTES,confirmationDeadline,verifyConfirmationEvidence} from './upload-confirmation-evidence.mjs';
import {nextUploadAction,confirmationService,describeConfirmationRuntime,confirmationPhases,runConfirmationPreflight} from './upload-confirmation-preflight.mjs';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256} from './support.mjs';

const time=Date.parse('2026-11-12T08:00:00Z'),stamp=ms=>new Date(time+ms).toISOString();
const expected={commit:'a'.repeat(40),tree:'b'.repeat(40),inspectorSha256:'c'.repeat(64),confirmationInspectorSha256:'e'.repeat(64),imageContract:imageContract('FROM scratch AS worker\nFROM node-runtime AS upload-confirmation\n')};
function fixture(){
 const images=Object.fromEntries(requiredImageTargets(expected).map((t,i)=>[t,{id:'sha256:'+String(i+1).repeat(64),platform:'linux/amd64'}]));
 const report=fiveFlowFixture(expected,stamp(30000),images);report.startedAt=stamp(0);report.imageContract=expected.imageContract;
 report.fixtureHashes=[{sha256:'6'.repeat(64)},{sha256:'7'.repeat(64)}];
 const runtime=(name,index)=>Object.fromEntries((name==='legacy'?['api','worker']:['api','worker','worker-parse','upload-confirmation']).map((service,i)=>[service,{containerId:String(index*4+i+1).repeat(64),imageId:images[service==='worker-parse'?'worker':service].id,revision:expected.commit,platform:'linux/amd64',startedAt:stamp(index*10000+100),running:true,
  ...(service==='api'?{}:{enabled:service==='worker'&&name==='size-split'?'0':'1',smallSlot:'0',spoolBytes:'134217728',lane:service==='upload-confirmation'?'large':service==='worker-parse'?'small':'general'}),
  ...(['worker','worker-parse'].includes(service)?{stagingVolume:service==='worker'?'synthetic-business-staging':'synthetic-confirmation-small',jobKinds:service==='worker-parse'?'parse':name==='legacy'?'run,parse':'run',concurrency:service==='worker-parse'?'1':'2',parseSlots:service==='worker'&&name==='legacy'?'1':'0',interactiveSlots:service==='worker'?'1':'0',command:['sh','-c','/usr/local/bin/bb-verify-ocr-runtime && exec node apps/worker/dist/runtime.js']}:{}),
  ...(service==='worker-parse'?{readOnly:true,modelConfiguration:false,credentialMounts:false,memoryBytes:1024*1024*1024,spoolType:'volume',spoolDestination:'/var/lib/bondbuddy/parse-staging',spoolDirectory:'/var/lib/bondbuddy/parse-staging/upload-confirmation'}:{}),
  ...(service==='upload-confirmation'?{readOnly:true,modelConfiguration:false,credentialMounts:false,memoryBytes:512*1024*1024,spoolType:'volume',spoolDestination:'/var/lib/bondbuddy/upload-confirmation',command:['node','apps/worker/dist/upload-confirmation-runtime.js']}:{}),}]));
 const modes=['legacy','size-split'].map((name,index)=>{
  const offset=index*10000,r=runtime(name,index),projectId='project-'+index;
  return {name,status:'passed',startedAt:stamp(offset),deadlineAt:stamp(offset+CONFIRMATION_BUDGET_MS),budgetMs:CONFIRMATION_BUDGET_MS,finishedAt:stamp(offset+5000),projectId,runtime:r,
   uploads:['small','large'].map((sizeClass,i)=>{
    const uploadId=name+'-'+sizeClass,bytes=SMALL_MAX_BYTES+i,sha256=String(i+6).repeat(64),filename=sizeClass+'.pdf',service=name==='legacy'?'worker':i===1?'upload-confirmation':'worker-parse';
    const httpReceipt={upload_id:uploadId,sha256,byte_size:bytes,filename,material_id:'material-'+uploadId,material_version:1};
    return {sizeClass,uploadId,bytes,sha256,filename,acceptedAt:stamp(offset+1000),finishedAt:stamp(offset+4000),httpReceipt,
     database:{state:'completed',drained:true,inspection_excepted:false,owner_user_id:'owner',project_id:projectId,upload_id:uploadId,outbox_id:'outbox-'+uploadId,delivery_attempts:1,delivered_at:stamp(offset+2000),sha256,material_sha256:sha256,byte_size:String(bytes),material_bytes:String(bytes),filename,material_id:httpReceipt.material_id,material_version:1,result:structuredClone(httpReceipt),model_calls:0},
     phases:['read','inspection','commit'].map(phase=>({service,containerId:r[service].containerId,phase,kind:'upload_confirmation_phase',upload_id:uploadId,lane:name==='legacy'?'general':sizeClass,at:stamp(offset+2500),elapsed_ms:1}))};
   })};
 });
 report.uploadConfirmation={schema:'release-upload-confirmation-v1',commit:expected.commit,tree:expected.tree,controllerSha256:expected.confirmationInspectorSha256,status:'passed',ownerId:'owner',modes};return report;
}
test('raw requested source, not report omission or current checkout, decides required images',()=>{
 const calls=[],old=candidateImageContract('b'.repeat(40),args=>{calls.push(args);return Buffer.from('FROM scratch AS worker\n');});
 assert.deepEqual(calls,[['cat-file','blob','b'.repeat(40)+':deploy/m1/Dockerfile']]);assert.equal(old.confirmation,false);
 assert.equal(imageContract('FROM --platform=$BUILDPLATFORM node-runtime \\\n+ AS upload-confirmation # exact source\n').confirmation,true);
 assert.deepEqual(requiredImageTargets(expected),['api','worker','web','upload-confirmation']);
 assert.throws(()=>requiredImageTargets({}),/Raw candidate/);
 const report=fixture();assert.doesNotThrow(()=>verifyReport(report,expected,time+40000));
 delete report.imageContract;assert.throws(()=>verifyReport(report,expected,time+40000));
 delete report.images['upload-confirmation'];assert.throws(()=>verifyReport(report,expected,time+40000));
});
test('role selection verifies only deployed services while exported source includes optional business image',()=>{
 assert.deepEqual(imageTargetsForRole('main',expected),['api','worker','web']);
 assert.deepEqual(imageTargetsForRole('execution',expected,'active'),['worker','upload-confirmation']);
 assert.deepEqual(imageTargetsForRole('execution',expected,'disabled'),['worker']);
 assert.deepEqual(imageTargetsForRole('all',expected,'disabled'),['api','worker','web']);
 assert.throws(()=>imageTargetsForRole('main',expected,'active'));assert.throws(()=>imageTargetsForRole('execution',{imageContract:imageContract('FROM scratch AS worker')},'active'));
});
test('every missing, stale or contradictory actual upload proof blocks the final release verifier',()=>{
 const changes=[r=>delete r.uploadConfirmation,r=>delete r.images['upload-confirmation'],r=>r.uploadConfirmation.modes.pop(),r=>r.uploadConfirmation.controllerSha256='f'.repeat(64),r=>r.uploadConfirmation.commit='f'.repeat(40),
  r=>r.uploadConfirmation.modes[1].runtime['upload-confirmation'].imageId=r.images.worker.id,
  r=>delete r.uploadConfirmation.modes[1].runtime['worker-parse'],
  r=>r.uploadConfirmation.modes[1].runtime.worker.enabled='1',
  r=>r.uploadConfirmation.modes[1].runtime.worker.jobKinds='parse',
  r=>r.uploadConfirmation.modes[1].runtime['worker-parse'].jobKinds='run,parse',
  r=>r.uploadConfirmation.modes[1].runtime['worker-parse'].lane='general',
  r=>r.uploadConfirmation.modes[1].runtime['worker-parse'].smallSlot='1',
  r=>r.uploadConfirmation.modes[1].runtime['worker-parse'].concurrency='2',
  r=>r.uploadConfirmation.modes[1].runtime['worker-parse'].imageId=r.images.api.id,
  r=>r.uploadConfirmation.modes[1].runtime['worker-parse'].credentialMounts=true,
  r=>r.uploadConfirmation.modes[1].runtime['worker-parse'].modelConfiguration=true,
  r=>r.uploadConfirmation.modes[1].runtime['worker-parse'].spoolDirectory='/tmp/shared',
  r=>r.uploadConfirmation.modes[1].runtime['worker-parse'].stagingVolume=r.uploadConfirmation.modes[1].runtime.worker.stagingVolume,
  r=>delete r.uploadConfirmation.modes[1].runtime['worker-parse'].stagingVolume,
  r=>r.uploadConfirmation.modes[1].runtime['worker-parse'].containerId=r.uploadConfirmation.modes[1].runtime.worker.containerId,
  r=>r.uploadConfirmation.modes[1].uploads[0].phases[0].service='worker',
  r=>r.uploadConfirmation.modes[1].runtime['upload-confirmation'].credentialMounts=true,
  r=>r.uploadConfirmation.modes[1].runtime['upload-confirmation'].modelConfiguration=true,
  r=>r.uploadConfirmation.modes[1].uploads[1].phases[0].lane='general',
  r=>r.uploadConfirmation.modes[1].uploads[1].phases[0].containerId='f'.repeat(64),
  r=>r.uploadConfirmation.modes[1].uploads[1].database.drained=false,
  r=>r.uploadConfirmation.modes[1].uploads[1].database.model_calls=1,
  r=>r.uploadConfirmation.modes[1].uploads[1].database.material_bytes='100',
  r=>r.uploadConfirmation.modes[1].uploads[1].httpReceipt.material_id='wrong',
  r=>r.uploadConfirmation.modes[1].uploads[1].phases=[],
  r=>r.uploadConfirmation.modes[1].uploads[1].sha256='f'.repeat(64),
  r=>r.uploadConfirmation.modes[1].deadlineAt=stamp(2*CONFIRMATION_BUDGET_MS),
  r=>r.uploadConfirmation.modes[1].finishedAt=stamp(2*CONFIRMATION_BUDGET_MS),
  r=>r.uploadConfirmation.modes[1].uploads[1].uploadId=r.uploadConfirmation.modes[0].uploads[1].uploadId];
 for(const mutate of changes){const r=fixture();mutate(r);assert.throws(()=>verifyReport(r,expected,time+40000));}
});
test('old source without target accepts its old three-image evidence but never authorizes new source',()=>{
 const old={...expected,imageContract:imageContract('FROM scratch AS worker\n')},r=fixture();delete r.uploadConfirmation;delete r.imageContract;delete r.images['upload-confirmation'];
 assert.doesNotThrow(()=>verifyReport(r,old,time+40000));assert.throws(()=>verifyReport(r,expected,time+40000));
});
test('new business image is only inspected or retagged by immutable tested ID; no build or pull fallback',()=>{
 const r=fixture(),calls=[],tags=new Set();
 const docker=args=>{calls.push(args);if(args[0]==='version')return 'linux/amd64';if(args[0]==='tag'){tags.add(args[2]);return '';}
  assert.deepEqual(args.slice(0,2),['image','inspect']);const ref=args[2],target=Object.keys(r.images).find(k=>r.images[k].id===ref||tags.has(ref)&&ref.includes('-'+k+':'));
  if(!target)throw Error('absent');return JSON.stringify([{Id:r.images[target].id,Os:'linux',Architecture:'amd64',Config:{Labels:{'org.opencontainers.image.revision':expected.commit}}}]);};
 assert.deepEqual(Object.keys(verifyInstalledImages(r,expected,'execution',{docker,reuse:true,selection:'active'})),['worker','upload-confirmation']);
 assert.equal(calls.filter(a=>a[0]==='tag').length,2);assert.ok(calls.every(a=>['version','image','tag'].includes(a[0])));
 const absent=args=>{if(args[0]==='version')return 'linux/amd64';throw Error('absent');};assert.throws(()=>verifyInstalledImages(r,expected,'execution',{docker:absent,reuse:true,selection:'active'}),/unavailable locally/);
});
test('resume preserves accepted IDs and the original deadline instead of refreshing or recreating work',()=>{
 assert.equal(nextUploadAction({}),'create');assert.equal(nextUploadAction({uploadId:'same',bytesPutAt:stamp(0)}),'confirm');assert.equal(nextUploadAction({httpReceipt:{}}),'verify');
 for(const u of [{createStartedAt:stamp(0)},{uploadId:'same'},{putStartedAt:stamp(0)}])assert.throws(()=>nextUploadAction(u),/refusing/);
 const mode=fixture().uploadConfirmation.modes[0];assert.equal(confirmationDeadline(mode,time+1000),599000);assert.throws(()=>confirmationDeadline(mode,time+CONFIRMATION_BUDGET_MS),/expired/);mode.budgetMs++;assert.throws(()=>confirmationDeadline(mode,time+1000),/budget changed/);
});
test('standalone runtime contains storage only, and actual inspection detects model or mount leakage',()=>{
 const c=confirmationService('tested',{DATABASE_URL:'synthetic',AZURE_STORAGE_CONNECTION_STRING:'synthetic',BB_DEPLOYMENT_TIER:'local',BB_RELEASE_TEST_INSTANCE:'synthetic',BB_CODEX_MODEL:'must-not-copy'});
 assert.equal(c.environment.BB_CODEX_MODEL,undefined);assert.equal(c.mem_limit,'512m');assert.deepEqual(c.volumes,['confirmation:/var/lib/bondbuddy/upload-confirmation']);
 const a={Id:'a'.repeat(64),Image:'sha256:'+'b'.repeat(64),Config:{Env:[...Object.entries(c.environment).map(([k,v])=>k+'='+v),'OPENAI_API_KEY=synthetic'],Labels:{'org.opencontainers.image.revision':expected.commit},Cmd:c.command},State:{StartedAt:stamp(0),Running:true},HostConfig:{ReadonlyRootfs:true,Memory:512*1024*1024},Mounts:[{Type:'volume',Destination:'/var/lib/bondbuddy/upload-confirmation'},{Type:'bind',Destination:'/run/secrets/model'}]};
 const d=describeConfirmationRuntime('upload-confirmation',a,{Id:a.Image,Os:'linux',Architecture:'amd64',Config:{Cmd:c.command}});assert.equal(d.modelConfiguration,true);assert.equal(d.credentialMounts,true);assert.equal(JSON.stringify(d).includes('synthetic'),false);
 assert.throws(()=>describeConfirmationRuntime('upload-confirmation',a,{Id:a.Image,Os:'linux',Architecture:'amd64',Config:{Cmd:['node','other.js']}}),/command differs/);
 const phases=confirmationPhases('not JSON\n'+JSON.stringify({kind:'upload_confirmation_phase',upload_id:'u',phase:'commit',lane:'large'}),'upload-confirmation',a.Id,'u');assert.equal(phases.length,1);assert.equal(phases[0].containerId,a.Id);
});

test('resuming a lost final HTTP receipt polls its original completed upload without another session or PUT',async()=>{
 const directory=dirname(fileURLToPath(import.meta.url)),area=mkdtempSync(join(tmpdir(),'confirmation-resume-unit-'));
 try{
  const small=join(area,'small.pdf'),large=join(area,'large.pdf');writeFileSync(small,'Synthetic transport-only unit bytes');writeFileSync(large,Buffer.alloc(SMALL_MAX_BYTES+1,80));
  const r=fixture(),p=r.uploadConfirmation,mode=p.modes[1],now=Date.now();r.sha=expected.commit;r.baseURL='http://localhost:5288';
  mode.status='pending';mode.startedAt=new Date(now-5000).toISOString();mode.deadlineAt=new Date(now-5000+CONFIRMATION_BUDGET_MS).toISOString();
  p.controllerSha256=sha256(readFileSync(join(directory,'upload-confirmation-preflight.mjs')));
  const rows=new Map(),logPolls=new Map();let observationQueries=0;
  for(const [i,path] of [small,large].entries()){
   const u=mode.uploads[i],bytes=readFileSync(path);u.sha256=sha256(bytes);u.bytes=bytes.length;u.bytesPutAt=new Date(now-1000).toISOString();u.confirmationStartedAt=u.bytesPutAt;
   Object.assign(u.httpReceipt,{sha256:u.sha256,byte_size:u.bytes});Object.assign(u.database,{sha256:u.sha256,material_sha256:u.sha256,byte_size:String(u.bytes),material_bytes:String(u.bytes),result:structuredClone(u.httpReceipt)});rows.set(u.uploadId,u.database);
  }
  const rawPhases=structuredClone(mode.uploads.flatMap(u=>u.phases));
  delete mode.uploads[1].httpReceipt;const originalId=mode.uploads[1].uploadId,deadline=mode.deadlineAt,calls=[];
  const client={async post(path){calls.push(path);if(path==='/api/v1/auth/login')return {status:()=>200,json:async()=>({user_id:'owner'})};
   assert.equal(path,`/api/v1/projects/${mode.projectId}/materials/uploads/${originalId}/complete`);return {status:()=>200,json:async()=>rows.get(originalId).result};},async put(){throw Error('Must not repeat PUT');},async storageState(){return {cookies:[{name:'bb_csrf',value:'synthetic'}]};},async dispose(){}};
  const args={report:r,privateData:{account:{username:'synthetic',password:'synthetic'},fixtures:{financial:[small,large]}},save(){},directory,requestFactory:async()=>client,configure(){throw Error('Must not recreate live mode');},snapshot:async()=>mode.runtime,
   logs:async(containerId)=>{const n=(logPolls.get(containerId)??0)+1;logPolls.set(containerId,n);return rawPhases.filter(e=>e.containerId===containerId&&(n>1||e.phase!=='commit')).map(JSON.stringify).join('\n');},
   execReadOnly:async request=>{observationQueries++;const row=rows.get(request.values[2]);return {rows:[observationQueries===1?{...row,drained:false}:row]};}};
  await runConfirmationPreflight(args);assert.equal(mode.uploads[1].uploadId,originalId);assert.equal(mode.deadlineAt,deadline);assert.equal(calls.length,2);assert.equal(mode.status,'passed');assert.ok(mode.uploads[0].observationPolls>=2,'read-only observation waits for drain/log visibility');
  await runConfirmationPreflight(args);assert.equal(calls.length,3,'completed modes only log in; no upload is sent again');
  mode.status='pending';await assert.rejects(runConfirmationPreflight({...args,snapshot:async()=>({...mode.runtime,worker:{...mode.runtime.worker,containerId:'f'.repeat(64)}})}),/runtime changed/);
  mode.startedAt=new Date(now-CONFIRMATION_BUDGET_MS-1000).toISOString();mode.deadlineAt=new Date(now-1000).toISOString();await assert.rejects(runConfirmationPreflight(args),/budget expired/);
 }finally{rmSync(area,{recursive:true,force:true});}
});
