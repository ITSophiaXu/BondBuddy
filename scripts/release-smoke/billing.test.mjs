import test from 'node:test';
import assert from 'node:assert/strict';
import {BILLING_HEADERS,normalizeAcceptedQuote,readBillingSnapshot,assertBillingTerminal,assertBillingUnchanged} from './billing.mjs';
import {BILLING_SNAPSHOT_SQL} from './billing-sql.mjs';

const owner='isolated-owner',version='bb-task-price-scope-20261111-v4';
const clone=v=>JSON.parse(JSON.stringify(v));
const accepted=(kind='update',points='1000')=>({kind,requestId:'request',quoteId:['qa','integrity'].includes(kind)?null:'quote-run',points,priceVersion:version,scopeQuoteId:null,runId:kind==='workpaper'?null:'run',packageBatchId:kind==='workpaper'?'package':null,workpaperBatchId:kind==='workpaper'?'batch':null});
function empty(points='10000000'){
 return {stage:'before',capturedAt:'2026-11-12T00:00:00Z',ownerId:owner,runIds:[],workpaperBatchId:null,http:{balance:{enabled:true,available:points,frozen:'0'},history:[],pages:[]},db:{owner_id:owner,transaction_read_only:'on',transaction_isolation:'repeatable read',scope_run_ids:[],runs:[],reservations:[],quotes:[],scope_quotes:[],events:[],allocations:[],integrity:[],
  lots:[{id:'seed',owner_user_id:owner,source:'existing_grant',source_key:'release-smoke-initial',original_points:points,remaining:points,frozen:'0',expires_at:null,is_expired:false}],
  workpaper:{batch:null,items:[],attempts:[],results:[],packages:[],package_quotes:[]}}};
}
function task(s,{run='run',kind='update',points='1000',charge=points,correction='0',state='succeeded',priceVersion=version,scope=null}={}){
 const db=s.db,res='reservation-'+run,quote='quote-'+run;
 db.scope_run_ids.push(run);db.runs.push({id:run,owner_user_id:owner,project_id:'project',state,billing_mode:'fixed_credits',reservation_id:res,input_hash:'a'.repeat(64)});
 db.reservations.push({id:res,owner_user_id:owner,run_id:run,quote_id:quote,points,charged_points:charge,state:BigInt(charge)>0n?'settled':'released',billing_policy:'on_delivery',created_at:'2026-11-12T00:01:00Z',finalized_at:'2026-11-12T00:02:00Z'});
 db.quotes.push({id:quote,owner_user_id:owner,project_id:'project',run_id:['qa','integrity'].includes(kind)?run:null,input_hash:'a'.repeat(64),points,price_version:priceVersion,scope_quote_id:scope,source:kind==='workpaper'?'m4':['qa','integrity'].includes(kind)?kind:'fixed'});
 if(scope)db.scope_quotes.push({id:scope,owner_user_id:owner,project_id:'project',price_version:priceVersion,points});
 for(const [event,value] of [['reserve',points],['settle',charge],['release',(BigInt(points)-BigInt(charge)).toString()],['correction',correction]])if(BigInt(value)>0n)db.events.push({id:event+'-'+run,owner_user_id:owner,event_key:event+':'+res,kind:event,points:value,reservation_id:res,run_id:run,lot_id:event==='correction'?'return-'+run:null,created_at:'2026-11-12T00:02:00Z'});
 db.allocations.push({reservation_id:res,lot_id:'seed',points,charged_points:charge});
 db.lots[0].remaining=(BigInt(db.lots[0].remaining)-BigInt(charge)).toString();
 if(BigInt(correction)>0n)db.lots.push({id:'return-'+run,owner_user_id:owner,source:'correction',source_key:'refund-'+run,original_points:correction,remaining:correction,frozen:'0',expires_at:null,is_expired:false});
 refresh(s);return s;
}
function refresh(s){
 s.http.balance={enabled:true,available:s.db.lots.reduce((n,l)=>n+BigInt(l.remaining)-BigInt(l.frozen),0n).toString(),frozen:s.db.lots.reduce((n,l)=>n+BigInt(l.frozen),0n).toString()};
 s.http.history=s.db.reservations.map(r=>{
  const total=kind=>s.db.events.filter(e=>e.reservation_id===r.id&&e.kind===kind).reduce((n,e)=>n+BigInt(e.points),0n).toString();
  return {reservation_id:r.id,run_id:r.run_id,state:r.state,billing_policy:r.billing_policy,reserved_points:r.points,charged_points:total('settle'),released_points:total('release'),corrected_points:total('correction')};
 });return s;
}
function fixture(kind='update',options={}){
 const before=empty(options.balance),terminal=task(clone(before),{kind,...options});terminal.stage='terminal';
 const a=accepted(kind,options.points??'1000');a.priceVersion=options.priceVersion??version;a.scopeQuoteId=options.scope??null;
 return {before,terminal,accepted:a,kind};
}
function integrity({points='2425',charge='2255',count=3,priceVersion=version}={}){
 const f=fixture('integrity',{points,charge,priceVersion});
 const pairs=Array.from({length:count},(_,i)=>({subject_id:'issuer',site_id:'site-'+i}));
 f.terminal.db.integrity=[{run_id:'run',operation:'check',locked_pairs:pairs,verified_pairs:pairs,verified_pair_count:count}];
 f.integrityVerifiedPairs=clone(pairs);return f;
}
function workpapers(){
 const before=empty(),terminal=clone(before),a=accepted('workpaper','5000');a.quoteId='package-quote';
 const w=terminal.db.workpaper,expectedItemIds=['one','two','three','four','five'];
 w.batch={id:'batch',owner_user_id:owner,project_id:'project',state:'complete',total_points:'5000',price_version:version};
 w.packages=[{id:'package',owner_user_id:owner,project_id:'project',request_id:'request',points:'5000',workpaper_batch_id:'batch',document_batch_id:null,price_version:version,quote_id:'package-quote',quote_points:'5000',item_ids:expectedItemIds}];
 w.package_quotes=[{id:'package-quote',owner_user_id:owner,project_id:'project',accepted_batch_id:'package',points:'5000',price_version:version}];
 for(const item of expectedItemIds){
  const charge=item==='five'?'0':'1000',correction=item==='four'?'1000':'0';
  task(terminal,{run:item,kind:'workpaper',charge,correction});
  w.items.push({item_id:item,run_id:item,attempt:item==='one'?2:1,state:'succeeded'});
  w.attempts.push({item_id:item,run_id:item,attempt:item==='one'?2:1});
  w.results.push({run_id:item,item_id:item,decision:{item_id:item,status:['four','five'].includes(item)?'missing_information':'generate'},explanation:['four','five'].includes(item)?{sha256:'b'.repeat(64)}:null});
 }
 task(terminal,{run:'old-one',kind:'workpaper',charge:'0',state:'failed'});w.attempts.push({item_id:'one',run_id:'old-one',attempt:1});
 return {before,terminal,accepted:a,kind:'workpaper',expectedItemIds};
}
function capture(kind){
 const q={quote_id:['update','review','workpaper'].includes(kind)?'quote':undefined,points:'1000',price_version:version};
 const request={quote_id:q.quote_id,...(!['update','review'].includes(kind)?{request_id:'request',expected_points:'1000',price_version:version}:{execution_request_id:'request'})};
 return {kind,request,response:kind==='workpaper'?{batch_id:'package',points:'1000',workpapers:{batch_id:'batch'}}:{run_id:'run'},quoteResponse:['update','review'].includes(kind)?{quote:q}:q};
}

