import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256 } from '../host-dispatch-protocol.mjs';
import { DEVELOPMENT_KEY } from '../capabilities.mjs';
import { billingHostEnvironment, prepareBillingDependencies, verifyBillingSource } from './windows-billing.mjs';
import { DOCKER_TESTS, validateDockerConfig, withinScratch } from './docker-cases.mjs';

export function validateDockerTestRequest({ candidate, runId, entry, runtime }) {
  assert.match(candidate.commit, /^[a-f0-9]{40}$/); assert.match(candidate.tree, /^[a-f0-9]{40}$/);
  assert.match(runId, /^[a-zA-Z0-9-]{8,80}$/);
  assert.ok(DOCKER_TESTS[entry.testId]); assert.equal(entry.profileId, DOCKER_TESTS[entry.testId]);
  assert.equal(entry.runPath, entry.testId); assert.equal(entry.runner, 'node'); assert.equal(entry.shard, 'misc');
  assert.equal(entry.fileTimeoutMs, 300000); assert.ok(Number.isSafeInteger(entry.sequence) && entry.sequence >= 0);
  for (const key of ['args','argv','env','command','cwd','executable']) assert.equal(Object.hasOwn(entry,key), false);
  assert.deepEqual(runtime?.candidate, candidate); assert.equal(runtime.runId, runId);
  assert.match(runtime.imageId, /^sha256:[a-f0-9]{64}$/); assert.equal(runtime.imageId, runtime.evidence.image_id);
}

import { verifyDockerTestEvidence } from '../docker-evidence.mjs';
export { verifyDockerTestEvidence } from '../docker-evidence.mjs';

