import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,rmdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertIdleWorkload,atomicWriteJson,composeEnvironment,ownedStartAction,pendingImageUpgrade,stopOwnedStack} from './runtime.mjs';

const container=(service,{running=true,image='old-worker',revision='previous'}={})=>({Id:service,Image:image,State:{Running:running,Status:running?'running':'exited'},
  Config:{Labels:{'com.docker.compose.service':service,'org.opencontainers.image.revision':revision}}});
const build={releaseSha:'new-release',images:[{target:'worker',id:'new-worker'},{target:'api',id:'new-api'},{target:'web',id:'new-web'}]};
const idle={identity:true,idle:true,queuedOrRunningJobs:0,leasedJobs:0,leasedMessages:0,activeRuns:0,pendingFormatDiagnostics:0};

test('old running and stopped images yield readable pending upgrade; service mappings include one-shots',()=>{
  const items=[container('worker'),container('worker-parse',{running:false}),container('api',{image:'old-api'}),
    container('migrate',{image:'old-api',running:false}),container('local-state-init',{image:'old-api',running:false}),container('postgres',{image:'postgres'})];
  const plan=pendingImageUpgrade(build,items);
  assert.equal(plan.state,'pending-upgrade');assert.equal(plan.services.length,5);
  assert.equal(plan.services.find(item=>item.service==='worker-parse').state,'exited');
  assert.equal(plan.services.find(item=>item.service==='migrate').expectedImage,'new-api');
  assert.equal(plan.services.find(item=>item.service==='local-state-init').expectedImage,'new-api');
  assert.equal(pendingImageUpgrade(build,[container('worker',{image:'new-worker'}),container('api',{image:'new-api'})]),null);
});

test('live upgrade requires actual idle verification; stopped stacks retain recovery path',()=>{
  assert.equal(ownedStartAction({ready:true},[container('api'),container('worker')]),'reuse');
  assert.equal(ownedStartAction({ready:false,pendingUpgrade:{}},[container('api'),container('worker')]),'verify-idle');
  assert.equal(ownedStartAction({ready:false,pendingUpgrade:{}},[container('api',{running:false}),container('worker',{running:false})]),'start');
  assert.throws(()=>ownedStartAction({ready:false},[container('api',{running:false}),container('worker')]),/cannot verify/);
  assert.throws(()=>ownedStartAction({ready:false},[container('api-legacy')]),/cannot verify/);
});

test('retired legacy API requires an idle upgrade while stopped retained containers do not block readiness',()=>{
  const legacy=container('api-legacy',{image:'old-api'});
  const plan=pendingImageUpgrade(build,[legacy]);
  assert.equal(plan.services[0].action,'stop-retired-service');
  assert.equal(plan.services[0].expectedImage,null);
  assert.equal(ownedStartAction({ready:false},[container('api'),legacy]),'verify-idle');
  assert.equal(pendingImageUpgrade(build,[container('api-legacy',{image:'old-api',running:false})]),null);
});

test('idle stop retires the owned orphan before Compose and leaves a restartable retained stack',async()=>{
  const items=[container('api',{image:'new-api'}),container('api-legacy',{image:'old-api'}),container('worker',{image:'new-worker'}),
    container('postgres',{image:'postgres'}),{...container('api-legacy',{running:false}),Id:'previous-stopped-legacy'}];
  const events=[];
  assertIdleWorkload({code:0,stdout:JSON.stringify(idle)});
  await stopOwnedStack(items,{
    stopContainer:async id=>{events.push(['stop-container',id]);const item=items.find(item=>item.Id===id);item.State.Running=false;item.State.Status='exited';},
    stopCompose:async()=>{
      events.push(['compose-stop']);
      // The new Compose model deliberately excludes api-legacy. Its normal stop
      // therefore cannot retire that orphan or make this scenario restartable.
      for(const item of items)if(item.Config.Labels['com.docker.compose.service']!=='api-legacy'){
        item.State.Running=false;item.State.Status='exited';
      }
    },
  });
  assert.deepEqual(events,[['stop-container','api-legacy'],['compose-stop']]);
  assert.equal(items.some(item=>item.State.Running),false);
  assert.equal(ownedStartAction({ready:false},items),'start');
  assert.equal(pendingImageUpgrade(build,items),null,'retained stopped legacy containers do not hold readiness false');
});

