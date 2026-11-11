import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import {int64} from '@bondbuddy/contracts';
import { grantCredits, lockCreditAccount } from './billing.js';
import { missing, Problem, transaction } from './data.js';
import {auditCredits} from './billing-audit.js';
import {scanAndIsolateBilling,repairWalletProjection,resumeBillingScope,billingAuditHash} from './billing-safety.js';

/** Correct an erroneous settled charge by an appended credit, never changing history. */
export async function correctSettlement(pool:Pool,input:{runId:string;actor:string;reason:string}){
  if(!input.actor?.trim()||!input.reason?.trim())throw new Problem(422,'VALIDATION_FAILED','Actor and correction reason required');
  return transaction(pool,async c=>{
    const row=(await c.query('SELECT * FROM bb_credit_reservations WHERE run_id=$1',[input.runId])).rows[0];if(!row)throw missing();
    await lockCreditAccount(c,row.owner_user_id);
    const r=(await c.query('SELECT * FROM bb_credit_reservations WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
    if(r.state!=='settled')throw new Problem(409,'VALIDATION_FAILED','Only an existing settled charge can be corrected');
    const returned=(await c.query("SELECT COALESCE(sum(points),0)::text points FROM bb_credit_events WHERE reservation_id=$1 AND kind='correction'",[r.id])).rows[0];
    if(int64(returned.points)>int64(r.charged_points??r.points))
      throw new Problem(409,'DATA_UNAVAILABLE','Historical task returns exceed the actual charge and require independent verification');
    // A whole-settlement repair returns only the still-unreturned original lot
    // slices. This shares the account lock with customer task-refund approval.
    if((await c.query('SELECT 1 FROM bb_credit_allocations WHERE reservation_id=$1 AND bb_credit_allocation_charge(reservation_id,lot_id) IS NULL',[r.id])).rowCount)
      throw new Problem(409,'DATA_UNAVAILABLE','Actual original charge allocations require verification');
    const allocations=(await c.query(`SELECT bb_credit_allocation_charge(a.reservation_id,a.lot_id)-COALESCE(t.points,0) AS points,l.id,l.source,l.expires_at
      FROM bb_credit_allocations a JOIN bb_credit_lots l ON l.id=a.lot_id
      LEFT JOIN LATERAL(SELECT sum(points) points FROM bb_task_refund_credits WHERE reservation_id=a.reservation_id AND origin_lot_id=a.lot_id) t ON true
      WHERE a.reservation_id=$1 AND bb_credit_allocation_charge(a.reservation_id,a.lot_id)-COALESCE(t.points,0)>0 ORDER BY l.id`,[r.id])).rows;
    const lots:string[]=[];
    for(const a of allocations){
      const key=`settlement-correction:${r.id}:${a.id}`;
      const existing=(await c.query('SELECT expires_at FROM bb_credit_lots WHERE owner_user_id=$1 AND source_key=$2',[r.owner_user_id,key])).rows[0];
      const expiry=existing?existing.expires_at:a.expires_at&&new Date(a.expires_at).getTime()<=Date.now()?new Date(Date.now()+7*86400000):a.expires_at;
      lots.push(await grantCredits(c,{owner:r.owner_user_id,source:a.source==='purchase'?'purchase':a.source==='subscription'?'subscription':'correction',key,points:int64(a.points),expiresAt:expiry?new Date(expiry).toISOString():null,
        actor:input.actor,reason:input.reason,reservationId:r.id,runId:r.run_id}));
    }
    return lots;
  });
}
export {auditCreditClient,auditCredits} from './billing-audit.js';

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  try{
    if(!process.env.DATABASE_URL)throw Error('DATABASE_URL required');
    const [command,file]=process.argv.slice(2),input=file?JSON.parse(readFileSync(file,'utf8')):null;
    if(command==='prices')throw new Problem(409,'QUOTE_CHANGED','Legacy price publication is retired; use automatic outcome pricing');
    else if(command==='correct-settlement')process.stdout.write(JSON.stringify({credit_lot_id:await correctSettlement(pool,input)})+'\n');
    else if(command==='audit'){
      if(input?.owner!==undefined&&(typeof input.owner!=='string'||!input.owner.trim()))throw Error('Audit owner must be an exact nonempty user ID');
      const report=await auditCredits(pool,input?.owner);process.stdout.write(JSON.stringify({...report,owner:input?.owner??null,audit_hash:billingAuditHash(report)},null,2)+'\n');if(!report.consistent)process.exitCode=1;
    }else if(command==='safety-scan'){
      process.stdout.write(JSON.stringify(await scanAndIsolateBilling(pool),null,2)+'\n');
    }else if(command==='repair-wallet-projection'){
      process.stdout.write(JSON.stringify(await repairWalletProjection(pool,input),null,2)+'\n');
    }else if(command==='safety-resume'){
      // No caller JSON can fabricate an authenticated channel verification.
      // Channels remain isolated until a trusted verifier supplies fresh evidence.
      process.stdout.write(JSON.stringify(await resumeBillingScope(pool,input),null,2)+'\n');
    }else if(command==='import-verified-right'){
      if(!input?.source_receipt||!['purchase','existing_grant'].includes(input.source))throw Error('Verified source receipt and original right type required; never import demo balances');
      await transaction(pool,c=>grantCredits(c,{...input,key:`legacy:${input.source_receipt}`,reason:`preserve_verified_right:${input.source_receipt}; ${input.reason}`}));
    }else throw Error('Use audit, safety-scan, repair-wallet-projection FILE, safety-resume FILE, correct-settlement FILE or import-verified-right FILE. Legacy prices publication is retired; new tasks use automatic outcome pricing.');
    if(!['audit','safety-scan','repair-wallet-projection','safety-resume'].includes(command))process.stdout.write('Applied idempotently; no run was started.\n');
  }finally{await pool.end();}
}
