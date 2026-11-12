import assert from 'node:assert/strict';
import {BILLING_SNAPSHOT_SQL} from './billing-sql.mjs';

export const BILLING_HEADERS = Object.freeze({'x-bb-billing-format':'int64-decimal-v1'});
const V4 = 'bb-task-price-scope-20261111-v4';
const KINDS = ['update','review','qa','integrity','workpaper'];
const moneyFields = ['reserved_points','charged_points','released_points','corrected_points'];
const id = (v, name) => {assert.equal(typeof v,'string',`${name} missing`);assert.ok(v.trim(),`${name} empty`);return v;};
const amount = (v, name) => {
 assert.ok(typeof v==='string' && /^(0|[1-9][0-9]*)$/.test(v),`${name} must be a canonical decimal string`);
 const n=BigInt(v);assert.ok(n<=9223372036854775807n,`${name} exceeds int64`);return n;
};
const sum = (rows, key='points') => rows.reduce((n,r)=>n+amount(r[key],key),0n);
const unique = (rows,key,name) => {
 const m=new Map();for(const r of rows){const k=key(r);assert.ok(!m.has(k),`duplicate ${name}: ${k}`);m.set(k,r);}return m;
};
const sameIds = (actual,expected,name) => {
 assert.equal(new Set(actual).size,actual.length,`duplicate ${name}`);
 assert.equal(new Set(expected).size,expected.length,`duplicate expected ${name}`);
 assert.deepEqual([...actual].sort(),[...expected].sort(),`${name} mismatch`);
};
const ordered = (rows,key) => [...rows].sort((a,b)=>key(a).localeCompare(key(b)));
const pairIds = (pairs,name) => {
 assert.ok(Array.isArray(pairs),`${name} missing`);
 const keys=pairs.map(p=>JSON.stringify([id(p.subject_id,`${name} subject`),id(p.site_id,`${name} site`)]));
 assert.equal(new Set(keys).size,keys.length,`duplicate ${name}`);return keys.sort();
};

/** Use captured HTTP bodies, not decoded UI values or the current price table. */
export function normalizeAcceptedQuote({kind,request,response,quoteResponse}) {
 assert.ok(KINDS.includes(kind),'unknown billing kind');assert.ok(request && response && quoteResponse,'accepted request/response/quote capture missing');
 const q=['update','review'].includes(kind)?quoteResponse.quote:quoteResponse;
 assert.ok(q,'quote body missing');amount(q.points,'accepted quote points');id(q.price_version,'accepted price version');
 const quoteId=q.quote_id??null,scopeQuoteId=q.scope_quote_id??null;
 if(['update','review','workpaper'].includes(kind)) {
  id(quoteId,'accepted quote id');assert.equal(request.quote_id,quoteId,'accepted quote id mismatch');
 }
 if(request.expected_points!==undefined)assert.equal(amount(request.expected_points,'request expected_points'),amount(q.points,'quote points'),'accepted amount mismatch');
 else assert.ok(['update','review'].includes(kind),'expected_points missing');
 if(request.price_version!==undefined)assert.equal(request.price_version,q.price_version,'accepted price version mismatch');
 else assert.ok(['update','review'].includes(kind),'request price version missing');
 if(!['update','review'].includes(kind) || request.scope_quote_id!==undefined)assert.equal(request.scope_quote_id??null,scopeQuoteId,'accepted scope quote mismatch');
 if(q.quote_status!==undefined)assert.equal(q.quote_status,'ready','accepted quote is not ready');
 const batch=kind==='workpaper';
 if(batch)assert.equal(amount(response.points,'accepted package points'),amount(q.points,'quote points'),'package accepted amount mismatch');
 const requestId=['update','review'].includes(kind)?request.execution_request_id:request.request_id;
 return {kind,requestId:id(requestId,'accepted request id'),quoteId,points:q.points,priceVersion:q.price_version,scopeQuoteId,
  runId:batch?null:id(response.run_id,'accepted run id'),
  packageBatchId:batch?id(response.batch_id,'accepted package batch id'):null,
  workpaperBatchId:batch?id(response.workpapers?.batch_id,'accepted workpaper batch id'):null};
}

