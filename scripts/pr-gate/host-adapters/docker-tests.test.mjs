import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDockerTestRequest, verifyDockerTestEvidence } from './docker-tests.mjs';
import { syntheticHostDispatch } from '../host-dispatch.test-fixture.mjs';

const candidate={commit:'a'.repeat(40),tree:'b'.repeat(40)};

test('Docker host requests reject unregistered files, commands, wider budgets and stale runtime',()=>{
  const dispatch=syntheticHostDispatch(candidate),entry=dispatch.plan.entries.find(row=>row.profileId==='docker-credentials');
  const options={candidate,runId:dispatch.plan.run_id,entry,runtime:{candidate,runId:dispatch.plan.run_id,imageId:dispatch.runtime.image_id,evidence:dispatch.runtime}};
  assert.doesNotThrow(()=>validateDockerTestRequest(options));
  for(const mutate of [v=>{v.entry.testId='scripts/other.test.mjs';},v=>{v.entry.env={DOCKER_HOST:'tcp://remote'};},v=>{v.entry.fileTimeoutMs++;},
    v=>{v.runtime.runId+='-old';},v=>{v.runtime.imageId='worker:latest';}]){
    const value=structuredClone(options);mutate(value);assert.throws(()=>validateDockerTestRequest(value));
  }
});

test('Docker receipts bind every original case to isolation, candidate, images and cleanup',()=>{
  for(const profile of ['docker-credentials','docker-backup']){
    const dispatch=syntheticHostDispatch(candidate),entry=dispatch.plan.entries.find(row=>row.profileId===profile);
    const evidence=dispatch.records.find(row=>row.profile_id===profile).evidence;
    assert.doesNotThrow(()=>verifyDockerTestEvidence(evidence,entry,dispatch.runtime));
    for(const mutate of [v=>{v.cases.pop();},v=>{v.cases[0].status=0===v.cases[0].status?1:0;},v=>{v.cases[0].cleanup.status='failed';},
      v=>{v.cases[0].isolation.network='host';},v=>{v.cases[0].isolation.mounts.push({destination:'/var/run/docker.sock'});},
      v=>{v.cases[0].isolation.rootfs_readonly=false;},v=>{v.configuration.image='worker:latest';},v=>{v.configuration.run_id+='-old';},
      v=>{v.source_sha256='0'.repeat(64);},v=>{v.source_after.files++;},v=>{delete v.source_before.manifest_sha256;},v=>{v.configuration.prefix+='-other';},
      v=>{v.source_root+='-other';},v=>{v.original_command.args.push('--test-name-pattern=partial');},
      v=>{v.original_command.timeout_ms++;},v=>{v.engine_endpoint='tcp://remote:2375';}]){
      const value=structuredClone(evidence);mutate(value);assert.throws(()=>verifyDockerTestEvidence(value,entry,dispatch.runtime));
    }
    if(profile==='docker-backup')for(const mutate of [v=>{v.network.internal=false;},v=>{v.azurite.host_ip='0.0.0.0';},v=>{v.dependencies.installed=true;}]){
      const value=structuredClone(evidence);mutate(value);assert.throws(()=>verifyDockerTestEvidence(value,entry,dispatch.runtime));
    }
  }
});