test('failed orphan stop keeps the main API and database running for the next idle proof',async()=>{
  const items=[container('api'),container('api-legacy'),container('postgres')],events=[];
  await assert.rejects(stopOwnedStack(items,{
    stopContainer:async id=>{events.push(['stop-container',id]);throw Error('synthetic Docker stop failure');},
    stopCompose:async()=>{events.push(['compose-stop']);},
  }),/synthetic Docker stop failure/);
  assert.deepEqual(events,[['stop-container','api-legacy']]);
  assert.equal(items.every(item=>item.State.Running),true);
  assert.equal(ownedStartAction({ready:false},items),'verify-idle');
});

test('queued work, active runs, all leases and Word sidecars reject even a falsely idle successful probe',()=>{
  assert.deepEqual(assertIdleWorkload({code:0,stdout:JSON.stringify(idle)}),idle);
  for(const field of ['queuedOrRunningJobs','leasedJobs','leasedMessages','activeRuns','pendingFormatDiagnostics'])
    assert.throws(()=>assertIdleWorkload({code:0,stdout:JSON.stringify({...idle,[field]:1})}),/active or unverifiable/);
  for(const probe of [{code:76,stdout:JSON.stringify(idle)},{code:77,stdout:'{}'},{code:0,stdout:'bad-json'},
    {code:0,stdout:JSON.stringify({...idle,identity:false})},{code:0,stdout:JSON.stringify({...idle,idle:false})}])
    assert.throws(()=>assertIdleWorkload(probe),/active or unverifiable/);
});

test('Compose uses the published receipt even when inherited or operator settings name another build',()=>{
  const inherited={BB_IMAGE_TAG:'previous-tag',OTHER_SETTING:'preserved'};
  const environment=composeEnvironment({tag:'local-prelaunch-1234-abcd-5678'},inherited);
  assert.equal(environment.BB_IMAGE_TAG,'local-prelaunch-1234-abcd-5678');
  assert.equal(environment.OTHER_SETTING,'preserved');
  assert.equal(inherited.BB_IMAGE_TAG,'previous-tag');
  for(const tag of [undefined,'','not-built','image:latest','local-prelaunch-123\nOTHER=1'])
    assert.throws(()=>composeEnvironment({tag},{}),/Invalid published/);
});

test('failed receipt publication preserves last completed build and leaves no partial alias',()=>{
  const directory=mkdtempSync(join(tmpdir(),'bb-prelaunch-publication-'));
  const alias=join(directory,'build.json'),occupied=join(directory,'occupied');
  try{
    atomicWriteJson(alias,{tag:'last-completed',images:['previous-image']});
    const previous=readFileSync(alias,'utf8');
    assert.throws(()=>atomicWriteJson(alias,{tag:'failed',unserializable:1n}));
    assert.equal(readFileSync(alias,'utf8'),previous);
    mkdirSync(occupied);writeFileSync(join(occupied,'marker'),'retained');
    assert.throws(()=>atomicWriteJson(occupied,{tag:'cannot-publish'}));
    assert.equal(readFileSync(join(occupied,'marker'),'utf8'),'retained');
    assert.deepEqual(readdirSync(directory).sort(),['build.json','occupied']);
    atomicWriteJson(alias,{tag:'next-completed',images:['new-image']});
    assert.deepEqual(JSON.parse(readFileSync(alias,'utf8')),{tag:'next-completed',images:['new-image']});
  }finally{
    // Only the exact files created by this test are removed; no recursive delete.
    rmSync(alias,{force:true});rmSync(join(occupied,'marker'),{force:true});
    rmdirSync(occupied);rmdirSync(directory);
  }
});