function validateDb(db,ownerId) {
 assert.ok(db && typeof db==='object','DB evidence missing');assert.equal(db.owner_id,ownerId,'DB owner mismatch');
 assert.equal(db.transaction_read_only,'on','billing SQL must use a READ ONLY transaction');
 assert.equal(db.transaction_isolation,'repeatable read','billing SQL must use REPEATABLE READ');
 for(const key of ['scope_run_ids','runs','reservations','quotes','scope_quotes','events','allocations','lots','integrity'])assert.ok(Array.isArray(db[key]),`DB ${key} missing`);
 for(const key of ['runs','reservations','quotes','scope_quotes','events','lots']){
  unique(db[key],r=>id(r.id,`${key} id`),key);
  for(const r of db[key])assert.equal(r.owner_user_id,ownerId,`${key} owner mismatch`);
 }
 unique(db.reservations,r=>id(r.run_id,'reservation run'),'reservation run');
 unique(db.reservations,r=>id(r.quote_id,'reservation quote'),'reservation quote');
 unique(db.events,r=>id(r.event_key,'event key'),'event key');
 unique(db.allocations,r=>JSON.stringify([r.reservation_id,r.lot_id]),'allocation');
 for(const r of db.reservations){amount(r.points,'reservation points');if(r.charged_points!==null)amount(r.charged_points,'projected charge');}
 for(const r of [...db.quotes,...db.scope_quotes,...db.events])amount(r.points,'DB points');
 for(const r of db.allocations){amount(r.points,'allocation points');if(r.charged_points!==null)amount(r.charged_points,'allocation charge');}
 for(const r of db.lots)for(const k of ['original_points','remaining','frozen'])amount(r[k],`lot ${k}`);
 sameIds(db.runs.map(r=>r.id),db.scope_run_ids,'DB run scope');
}

async function getJson(page,path) {
 const response=await page.request.get(path,{headers:BILLING_HEADERS});
 assert.ok(response.ok(),`billing HTTP ${response.status()} for ${path}`);return response.json();
}

