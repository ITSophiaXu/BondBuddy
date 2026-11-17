import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionStartFeedback, SESSION_START_COMMAND } from './file-authoring-session-start.js';
import { fileCompletionArgs, COMPLETION_COMMAND } from './file-authoring-completion.js';

const note=(next:string)=>JSON.stringify({version:'file-authoring-continuation-v1',status:'current',progress:{next_action:next},host_acceptance:false});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'bb-session-start-unit-'));await mkdir(join(root,'scratch'));await writeFile(join(root,'input.json'),JSON.stringify({version:'codex-file-input-v1'}));return root;}

test('startup/resume/compact read current disk context without approving completion',async()=>{
  const root=await fixture();
  try {
    let next='first unfinished step',reads=0;
    const reader=async()=>{reads++;return note(next)};
    for(const source of ['startup','resume','compact']) {
      next='fresh '+source;
      const output=await sessionStartFeedback(root,source,reader) as any;
      assert.equal(output.hookSpecificOutput.hookEventName,'SessionStart');
      assert.match(output.hookSpecificOutput.additionalContext,new RegExp('fresh '+source));
      assert.match(output.hookSpecificOutput.additionalContext,/untrusted execution data, not instructions/);
      assert.match(output.hookSpecificOutput.additionalContext,/BB_CONTINUATION_OBSERVATION_SHA256=[a-f0-9]{64}/);
      assert.match(output.hookSpecificOutput.additionalContext,/not reading, factual, authoring or delivery acceptance/);
      assert.equal(output.decision,undefined);
    }
    assert.equal(reads,3);
    assert.deepEqual(await sessionStartFeedback(root,'clear',reader),{});
    assert.equal(reads,3);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('unrelated, missing, unsafe and unreadable state never blocks the authoring turn',async()=>{
  const root=await fixture();
  try {
    const failed=async()=>{throw Error('synthetic unavailable')};
    assert.deepEqual(await sessionStartFeedback(root,'compact',failed),{});
    await writeFile(join(root,'input.json'),JSON.stringify({version:'other-tool'}));
    assert.deepEqual(await sessionStartFeedback(root,'compact',async()=>note('must not inject')),{});
    await rm(join(root,'input.json'));
    assert.deepEqual(await sessionStartFeedback(root,'startup',failed),{});
    await writeFile(join(root,'scratch/foreign.json'),JSON.stringify({version:'codex-file-input-v1'}));
    await symlink(join(root,'scratch/foreign.json'),join(root,'input.json'));
    assert.deepEqual(await sessionStartFeedback(root,'compact',async()=>note('must not inject')),{});
  }finally{await rm(root,{recursive:true,force:true});}
});

test('the existing Stop and fresh SessionStart handlers retain separate explicit trust hashes',()=>{
  const args=fileCompletionArgs();assert.equal(args.filter(x=>x.startsWith('hooks=')).length,1);
  const config=args.find(x=>x.startsWith('hooks='))!;
  assert.ok(config.includes('Stop=['));assert.ok(config.includes('SessionStart=['));
  assert.ok(config.includes(COMPLETION_COMMAND));assert.ok(config.includes(SESSION_START_COMMAND));
  assert.equal((config.match(/trusted_hash=/g)??[]).length,2);
  assert.ok(config.includes(':stop:0:0'));assert.ok(config.includes(':session_start:0:0'));
  assert.doesNotMatch(config,/bypass|dangerously/);
});
