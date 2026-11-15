import {constants} from 'node:fs';
import {open, lstat, rename, unlink} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical, sha256, requireThat} from './policy.mjs';
import {readPrivateJson} from './private-files.mjs';
import {expensePeriod} from './costcap.mjs';

export const QUOTE_REFRESH_VERSION='lighthouse-quote-refresh-v1';
const OWNER='100006372392', REGION='ap-beijing', INSTANCE='lhins-4i18xeto';
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const date=v=>{requireThat(typeof v==='string'&&v.includes('T')&&/(Z|[+-]\d\d:\d\d)$/.test(v),'QUOTE_TIME');const n=Date.parse(v);requireThat(Number.isFinite(n),'QUOTE_TIME');return n;};
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const finite=v=>Number.isFinite(v)&&v>=0;
const flights=new Map();
export function quoteSsmRequestBound(minutes) {
  requireThat(integer(minutes),'QUOTE_SECRET_TIME_BOUND');
  // 68 renewal calls + 22 (List + <=10 Get) broker calls each minute,
  // plus <=24 attempts * <=11 calls for each of at most N+2 starts.
  return 354*minutes+528;
}

function refreshPolicy(config, at) {
  const p=config.cloud_quote_refresh;
  requireThat(p?.version===QUOTE_REFRESH_VERSION&&config.account_id===OWNER&&config.region===REGION&&
    config.time_zone==='Asia/Shanghai'&&p.instance_id===INSTANCE&&p.bundle_id==='bundle_starter_mc_med4_01'&&
    p.bandwidth_mbps===5&&p.traffic_package_total_bytes===536870912000,'QUOTE_REFRESH_SCOPE');
  requireThat(config.registration_directory?.startsWith('/')&&
    p.snapshot_file===join(config.registration_directory,'cloud-quote-snapshot.json')&&hash(config.quote_sha256), 'QUOTE_SNAPSHOT_PATH');
  const period=expensePeriod(new Date(at).toISOString(),config.time_zone), end=date(period.period_end);
  // This is a separate reviewed tariff horizon, not the previous day's
  // observed network allowance. Expired tariff evidence cannot be extended.
  requireThat(date(p.pricing_valid_until)>=end,'QUOTE_TARIFF_EXPIRED');
  return {p,period,end};
}

function priceTemplate(template, config, at, end) {
  requireThat(template?.version==='execution-cloud-price-bounds-v1'&&template.currency==='CNY'&&
    template.account_id===OWNER&&template.region===REGION&&template.policy_revision===config.expense_policy_revision&&
    sha256(canonical(template))===config.quote_sha256&&hash(config.expense_policy_sha256)&&
    date(template.valid_from)<=at&&date(template.valid_until)>date(template.valid_from),'QUOTE_PRICE_SOURCE');
  const kinds=['compute','disk','ip','egress','network','secret'];
  requireThat(template.components?.length===6&&kinds.every(k=>template.components.filter(c=>c.kind===k).length===1), 'QUOTE_COMPONENTS');
  for(const c of template.components)requireThat(finite(c.running_cny_per_node_hour)&&finite(c.stopped_cny_per_node_hour)&&
    c.evidence_ref&&hash(c.evidence_sha256)&&hash(c.enforced_bound_sha256),'QUOTE_RATE_EVIDENCE');
  requireThat(template.fixed_commitments?.length===2&&['secret','snapshot'].every(k=>template.fixed_commitments.filter(c=>c.kind===k).length===1), 'QUOTE_FIXED_COMMITMENTS');
  for(const c of template.fixed_commitments)requireThat(finite(c.upper_bound_cny)&&c.evidence_ref&&hash(c.evidence_sha256)&&hash(c.enforced_bound_sha256),'QUOTE_FIXED_EVIDENCE');
  const fixedSecret=template.fixed_commitments.find(c=>c.kind==='secret').upper_bound_cny;
  requireThat(fixedSecret>=6&&template.fixed_commitments.find(c=>c.kind==='snapshot').upper_bound_cny>=12,'QUOTE_FIXED_LIABILITY');
  const compute=template.components.find(c=>c.kind==='compute'), secret=template.components.find(c=>c.kind==='secret');
  const hours=(end-at)/3600000, minutes=Math.ceil((end-at)/60000);
  // Shared persisted tick + both bounded brokers/renewals/boot attempts. Retain
  // the complete monthly commitment and reserve full regional API buckets.
  const calls=quoteSsmRequestBound(minutes), api= Math.ceil(calls/10000)*.4;
  requireThat(fixedSecret+2*secret.running_cny_per_node_hour*hours>=6+api,'QUOTE_SECRET_CALL_BOUND');
  const rate=template.components.reduce((s,c)=>s+c.running_cny_per_node_hour,0);
  requireThat(compute.running_cny_per_node_hour===.8&&compute.stopped_cny_per_node_hour===0&&
    rate*2<=config.total_cap_cny_per_hour+1e-9&&config.total_cap_cny_per_hour<=4&&config.period_cap_cny===48,'QUOTE_RATE_CAP');
  return {remaining_control_minutes:minutes,ssm_calls_upper_bound:calls,ssm_api_upper_bound_cny:api};
}

