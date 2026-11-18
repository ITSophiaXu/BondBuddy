"""Rebind the retained quote snapshot after the exact scoped #1551 config change.
Validate both bindings with the installed quote validator, preserve original
price/traffic evidence, then require a fresh official read-only quote. No Start.
Usage on main as root: python3 rebind-quote.py validate|apply
"""
import copy,datetime,fcntl,hashlib,json,os,pathlib,stat,subprocess,sys
R=pathlib.Path('/var/lib/bondbuddy/workpaper1551-20261118');P=R/'private';S=pathlib.Path('/var/lib/bondbuddy/migration-908/state-main');OWNER='workpaper1551-control'
def need(ok,code):
 if not ok:raise RuntimeError(code)
def read(p):return json.loads(p.read_bytes())
def sha(b):return hashlib.sha256(b).hexdigest()
def run(a,b=None,timeout=45):
 p=subprocess.run(a,input=b,capture_output=True,timeout=timeout);need(p.returncode==0,'validator_or_refresh_failed');return p.stdout

def atomic(p,b,mode=0o600,uid=0,gid=0):
 need(not p.is_symlink(),'symlink');tmp=p.with_name(p.name+'.workpaper1551-quote-new');fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 with os.fdopen(fd,'wb')as f:f.write(b);f.flush();os.fsync(f.fileno())
 os.chmod(tmp,mode);os.chown(tmp,uid,gid);os.replace(tmp,p)
 fd=os.open(p.parent,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
def save(p,x):atomic(p,(json.dumps(x,sort_keys=True)+'\n').encode())
VALIDATE=r"""import {refreshCloudQuote}from './deploy/tencent-elasticity/cloud-quote-refresh.mjs';import {canonical,sha256}from './deploy/tencent-elasticity/policy.mjs';
let raw='';for await(const b of process.stdin)raw+=b;const v=JSON.parse(raw);const candidate={...v.snapshot,source_config_sha256:sha256(canonical(v.after)),config:{...v.after,quote_sha256:v.snapshot.config.quote_sha256}};
for(const [config,snapshot]of [[v.before,v.snapshot],[v.after,candidate]]){
const at=Date.parse(snapshot.observation.observed_at);let calls=0;
const r=await refreshCloudQuote({configPath:v.configPath,config,capturedAt:snapshot.observation.observed_at,now:()=>at,transport:{call(){calls++;throw Error('offline_validation_cloud_call');}},readConfig:async p=>{if(p===v.configPath)return config;if(p===config.cloud_quote_file)return v.template;if(p===config.cloud_quote_refresh.snapshot_file)return snapshot;throw Error('unexpected_path');}});
if(calls||canonical(r.quote)!==canonical(v.snapshot.quote)||canonical(r.observation)!==canonical(v.snapshot.observation))throw Error('retained_evidence_changed');}
process.stdout.write(JSON.stringify(candidate));"""
REFRESH=r"""import {Pool}from 'pg';import {executionCloudExpenseLedger,executionCapacityControl}from '@bondbuddy/api/execution-capacity';import {readPrivateJson,observationArchive}from './deploy/tencent-elasticity/private-files.mjs';import {createSocketCredentialProvider}from './deploy/tencent-elasticity/control-socket.mjs';import {TencentTransport,TencentCvm}from './deploy/tencent-elasticity/tencent-cvm.mjs';import {refreshCloudQuote}from './deploy/tencent-elasticity/cloud-quote-refresh.mjs';import {produceExpenseSnapshot,costAdmission}from './deploy/tencent-elasticity/costcap.mjs';import {readExpenseHistory}from './deploy/tencent-elasticity/expense-history.mjs';
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1});try{const path=process.env.BB_EXECUTION_POOL_CONFIG,base=await readPrivateJson(path),provider=createSocketCredentialProvider(base.control_credential_provider),transport=new TencentTransport({region:base.region,credentials:()=>provider.get()}),cloud=new TencentCvm({config:base,transport,control:executionCapacityControl(pool),archive:observationArchive(base.observation_directory)});const inventory=await cloud.inventory(),ledger=await executionCloudExpenseLedger(pool),r=await refreshCloudQuote({configPath:path,config:base,transport,capturedAt:ledger.captured_at}),expense=produceExpenseSnapshot({ledger,inventory,quote:r.quote,config:r.config,history:await readExpenseHistory(r.config)}),decision=costAdmission(expense,inventory,r.config);if(!decision.allowed)throw Error('normal_cost_admission_closed');console.log(JSON.stringify({normal_refresh:true,admission_allowed:true,observed_at:r.observation.observed_at,valid_until:r.quote.valid_until,cloud_start_requested:false}));}finally{await pool.end();}"""
def main():
 need(os.geteuid()==0,'root');action=sys.argv[1];need(action in ('validate','apply','reconcile-validate','reconcile'),'action');reconcile=action.startswith('reconcile');plan=read(P/'plan.safe.json');activation=read(P/'activation.safe.json');fds=[]
 try:
  for p in [S/'config.lock',S/'deploy.lock',S/'migration.lock',pathlib.Path(plan['control_lock'])]:
   need(stat.S_ISREG(p.lstat().st_mode)and not p.is_symlink(),'lock');fd=os.open(p,os.O_RDWR|os.O_NOFOLLOW);fds.append(fd);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  need((S/'pending-release.json').exists()and read(S/'pending-release.json').get('owner')==OWNER,'owned_activation_required');need(activation['phase']=='activated'and sha((S/'current-components.json').read_bytes())==activation['manifest_after_sha256'],'activation_drift')
  c=json.loads(run(['docker','inspect','bb-main-ops-1']))[0];need(c['Id']==activation['ops_id']and c['State']['Running'],'ops_drift')
  q="SELECT count(*) FROM bb_execution_nodes WHERE state<>'stopped'; SELECT count(*) FROM bb_execution_cloud_operations WHERE state NOT IN ('completed','cancelled','rejected'); SELECT count(*) FROM bb_model_capacity_holders; SELECT count(*) FROM bb_jobs WHERE execution_node_id IS NOT NULL AND lease_token IS NOT NULL;"
  counts=run(['docker','exec','-e','PGOPTIONS=-c default_transaction_read_only=on','bb-main-postgres-1','psql','-X','-qAt','-U','bondbuddy','-d','bondbuddy','-v','ON_ERROR_STOP=1','-c',q]).decode().split();need(counts==['0']*4,'not_drained')
  before_mount=next(m for m in read(P/'ops.before.inspect.private.json')['Mounts']if m['Destination']==plan['pool_target']);before_raw=pathlib.Path(before_mount['Source']).read_bytes();after_raw=(P/'pool.private.json').read_bytes();need(sha(before_raw)==plan['pool_before_sha256']and sha(after_raw)==plan['pool_after_sha256'],'pool_hash');before=json.loads(before_raw);after=json.loads(after_raw)
  expected=copy.deepcopy(before);expected['business_overlay_sha256']=plan['archive_sha256']
  for t in plan['templates']:next(x for x in expected['node_secrets']if x['role_name']==t['role'])['service_template_file']=t['after_path']
  need(expected==after,'unrelated_pool_change')
  root=pathlib.Path('/proc')/str(c['State']['Pid'])/'root';need((root/plan['pool_target'].lstrip('/')).read_bytes()==after_raw,'effective_pool_drift')
  snapshot_path=pathlib.Path(before['cloud_quote_refresh']['snapshot_file']);ss=snapshot_path.lstat();need(stat.S_ISREG(ss.st_mode)and not snapshot_path.is_symlink(),'snapshot_file');current_raw=snapshot_path.read_bytes();snapshot_raw=(P/'quote-binding.before.private.json').read_bytes()if reconcile else current_raw;snapshot=json.loads(snapshot_raw);template=read(root/before['cloud_quote_file'].lstrip('/'))
  payload={'configPath':plan['pool_target'],'before':before,'after':after,'snapshot':snapshot,'template':template}
  candidate=run(['docker','exec','-i','bb-main-ops-1','node','--input-type=module','-e',VALIDATE],json.dumps(payload).encode());value=json.loads(candidate)
  need(value['quote']==snapshot['quote']and value['observation']==snapshot['observation'],'quote_evidence_changed')
  if reconcile:
   current=json.loads(current_raw);need(current['observation']['observed_at']>=snapshot['observation']['observed_at'],'observation_rollback');current_payload={**payload,'before':after,'snapshot':current};run(['docker','exec','-i','bb-main-ops-1','node','--input-type=module','-e',VALIDATE],json.dumps(current_payload).encode())
  result={'action':action,'source':plan['source_commit'],'old_snapshot_sha256':sha(snapshot_raw),'candidate_snapshot_sha256':sha(candidate),'unchanged_tariff_and_traffic_evidence':True,'exact_pool_scope_verified':True,'cloud_start_requested':False}
  if action in ('validate','reconcile-validate'):print(json.dumps({'status':'PASS',**result}));return
  if not reconcile:
   need(not(P/'quote-binding.before.private.json').exists(),'prior_attempt_reconcile');atomic(P/'quote-binding.before.private.json',snapshot_raw);save(S/'pending-release.json',{'owner':OWNER,'phase':'quote_rebind','root':str(R)})
   need(snapshot_path.read_bytes()==snapshot_raw,'fresh_snapshot_cas');atomic(snapshot_path,candidate,stat.S_IMODE(ss.st_mode),ss.st_uid,ss.st_gid)
  refreshed=json.loads(run(['docker','exec','-i','bb-main-ops-1','node','--input-type=module','-e',REFRESH],timeout=45))
  result.update(refreshed);result.update(at=datetime.datetime.now(datetime.timezone.utc).isoformat(),snapshot_after_sha256=sha(snapshot_path.read_bytes()),snapshot_path=str(snapshot_path),backup=str(P/'quote-binding.before.private.json'),snapshot_mode=stat.S_IMODE(ss.st_mode),snapshot_uid=ss.st_uid,snapshot_gid=ss.st_gid)
  save(P/'quote-binding.safe.json',result);need(read(S/'pending-release.json')['owner']==OWNER,'pending_owner');(S/'pending-release.json').unlink();print(json.dumps({'status':'PASS',**result}))
 finally:
  for fd in reversed(fds):os.close(fd)
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'status':'FAIL','code':str(e)if isinstance(e,RuntimeError)else type(e).__name__,'automatic_retry':False}));raise SystemExit(1)