for(const kind of ['update','review','qa','integrity','workpaper'])test(`normalizes captured ${kind} acceptance without guessing quote IDs`,()=>{
 const a=normalizeAcceptedQuote(capture(kind));assert.equal(a.kind,kind);assert.equal(a.points,'1000');assert.doesNotThrow(()=>JSON.stringify(a));
 if(['qa','integrity'].includes(kind))assert.equal(a.quoteId,null);
 if(kind==='workpaper'){assert.equal(a.runId,null);assert.equal(a.packageBatchId,'package');assert.equal(a.workpaperBatchId,'batch');}
});
test('fixed acceptance pins its quote including scope metadata without a redundant request scope ID',()=>{
 const c=capture('update');c.quoteResponse.quote.scope_quote_id='scope';assert.equal(normalizeAcceptedQuote(c).scopeQuoteId,'scope');
});
test('acceptance rejects changed amount/version/quote, unsafe numeric money and missing original response',()=>{
 for(const change of [c=>c.request.expected_points='1001',c=>c.request.price_version='other',c=>c.quoteResponse.points=1000,c=>c.response=null]){
  const c=capture('qa');change(c);assert.throws(()=>normalizeAcceptedQuote(c));
 }
 const c=capture('workpaper');c.request.quote_id='other';assert.throws(()=>normalizeAcceptedQuote(c),/quote id mismatch/);
});

