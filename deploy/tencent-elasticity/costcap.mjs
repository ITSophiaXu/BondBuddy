import {canonical, sha256, requireThat} from './policy.mjs';

const HOUR = 3600000;
const finite = v => Number.isFinite(v) && v >= 0;
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const ms = value => {const n = Date.parse(value); requireThat(Number.isFinite(n), 'EXPENSE_TIME_REQUIRED'); return n;};
const money = value => Math.ceil(value * 1000000) / 1000000;

const sameResource = (a, b) => a?.account_id === b.account_id && a?.region === b.region && a?.instance_id === b.instance_id;
const pending = o => ['intent','submitted','unknown'].includes(o.state);

/** A node row changes epoch on a warm reservation. Only immutable operation
 * history can retain the stopped predecessor and all earlier savings. */
function chargingHistory(operations, created, until) {
  for(const o of operations.filter(o=>['run','start'].includes(o.action)))
    requireThat(o.dispatched_at||['intent','cancelled','rejected'].includes(o.state)&&!o.provider_request_id,'EXPENSE_DISPATCH_REQUIRED');
  const starts=operations.filter(o=>['run','start'].includes(o.action)&&o.dispatched_at);
  const events=starts.map(o=>({at:ms(o.dispatched_at),running:true,epoch:o.identity.epoch,id:o.operation_id}));
  for(const o of operations.filter(o=>o.action==='stop')) {
    const observed=o.cloud_observation, dispatched=Date.parse(o.dispatched_at), completed=Date.parse(o.completed_at), at=Date.parse(observed?.observed_at);
    // A null ACK must never equal another null and authorize savings. The
    // evidence belongs to this operation's historical epoch, not today's row.
    if(o.state!=='completed'||!o.provider_request_id||!o.dispatched_at||!o.completed_at||
      observed?.latest_operation_request_id!==o.provider_request_id||observed?.latest_operation!=='StopInstances'||
      observed?.latest_operation_state!=='SUCCESS'||observed?.instance_state!=='STOPPED'||observed?.stop_charging_mode!=='STOP_CHARGING'||
      !digest(observed?.evidence_sha256)||!observed?.evidence_ref||
      !Number.isFinite(dispatched)||!Number.isFinite(completed)||!Number.isFinite(at)||completed<dispatched||at<dispatched||at>completed+30000)continue;
    events.push({at:Math.max(completed,at),running:false,epoch:o.identity.epoch,id:o.operation_id});
  }
  // At equal timestamps a Start supersedes the stopped predecessor. A late
  // Stop from a different epoch cannot close the newly dispatched interval.
  events.sort((a,b)=>a.at-b.at||Number(a.running)-Number(b.running)||a.id.localeCompare(b.id));
  const run=starts.find(o=>o.action==='run');
  requireThat(run&&new Set(starts.map(o=>o.identity.epoch)).size===starts.length,'EXPENSE_START_HISTORY_DRIFT');
  let cursor=created,running=true,epoch=run.identity.epoch;
  const intervals=[];
  for(const e of events) {
    requireThat(e.at>=created&&e.at<=until+30000,'EXPENSE_OPERATION_TIME');
    if(e.at>until)continue;
    if(!e.running&&e.epoch!==epoch)continue;
    if(e.at>cursor)intervals.push({from:cursor,to:e.at,running});
    cursor=e.at;running=e.running;epoch=e.epoch;
  }
  if(cursor<until)intervals.push({from:cursor,to:until,running});
  return {intervals,running};
}

function intervalCost(intervals, from, to, runningRate, stoppedRate) {
  return intervals.reduce((sum,i)=>sum+Math.max(0,Math.min(i.to,to)-Math.max(i.from,from))/HOUR*(i.running?runningRate:stoppedRate),0);
}