/** Snapshot stages are independent observations; only terminal assertions compare HTTP to SQL. */
export async function readBillingSnapshot({page,ownerId,runIds=[],workpaperBatchId=null,stage,execReadOnly}) {
 id(ownerId,'ownerId');id(stage,'billing stage');assert.equal(typeof execReadOnly,'function','read-only SQL callback required');
 sameIds(runIds,runIds,'requested runs');for(const r of runIds)id(r,'requested run');
 const capturedAt=new Date().toISOString();
 const balance=await getJson(page,'/api/v1/credits/balance');
 assert.equal(balance.enabled,true,'billing is disabled');amount(balance.available,'HTTP available');amount(balance.frozen,'HTTP frozen');
 const history=[],pages=[],seenCursors=new Set(),seenReservations=new Set();let cursor=null;
 for(let n=0;;n++) {
  assert.ok(n<10000,'billing history pagination exceeded safety bound');
  const body=await getJson(page,`/api/v1/credits/consumption-history?limit=50${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);
  assert.ok(Array.isArray(body.items) && body.page && typeof body.page.has_more==='boolean','invalid history page');
  assert.ok(body.items.length<=50,'history page exceeds requested limit');
  for(const item of body.items){
   id(item.reservation_id,'history reservation');id(item.run_id,'history run');
   assert.ok(!seenReservations.has(item.reservation_id),`duplicate history reservation ${item.reservation_id}`);seenReservations.add(item.reservation_id);
   for(const key of moneyFields)amount(item[key],`history ${key}`);history.push(item);
  }
  pages.push({cursor,response:body});
  const next=body.page.next_cursor;
  if(!body.page.has_more){assert.equal(next,null,'history has_more/cursor mismatch');break;}
  assert.ok(body.items.length>0,'empty history page claims more');id(next,'history next_cursor');
  assert.ok(!seenCursors.has(next),'history cursor loop');seenCursors.add(next);cursor=next;
 }
 const result=await execReadOnly({text:BILLING_SNAPSHOT_SQL,values:[ownerId,runIds,workpaperBatchId],transaction:{isolation:'repeatable read',readOnly:true}});
 assert.equal(result?.rows?.length,1,'billing SQL must return one evidence row');
 const db=typeof result.rows[0].evidence==='string'?JSON.parse(result.rows[0].evidence):result.rows[0].evidence;
 validateDb(db,ownerId);
 const attempts=db.workpaper?.attempts??[];
 sameIds(db.scope_run_ids,[...new Set([...runIds,...attempts.map(a=>a.run_id)])],'requested DB scope');
 if(workpaperBatchId)assert.equal(db.workpaper?.batch?.id,workpaperBatchId,'workpaper batch missing');
 return {stage,capturedAt,ownerId,runIds:[...runIds],workpaperBatchId,http:{balance,history,pages},db};
}

function eventTotals(db,reservationId) {
 const rows=db.events.filter(e=>e.reservation_id===reservationId);
 return Object.fromEntries(['reserve','settle','release','correction'].map(kind=>[kind,sum(rows.filter(e=>e.kind===kind))]));
}

function assertStableSnapshot(s) {
 validateDb(s.db,s.ownerId);const {db,http}=s;
 assert.ok(http && Array.isArray(http.history),'HTTP evidence missing');assert.equal(http.balance?.enabled,true,'billing disabled');
 const history=unique(http.history,r=>r.reservation_id,'history reservation');
 sameIds([...history.keys()],db.reservations.map(r=>r.id),'complete HTTP history');
 for(const r of db.reservations){
  const h=history.get(r.id),e=eventTotals(db,r.id);
  assert.equal(h.run_id,r.run_id,'history run mismatch');assert.equal(h.state,r.state,'history state mismatch');
  assert.equal(h.billing_policy,r.billing_policy,'history policy mismatch');
  assert.equal(amount(h.reserved_points,'history reserve'),r.billing_policy==='authoring_balance_v2'?0n:amount(r.points,'reserved'),'history reserve mismatch');
  for(const [field,event] of [['charged_points','settle'],['released_points','release'],['corrected_points','correction']])assert.equal(amount(h[field],field),e[event],`history ${field} mismatch`);
 }
 let available=0n,frozen=0n;
 for(const l of db.lots){
  const remain=amount(l.remaining,'lot remaining'),held=amount(l.frozen,'lot frozen');
  assert.ok(held<=remain && remain<=amount(l.original_points,'lot original'),'invalid lot balance');
  assert.equal(l.is_expired,false,'expired lot makes isolated wallet comparison invalid');
  available+=remain-held;frozen+=held;
 }
 assert.equal(amount(http.balance.available,'HTTP available'),available,'HTTP/SQL available mismatch');
 assert.equal(amount(http.balance.frozen,'HTTP frozen'),frozen,'HTTP/SQL frozen mismatch');
 return {available,frozen};
}

function assertQuote(db,r,run,accepted,kind) {
 const quotes=db.quotes.filter(q=>q.id===r.quote_id);assert.equal(quotes.length,1,`immutable quote missing for ${run.id}`);
 const q=quotes[0];assert.equal(q.points,r.points,'quote/reservation amount mismatch');assert.equal(q.project_id,run.project_id,'quote project mismatch');
 assert.equal(q.source,kind==='workpaper'?'m4':kind==='qa'?'qa':kind==='integrity'?'integrity':'fixed','quote source mismatch');
 if(q.run_id!==null)assert.equal(q.run_id,run.id,'quote run mismatch');
 if(kind!=='workpaper'){
  if(accepted.quoteId!==null)assert.equal(q.id,accepted.quoteId,'accepted quote id mismatch');
  assert.equal(q.points,accepted.points,'accepted quote amount mismatch');assert.equal(q.price_version,accepted.priceVersion,'accepted quote version mismatch');
  assert.equal(q.scope_quote_id??null,accepted.scopeQuoteId??null,'accepted scope id mismatch');
 }
 if(q.scope_quote_id){
  const scope=db.scope_quotes.find(s=>s.id===q.scope_quote_id);assert.ok(scope,'accepted scope quotation missing');
  assert.equal(scope.project_id,q.project_id,'scope project mismatch');assert.equal(scope.price_version,q.price_version,'scope version mismatch');
  assert.equal(scope.points,q.points,'scope amount mismatch');
 }
 return q;
}

function workpaperScope(db,accepted,expectedItemIds) {
 assert.ok(expectedItemIds.length>0,'expected workpaper items missing');const w=db.workpaper,b=w?.batch;
 assert.ok(b,'workpaper batch missing');assert.equal(b.id,accepted.workpaperBatchId,'accepted workpaper batch mismatch');
 assert.equal(b.state,'complete','workpaper batch is not complete');
 sameIds(w.items.map(i=>i.item_id),expectedItemIds,'workpaper selected items');
 unique(w.attempts,a=>a.run_id,'workpaper attempt run');unique(w.attempts,a=>JSON.stringify([a.item_id,a.attempt]),'workpaper attempt');
 sameIds(db.scope_run_ids,w.attempts.map(a=>a.run_id),'all workpaper attempts');
 assert.ok(w.attempts.length>=w.items.length,'workpaper attempts missing');
 for(const a of w.attempts)assert.ok(expectedItemIds.includes(a.item_id),'foreign workpaper attempt');
 for(const i of w.items){
  assert.equal(i.state,'succeeded',`workpaper item ${i.item_id} incomplete`);
  const attempts=w.attempts.filter(a=>a.item_id===i.item_id);
  assert.ok(attempts.some(a=>a.run_id===i.run_id && a.attempt===i.attempt),'current workpaper attempt mismatch');
  assert.equal(i.attempt,Math.max(...attempts.map(a=>a.attempt)),'current workpaper attempt is not latest');
  assert.equal(db.runs.find(r=>r.id===i.run_id)?.state,'succeeded','current workpaper run incomplete');
 }
 assert.equal(w.packages.length,1,'accepted package missing or ambiguous');const p=w.packages[0];
 assert.equal(p.id,accepted.packageBatchId,'accepted package mismatch');assert.equal(p.request_id,accepted.requestId,'package request mismatch');
 assert.equal(p.workpaper_batch_id,b.id,'package child mismatch');assert.equal(p.document_batch_id,null,'unexpected document batch in workpaper-only flow');
 assert.equal(p.points,accepted.points,'accepted package points mismatch');assert.equal(p.quote_points,p.points,'package snapshot amount mismatch');
 assert.equal(p.price_version,accepted.priceVersion,'package version mismatch');assert.equal(p.quote_id,accepted.quoteId,'package quote mismatch');
 sameIds(p.item_ids,expectedItemIds,'accepted package items');
 assert.equal(b.total_points,p.points,'workpaper/package total mismatch');assert.equal(b.price_version,p.price_version,'workpaper/package version mismatch');
 assert.equal(w.package_quotes.length,1,'locked package quote missing');const q=w.package_quotes[0];
 assert.equal(q.id,p.quote_id,'locked package quote id mismatch');assert.equal(q.accepted_batch_id,p.id,'locked package acceptance mismatch');
 assert.equal(q.points,p.points,'locked package points mismatch');assert.equal(q.price_version,p.price_version,'locked package version mismatch');
 assert.equal(q.project_id,p.project_id,'locked package project mismatch');assert.equal(p.project_id,b.project_id,'workpaper project mismatch');
 return w;
}

function assertWalletDelta(before,terminal,scope,totals) {
 const b=before.db,t=terminal.db,scopeSet=new Set(scope);
 const beforeEvents=new Map(b.events.map(e=>[e.id,e])),terminalEvents=new Map(t.events.map(e=>[e.id,e]));
 for(const [key,e] of beforeEvents)assert.deepEqual(terminalEvents.get(key),e,'historical event changed/disappeared');
 const added=t.events.filter(e=>!beforeEvents.has(e.id));
 for(const e of added)assert.ok(scopeSet.has(e.reservation_id) && ['reserve','settle','release','correction'].includes(e.kind),'foreign event/grant invalidates isolated wallet delta');
 assert.equal(sum(added.filter(e=>e.kind==='settle')),totals.charged,'new settle events mismatch');
 assert.equal(sum(added.filter(e=>e.kind==='correction')),totals.corrected,'new correction events mismatch');
 const oldReservations=new Map(b.reservations.map(r=>[r.id,r]));
 for(const r of t.reservations){
  if(oldReservations.has(r.id)){assert.ok(!scopeSet.has(r.id),'task already reserved before acceptance');assert.deepEqual(r,oldReservations.get(r.id),'unrelated reservation changed');}
  else assert.ok(scopeSet.has(r.id),'foreign reservation invalidates isolated wallet delta');
 }
 for(const r of b.reservations)assert.ok(t.reservations.some(x=>x.id===r.id),'historical reservation disappeared');
 const foreignAlloc=rows=>ordered(rows.filter(a=>!scopeSet.has(a.reservation_id)),a=>JSON.stringify([a.reservation_id,a.lot_id]));
 assert.deepEqual(foreignAlloc(t.allocations),foreignAlloc(b.allocations),'unrelated allocation changed');
 const oldLots=new Map(b.lots.map(l=>[l.id,l]));
 for(const old of b.lots)assert.ok(t.lots.some(l=>l.id===old.id),'historical lot disappeared');
 for(const l of t.lots){
  const old=oldLots.get(l.id),charged=sum(t.allocations.filter(a=>scopeSet.has(a.reservation_id)&&a.lot_id===l.id),'charged_points');
  const returned=sum(added.filter(e=>e.kind==='correction'&&e.lot_id===l.id));
  if(old)for(const k of ['source','source_key','original_points','expires_at'])assert.deepEqual(l[k],old[k],`lot ${k} changed`);
  else {assert.ok(returned>0n,'unrelated new lot');assert.equal(amount(l.original_points,'new lot original'),returned,'correction lot mismatch');}
  assert.equal((old?amount(old.remaining,'before lot'):0n)-amount(l.remaining,'terminal lot'),charged-returned,'lot charge/correction mismatch');
 }
 const beforeWallet=assertStableSnapshot(before),afterWallet=assertStableSnapshot(terminal);
 assert.equal(beforeWallet.frozen,0n,'concurrent held credits before task');assert.equal(afterWallet.frozen,0n,'held credits remain');
 assert.equal(beforeWallet.available-afterWallet.available,totals.charged-totals.corrected,'isolated wallet delta mismatch');
}

/** Assertions are for a successful five-flow delivery, not a way to finalize a run. */
export function assertBillingTerminal({before,terminal,accepted,kind=accepted?.kind,expectedItemIds=[],integrityVerifiedPairs}) {
 assert.ok(accepted && KINDS.includes(kind),'accepted billing identity missing');assert.equal(kind,accepted.kind,'accepted kind mismatch');
 assert.equal(before.ownerId,terminal.ownerId,'snapshot owner changed');assertStableSnapshot(before);assertStableSnapshot(terminal);
 const db=terminal.db;let workpaper=null;
 if(kind==='workpaper')workpaper=workpaperScope(db,accepted,expectedItemIds);
 else sameIds(db.scope_run_ids,[id(accepted.runId,'accepted run')],'accepted run scope');
 const summaries=[];let reserved=0n,charged=0n,released=0n,corrected=0n;
 for(const run of db.runs){
  assert.ok(workpaper?['succeeded','failed','cancelled','rejected'].includes(run.state):run.state==='succeeded',`run ${run.id} is not successful/terminal: ${run.state}`);
  const matches=db.reservations.filter(r=>r.run_id===run.id);assert.equal(matches.length,1,`reservation missing for ${run.id}`);
  const r=matches[0];assert.equal(run.reservation_id,r.id,'run reservation mismatch');assert.equal(r.billing_policy,'on_delivery','unexpected billing policy');
  assert.ok(['settled','released'].includes(r.state),'held reservation remains');assert.ok(r.finalized_at,'reservation finalization missing');
  const q=assertQuote(db,r,run,accepted,kind),e=eventTotals(db,r.id),n=amount(r.points,'reserved');
  assert.ok(n>0n,'paid run has empty reservation');assert.equal(e.reserve,n,'reserve event amount mismatch');assert.equal(n,e.settle+e.release,'reserved != charged + released');
  assert.ok(e.correction<=e.settle,'correction exceeds actual charge');assert.equal(amount(r.charged_points,'projected charge'),e.settle,'charge projection mismatch');
  assert.equal(r.state,e.settle>0n?'settled':'released','reservation state/charge mismatch');
  const events=db.events.filter(x=>x.reservation_id===r.id);
  for(const event of events){assert.equal(event.run_id,run.id,'event run mismatch');assert.ok(['reserve','settle','release','correction'].includes(event.kind),'unexpected reservation event');assert.ok(amount(event.points,'event points')>0n,'zero event');}
  for(const eventKind of ['reserve','settle','release'])assert.equal(events.filter(x=>x.kind===eventKind).length,e[eventKind]>0n?1:0,`duplicate/missing ${eventKind} event`);
  const allocations=db.allocations.filter(a=>a.reservation_id===r.id);assert.ok(allocations.length>0,'allocation missing');
  assert.equal(sum(allocations),n,'allocation reserve mismatch');assert.equal(sum(allocations,'charged_points'),e.settle,'allocation charge mismatch');
  for(const a of allocations){assert.ok(db.lots.some(l=>l.id===a.lot_id),'allocation lot missing');assert.ok(amount(a.charged_points,'allocation charge')<=amount(a.points,'allocation points'),'allocation overcharge');}
  if(workpaper){
   assert.equal(q.price_version,workpaper.batch.price_version,'item price version mismatch');
   const results=workpaper.results.filter(x=>x.run_id===run.id);assert.ok(results.length<=1,'duplicate workpaper result');
   if(run.state==='succeeded'){
    assert.equal(results.length,1,'successful workpaper result missing');const result=results[0];
    const attempt=workpaper.attempts.find(a=>a.run_id===run.id);assert.equal(result.item_id,attempt.item_id,'workpaper result item mismatch');
    if(result.decision?.status==='generate'){assert.equal(result.explanation,null,'generated item has explanation');assert.equal(e.settle,n,'generated item charge mismatch');}
    else {assert.ok(['not_applicable','missing_information','external_evidence'].includes(result.decision?.status),'invalid workpaper decision');assert.ok(result.explanation,'workpaper explanation missing');assert.equal(e.settle-e.correction,0n,'explanation must be free');}
   }else assert.equal(e.settle-e.correction,0n,'unsuccessful workpaper attempt has net charge');
  }else if(kind==='integrity'){
   const records=db.integrity.filter(i=>i.run_id===run.id);assert.equal(records.length,1,'integrity billing evidence missing');const i=records[0];
   assert.equal(i.operation,'check','not a paid integrity check');const pairs=pairIds(i.verified_pairs,'DB verified pairs'),locked=pairIds(i.locked_pairs,'locked pairs');
   assert.ok(pairs.length>0,'zero verified pairs cannot pass successful paid integrity flow');assert.equal(i.verified_pair_count,pairs.length,'verified pair count mismatch');
   for(const pair of pairs)assert.ok(locked.includes(pair),'verified pair outside accepted scope');
   assert.deepEqual(pairIds(integrityVerifiedPairs,'independently verified pairs'),pairs,'independent/DB verified pairs mismatch');
   const expected=q.price_version===V4?[n,22738n,2000n+85n*BigInt(pairs.length)].reduce((a,b)=>a<b?a:b):n;
   assert.equal(e.settle,expected,'integrity accepted-version charge mismatch');
  }else assert.equal(e.settle,n,'successful fixed-price charge mismatch');
  reserved+=n;charged+=e.settle;released+=e.release;corrected+=e.correction;
  summaries.push({runId:run.id,reservationId:r.id,quoteId:q.id,priceVersion:q.price_version,reserved:n.toString(),charged:e.settle.toString(),released:e.release.toString(),corrected:e.correction.toString(),net:(e.settle-e.correction).toString()});
 }
 assertWalletDelta(before,terminal,summaries.map(s=>s.reservationId),{charged,corrected});
 return {kind,acceptedPoints:accepted.points,reserved:reserved.toString(),charged:charged.toString(),released:released.toString(),corrected:corrected.toString(),net:(charged-corrected).toString(),held:'0',reservations:summaries,
  walletDeltaVerified:true,syntheticCredits:true,paymentChannelVerified:false};
}

/** Refresh and repeat-download observations cannot append or mutate any wallet facts. */
export function assertBillingUnchanged({before,after}) {
 assert.equal(before.ownerId,after.ownerId,'snapshot owner changed');assertStableSnapshot(before);assertStableSnapshot(after);
 for(const key of ['events','reservations','allocations','lots']){
  const identity=key==='allocations'?r=>JSON.stringify([r.reservation_id,r.lot_id]):r=>r.id;
  assert.deepEqual(ordered(after.db[key],identity),ordered(before.db[key],identity),`billing ${key} changed after refresh/download`);
 }
 assert.deepEqual(after.http.balance,before.http.balance,'balance changed after refresh/download');
 return {unchanged:true,reservations:after.db.reservations.length,events:after.db.events.length};
}