function fakePage(pages,balance={enabled:true,available:'10000000',frozen:'0'}){
 const calls=[];let index=0;
 return {calls,request:{get:async(path,options)=>{calls.push({path,options});return {ok:()=>true,status:()=>200,json:async()=>path.includes('/balance')?balance:pages[index++]};}}};
}
const page=(items,next_cursor=null)=>({items,page:{has_more:next_cursor!==null,next_cursor}});
const historyItem=i=>({reservation_id:'res-'+i,run_id:'run-'+i,state:'settled',billing_policy:'on_delivery',reserved_points:'9007199254740993',charged_points:'9007199254740993',released_points:'0',corrected_points:'0'});
const read=(p,db=empty().db)=>readBillingSnapshot({page:p,ownerId:owner,stage:'before',execReadOnly:async query=>{assert.deepEqual(query.values,[owner,[],null]);assert.deepEqual(query.transaction,{isolation:'repeatable read',readOnly:true});return {rows:[{evidence:db}]};}});
test('reads every history page with explicit decimal header and retained page evidence',async()=>{
 const p=fakePage([page(Array.from({length:50},(_,i)=>historyItem(i)),'cursor+/='),page([historyItem(50)])]);
 const s=await read(p);assert.equal(s.http.history.length,51);assert.equal(s.http.pages.length,2);
 assert.equal(s.http.history[50].charged_points,'9007199254740993');assert.ok(p.calls[2].path.endsWith('cursor=cursor%2B%2F%3D'));
 for(const call of p.calls)assert.deepEqual(call.options.headers,BILLING_HEADERS);
});
for(const [name,pages] of [
 ['duplicate reservation',[page([historyItem(1)],'next'),page([historyItem(1)])]],
 ['cursor loop',[page([historyItem(1)],'next'),page([historyItem(2)],'next')]],
 ['missing next cursor',[{items:[historyItem(1)],page:{has_more:true,next_cursor:null}}]],
 ['unexpected final cursor',[{items:[historyItem(1)],page:{has_more:false,next_cursor:'next'}}]],
 ['empty page claims more',[page([],'next')]],
 ['numeric history amount',[page([{...historyItem(1),charged_points:1}])]],
])test(`rejects history ${name}`,async()=>{await assert.rejects(read(fakePage(pages)));});
test('requires a database read-only repeatable-read transaction and matching owner',async()=>{
 for(const [field,value] of [['transaction_read_only','off'],['transaction_isolation','read committed'],['owner_id','foreign']]){const db=empty().db;db[field]=value;await assert.rejects(read(fakePage([page([])]),db));}
});
test('SQL is parameterized and performs no mutations, account locks or settlement calls',()=>{
 assert.match(BILLING_SNAPSHOT_SQL,/\$1/);assert.match(BILLING_SNAPSHOT_SQL,/\$2::text\[\]/);assert.match(BILLING_SNAPSHOT_SQL,/batch_id=\$3/);
 assert.doesNotMatch(BILLING_SNAPSHOT_SQL,/\b(INSERT|UPDATE|DELETE|CALL|LOCK|FOR UPDATE)\b/i);
 assert.match(BILLING_SNAPSHOT_SQL,/FROM bb_workpaper_attempts/);assert.match(BILLING_SNAPSHOT_SQL,/bb_integrity_verified_query_pair_count/);
});