/** Fixed civil-day boundaries, never a rolling 24-hour interval or caller clock. */
export function expensePeriod(capturedAt, timeZone) {
  const timestamp = ms(capturedAt);
  requireThat(typeof timeZone === 'string' && timeZone.length > 0, 'EXPENSE_TIME_ZONE_REQUIRED');
  const formatter = new Intl.DateTimeFormat('en-CA', {timeZone, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'});
  const parts = t => Object.fromEntries(formatter.formatToParts(t).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  const offset = t => {const p=parts(t); return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-Math.floor(t/1000)*1000;};
  const midnight = wall => {let t=wall; for(let i=0;i<3;i++) t=wall-offset(t); return t;};
  const p=parts(timestamp), wall=Date.UTC(p.year,p.month-1,p.day), start=midnight(wall), end=midnight(wall+24*HOUR);
  requireThat(start <= timestamp && timestamp < end, 'EXPENSE_CIVIL_DAY');
  return {period_key: `${timeZone}:${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`,
    period_start:new Date(start).toISOString(), period_end:new Date(end).toISOString()};
}

/** All rates are reviewed worst-case bounds including enforced network limits.
 * Price-only traffic quotes cannot bound usage. Missing bills never mean zero. */
export function produceExpenseSnapshot({ledger, inventory, quote, config}) {
  requireThat(ledger?.captured_at && Array.isArray(ledger.nodes) && Array.isArray(ledger.operations) && Array.isArray(inventory), 'EXPENSE_LEDGER_REQUIRED');
  const now=ms(ledger.captured_at), period=expensePeriod(ledger.captured_at,config.time_zone);
  const start=ms(period.period_start), end=ms(period.period_end);
  requireThat(quote?.version==='execution-cloud-price-bounds-v1' && quote.currency==='CNY' &&
    quote.account_id===config.account_id && quote.region===config.region && quote.policy_revision===config.expense_policy_revision &&
    sha256(canonical(quote))===config.quote_sha256 && digest(config.expense_policy_sha256) &&
    ms(quote.valid_from)<=now && ms(quote.valid_until)>=end && Array.isArray(quote.components), 'EXPENSE_QUOTE_UNVERIFIED');
  const required=['compute','disk','ip','egress','network','secret'];
  requireThat(quote.components.length===required.length && new Set(quote.components.map(c=>c.kind)).size===required.length &&
    required.every(k=>quote.components.some(c=>c.kind===k)), 'EXPENSE_FEE_COMPONENTS_INCOMPLETE');
  for(const c of quote.components) requireThat(finite(c.running_cny_per_node_hour) && finite(c.stopped_cny_per_node_hour) &&
    typeof c.evidence_ref==='string' && c.evidence_ref.length>0 && digest(c.evidence_sha256) && digest(c.enforced_bound_sha256), 'EXPENSE_RATE_EVIDENCE_REQUIRED');
  // Monthly secret charges and image snapshots are committed liabilities. They
  // cannot be reduced to zero by hourly averaging or a fresh civil-day file.
  requireThat(Array.isArray(quote.fixed_commitments)&&quote.fixed_commitments.length===2&&
    ['secret','snapshot'].every(kind=>quote.fixed_commitments.filter(c=>c.kind===kind).length===1),'EXPENSE_FIXED_COMMITMENTS_REQUIRED');
  for(const c of quote.fixed_commitments)requireThat(finite(c.upper_bound_cny)&&c.evidence_ref&&digest(c.evidence_sha256)&&digest(c.enforced_bound_sha256),'EXPENSE_FIXED_COMMITMENT_EVIDENCE');
  const fixedCommitments=money(quote.fixed_commitments.reduce((sum,c)=>sum+c.upper_bound_cny,0));
  const compute=quote.components.find(c=>c.kind==='compute');
  requireThat(compute.running_cny_per_node_hour===.8 && compute.stopped_cny_per_node_hour===0, 'EXPENSE_COMPUTE_RATE');
  const running=quote.components.reduce((a,c)=>a+c.running_cny_per_node_hour,0), stopped=quote.components.reduce((a,c)=>a+c.stopped_cny_per_node_hour,0);
  requireThat(running*2<=config.total_cap_cny_per_hour+1e-9 && running*2<=4+1e-9 && stopped<=running &&
    config.total_cap_cny_per_hour<=4 && config.period_cap_cny===48 && config.reservation_hours>=1 && config.drain_reserve_hours>=1, 'EXPENSE_RATE_CAP');
  const ops=new Map(ledger.operations.map(o=>[o.operation_id,o]));
  requireThat(ops.size===ledger.operations.length && inventory.length<=2 && new Set(inventory.map(i=>i.instance_id)).size===inventory.length, 'EXPENSE_INVENTORY_DRIFT');
  const live=ledger.nodes.filter(n=>n.destroyed_at===null);
  requireThat(live.length<=2 && new Set(live.map(n=>n.identity.instance_id)).size===live.length &&
    live.length===inventory.length && live.every(n=>inventory.some(i=>i.instance_id===n.identity.instance_id)), 'EXPENSE_INVENTORY_INCOMPLETE');
  for(const i of inventory) requireThat(i.account_id===config.account_id && i.region===config.region &&
    ms(i.observed_at)<=now+30000 && now-ms(i.observed_at)<=300000 && digest(i.evidence_sha256) && i.evidence_ref, 'EXPENSE_CLOUD_OBSERVATION_REQUIRED');
  const rows=[];
  let spent=0, carry=0, reservations=0;
  for(const n of ledger.nodes) {
    const currentStart=ops.get(n.cloud_start_operation_id);
    requireThat(n.identity.account_id===config.account_id && n.identity.region===config.region && digest(n.launch_manifest_sha256) &&
      sameResource(currentStart?.identity,n.identity)&&currentStart.identity.epoch===n.identity.epoch&&['run','start'].includes(currentStart.action), 'EXPENSE_NODE_BINDING');
    const history=ledger.operations.filter(o=>sameResource(o.identity,n.identity));
    const launches=history.filter(o=>o.action==='run');
    requireThat(launches.length===1 && launches[0].dispatched_at,'EXPENSE_ORIGINAL_RUN_REQUIRED');
    // PG creates the node row only after cloud completion. Charge the complete
    // boot interval starting at dispatch, including a midnight boundary.
    const created=Math.min(ms(n.created_at),ms(launches[0].dispatched_at)), until=n.destroyed_at===null?now:ms(n.destroyed_at);
    requireThat(created<=until && until<=now+30000, 'EXPENSE_NODE_TIME');
    const cloud=inventory.find(i=>i.instance_id===n.identity.instance_id);
    const charging=chargingHistory(history,created,until);
    // Closed historical savings stay intact, but an open stopped tail must
    // agree with fresh inventory. Unexpected running or uncertainty closes
    // admission instead of using an old Stop to discount current liability.
    requireThat(n.destroyed_at!==null||charging.running||cloud?.instance_state==='STOPPED','EXPENSE_CURRENT_STOP_UNCONFIRMED');
    const upper=money(intervalCost(charging.intervals,start,until,running,stopped));
    const unresolved=history.filter(pending),dispatchedUnknown=unresolved.some(o=>o.dispatched_at);
    const prior=dispatchedUnknown?money(intervalCost(charging.intervals,created,Math.min(start,until),running,stopped)):0;
    // Reserving a new epoch does not start billing. Keep its prospective cost,
    // while the historical stopped interval remains stopped until dispatch.
    const prospective=unresolved.some(o=>['run','start'].includes(o.action)&&!o.dispatched_at);
    const reserve=n.destroyed_at===null?money(config.reservation_hours*(charging.running||prospective?running:stopped)):0;
    spent+=upper;carry+=prior;reservations+=reserve;
    rows.push({resource_id:n.identity.instance_id,launch_manifest_sha256:n.launch_manifest_sha256,operation_ids:unresolved.map(o=>o.operation_id),
      upper_bound_cny:upper,carry_liability_cny:prior,reservation_cny:reserve,cloud_evidence_sha256:cloud?.evidence_sha256??null});
  }
  const unbound=ledger.operations.filter(o=>o.action==='run' && o.identity===null && pending(o));
  requireThat(live.length+unbound.length<=2, 'EXPENSE_RESERVED_POOL_BOUND');
  for(const o of unbound) {
    requireThat(o.request?.account_id===config.account_id && o.request.region===config.region && o.request.instance_count===1 && digest(o.request.launch_manifest_sha256), 'EXPENSE_UNBOUND_REQUEST');
    requireThat(o.dispatched_at||o.state==='intent'&&!o.provider_request_id,'EXPENSE_DISPATCH_REQUIRED');
    const began=ms(o.dispatched_at??ledger.captured_at);requireThat(began<=now+30000,'EXPENSE_OPERATION_TIME');
    const upper=o.dispatched_at?money(Math.max(0,now-Math.max(start,began))/HOUR*running):0;
    const prior=o.dispatched_at?money(Math.max(0,start-began)/HOUR*running):0, reserve=money(config.reservation_hours*running);
    spent+=upper;carry+=prior;reservations+=reserve;
    rows.push({resource_id:null,operation_ids:[o.operation_id],launch_manifest_sha256:o.request.launch_manifest_sha256,
      upper_bound_cny:upper,carry_liability_cny:prior,reservation_cny:reserve});
  }
  // A zero-floor automatic pool promises no resident. Actual running/unknown
  // rows, disk and fixed liabilities remain above; both safe-drain slots and a
  // prospective start stay reserved independently of the resident floor.
  const automaticZero=config.phase==='automatic'&&config.min_running===0;
  const resident=automaticZero?0:money(Math.max(0,end-now)/HOUR*running), drain=money(2*running*config.drain_reserve_hours);
  const result={version:'execution-cloud-expense-v2',currency:'CNY',account_id:config.account_id,region:config.region,
    quote_sha256:config.quote_sha256,expense_policy_sha256:config.expense_policy_sha256,policy_revision:config.expense_policy_revision,
    observed_at:ledger.captured_at,...period,period_cap_cny:config.period_cap_cny,total_hourly_cap_cny:config.total_cap_cny_per_hour,
    resource_ids:live.map(n=>n.identity.instance_id).sort(),ledger_sha256:sha256(canonical(ledger)),inventory_sha256:sha256(canonical(inventory)),
    quote_component_evidence:quote.components.map(c=>({kind:c.kind,evidence_ref:c.evidence_ref,evidence_sha256:c.evidence_sha256,enforced_bound_sha256:c.enforced_bound_sha256})),
    fixed_commitment_evidence:quote.fixed_commitments,fixed_commitments_upper_bound_cny:fixedCommitments,
    reconciliation:'conservative_rate_bound_without_zero_bill_assumption',rows,spent_upper_bound_cny:money(spent),
    reserved_upper_bound_cny:money(reservations),unknown_liability_cny:money(carry),drain_reserve_cny:drain,
    resident_remaining_period_cny:resident,prospective_slot_cny:money(running*config.reservation_hours)};
  return result;
}

export function costAdmission(input, inventory, config) {
  const fail=reason=>({allowed:false,reason});
  if(input?.version!=='execution-cloud-expense-v2')return fail('expense_producer_required');
  const now=Date.now(), observed=Date.parse(input.observed_at);
  if(!Number.isFinite(observed)||observed>now+30000||now-observed>300000)return fail('expense_snapshot_stale');
  let period;try{period=expensePeriod(input.observed_at,config.time_zone);}catch{return fail('expense_period_invalid');}
  if(Object.entries(period).some(([k,v])=>input[k]!==v)||now>=Date.parse(period.period_end))return fail('expense_period_mismatch');
  if(input.currency!=='CNY'||input.account_id!==config.account_id||input.region!==config.region||input.quote_sha256!==config.quote_sha256||
    input.expense_policy_sha256!==config.expense_policy_sha256||input.policy_revision!==config.expense_policy_revision||
    input.period_cap_cny!==48||input.total_hourly_cap_cny>4||input.inventory_sha256!==sha256(canonical(inventory))||
    !digest(input.ledger_sha256)||input.quote_component_evidence?.length!==6)return fail('expense_source_mismatch');
  const keys=['spent_upper_bound_cny','reserved_upper_bound_cny','unknown_liability_cny','drain_reserve_cny','resident_remaining_period_cny','prospective_slot_cny','fixed_commitments_upper_bound_cny'];
  if(keys.some(k=>!finite(input[k]))||input.drain_reserve_cny<1.6)return fail('expense_bound_missing');
  const used=keys.reduce((n,k)=>n+Math.ceil(input[k]*1000000),0);
  return used<=48000000?{allowed:true,headroom_cny:(48000000-used)/1000000}:{allowed:false,reason:'period_cap'};
}
export function requireCostAdmission(input,inventory,config){const result=costAdmission(input,inventory,config);requireThat(result.allowed,'CLOUD_COSTCAP_REJECTED');return result;}
