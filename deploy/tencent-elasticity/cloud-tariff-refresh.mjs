import {canonical,sha256,requireThat} from './policy.mjs';

export const TARIFF_REFRESH_VERSION='tencent-readonly-tariffs-v1';
export const TARIFF_DOCUMENTS=Object.freeze([
  'https://cloud.tencent.com/document/product/1140/40372',
  'https://cloud.tencent.com/document/product/362/2413',
  'https://cloud.tencent.com/document/product/877/18676',
  'https://cloud.tencent.com/document/product/215/20096',
]);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const time=v=>{requireThat(typeof v==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v)),'TARIFF_TIME');return Date.parse(v);};
const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const requestId=v=>typeof v==='string'&&v.length>0&&v.length<=128;
export function tariffRefreshPolicy(config,end) {
  const p=config.cloud_quote_refresh?.tariff_refresh;
  requireThat(Number.isFinite(end)&&p?.version===TARIFF_REFRESH_VERSION&&hash(p.review_sha256)&&hash(p.enforcement_sha256)&&
    time(p.reviewed_at)<end&&time(p.terms_valid_until)>time(p.reviewed_at)&&time(p.terms_valid_until)>=end&&Array.isArray(p.documents)&&p.documents.length===4&&
    TARIFF_DOCUMENTS.every(url=>p.documents.filter(d=>d.url===url&&hash(d.body_sha256)).length===1),'TARIFF_REVIEW_REQUIRED');
  return p;
}
export function tariffRequests(config) {
  requireThat(config.account_id==='100006372392'&&config.region==='ap-beijing'&&config.zone==='ap-beijing-7'&&
    config.instance_type==='SA9.LARGE16','TARIFF_RESOURCE_SCOPE');
  return {
    compute:{Filters:[{Name:'zone',Values:['ap-beijing-7']},{Name:'instance-type',Values:['SA9.LARGE16']},
      {Name:'instance-charge-type',Values:['POSTPAID_BY_HOUR']}]},
    disks:[40,80].map(DiskSize=>({DiskChargeType:'POSTPAID_BY_HOUR',DiskType:'CLOUD_PREMIUM',DiskSize,DiskCount:1})),
  };
}

export function validateTariffRequest(service,action,payload) {
  const requests=tariffRequests({account_id:'100006372392',region:'ap-beijing',zone:'ap-beijing-7',instance_type:'SA9.LARGE16'});
  const expected=service==='cvm'&&action==='DescribeZoneInstanceConfigInfos'?[requests.compute]:
    service==='cbs'&&action==='InquiryPriceCreateDisks'?requests.disks:[];
  requireThat(expected.some(p=>canonical(p)===canonical(payload)),'TARIFF_REQUEST_SCOPE');
}

/** Read the official article as JSON data; never execute its scripts. Navigation,
 * login widgets and server timestamps are not the reviewed tariff content. */