for(const kind of ['update','review','qa'])test(`${kind} reconciles accepted quote, immutable events, allocations, HTTP and wallet`,()=>{
 const report=assertBillingTerminal(fixture(kind,{scope:'scope'}));assert.equal(report.net,'1000');assert.equal(report.paymentChannelVerified,false);assert.doesNotThrow(()=>JSON.stringify(report));
});
test('does all money arithmetic beyond MAX_SAFE_INTEGER with BigInt and returns decimal JSON',()=>{
 const f=fixture('qa',{points:'9007199254740993',balance:'9007199254741993'});
 assert.equal(assertBillingTerminal(f).charged,'9007199254740993');assert.equal(f.terminal.http.balance.available,'1000');
});
test('a reservation can allocate across several lots without duplicate freeze events',()=>{
 const f=fixture();
 f.before.db.lots[0].original_points='5000000';f.before.db.lots[0].remaining='5000000';
 f.before.db.lots.push({...clone(f.before.db.lots[0]),id:'second',source_key:'second'});
 f.terminal.db.lots=clone(f.before.db.lots);f.terminal.db.lots[0].remaining='4999600';f.terminal.db.lots[1].remaining='4999400';
 f.terminal.db.allocations=[{reservation_id:'reservation-run',lot_id:'seed',points:'400',charged_points:'400'},{reservation_id:'reservation-run',lot_id:'second',points:'600',charged_points:'600'}];
 refresh(f.before);refresh(f.terminal);assert.equal(assertBillingTerminal(f).reserved,'1000');
});
for(const [name,mutate] of [
 ['missing run',f=>f.terminal.db.runs=[]],
 ['missing reservation',f=>{f.terminal.db.reservations=[];f.terminal.http.history=[];}],
 ['missing quote',f=>f.terminal.db.quotes=[]],
 ['missing allocation',f=>f.terminal.db.allocations=[]],
 ['missing allocation charge',f=>f.terminal.db.allocations[0].charged_points=null],
 ['missing complete history',f=>f.terminal.http.history=[]],
 ['quote owner mismatch',f=>f.terminal.db.quotes[0].owner_user_id='other'],
 ['quote version mismatch',f=>f.terminal.db.quotes[0].price_version='other'],
 ['unaccepted quote',f=>f.accepted.quoteId='other'],
 ['duplicate reservation',f=>f.terminal.db.reservations.push(clone(f.terminal.db.reservations[0]))],
 ['held reservation',f=>{f.terminal.db.reservations[0].state='held';refresh(f.terminal);}],
 ['settlement_pending',f=>f.terminal.db.runs[0].state='settlement_pending'],
 ['paused run',f=>f.terminal.db.runs[0].state='paused'],
 ['allocation overcharge',f=>f.terminal.db.allocations[0].charged_points='1001'],
 ['missing accepted scope',f=>{f.terminal.db.quotes[0].scope_quote_id='scope';f.accepted.scopeQuoteId='scope';}],
])test(`terminal rejects ${name}`,()=>{const f=fixture();mutate(f);assert.throws(()=>assertBillingTerminal(f));});
test('rejects split duplicate settle events even when the amount and wallet still balance',()=>{
 const f=fixture();const settle=f.terminal.db.events.find(e=>e.kind==='settle');settle.points='500';f.terminal.db.events.push({...settle,id:'duplicate',event_key:'duplicate',points:'500'});
 refresh(f.terminal);assert.throws(()=>assertBillingTerminal(f),/duplicate\/missing settle/);
});
test('detects an unrelated grant rather than crediting it against this flow',()=>{
 const f=fixture();f.terminal.db.events.push({id:'grant',event_key:'grant',owner_user_id:owner,kind:'grant',points:'100',reservation_id:null,run_id:null,lot_id:'new'});
 assert.throws(()=>assertBillingTerminal(f),/foreign event\/grant/);
});
test('detects another task reservation even if the scoped run and its charge are correct',()=>{
 const f=fixture();task(f.terminal,{run:'foreign'});f.terminal.db.scope_run_ids=['run'];f.terminal.db.runs=f.terminal.db.runs.filter(r=>r.id==='run');
 assert.throws(()=>assertBillingTerminal(f),/foreign event\/grant/);
});
test('rejects expiry and edits to immutable historical events',()=>{
 const f=fixture();f.terminal.db.lots[0].is_expired=true;assert.throws(()=>assertBillingTerminal(f),/expired lot/);
 const g=fixture(),event={id:'seed-event',event_key:'seed',owner_user_id:owner,kind:'grant',points:'10000000',reservation_id:null,lot_id:'seed',run_id:null};
 g.before.db.events=[event];g.terminal.db.events.push({...event,points:'9999999'});assert.throws(()=>assertBillingTerminal(g),/historical event/);
});

