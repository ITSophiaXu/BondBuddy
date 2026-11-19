import test from 'node:test';import assert from 'node:assert/strict';
const base=process.env.BB_CANCELLATION_EMITS?new URL('file://'+process.env.BB_CANCELLATION_EMITS+'/'):new URL('../dist/',import.meta.url);
const {renewModelCapacity}=await import(new URL('model-capacity-renewal.js',base));
const {modelCancellationDiagnostic}=await import(new URL('model-call-budget.js',base));
test('unavailable fresh connection preserves the original connection timeout category without raw messages',async()=>{
 const error=Error('Connection terminated due to connection timeout');
 const sessions={options:{host:'127.0.0.1',port:1,connectionTimeoutMillis:100},connect:async()=>{throw error;}};
 await assert.rejects(renewModelCapacity({sessions,token:'synthetic',host:'test',signal:new AbortController().signal,
   scope:'run:synthetic-connect-timeout',lastConfirmed:Date.now(),eventLoopLagMs:0}),e=>e===error);
 const diagnostic=modelCancellationDiagnostic(error,'capacity_renewal','renewal');
 assert.equal(diagnostic.error_class,'pg_connect_timeout');assert.equal(diagnostic.original_error_code,null);
 assert.ok(!JSON.stringify(diagnostic).includes('Connection terminated'));
});
