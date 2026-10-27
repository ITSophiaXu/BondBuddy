// Read-only evidence from actual wallet HTTP and a single PostgreSQL RR snapshot.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {ProductionBrowser} from './run-supplement-production-real-harness';

type Row=Record<string,any>;
export type WalletSnapshot=Awaited<ReturnType<typeof captureWallet>>;
const sum=(rows:Row[],key:string)=>rows.reduce((n,row)=>n+Number(row[key]??0),0);
const reservation=(snapshot:WalletSnapshot,id:string)=>{
  const found=snapshot.database.tables.bb_credit_reservations.find(row=>row.id===id);
  assert.ok(found,`Expected reservation ${id}`);return found;
};

export async function captureWallet(r:ProductionBrowser,label:string){
  // HTTP uses its own transaction. Stable worker barriers/paused states and the
  // two equal HTTP observations bracket the RR sample; no shared MVCC is claimed.
  const before=await r.request('GET','/api/v1/credits/balance'),client=await r.pool.connect();
  let metadata:Row={},tables:Record<string,Row[]>={};
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    metadata=(await client.query("SELECT transaction_timestamp() AS sampled_at,txid_current_snapshot()::text AS mvcc_snapshot,current_setting('transaction_isolation') AS isolation")).rows[0];
    for(const table of ['bb_credit_accounts','bb_credit_lots','bb_credit_reservations','bb_credit_events',
      'bb_run_billing_segments','bb_run_billing_progress','bb_run_execution_heads'])
      tables[table]=(await client.query(`SELECT t.* FROM ${table} t WHERE owner_user_id=$1 ORDER BY to_jsonb(t)::text`,[r.owner])).rows;
    tables.bb_credit_allocations=(await client.query(`SELECT a.* FROM bb_credit_allocations a JOIN bb_credit_reservations q ON q.id=a.reservation_id
      WHERE q.owner_user_id=$1 ORDER BY a.reservation_id,a.lot_id`,[r.owner])).rows;
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  const after=await r.request('GET','/api/v1/credits/balance');
  assert.deepEqual(before,after,`Wallet HTTP changed around ${label} RR evidence`);
  assert.equal(after.enabled,true,'The real desktop fixture enables paid authoring/review');
  const lots=tables.bb_credit_lots,events=tables.bb_credit_events;
  assert.ok(lots.length>0&&lots.every(row=>row.expires_at===null),'Synthetic grants must not expire during evidence');
  assert.ok(events.every(row=>['grant','settle'].includes(row.kind)),'These synthetic cases have only grants and actual consumption');
  const totals={available:sum(lots,'remaining')-sum(lots,'frozen'),reserved:sum(lots,'frozen'),
    consumed:sum(events.filter(row=>row.kind==='settle'),'points'),granted:sum(lots,'original_points')};
  for(const amount of Object.values(totals))assert.ok(Number.isSafeInteger(amount)&&amount>=0);
  assert.equal(after.available,totals.available);assert.equal(after.frozen,totals.reserved);
  assert.equal(sum(events.filter(row=>row.kind==='grant'),'points'),totals.granted);
  assert.equal(totals.available+totals.reserved+totals.consumed,totals.granted,'Wallet/lot/ledger conservation');
  assert.equal(totals.reserved,0,'Dynamic authoring fees do not freeze a fixed-price amount');
  for(const q of tables.bb_credit_reservations){
    assert.equal(q.billing_policy,'authoring_balance_v2');
    const settled=sum(events.filter(row=>row.kind==='settle'&&row.reservation_id===q.id),'points');
    assert.equal(Number(q.charged_points),settled);
    assert.equal(sum(tables.bb_credit_allocations.filter(row=>row.reservation_id===q.id),'charged_points'),settled);
    assert.ok(settled<=Number(q.points));
  }
  const snapshot={label,captured_at:new Date().toISOString(),http:{before,after},
    database:{...metadata,tables},totals,
    semantics:{reserved:'HTTP frozen / actual frozen lot balance',consumed:'SUM(credit_events.points WHERE kind=settle)',
      http_and_rr:'Separate transactions bracketed at a stable worker barrier or paused state'}};
  await writeFile(join(r.artifactRoot,`wallet-${label}.json`),JSON.stringify(snapshot,null,2));
  return snapshot;
}

