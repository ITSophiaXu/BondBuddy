import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Pool} from 'pg';
import {resumeEvidenceGate} from './evidence-gate.js';

test('ordinary evidence resume cannot remove a database restore quarantine',async()=>{
  let inserts=0;
  const client={release(){},async query(sql:string){
    if(sql.includes('SELECT state,reason_code'))return {rows:[{state:'paused',reason_code:'database_restore_quarantine',created_at:new Date()}]};
    if(sql.includes('INSERT INTO bb_evidence_gate_events'))inserts++;
    return {rows:[],rowCount:0};
  }};
  const pool={async connect(){return client;}} as unknown as Pool;
  await assert.rejects(resumeEvidenceGate(pool,'synthetic-operator','manual_resume'),
    (error:unknown)=>(error as {code?:string}).code==='RESTORE_QUARANTINE_REQUIRES_RECONCILIATION');
  assert.equal(inserts,0);
});
