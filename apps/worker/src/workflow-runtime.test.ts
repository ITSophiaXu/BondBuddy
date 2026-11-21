import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import type {PrivateBlobs} from '@bondbuddy/api/data';
import {workerRuntimeOptionsFromEnv} from './runtime.js';

const opts=(env:NodeJS.ProcessEnv)=>workerRuntimeOptionsFromEnv({} as Pool,{} as PrivateBlobs,{BB_WORKER_JOB_KINDS:'run',...env});
test('workflow startup needs explicit version, phase, durable disk and token budget',()=>{
  assert.throws(()=>opts({BB_WORKFLOW_V1:'1'}),/WORKFLOW_RUNTIME_CONFIGURATION_REQUIRED/);
  assert.throws(()=>opts({BB_WORKFLOW_PHASE:'authoring'}),/CONFLICT/);
  const result=opts({BB_WORKFLOW_V1:'1',BB_WORKFLOW_PHASE:'postprocess',BB_DURABLE_SPOOL_ROOT:'/var/lib/bondbuddy/spool',BB_WORKFLOW_WORK_ROOT:'/var/lib/bondbuddy/workflow',BB_WORKFLOW_TOKEN_LIMIT:'1000000'});
  assert.equal(result.workflowPhase,'postprocess');
  assert.equal(result.concurrency,1);
  const mixed=opts({BB_WORKFLOW_V1:'1',BB_WORKFLOW_PHASE:'mixed',BB_DURABLE_SPOOL_ROOT:'/var/lib/bondbuddy/spool',BB_WORKFLOW_WORK_ROOT:'/var/lib/bondbuddy/workflow',BB_WORKFLOW_TOKEN_LIMIT:'1000000'});
  assert.equal(mixed.concurrency,2);assert.equal(mixed.interactiveSlots,0);
  assert.equal(opts({}).workflowPhase,undefined);
});
