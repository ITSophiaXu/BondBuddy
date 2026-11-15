import test from 'node:test';import assert from 'node:assert/strict';
const {PgModelCallBudget,modelCancellationDiagnostic}=await import(process.env.BB_CANCELLATION_EMITS+'/model-call-budget.js');
const capture=async fn=>{const old=process.stderr.write,logs=[];process.stderr.write=function(bytes){logs.push(String(bytes));return true;};try{return{value:await fn(),logs:logs.join('').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x))};}finally{process.stderr.write=old;}};
test('connection establishment failure still fences the permit and preserves its category through native cancellation',async()=>{
 const budget=new PgModelCallBudget({options:{}},4);let token;
 budget.sessions.query=async(q,args)=>{if(q.startsWith('SELECT * FROM bb_model_capacity_holders'))return{rows:[]};if(q.startsWith('INSERT INTO bb_model_capacity_waiters'))token=args[0];if(q.startsWith('UPDATE bb_model_capacity_holders'))throw new Error('Connection terminated due to connection timeout');return{rows:[],rowCount:1};};
 budget.sessions.connect=async()=>({query:async q=>q.includes('pg_try_advisory')?{rows:[{locked:true}]}:q.includes('SELECT w.token')?{rows:[{token}]}:q.includes('generate_series')?{rows:[{slot:1}]}:{rows:[],rowCount:1},release(){}});
 const permit=await budget.acquire(undefined,'run:synthetic-connect-timeout');try{
  const r=await capture(async()=>{await assert.rejects(permit.renew());});assert.equal(permit.signal.aborted,true);assert.equal(r.logs[0].error_class,'pg_connect_timeout');assert.equal(r.logs[0].original_error_code,null);
  const native=modelCancellationDiagnostic(permit.signal.reason,'capacity_signal','native');assert.equal(native.error_class,'pg_connect_timeout');assert.equal(native.source,'capacity_signal');assert.equal(native.phase,'native');assert.ok(!JSON.stringify(native).includes('Connection terminated'));
 }finally{await permit.release();await budget.sessions.end();}
});