/** Official Lighthouse v20200324: all Traffic* quantities below are bytes.
 * Account comes from the authenticated role's STS response, never from input. */
export function observeLighthouseQuote({caller,instances,traffic,config,at,previous}) {
  const {p,period,end}=refreshPolicy(config,at);
  requireThat(String(caller?.AccountId)===OWNER&&caller.RequestId,'QUOTE_ACCOUNT');
  requireThat(instances?.RequestId&&instances.TotalCount===1&&instances.InstanceSet?.length===1,'QUOTE_INSTANCE_COUNT');
  const i=instances.InstanceSet[0];
  requireThat(i.InstanceId===INSTANCE&&i.BundleId===p.bundle_id&&i.InstanceState==='RUNNING'&&i.Zone==='ap-beijing-7'&&
    i.InternetAccessible?.InternetChargeType==='TRAFFIC_POSTPAID_BY_HOUR'&&i.InternetAccessible.InternetMaxBandwidthOut===5&&
    i.InternetAccessible.PublicIpAssigned===true&&date(i.ExpiredTime)>=end,'QUOTE_INSTANCE_DRIFT');
  requireThat(traffic?.RequestId&&traffic.TotalCount===1&&traffic.InstanceTrafficPackageSet?.length===1&&
    traffic.InstanceTrafficPackageSet[0].InstanceId===INSTANCE&&traffic.InstanceTrafficPackageSet[0].TrafficPackageSet?.length===1,'QUOTE_TRAFFIC_COUNT');
  const t=traffic.InstanceTrafficPackageSet[0].TrafficPackageSet[0];
  requireThat(/^lhtfp-[a-z0-9]+$/.test(t.TrafficPackageId??'')&&t.Status==='NETWORK_NORMAL'&&
    [t.TrafficUsed,t.TrafficPackageTotal,t.TrafficPackageRemaining,t.TrafficOverflow].every(integer)&&
    t.TrafficOverflow===0&&t.TrafficPackageTotal===p.traffic_package_total_bytes&&
    t.TrafficUsed+t.TrafficPackageRemaining===t.TrafficPackageTotal,'QUOTE_TRAFFIC_INVALID');
  const began=date(t.StartTime), ended=date(t.EndTime), deadline=date(t.Deadline);
  requireThat(began<=at&&at<ended&&end<=ended&&end<=deadline&&began<ended&&ended<=deadline,'QUOTE_PACKAGE_EXPIRED');
  const required=Math.ceil(5*1000000/8*(end-at)/1000);
  requireThat(t.TrafficPackageRemaining>=required,'QUOTE_TRAFFIC_INSUFFICIENT');
  if(previous) {
    requireThat(at>=date(previous.observed_at),'QUOTE_CLOCK_ROLLBACK');
    const old=previous.traffic;
    if(old.TrafficPackageId===t.TrafficPackageId)requireThat(old.StartTime===t.StartTime&&old.EndTime===t.EndTime&&old.Deadline===t.Deadline&&
      old.TrafficPackageTotal===t.TrafficPackageTotal&&t.TrafficUsed>=old.TrafficUsed&&t.TrafficPackageRemaining<=old.TrafficPackageRemaining,'QUOTE_TRAFFIC_ROLLBACK');
    else requireThat(date(old.EndTime)===began&&at>=date(old.EndTime),'QUOTE_PACKAGE_DRIFT');
  }
  return {version:'lighthouse-network-observation-v1',account_id:OWNER,region:REGION,instance_id:INSTANCE,
    observed_at:new Date(at).toISOString(),...period,instance:{BundleId:i.BundleId,InstanceState:i.InstanceState,
    Zone:i.Zone,ExpiredTime:i.ExpiredTime,InternetAccessible:{InternetChargeType:i.InternetAccessible.InternetChargeType,
      InternetMaxBandwidthOut:i.InternetAccessible.InternetMaxBandwidthOut,PublicIpAssigned:i.InternetAccessible.PublicIpAssigned}},
    traffic:Object.fromEntries(['TrafficPackageId','TrafficUsed','TrafficPackageTotal','TrafficPackageRemaining','TrafficOverflow',
      'StartTime','EndTime','Deadline','Status'].map(k=>[k,t[k]])),
    whole_host_bandwidth_mbps:5,required_remaining_bytes:required,
    request_ids:{caller:caller.RequestId,instance:instances.RequestId,traffic:traffic.RequestId}};
}