test('workpaper includes historical attempts and separates release, gross charge, correction and net',()=>{
 const f=workpapers(),r=assertBillingTerminal(f);assert.equal(r.acceptedPoints,'5000');assert.equal(r.reserved,'6000');assert.equal(r.charged,'4000');assert.equal(r.released,'2000');assert.equal(r.corrected,'1000');assert.equal(r.net,'3000');assert.equal(r.reservations.length,6);
});
for(const [name,mutate] of [
 ['partial batch',f=>f.terminal.db.workpaper.batch.state='partial'],
 ['wrong current attempt',f=>f.terminal.db.workpaper.items[0].attempt=1],
 ['omitted historical attempt',f=>f.terminal.db.workpaper.attempts.pop()],
 ['active historical run',f=>f.terminal.db.runs.find(r=>r.id==='old-one').state='running'],
 ['missing selected item',f=>f.expectedItemIds.pop()],
 ['wrong package total',f=>f.terminal.db.workpaper.packages[0].points='6000'],
 ['missing package quote',f=>f.terminal.db.workpaper.package_quotes=[]],
 ['missing result',f=>f.terminal.db.workpaper.results.pop()],
 ['charged explanation',f=>{const r=f.terminal.db.workpaper.results.find(r=>r.run_id==='three');r.decision.status='missing_information';r.explanation={sha256:'c'.repeat(64)};}],
])test(`workpaper rejects ${name}`,()=>{const f=workpapers();mutate(f);assert.throws(()=>assertBillingTerminal(f));});

test('integrity v4 bills distinct verified pairs and releases unfulfilled scope',()=>{const r=assertBillingTerminal(integrity());assert.equal(r.charged,'2255');assert.equal(r.released,'170');});
test('integrity v4 cap and accepted reserved ceiling both apply',()=>{
 assert.equal(assertBillingTerminal(integrity({points:'30000',charge:'22738',count:300})).charged,'22738');
 assert.equal(assertBillingTerminal(integrity({points:'2100',charge:'2100',count:3})).charged,'2100');
});
test('older accepted integrity prices keep their original full charge',()=>{
 assert.equal(assertBillingTerminal(integrity({points:'5000',charge:'5000',priceVersion:'integrity-round-5000-v1'})).charged,'5000');
});
for(const [name,mutate] of [
 ['zero verified pairs',f=>{f.terminal.db.integrity[0].verified_pairs=[];f.terminal.db.integrity[0].verified_pair_count=0;f.integrityVerifiedPairs=[];}],
 ['duplicate verified pair',f=>f.terminal.db.integrity[0].verified_pairs.push(clone(f.terminal.db.integrity[0].verified_pairs[0]))],
 ['missing independent evidence',f=>delete f.integrityVerifiedPairs],
 ['independent capture mismatch',f=>f.integrityVerifiedPairs.pop()],
 ['unlocked pair',f=>f.terminal.db.integrity[0].locked_pairs.pop()],
 ['incorrect charge',f=>f.terminal.db.quotes[0].price_version='integrity-round-5000-v1'],
])test(`integrity rejects ${name}`,()=>{const f=integrity();mutate(f);assert.throws(()=>assertBillingTerminal(f));});

test('refresh/download permits new observation times but no wallet changes',()=>{
 const {terminal}=fixture(),after=clone(terminal);after.stage='after-download';after.capturedAt='2026-11-12T00:03:00Z';after.db.captured_at=after.capturedAt;
 assert.equal(assertBillingUnchanged({before:terminal,after}).unchanged,true);
});
test('refresh/download rejects newly appended zero-net events or a fresh reservation',()=>{
 const {terminal}=fixture();let after=clone(terminal);after.db.events.push({id:'unexpected',owner_user_id:owner,event_key:'unexpected',kind:'grant',points:'1',reservation_id:null});
 assert.throws(()=>assertBillingUnchanged({before:terminal,after}),/events changed/);
 after=clone(terminal);task(after,{run:'again',charge:'0',state:'cancelled'});assert.throws(()=>assertBillingUnchanged({before:terminal,after}));
});
