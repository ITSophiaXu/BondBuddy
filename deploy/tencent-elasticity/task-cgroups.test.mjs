import test from 'node:test';
import assert from 'node:assert/strict';
import {taskCgroupUnit,assertTaskCgroupServiceIdle} from './task-cgroups.mjs';
import {verifyTaskExecutionImage} from './node-adapter.mjs';

test('host unit permits only the actual service subtree and confined metadata reads',()=>{
 const input={service:'authoring',session:'12345678-1234-1234-1234-123456789abc',
  group:'/system.slice/docker-synthetic.scope',brokerPath:'/opt/bondbuddy/deploy/tencent-elasticity/task-cgroup-broker.py'};
 const unit=taskCgroupUnit(input);
 assert.match(unit,/AppArmorProfile=bondbuddy-task-cgroups-v1/);
 assert.match(unit,/ReadOnlyPaths=\/sys\/fs\/cgroup\n/);
 assert.match(unit,/ReadWritePaths=\/sys\/fs\/cgroup\/system.slice\/docker-synthetic.scope \/var\/lib\/bondbuddy\/task-cgroups\/12345678-1234-1234-1234-123456789abc \/run\/bondbuddy\/task-cgroups\/authoring\n/);
 assert.match(unit,/NoNewPrivileges=yes/);
 assert.match(unit,/InaccessiblePaths=-\/run\/docker.sock -\/var\/run\/docker.sock -\/run\/containerd -\/etc\/bondbuddy/);
 assert.match(unit,/RestrictNamespaces=yes/);
 assert.doesNotMatch(unit,/CAP_SYS_ADMIN|privileged/);
 for(const delta of [{group:'/'},{group:'/../../outside'},{service:'api'},{brokerPath:'/tmp/task-cgroup-broker.py'}])
  assert.throws(()=>taskCgroupUnit({...input,...delta}),/TASK_CGROUP/);
});

test('a live or unobservable prior broker refuses a service replacement',async()=>{
 const calls=[];
 await assert.rejects(assertTaskCgroupServiceIdle('review',async args=>{calls.push(args);return {stdout:'active\n'};}),/LIVE_REPLACEMENT/);
 assert.deepEqual(calls,[['is-active','bondbuddy-task-cgroups-review.service']]);
 await assert.rejects(assertTaskCgroupServiceIdle('review',async()=>{throw Error('unknown state');}),/LIVE_REPLACEMENT/);
 await assertTaskCgroupServiceIdle('review',async()=>({stdout:'inactive\n'}));
});

test('image compatibility is a mandatory isolated executable proof, not digest existence',async()=>{
 const calls=[],image='sha256:'+'a'.repeat(64);
 await verifyTaskExecutionImage(image,async args=>{calls.push(args);return 'task-cgroup-v1';});
 assert.equal(calls.length,1);
 assert.deepEqual(calls[0].slice(0,15),['run','--rm','--pull','never','--network','none','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--entrypoint','node']);
 assert.equal(calls[0][15],image);
 assert.match(calls[0].at(-1),/TASK_CGROUP_PROTOCOL_VERSION/);
 await assert.rejects(verifyTaskExecutionImage(image,async()=>''),/NOT_PROVEN/);
 await assert.rejects(verifyTaskExecutionImage('mutable-tag',async()=>{assert.fail('must not run');}),/DIGEST_REQUIRED/);
});
