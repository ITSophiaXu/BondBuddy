import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {runtime} from './config.mjs';
import {sameIdentity,withLifecycleLock} from './processes.mjs';
import {startServices} from './lifecycle.mjs';

const file=join(runtime,'services.json');let original;
// Model an interrupted launch after the native receipt is durable but before state adoption.
await withLifecycleLock(runtime,async()=>{
  original=JSON.parse(readFileSync(file,'utf8'));assert.equal(original.ready,true);
  const pending=structuredClone(original),ref=pending.processes.blob;
  const receipt=JSON.parse(readFileSync(join(runtime,'launch-receipts',ref.launchId+'.json'),'utf8'));
  assert.ok(sameIdentity(receipt,ref));
  delete pending.processes.blob;pending.pending.blob={launchId:ref.launchId};pending.ready=false;
  writeFileSync(file,JSON.stringify(pending,null,2));
});
const restored=await startServices();
for(const [name,ref] of Object.entries(original.processes))assert.ok(sameIdentity(restored.processes[name],ref));
assert.deepEqual(restored.pending,{});assert.equal(restored.ready,true);
writeFileSync(join(runtime,'receipt-recovery-proof.json'),JSON.stringify({checkedAt:new Date().toISOString(),passed:true,allProcessesReused:true},null,2));
console.log('PASS durable launch receipt recovery reuses all five process identities');
