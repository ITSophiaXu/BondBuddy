import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {quoteFixture} from './cloud-quote-refresh.test.mjs';
import {canonical,sha256} from './policy.mjs';
import {expensePeriod} from './costcap.mjs';
import {TARIFF_DOCUMENTS,TARIFF_REFRESH_VERSION,tariffDocument,tariffRequests,observeTariffs,verifyTariffObservation} from './cloud-tariff-refresh.mjs';
import {TencentTransport} from './tencent-cvm.mjs';

// Every price/document below is synthetic, including the review hashes.
const h='a'.repeat(64);
function html(body){return `<script>window.__staticRouterHydrationData = JSON.parse(${JSON.stringify(JSON.stringify({loaderData:{'product-article':{data:{article:{content:{title:'Synthetic price terms',body,disable:false}}}}}}))})</script>`;}
const bodies=TARIFF_DOCUMENTS.map((url,i)=>`<p>SYNTHETIC:${i}:${'price '.repeat(30)}</p>`);
export async function tariffFixture(t,options={}){
  const f=await quoteFixture(t,options),original=f.transport;
  for(const c of f.quote.components){c.running_cny_per_node_hour={compute:.8,disk:.11,ip:0,egress:0,network:0,secret:.4}[c.kind];c.stopped_cny_per_node_hour=c.kind==='compute'?0:c.running_cny_per_node_hour;}
  f.config.quote_sha256=sha256(canonical(f.quote));f.config.period_cap_cny=96;
  f.config.cloud_quote_refresh.pricing_valid_until='2026-11-15T16:00:00Z';
  f.config.cloud_quote_refresh.tariff_refresh={version:TARIFF_REFRESH_VERSION,review_sha256:h,enforcement_sha256:h,
    reviewed_at:'2026-11-15T00:00:00Z',terms_valid_until:'2027-01-01T00:00:00Z',
    documents:TARIFF_DOCUMENTS.map((url,i)=>({url,body_sha256:sha256(bodies[i])}))};
  const compute={RequestId:'synthetic-compute',InstanceTypeQuotaSet:[{Zone:'ap-beijing-7',InstanceType:'SA9.LARGE16',InstanceChargeType:'POSTPAID_BY_HOUR',Cpu:4,Memory:16,Price:{ChargeUnit:'HOUR',UnitPrice:.8,UnitPriceDiscount:.8}}]};
  const disks=[['.036',.04],['.072',.07]].map(([high,rounded],i)=>({RequestId:`synthetic-disk-${i}`,DiskPrice:{ChargeUnit:'HOUR',UnitPrice:rounded,UnitPriceDiscount:rounded,UnitPriceHigh:`0${high}`,UnitPriceDiscountHigh:`0${high}`}}));
  const counts={prices:0,documents:0};const transport={async call(s,a,p,o){
    if(s==='cvm'||s==='cbs'){counts.prices++;return structuredClone(a==='DescribeZoneInstanceConfigInfos'?compute:disks[[40,80].indexOf(p.DiskSize)]);}
    return original.call(s,a,p,o);
  }};
  const fetchImpl=async(url,o)=>{counts.documents++;assert.equal(o.redirect,'error');return new Response(html(bodies[TARIFF_DOCUMENTS.indexOf(url)]));};
  const input=()=>({config:f.config,template:f.quote,at:f.state.at,period:expensePeriod(new Date(f.state.at).toISOString(),'Asia/Shanghai'),caller:f.caller,compute,disks,
    documents:TARIFF_DOCUMENTS.map((url,i)=>tariffDocument(html(bodies[i]),url))});
  await f.save();return {...f,transport,fetchImpl,counts,input,compute,disks,refresh:extra=>f.refresh({transport,fetchImpl,...extra})};
}

test('daily renewal crosses expired legacy tariff horizon and caches only within the same civil day',async t=>{
  const f=await tariffFixture(t,{at:Date.parse('2026-11-15T15:59:00Z')});const source=await readFile(f.configPath);
  let r=await f.refresh();assert.deepEqual(f.counts,{prices:3,documents:4});
  f.state.at+=31000;r=await f.refresh();assert.deepEqual(f.counts,{prices:3,documents:4});
  f.state.at+=30000;r=await f.refresh();assert.deepEqual(f.counts,{prices:6,documents:8});
  assert.equal(r.quote.valid_until,'2026-11-16T16:00:00.000Z');assert.deepEqual(r.quote.fixed_commitments,f.quote.fixed_commitments);
  assert.equal(r.config.period_cap_cny,96);assert.equal(r.config.total_cap_cny_per_hour,4);
  for(const old of f.quote.components){const c=r.quote.components.find(c=>c.kind===old.kind);assert.equal(c.running_cny_per_node_hour,old.running_cny_per_node_hour);assert.equal(c.evidence_sha256,old.evidence_sha256);}
  assert.deepEqual(await readFile(f.configPath),source);assert.ok((await readFile(f.config.cloud_quote_refresh.snapshot_file)).length<=65536);
});

