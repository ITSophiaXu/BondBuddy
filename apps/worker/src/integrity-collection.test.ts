import test from 'node:test';
import assert from 'node:assert/strict';
import {INTEGRITY_SITES} from '@bondbuddy/contracts';
import {collectIntegritySite} from './integrity-browser-stage.js';
const site=INTEGRITY_SITES.find(s=>s.id==='emergency')!;
const subject={name:'合成企业',kind:'company' as const,province:'河南',city:''};
test('site-local browser failure becomes an incomplete record; cancellation still stops collection',async()=>{
 const r=await collectIntegritySite(async()=>{throw Error('INTEGRITY_NATIVE_PANEL_UNAVAILABLE');},site,subject,new AbortController().signal);
 assert.equal(r.outcome,'failed');assert.equal(r.search_performed,false);assert.deepEqual(r.captures,[]);assert.equal(r.diagnostic?.detail,'INTEGRITY_NATIVE_PANEL_UNAVAILABLE');
 const privateError=await collectIntegritySite(async()=>{throw Error('browser failed: secret/path?token=private');},site,subject,new AbortController().signal);
 assert.equal(privateError.diagnostic?.detail,'INTEGRITY_BROWSER_RUNTIME_FAILED');assert.doesNotMatch(JSON.stringify(privateError),/secret|token|private/);
 const c=new AbortController();c.abort();await assert.rejects(collectIntegritySite(async()=>{throw Error('closed');},site,subject,c.signal),{name:'AbortError'});
});
