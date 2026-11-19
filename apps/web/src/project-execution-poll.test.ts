import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Exercise the controller's real polling path without mounting unrelated DOM/CSS modules.
function controller(api: unknown, delivered: () => void) {
  const source=readFileSync(new URL('../src/project-execution.ts',import.meta.url),'utf8');
  const exports:Record<string,any>={};
  runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
    {exports,require:()=>({onTaskRestart:()=>{}}),AbortController,URLSearchParams,location:{hash:''},setTimeout,clearTimeout});
  const execution=new exports.ProjectExecution(api,{project:{project_id:'synthetic'}},{},undefined,undefined,'',delivered);
  execution.render=()=>{};execution.loadCharge=async()=>{};
  return execution;
}
const running={run_id:'run-1',project_id:'synthetic',state:'running',stage:'word_delivery',event_cursor:0};
const succeeded={...running,state:'succeeded',stage:'completed'};

test('polling completion refreshes version history once and retains event reads',async()=>{
  let delivered=0,eventReads=0;
  const execution=controller({run:async()=>succeeded,runEvents:async()=>{eventReads++;return {items:[],next_cursor:null};}},()=>{delivered++;});
  execution.run=running;
  await execution.poll();
  assert.equal(delivered,1);assert.equal(eventReads,1);assert.equal(execution.run.state,'succeeded');
  await execution.poll();
  assert.equal(delivered,1);assert.equal(eventReads,2);
  execution.dispose();
});

test('a superseded polling response cannot refresh history for a different run',async()=>{
  let release!:(run:unknown)=>void,delivered=0;
  const execution=controller({run:()=>new Promise(resolve=>{release=resolve;})},()=>{delivered++;});
  execution.run=running;
  const poll=execution.poll();
  execution.acceptRun({...succeeded,run_id:'run-2'});
  assert.equal(delivered,1);
  release(succeeded);await poll;
  assert.equal(delivered,1);assert.equal(execution.run.run_id,'run-2');
  execution.dispose();
});