test('legacy snapshot upgrades only with the optional review policy and retains monotonic traffic checks',async t=>{
  const f=await tariffFixture(t,{at:Date.parse('2026-11-15T15:59:00Z')});
  const policy=f.config.cloud_quote_refresh.tariff_refresh;delete f.config.cloud_quote_refresh.tariff_refresh;await f.save();await f.refresh();
  f.config.cloud_quote_refresh.tariff_refresh=policy;f.state.at+=61000;await f.save();
  const old=await readFile(f.config.cloud_quote_refresh.snapshot_file);
  f.config.source_sha256='b'.repeat(64);await f.save();await assert.rejects(f.refresh(),/QUOTE_SNAPSHOT_DRIFT/);
  f.config.source_sha256=h;await f.save();const traffic=f.traffic.InstanceTrafficPackageSet[0].TrafficPackageSet[0];traffic.TrafficUsed--;traffic.TrafficPackageRemaining++;
  await assert.rejects(f.refresh(),/QUOTE_TRAFFIC_ROLLBACK/);assert.deepEqual(await readFile(f.config.cloud_quote_refresh.snapshot_file),old);
  traffic.TrafficUsed++;traffic.TrafficPackageRemaining--;const r=await f.refresh();assert.ok(r.quote.tariff_observation);
});

test('precise disk aggregate, list and stepped prices, scope and reviewed terms cannot be weakened',async t=>{
  const f=await tariffFixture(t);assert.ok(observeTariffs(f.input()));
  for(const mutate of [
    x=>x.compute.InstanceTypeQuotaSet[0].Price.UnitPrice=.81,
    x=>x.compute.InstanceTypeQuotaSet[0].Price.UnitPriceThirdStep=.81,
    x=>x.disks[0].DiskPrice.UnitPriceHigh='0.039', // .039+.072 exceeds .11, but rounds to .04+.07
    x=>delete x.disks[1].DiskPrice.UnitPriceHigh,
    x=>x.disks[1].DiskPrice.UnitPriceHigh='NaN',
    x=>x.caller.AccountId='999',x=>x.compute.InstanceTypeQuotaSet[0].Memory=32,
    x=>x.documents[0].body_sha256='b'.repeat(64),
    x=>x.config.cloud_quote_refresh.tariff_refresh.terms_valid_until='2026-11-15T04:30:00Z',
    x=>x.config.cloud_quote_refresh.tariff_refresh.reviewed_at='2026-11-15T05:00:00Z',
    x=>x.template.fixed_commitments[0].enforced_bound_sha256='b'.repeat(64),
  ]){const x=structuredClone(f.input());mutate(x);assert.throws(()=>observeTariffs(x),/TARIFF_/);}
});

test('article extraction ignores navigation but rejects ambiguous, missing and changed article content without executing scripts',()=>{
  const source=html(bodies[0]);const a=tariffDocument(source,TARIFF_DOCUMENTS[0]);
  assert.deepEqual(tariffDocument(`navigation ${Date.now()} ${source}<script>throw Error('must never execute')</script>`,TARIFF_DOCUMENTS[0]),a);
  assert.notEqual(tariffDocument(html(bodies[0]+'changed'),TARIFF_DOCUMENTS[0]).body_sha256,a.body_sha256);
  for(const bad of [source+source,'<html>login</html>',source.replace('JSON.parse','eval'),html('short')])assert.throws(()=>tariffDocument(bad,TARIFF_DOCUMENTS[0]),/TARIFF_DOCUMENT_/);
});