export async function executeDockerTests(options) {
  validateDockerTestRequest(options);
  assert.equal(process.platform, 'win32', 'This adapter uses the existing Windows host and dependency cache');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22);
  const { candidate, runId, entry, runtime, signal } = options;
  const source = realpathSync(options.sourceRoot), out = resolve(options.evidenceRoot), scratch = join(out,'scratch');
  assert.ok(lstatSync(out).isDirectory() && !lstatSync(out).isSymbolicLink()); mkdirSync(scratch);
  const env = { ...billingHostEnvironment(), TEMP: scratch, TMP: scratch, TMPDIR: scratch };
  const prefix = 'bb-pr-gate-docker-' + runId + '-' + entry.sequence;
  const evidence = { ...candidate, run_id:runId, test_id:entry.testId, profile_id:entry.profileId, started_at:new Date().toISOString(),
    commands:[], resources:[], models:0, source_bundle_sha256:runtime.evidence.bundle_sha256, cleanup:{status:'pending'} };
  const save = () => writeFileSync(join(out,'evidence.json'), JSON.stringify(evidence,null,2)+'\n'); save();
  let commandIndex = 0;
  const command = async (label, executable, args, { timeout=30000, cleanup=false, commandEnv=env }={}) => {
    if (signal?.aborted && !cleanup) throw new Error('Host Docker capability cancelled');
    const started=Date.now(); let child, timedOut=false, cancelled=false, outputLimit=false, spawnError, stdout='', stderr='';
    const kill = () => {
      if (!child?.pid) return;
      if (process.platform==='win32') spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{env,windowsHide:true,stdio:'ignore'});
      else { try {process.kill(-child.pid,'SIGKILL');} catch {child.kill('SIGKILL');} }
    };
    const abort=()=>{cancelled=true;kill();};
    const result=await new Promise(done=>{
      child=spawn(executable,args,{cwd:source,env:commandEnv,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
      const timer=setTimeout(()=>{timedOut=true;kill();},timeout);
      if(!cleanup){signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();}
      child.stdout.on('data',data=>{stdout+=data;if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>8*1024*1024){outputLimit=true;kill();}});
      child.stderr.on('data',data=>{stderr+=data;if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>8*1024*1024){outputLimit=true;kill();}});
      child.once('error',error=>{spawnError=error;});
      child.once('close',(code,childSignal)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);done({code,signal:childSignal});});
    });
    const stem=String(commandIndex++).padStart(3,'0')+'-'+label;
    writeFileSync(join(out,stem+'.stdout.log'),stdout);writeFileSync(join(out,stem+'.stderr.log'),stderr);
    const recorded={label,executable,args,cwd:source,started_at:new Date(started).toISOString(),durationMs:Date.now()-started,...result,
      timedOut,cancelled,output_limit_failed:outputLimit,stdout_sha256:sha256(stdout),stderr_sha256:sha256(stderr),timeout_ms:timeout};
    evidence.commands.push(recorded);save();
    if(spawnError||cancelled||outputLimit)throw new Error(label+': '+(spawnError?.message??(cancelled?'cancelled':'output limit')));
    return {...result,timedOut,stdout,stderr,durationMs:recorded.durationMs,recorded};
  };
  const docker=async(label,args,opts)=>{
    const result=await command(label,'docker',['--context',runtime.context,...args],opts);
    assert.equal(result.timedOut,false,label+' timed out');assert.equal(result.code,0,result.stderr);return result.stdout.trim();
  };
  let execution,failure,networkId,azuriteId,ownsScope=false;
  const trace=join(out,'cases.json');writeFileSync(trace,'[]\n',{flag:'wx'});
  const config={...candidate,run_id:runId,test_id:entry.testId,profile_id:entry.profileId,prefix,image:runtime.imageId,
    context:runtime.context,scratch,trace};
  try {
    evidence.source_before=verifyBillingSource(source,candidate,env);
    evidence.source_sha256=sha256(readFileSync(join(source,entry.testId)));assert.equal(evidence.source_sha256,entry.sourceSha256);
    evidence.engine_endpoint=await docker('engine-endpoint',['context','inspect','--format','{{.Endpoints.docker.Host}}']);
    assert.match(evidence.engine_endpoint,/^(unix|npipe):\/\//,'Only local Docker engines are accepted');
    assert.equal(await docker('worker-image',['image','inspect',runtime.imageId,'--format','{{.Id}}']),runtime.imageId);
    assert.equal(await docker('scope-must-be-new',['ps','-a','--filter','label=bondbuddy.pr-gate.scope='+prefix,'--format','{{.ID}}']),'','Never adopt an existing Docker test scope');
    ownsScope=true;
    if(entry.profileId==='docker-backup'){
      evidence.dependencies=prepareBillingDependencies(source,options.dependencyRoot);
      config.app_volume=runtime.volume;config.network=prefix+'-network';config.azurite_name=prefix+'-azurite';
      config.azurite_image=await docker('azurite-image',['image','inspect','mcr.microsoft.com/azure-storage/azurite:3.35.0','--format','{{.Id}}']);
      assert.match(config.azurite_image,/^sha256:[a-f0-9]{64}$/);
      const absent=await command('network-must-be-new','docker',['--context',runtime.context,'network','inspect',config.network]);
      assert.ok(absent.code!==0&&/no such network|not found/i.test(absent.stderr));
      networkId=await docker('network-create',['network','create','--internal','--label','bondbuddy.pr-gate.run='+runId,'--label','bondbuddy.pr-gate.scope='+prefix,config.network]);
      evidence.resources.push({kind:'network',id:networkId,name:config.network});save();
      const network=JSON.parse(await docker('network-identity',['network','inspect',networkId]))[0];
      assert.equal(network.Id,networkId);assert.equal(network.Name,config.network);assert.equal(network.Internal,true);
      evidence.network={id:networkId,name:config.network,internal:true};
      const azuriteData=join(scratch,'azurite');mkdirSync(azuriteData);
      const azuriteAbsent=await command('azurite-must-be-new','docker',['--context',runtime.context,'inspect',config.azurite_name]);
      assert.ok(azuriteAbsent.code!==0&&/no such (object|container)/i.test(azuriteAbsent.stderr));
      azuriteId=await docker('azurite-create',['create','--pull','never','--name',config.azurite_name,'--label','bondbuddy.pr-gate.run='+runId,
        '--label','bondbuddy.pr-gate.scope='+prefix,'--network',config.network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
        '--user','1000:1000','--cpus','1','--memory','512m','--pids-limit','128','--mount',`type=bind,source=${azuriteData},target=/data`,
        '-p','127.0.0.1::10000',config.azurite_image,'azurite-blob','--blobHost','0.0.0.0','--location','/data','--skipApiVersionCheck','--disableProductStyleUrl']);
      assert.match(azuriteId,/^[a-f0-9]{64}$/);evidence.resources.push({kind:'azurite',id:azuriteId,name:config.azurite_name,image:config.azurite_image});save();
      await docker('azurite-start',['start',azuriteId]);
      const state=JSON.parse(await docker('azurite-identity',['inspect',azuriteId]))[0];
      assert.equal(state.Image,config.azurite_image);assert.equal(state.HostConfig.NetworkMode,config.network);
      const bound=state.NetworkSettings.Ports['10000/tcp'];assert.equal(bound.length,1);assert.equal(bound[0].HostIp,'127.0.0.1');
      assert.match(bound[0].HostPort,/^[1-9][0-9]*$/);
      evidence.azurite={name:config.azurite_name,image:config.azurite_image,host_ip:'127.0.0.1',host_port:bound[0].HostPort};
      const connection=endpoint=>`DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${DEVELOPMENT_KEY};BlobEndpoint=http://${endpoint}/devstoreaccount1;`;
      config.host_connection=connection('127.0.0.1:'+bound[0].HostPort);config.container_connection=connection(config.azurite_name+':10000');
    }
    validateDockerConfig(config,entry.testId);evidence.configuration=config;save();
    const configPath=join(out,'configuration.json');writeFileSync(configPath,JSON.stringify(config,null,2)+'\n',{flag:'wx'});
    const result=await command('original-test',process.execPath,['--test','--test-reporter=tap',entry.runPath],{timeout:entry.fileTimeoutMs,
      commandEnv:{...env,BB_PR_GATE_DOCKER_TEST_CONFIG:configPath,...(entry.profileId==='docker-credentials'?{BB_RELEASE_CREDENTIAL_TEST_IMAGE:runtime.imageId}:{})}});
    evidence.original_command=result.recorded;
    const {recorded,...value}=result;execution=value;
  } catch(error){failure=error;}
  finally {
    const cleanupErrors=[];
    const attempt=async task=>{try{await task();}catch(error){cleanupErrors.push(error.message);}};
    if(ownsScope)await attempt(async()=>{
      // Reap only exact names, images and labels created for this invocation.
      const found=(await docker('cleanup-inventory',['ps','-a','--filter','label=bondbuddy.pr-gate.scope='+prefix,'--format','{{.ID}}'],{cleanup:true})).split(/\s+/).filter(Boolean);
      for(const shortId of found){
        const value=JSON.parse(await docker('cleanup-identity',['inspect',shortId],{cleanup:true}))[0];
        assert.equal(value.Config.Labels['bondbuddy.pr-gate.run'],runId);assert.equal(value.Config.Labels['bondbuddy.pr-gate.scope'],prefix);
        assert.ok(value.Name==='/'+prefix+'-azurite'||new RegExp('^/'+prefix+'-case-[1-5]$').test(value.Name));
        assert.equal(value.Image,value.Name.endsWith('-azurite')?config.azurite_image:runtime.imageId);
        await docker('cleanup-container',['rm','--force','--volumes',value.Id],{cleanup:true});
        const absent=await command('cleanup-container-absent','docker',['--context',runtime.context,'inspect',value.Id],{cleanup:true});
        assert.ok(absent.code!==0&&/no such (object|container)/i.test(absent.stderr));
      }
    });
    if(networkId&&cleanupErrors.length===0)await attempt(async()=>{
      const value=JSON.parse(await docker('cleanup-network-identity',['network','inspect',networkId],{cleanup:true}))[0];
      assert.equal(value.Id,networkId);assert.equal(value.Name,config.network);assert.equal(value.Labels['bondbuddy.pr-gate.scope'],prefix);
      assert.equal(value.Labels['bondbuddy.pr-gate.run'],runId);assert.equal(Object.keys(value.Containers??{}).length,0);
      await docker('cleanup-network',['network','rm',networkId],{cleanup:true});
      const absent=await command('cleanup-network-absent','docker',['--context',runtime.context,'network','inspect',networkId],{cleanup:true});
      assert.ok(absent.code!==0&&/no such network|not found/i.test(absent.stderr));
    });
    await attempt(async()=>{evidence.cases=JSON.parse(readFileSync(trace,'utf8'));});
    await attempt(async()=>{evidence.source_after=verifyBillingSource(source,candidate,env);assert.deepEqual(evidence.source_after,evidence.source_before);});
    if(cleanupErrors.length===0)await attempt(async()=>{
      assert.equal(realpathSync(scratch),scratch);assert.ok(!lstatSync(scratch).isSymbolicLink());withinScratch(out,scratch);rmSync(scratch,{recursive:true});
    });
    evidence.cleanup={status:cleanupErrors.length?'failed':'passed',errors:cleanupErrors};evidence.finished_at=new Date().toISOString();save();
    if(cleanupErrors.length)failure=new Error([failure?.message,...cleanupErrors].filter(Boolean).join('; '));
  }
  if(failure){failure.execution=execution;failure.evidence=evidence;throw failure;}
  if(execution.code===0)try{verifyDockerTestEvidence(evidence,entry,runtime.evidence);}catch(error){error.execution=execution;error.evidence=evidence;throw error;}
  return {execution,evidence};
}