export function tariffDocument(html,url) {
  requireThat(TARIFF_DOCUMENTS.includes(url)&&typeof html==='string'&&Buffer.byteLength(html)<=2097152,'TARIFF_DOCUMENT_SCOPE');
  const matches=[...html.matchAll(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\(("(?:[^"\\]|\\.)*")\)/g)];
  requireThat(matches.length===1,'TARIFF_DOCUMENT_FORMAT');
  let content;
  try {content=JSON.parse(JSON.parse(matches[0][1])).loaderData['product-article'].data.article.content;}catch{throw Error('TARIFF_DOCUMENT_FORMAT');}
  requireThat(typeof content?.body==='string'&&Buffer.byteLength(content.body)>100&&Buffer.byteLength(content.body)<=1048576&&
    typeof content.title==='string'&&content.title.length>0&&content.title.length<200&&!content.disable,'TARIFF_DOCUMENT_FORMAT');
  return {url,title:content.title,body_sha256:sha256(content.body)};
}

function priceBound(price,cap,{disk=false}={}) {
  requireThat(price?.ChargeUnit==='HOUR'&&finite(price.UnitPrice)&&price.UnitPrice<=cap+1e-9,'TARIFF_PRICE_CHANGED');
  // A low discount must never hide a higher list/stepped price.
  for(const name of ['UnitPriceDiscount','UnitPriceSecondStep','UnitPriceDiscountSecondStep','UnitPriceThirdStep','UnitPriceDiscountThirdStep'])
    if(price[name]!=null)requireThat(finite(price[name])&&price[name]<=cap+1e-9,'TARIFF_PRICE_CHANGED');
  let high=0;
  for(const name of ['UnitPriceHigh','UnitPriceDiscountHigh'])if(disk||price[name]!=null){
    requireThat(typeof price[name]==='string'&&/^\d+(?:\.\d+)?$/.test(price[name])&&Number.isFinite(Number(price[name])),'TARIFF_PRICE_CHANGED');
    const n=Number(price[name]);
    requireThat((disk?Math.round(n*100)/100:n)<=cap+1e-9,'TARIFF_PRICE_CHANGED');
    high=Math.max(high,n);
  }
  return high;
}

/** Fresh exact API responses renew evidence, never the approved rates or cap. */
export function observeTariffs({config,template,at,period,caller,compute,disks,documents}) {
  const p=tariffRefreshPolicy(config,time(period.period_end)),requests=tariffRequests(config);
  requireThat(time(p.reviewed_at)<=at&&at>=time(period.period_start)&&at<time(period.period_end)&&
    String(caller?.AccountId)===config.account_id&&requestId(caller.RequestId),'TARIFF_ACCOUNT_OR_TIME');
  requireThat(requestId(compute?.RequestId)&&compute.InstanceTypeQuotaSet?.length===1,'TARIFF_COMPUTE_SCOPE');
  const c=compute.InstanceTypeQuotaSet[0];
  requireThat(c.Zone===config.zone&&c.InstanceType===config.instance_type&&c.InstanceChargeType==='POSTPAID_BY_HOUR'&&c.Cpu===4&&c.Memory===16,'TARIFF_COMPUTE_SCOPE');
  const rates=Object.fromEntries(template.components.map(c=>[c.kind,c]));
  requireThat(rates.compute?.running_cny_per_node_hour===.8&&rates.compute.stopped_cny_per_node_hour===0&&
    rates.disk?.running_cny_per_node_hour===.11&&rates.disk.stopped_cny_per_node_hour===.11&&
    ['ip','egress','network'].every(k=>rates[k]?.running_cny_per_node_hour===0&&rates[k].stopped_cny_per_node_hour===0)&&
    rates.secret?.running_cny_per_node_hour>=.4&&rates.secret.stopped_cny_per_node_hour>=.4&&
    template.components.every(c=>c.enforced_bound_sha256===p.enforcement_sha256)&&
    template.fixed_commitments.every(c=>c.enforced_bound_sha256===p.enforcement_sha256),'TARIFF_REVIEW_SCOPE');
  priceBound(c.Price,.8);
  requireThat(Array.isArray(disks)&&disks.length===2&&disks.every(d=>requestId(d?.RequestId)),'TARIFF_DISK_SCOPE');
  // Tencent rounds each displayed price to cents. Keep the high precision
  // aggregate too: .036 + .072 = .108 is covered by the approved .11/hour.
  requireThat(disks.reduce((sum,d,i)=>sum+priceBound(d.DiskPrice,[.04,.07][i],{disk:true}),0)<=.11+1e-9,'TARIFF_PRICE_CHANGED');
  requireThat(Array.isArray(documents)&&documents.length===4&&p.documents.every(pin=>documents.filter(d=>d.url===pin.url&&
    d.body_sha256===pin.body_sha256&&typeof d.title==='string'&&d.title.length>0).length===1),'TARIFF_DOCUMENT_CHANGED');
  const observation={version:TARIFF_REFRESH_VERSION,observed_at:new Date(at).toISOString(),...period,account_id:config.account_id,region:config.region,
    review_sha256:p.review_sha256,source_quote_sha256:config.quote_sha256,requests_sha256:sha256(canonical(requests)),
    caller,compute,disks,documents};
  requireThat(Buffer.byteLength(canonical(observation))<=24576,'TARIFF_OBSERVATION_SIZE');
  return observation;
}

export function verifyTariffObservation(value,config,template,period,at) {
  requireThat(value?.version===TARIFF_REFRESH_VERSION&&time(value.observed_at)<=at&&at-time(value.observed_at)<=86400000&&
    Object.entries(period).every(([k,v])=>value[k]===v),'TARIFF_OBSERVATION_STALE');
  const verified=observeTariffs({config,template,at:time(value.observed_at),period,caller:value.caller,compute:value.compute,
    disks:value.disks,documents:value.documents});
  requireThat(canonical(value)===canonical(verified),'TARIFF_OBSERVATION_DRIFT');
  return value;
}

export async function collectTariffs({config,template,at,period,transport,caller,fetchImpl=fetch,signal}) {
  const requests=tariffRequests(config);
  const document=async url=>{
    const r=await fetchImpl(url,{redirect:'error',signal,headers:{Accept:'text/html'}});
    requireThat(r.ok&&(!r.url||r.url===url),'TARIFF_DOCUMENT_HTTP');
    let size=0;const chunks=[];
    for await(const chunk of r.body){signal?.throwIfAborted();size+=chunk.length;requireThat(size<=2097152,'TARIFF_DOCUMENT_SIZE');chunks.push(chunk);}
    return tariffDocument(Buffer.concat(chunks).toString('utf8'),url);
  };
  // Wait for every bounded request to finish, including failures, so a failed
  // tick cannot leave price requests running behind the next tick.
  const results=await Promise.allSettled([
    transport.call('cvm','DescribeZoneInstanceConfigInfos',requests.compute,{signal}),
    ...requests.disks.map(p=>transport.call('cbs','InquiryPriceCreateDisks',p,{signal})),
    ...TARIFF_DOCUMENTS.map(document),
  ]);
  const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;
  signal?.throwIfAborted();const values=results.map(r=>r.value);
  return observeTariffs({config,template,at,period,caller,compute:values[0],disks:values.slice(1,3),documents:values.slice(3)});
}