test('stale, future, mismatched and self-rehashed tariff receipts are rejected',async t=>{
  const f=await tariffFixture(t),input=f.input(),o=observeTariffs(input);assert.ok(verifyTariffObservation(o,f.config,f.quote,input.period,f.state.at));
  for(const mutate of [x=>x.observed_at=new Date(f.state.at+1).toISOString(),x=>x.period_key='other',x=>x.review_sha256='b'.repeat(64),x=>x.requests_sha256='b'.repeat(64),x=>x.compute.InstanceTypeQuotaSet[0].Price.UnitPrice=1]){
    const x=structuredClone(o);mutate(x);assert.throws(()=>verifyTariffObservation(x,f.config,f.quote,input.period,f.state.at),/TARIFF_/);
  }
  await f.refresh();const path=f.config.cloud_quote_refresh.snapshot_file;const snapshot=JSON.parse(await readFile(path));snapshot.tariff_observation.review_sha256='b'.repeat(64);
  snapshot.quote.tariff_observation.evidence_sha256=sha256(canonical(snapshot.tariff_observation));snapshot.config.quote_sha256=sha256(canonical(snapshot.quote));
  await writeFile(path,canonical(snapshot));await assert.rejects(f.refresh(),/TARIFF_OBSERVATION_DRIFT/);
});

test('new-day document/API errors keep the prior indivisible snapshot; a late response cannot publish',async t=>{
  const f=await tariffFixture(t,{at:Date.parse('2026-11-15T15:59:00Z')});await f.refresh();f.state.at+=61000;
  const path=f.config.cloud_quote_refresh.snapshot_file,old=await readFile(path);
  await assert.rejects(f.refresh({fetchImpl:async()=>new Response('denied',{status:403})}),/TARIFF_DOCUMENT_HTTP/);
  await assert.rejects(f.refresh({transport:{call:async(s,a,p,o)=>{if(s==='cbs')throw Error('synthetic UnauthorizedOperation');return f.transport.call(s,a,p,o);}}}),/UnauthorizedOperation/);
  const releases=[];let started;const ready=new Promise(r=>started=r);
  const pending=f.refresh({deadlineMs:1000,fetchImpl:async url=>{await new Promise(r=>{releases.push(r);if(releases.length===4)started();});return new Response(html(bodies[TARIFF_DOCUMENTS.indexOf(url)]));}});
  const rejected=assert.rejects(pending,/QUOTE_REFRESH_DEADLINE/);await ready;await rejected;
  await assert.rejects(f.refresh(),/QUOTE_REFRESH_BUSY/);releases.forEach(r=>r());await new Promise(r=>setImmediate(r));
  assert.deepEqual(await readFile(path),old);
  const until=Date.now()+1000;
  for(;;){try{await f.refresh();break;}catch(e){if(e.message!=='QUOTE_REFRESH_BUSY'||Date.now()>=until)throw e;await new Promise(r=>setTimeout(r,10));}}
});

test('TC3 tariff reads enforce exact Beijing resources and cannot create disks or bypass control-source scope',async()=>{
  let calls=0;const options={region:'ap-beijing',credentials:async()=>({secretId:'synthetic',secretKey:'synthetic',token:'synthetic',expiresAt:Date.now()+600000}),fetchImpl:async(url,o)=>{
    calls++;assert.equal(o.headers['X-TC-Version'],'2017-03-12');return new Response(JSON.stringify({Response:{RequestId:'synthetic'}}));}};
  const transport=new TencentTransport(options),r=tariffRequests({account_id:'100006372392',region:'ap-beijing',zone:'ap-beijing-7',instance_type:'SA9.LARGE16',image_id:'img-synthetic'});
  for(const [s,a,p] of [['cvm','DescribeZoneInstanceConfigInfos',r.compute],...r.disks.map(d=>['cbs','InquiryPriceCreateDisks',d])])await transport.call(s,a,p);
  for(const change of [p=>p.Filters[0].Values=['ap-beijing-6'],p=>p.Filters[1].Values=['SA9.LARGE32'],p=>p.Filters.pop(),p=>p.Limit=100]){
    const p=structuredClone(r.compute);change(p);await assert.rejects(transport.call('cvm','DescribeZoneInstanceConfigInfos',p),/TARIFF_REQUEST_SCOPE/);
  }
  await assert.rejects(transport.call('cbs','InquiryPriceCreateDisks',{...r.disks[0],DiskSize:100}),/TARIFF_REQUEST_SCOPE/);
  await assert.rejects(transport.call('cbs','CreateDisks',r.disks[0]),/ACTION_NOT_ALLOWED/);
  await assert.rejects(transport.call('cvm','InquiryPriceRunInstances',{}),/ACTION_NOT_ALLOWED/);
  await assert.rejects(new TencentTransport({...options,purpose:'control-source',assumeRoleArn:'qcs::cam::uin/100006372392:roleName/bondbuddy-execution-control'}).call('cvm','DescribeZoneInstanceConfigInfos',r.compute),/ACTION_NOT_ALLOWED/);
  assert.equal(calls,3);
});