function makeSnapshot(template,config,observation) {
  const at=date(observation.observed_at),end=date(observation.period_end),bounds=priceTemplate(template,config,at,end);
  const evidence=sha256(canonical(observation));
  const quote={...template,valid_from:observation.observed_at,valid_until:observation.period_end,refreshed_from_quote_sha256:config.quote_sha256,
    refresh_bounds:bounds,network_observation:{evidence_sha256:evidence,instance_id:INSTANCE,observed_at:observation.observed_at},
    components:template.components.map(c=>['network','egress'].includes(c.kind)?
      {...c,enforced_bound_sha256:evidence,previous_enforced_bound_sha256:c.enforced_bound_sha256}:c)};
  return {version:'execution-cloud-quote-snapshot-v1',source_config_sha256:sha256(canonical(config)),source_quote_sha256:config.quote_sha256,
    config:{...config,quote_sha256:sha256(canonical(quote))},quote,observation};
}

async function publish(path,value,{check,beforeRename=async()=>{}}) {
  const bytes=canonical(value);requireThat(Buffer.byteLength(bytes)<=65536,'QUOTE_SNAPSHOT_SIZE');
  const temp=`${path}.${randomUUID()}.tmp`;let f,dir;
  try {
    f=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    await f.writeFile(bytes);await f.sync();await f.close();f=null;
    await beforeRename();await check();
    await rename(temp,path);
    dir=await open(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);await dir.sync();
    await check();
  } finally {await f?.close();await dir?.close();await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}

/** Both entry points hold the existing control-tick.lock. One rename publishes
 * configuration and quote together; the reviewed source files remain intact. */
export async function refreshCloudQuote({configPath,config,transport,capturedAt,readConfig=readPrivateJson,now=Date.now,
  deadlineMs=20000,beforeRename}) {
  if(!config.cloud_quote_refresh)return {config,quote:await readConfig(config.cloud_quote_file)};
  const at=date(capturedAt), began=now(), {p,period,end}=refreshPolicy(config,at);
  requireThat(!flights.has(p.snapshot_file),'QUOTE_REFRESH_BUSY');
  requireThat(integer(began)&&Math.abs(began-at)<=30000&&deadlineMs>0&&deadlineMs<=20000,'QUOTE_CLOCK');
  const controller=new AbortController();let timeout;
  const check=async()=>{
    requireThat(!controller.signal.aborted&&now()>=began&&now()-began<deadlineMs&&now()<end,'QUOTE_REFRESH_DEADLINE');
    requireThat(sha256(canonical(await readConfig(configPath)))===sha256(canonical(config)),'QUOTE_CONFIG_DRIFT');
  };
  const work=async()=>{
    const directory=await lstat(config.registration_directory);
    requireThat(directory.isDirectory()&&!directory.isSymbolicLink()&&directory.uid===process.getuid()&&(directory.mode&0o777)===0o700,'QUOTE_DIRECTORY');
    const template=await readConfig(config.cloud_quote_file);priceTemplate(template,config,at,end);
    let previous;
    try {previous=await readConfig(p.snapshot_file);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(previous)requireThat(previous.version==='execution-cloud-quote-snapshot-v1'&&
      previous.source_config_sha256===sha256(canonical(config))&&previous.source_quote_sha256===config.quote_sha256&&
      sha256(canonical(previous.quote))===previous.config?.quote_sha256&&
      sha256(canonical(previous.observation))===previous.quote?.network_observation?.evidence_sha256,'QUOTE_SNAPSHOT_DRIFT');
    await check();
    if(previous){
      const o=previous.observation;
      requireThat(at>=date(o.observed_at),'QUOTE_CLOCK_ROLLBACK');
      const verified=observeLighthouseQuote({config,at:date(o.observed_at),caller:{AccountId:o.account_id,RequestId:o.request_ids?.caller},
        instances:{RequestId:o.request_ids?.instance,TotalCount:1,InstanceSet:[{InstanceId:o.instance_id,...o.instance}]},
        traffic:{RequestId:o.request_ids?.traffic,TotalCount:1,InstanceTrafficPackageSet:[{InstanceId:o.instance_id,TrafficPackageSet:[o.traffic]}]}});
      requireThat(canonical(verified)===canonical(o)&&canonical(makeSnapshot(template,config,o))===canonical(previous),'QUOTE_SNAPSHOT_DRIFT');
      // Reuse only within this tick's freshness window. Its reservation covers
      // ALL remaining main-site traffic through day end, not just node traffic.
      if(period.period_key===o.period_key&&now()-date(o.observed_at)<=30000){
        await check();return {config:previous.config,quote:previous.quote,observation:o};
      }
    }
    const call=(service,action,payload)=>transport.call(service,action,payload,{signal:controller.signal});
    const caller=await call('sts','GetCallerIdentity',{});requireThat(String(caller?.AccountId)===OWNER,'QUOTE_ACCOUNT');await check();
    const instances=await call('lighthouse','DescribeInstances',{InstanceIds:[INSTANCE],Offset:0,Limit:1});await check();
    const traffic=await call('lighthouse','DescribeInstancesTrafficPackages',{InstanceIds:[INSTANCE],Offset:0,Limit:1});await check();
    const observation=observeLighthouseQuote({caller,instances,traffic,config,at,previous:previous?.observation});
    const snapshot=makeSnapshot(template,config,observation);
    await publish(p.snapshot_file,snapshot,{check,beforeRename});
    // Consume the actual on-disk indivisible pair, not speculative write data.
    const published=await readConfig(p.snapshot_file);await check();
    requireThat(canonical(published)===canonical(snapshot),'QUOTE_PUBLICATION_DRIFT');
    return {config:published.config,quote:published.quote,observation:published.observation};
  };
  const flight=Promise.resolve().then(work).finally(()=>{if(flights.get(p.snapshot_file)===flight)flights.delete(p.snapshot_file);});
  flights.set(p.snapshot_file,flight);
  try {
    return await Promise.race([flight,new Promise((_,reject)=>{timeout=setTimeout(()=>{controller.abort();reject(Error('QUOTE_REFRESH_DEADLINE'));},deadlineMs);})]);
  } finally {clearTimeout(timeout);controller.abort();}
}