export function assertPausedWallet(before:WalletSnapshot,paused:WalletSnapshot,originalId:string){
  assert.equal(before.database.tables.bb_credit_reservations.length,1);
  assert.equal(paused.database.tables.bb_credit_reservations.length,1);
  const delta=paused.totals.consumed-before.totals.consumed;
  assert.ok(delta>=0,'A pause may settle only activity before the pause request');
  assert.equal(before.totals.available-paused.totals.available,delta);
  assert.equal(Number(reservation(paused,originalId).charged_points)-Number(reservation(before,originalId).charged_points),delta);
  assert.equal(reservation(paused,originalId).state,'held');
  const oldEvents=new Set(before.database.tables.bb_credit_events.map(row=>row.id));
  const finalActiveSettles=paused.database.tables.bb_credit_events.filter(row=>!oldEvents.has(row.id));
  assert.ok(finalActiveSettles.every(row=>row.kind==='settle'&&row.reservation_id===originalId&&row.reason==='authoring_progress_debit'));
  assert.ok(paused.database.tables.bb_run_billing_progress.every(row=>row.lease_until===null));
  return {pause_request_final_active_points:delta,no_new_reservation:true,paused_clock_stopped:true};
}

export function assertWalletUnchanged(a:WalletSnapshot,b:WalletSnapshot){
  assert.deepEqual(a.totals,b.totals,`${a.label} → ${b.label} wallet changed`);
  for(const table of ['bb_credit_accounts','bb_credit_lots','bb_credit_allocations','bb_credit_reservations','bb_credit_events','bb_run_billing_progress'])
    assert.deepEqual(a.database.tables[table],b.database.tables[table],`${a.label} → ${b.label}: ${table} changed`);
}

export function assertAdoptedWallet(before:WalletSnapshot,adopted:WalletSnapshot,originalId:string,newId:string){
  assert.deepEqual(before.totals,adopted.totals,'Adoption itself does not debit or freeze the additional ceiling');
  for(const table of ['bb_credit_accounts','bb_credit_lots','bb_credit_allocations','bb_credit_events'])
    assert.deepEqual(before.database.tables[table],adopted.database.tables[table],`Adoption must not change ${table}`);
  assert.equal(adopted.database.tables.bb_credit_reservations.length,before.database.tables.bb_credit_reservations.length+1);
  const old=reservation(before,originalId),preserved=reservation(adopted,originalId),additional=reservation(adopted,newId);
  assert.equal(preserved.state,'settled');assert.equal(preserved.charged_points,old.charged_points);
  assert.equal(preserved.points,old.points);
  assert.equal(additional.state,'held');assert.equal(Number(additional.points),4500);assert.equal(Number(additional.charged_points),0);
  assert.equal(adopted.database.tables.bb_credit_allocations.filter(row=>row.reservation_id===newId).length,0);
  return {one_additional_reservation:true,additional_ceiling:4500,adoption_debit:0,adoption_frozen:0,original_charged_points:Number(old.charged_points)};
}

export async function writeFiveStageWallet(r:ProductionBrowser,stages:{before_pause:WalletSnapshot;paused:WalletSnapshot;supplement_saved:WalletSnapshot;
  before_adoption_consent:WalletSnapshot;succeeded:WalletSnapshot},adopted:WalletSnapshot,originalId:string,newId:string){
  const pause=assertPausedWallet(stages.before_pause,stages.paused,originalId);
  assertWalletUnchanged(stages.paused,stages.supplement_saved);assertWalletUnchanged(stages.paused,stages.before_adoption_consent);
  const adoption=assertAdoptedWallet(stages.before_adoption_consent,adopted,originalId,newId),success=stages.succeeded;
  assert.deepEqual(reservation(adopted,originalId),reservation(success,originalId),'Original charged fee stays immutable through V2');
  assert.equal(success.database.tables.bb_credit_reservations.length,2);
  assert.equal(reservation(success,newId).state,'settled');assert.equal(Number(reservation(success,newId).charged_points),4500);
  assert.equal(success.totals.consumed-stages.before_adoption_consent.totals.consumed,4500);
  assert.equal(stages.before_adoption_consent.totals.available-success.totals.available,4500);
  const events=new Map(success.database.tables.bb_credit_events.map(row=>[row.id,row]));
  for(const row of adopted.database.tables.bb_credit_events)assert.deepEqual(events.get(row.id),row,'Existing ledger rows stay immutable');
  const oldIds=new Set(adopted.database.tables.bb_credit_events.map(row=>row.id));
  const successorEvents=success.database.tables.bb_credit_events.filter(row=>!oldIds.has(row.id));
  assert.ok(successorEvents.every(row=>row.kind==='settle'&&row.reservation_id===newId));
  const evidence={required_five_stages:stages,adopted_auxiliary:adopted,checks:{...pause,...adoption,
    paused_through_saving_and_quote_refresh_unchanged:true,successor_consumed_points:4500,original_fee_preserved:true,ledger_append_only:true,
    all_http_wallets_match_rr_lots:true,all_lot_ledger_wallet_totals_conserved:true}};
  await writeFile(join(r.artifactRoot,'wallet-five-stages.json'),JSON.stringify(evidence,null,2));
  return evidence.checks;
}
