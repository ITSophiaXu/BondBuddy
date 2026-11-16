"""Activate/restore only #1420 ops mounts and authority files under shared locks.
No database, billing, cloud operation, worker image, API/web/parser changes.
Unknown outcomes retain owned pending state for explicit reconciliation.
"""
import copy,datetime,fcntl,hashlib,json,os,pathlib,stat,subprocess,sys,time
ROOT=pathlib.Path('/var/lib/bondbuddy/timing1488-20261116');P=ROOT/'private'
STATE=pathlib.Path('/var/lib/bondbuddy/migration-908/state-main');PENDING=STATE/'pending-release.json'
AUTH=pathlib.Path('/var/lib/bondbuddy/elastic-pg-mtls/authority.json');CODE=pathlib.Path('/opt/bondbuddy-elastic-control/deploy/tencent-elasticity')
OLD={'bootstrap.mjs':'71efa66df88f9a30a8230bcd06af1559af786f339fddcd0c2f5e1d86589e3fe9','business-overlay.mjs':'60afbcc278f3bac460235240bc2cff03600f61d42b992dbed0fed49ef32609ca'}
NEW={'bootstrap.mjs':'8a160df7157942f1703c4c7d99e57fa7642b3d9931dc97ba2e1cf0354a55c94e','business-overlay.mjs':'75e10607d1886e1b11e3be809d664a4cd362bc2597e238511175bc96487f44e4'}
OWNER='timing1488-recovery-control';MANIFEST='b67f02c36da474d211af8292ee2f7761d04541316e2206f6cd905a4def74119b'
def need(ok,code):
 if not ok:raise RuntimeError(code)
def sha(b):return hashlib.sha256(b).hexdigest()
def read(p):return json.loads(p.read_bytes())
def run(a,b=None,timeout=60):
 p=subprocess.run(a,input=b,capture_output=True,timeout=timeout);need(p.returncode==0,'command_failed:'+a[0]);return p.stdout

def atomic(p,b,mode=0o600,uid=0,gid=0):
 need(not p.is_symlink(),'symlink_rejected');tmp=p.with_name(p.name+'.timing1478-tmp')
 fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 with os.fdopen(fd,'wb') as out:out.write(b);out.flush();os.fsync(out.fileno())
 os.chmod(tmp,mode);os.chown(tmp,uid,gid);os.replace(tmp,p)
 fd=os.open(p.parent,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
def save(p,v):atomic(p,(json.dumps(v,sort_keys=True,indent=2)+'\n').encode())
def inspect(name):return json.loads(run(['docker','inspect',name]))[0]
def db_guard():
 q="SELECT json_build_object('ledger',(SELECT count(*) FROM bb_schema_migrations),'leases',(SELECT count(*) FROM bb_jobs WHERE execution_node_id IS NOT NULL AND lease_token IS NOT NULL)+(SELECT count(*) FROM bb_review_messages WHERE execution_node_id IS NOT NULL AND lease_token IS NOT NULL),'holders',(SELECT count(*) FROM bb_model_capacity_holders),'not_stopped',(SELECT count(*) FROM bb_execution_nodes WHERE state<>'stopped'),'pending_ops',(SELECT count(*) FROM bb_execution_cloud_operations WHERE state NOT IN ('completed','cancelled','rejected')));"
 d=json.loads(run(['docker','exec','-i','bb-main-postgres-1','psql','-X','-qAt','-U','bondbuddy','-d','bondbuddy','-v','ON_ERROR_STOP=1'],('BEGIN READ ONLY;'+q+'ROLLBACK;').encode()))
 need(d=={'ledger':190,'leases':0,'holders':0,'not_stopped':0,'pending_ops':0},'database_drain_guard');return d

def pool_hash(c,target):return sha((pathlib.Path('/proc')/str(c['State']['Pid'])/'root'/target.lstrip('/')).read_bytes())
def check_config(old,current,overlay):
 need(current['Image']==old['Image'],'image_changed');a=copy.deepcopy(old['Config']);b=copy.deepcopy(current['Config'])
 for x in [a,b]:
  x.pop('Hostname',None);x.pop('Image',None);x['Env']=sorted(x.get('Env',[]));x['Labels']={k:v for k,v in x.get('Labels',{}).items() if not k.startswith('com.docker.compose.')}
 need(a==b,'process_configuration_drift');a=copy.deepcopy(old['HostConfig']);b=copy.deepcopy(current['HostConfig']);binds={s.split(':')[1]:s for s in a['Binds']}
 for v in overlay:binds[v['target']]=v['source']+':'+v['target']+':ro'
 a['Binds']=list(binds.values())
 for x in [a,b]:
  if x.get('OomKillDisable') is None:x['OomKillDisable']=False
  for k in ['Binds','SecurityOpt','CapDrop','CapAdd']:
   if isinstance(x.get(k),list):x[k]=sorted(x[k])
 need(a==b,'host_configuration_drift')
def healthy(c):return c['State']['Running'] and c['State'].get('Health',{}).get('Status','healthy')=='healthy'
def main():
 need(os.geteuid()==0,'root_required');action=json.load(sys.stdin)['action'];need(action in ('validate','activate','rollback'),'action_scope')
 plan=read(P/'plan.safe.json');probe=read(P/'probe.safe.json');old=read(P/'ops.before.inspect.private.json');overlay=read(P/'ops.compose.private.json')['services']['ops']['volumes']
 need(probe['status']=='PASS' and probe['probe_removed'] and len(overlay)==5,'probe_required')
 for k in ('candidate','rollback'):need(sha((P/f'ops.{k}.compose.private.json').read_bytes())==probe[k+'_compose_sha256'],'compose_hash')
 for name,h in NEW.items():need(sha((ROOT/'public'/name).read_bytes())==h,'candidate_code_hash')
 need(sha((P/'authority.private.json').read_bytes())==plan['authority_after_sha256'],'authority_candidate_hash')
 fds=[]
 try:
  for path in [STATE/'config.lock',STATE/'deploy.lock',STATE/'migration.lock',pathlib.Path(plan['control_lock'])]:
   s=path.lstat();need(stat.S_ISREG(s.st_mode) and not path.is_symlink(),'lock_file')
   fd=os.open(path,os.O_RDWR|os.O_NOFOLLOW);fds.append(fd);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  db=db_guard();c=inspect('bb-main-ops-1');protected={n:inspect(n)['Id'] for n in ('bb-main-api-1','bb-main-web-1','bb-main-postgres-1')}
  rollback=action=='rollback';sf=P/'activation.safe.json';state=read(sf) if sf.exists() else None
  if not rollback:
   need(state is None,'prior_attempt_reconcile_required');need(not PENDING.exists(),'other_release_pending');need(c['Id']==plan['ops_id'] and healthy(c),'ops_preimage')
   check_config(old,c,[]);need(pool_hash(c,plan['pool_target'])==plan['pool_before_sha256'],'pool_preimage')
   need(sha(AUTH.read_bytes())==plan['authority_before_sha256'],'authority_preimage');need(sha((STATE/'current-components.json').read_bytes())==MANIFEST,'manifest_preimage')
   for name,h in OLD.items():need(sha((CODE/name).read_bytes())==h,'authority_code_preimage')
   for item in plan['templates']:
    for key in ('before','after'):need(sha(pathlib.Path(item[key+'_path']).read_bytes())==item[key+'_sha256'],'template_preimage')
   # Validate source, exact UserData and config using current runtime without starting a worker.
   for name in NEW:run(['node','--check',str(ROOT/'public'/name)])
   if action=='validate':print(json.dumps({'status':'PASS','activation_ready':True,'database':db,'ops_id':c['Id'],'production_changed':False}));return
   state={'owner':OWNER,'source_commit':plan['source_commit'],'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'phase':'backing_up','files':{},'protected':protected}
   for path in [AUTH,*[CODE/n for n in OLD],STATE/'current-components.json']:
    s=path.stat();backup=P/(path.name+'.before');need(not backup.exists(),'backup_exists');atomic(backup,path.read_bytes());state['files'][str(path)]={'backup':str(backup),'sha256':sha(path.read_bytes()),'mode':stat.S_IMODE(s.st_mode),'uid':s.st_uid,'gid':s.st_gid}
   save(sf,state);save(PENDING,{'owner':OWNER,'root':str(ROOT),'source':plan['source_commit'],'phase':'control_activation'})
  else:
   need(state and state['owner']==OWNER,'owned_state_required')
   if PENDING.exists():need(read(PENDING).get('owner')==OWNER,'other_release_pending')
   else:save(PENDING,{'owner':OWNER,'root':str(ROOT),'phase':'control_rollback'})
   need(c['Image']==plan['ops_image'],'rollback_image_drift')
   check_config(old,c,overlay if c['Id']!=plan['ops_id'] else [])
  state['phase']='stopping_ops';save(sf,state)
  if c['State']['Running']:
   run(['docker','kill','--signal=TERM',c['Id']]);run(['docker','wait',c['Id']],timeout=90)
  need(not inspect('bb-main-ops-1')['State']['Running'],'ops_still_running');db_guard()
  state['phase']='writing_authority';save(sf,state)
  targets={AUTH:('authority.private.json',plan['authority_after_sha256']),**{CODE/n:(n,h) for n,h in NEW.items()}}
  for path,(name,h) in targets.items():
   rec=state['files'][str(path)];prior=pathlib.Path(rec['backup']).read_bytes();need(sha(prior)==rec['sha256'],'backup_hash')
   need(sha(path.read_bytes()) in (rec['sha256'],h),'authority_fresh_cas')
   data=prior if rollback else ((P if path==AUTH else ROOT/'public')/name).read_bytes()
   atomic(path,data,rec['mode'],rec['uid'],rec['gid'])
  run(['systemctl','restart','bondbuddy-elastic-control-authority.service'],timeout=45)
  need(run(['systemctl','is-active','bondbuddy-elastic-control-authority.service']).decode().strip()=='active','authority_inactive')
  kind='rollback' if rollback else 'candidate';state['phase']='recreating_ops_'+kind;save(sf,state)
  file=P/f'ops.{kind}.compose.private.json'
  run(['docker','compose','--project-name','bb-main','--project-directory',str(P),'-f',str(file),'up','-d','--no-deps','--no-build','--pull','never','--force-recreate','--wait','--wait-timeout','90','ops'],timeout=120)
  c=inspect('bb-main-ops-1');need(healthy(c),'ops_unhealthy');check_config(old,c,[] if rollback else overlay)
  need(pool_hash(c,plan['pool_target'])==plan['pool_'+('before' if rollback else 'after')+'_sha256'],'effective_pool_hash')
  for name in OLD:
   h=(OLD if rollback else NEW)[name];need(sha((CODE/name).read_bytes())==h,'authority_file_hash')
   effective=pathlib.Path('/proc')/str(c['State']['Pid'])/'root/app/deploy/tencent-elasticity'/name;need(sha(effective.read_bytes())==h,'ops_file_hash')
  need(all(inspect(n)['Id']==v for n,v in state['protected'].items()),'unrelated_service_changed');db_guard()
  manifest=STATE/'current-components.json';before=state['files'][str(manifest)];raw=manifest.read_bytes();need(sha(raw) in (before['sha256'],state.get('manifest_after_sha256')),'manifest_fresh_cas')
  value=json.loads(raw);v=copy.deepcopy(value);record=v['components']['ops'];record.update(container_id=c['Id'],image_id=c['Image'],started_at=c['State']['StartedAt'],started_utc=c['State']['StartedAt'],running=True,configuration_path=str(file),configuration_files=[str(file)])
  record['timing1478_control']={'source_commit':plan['source_commit'],'archive_sha256':plan['archive_sha256'],'rollback':rollback,'receipt_root':str(ROOT),'verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
  need({k:x for k,x in v['components'].items() if k!='ops'}=={k:x for k,x in value['components'].items() if k!='ops'},'manifest_scope')
  data=(json.dumps(v,sort_keys=True,indent=2)+'\n').encode();atomic(manifest,data,before['mode'],before['uid'],before['gid'])
  state.update(phase='rolled_back' if rollback else 'activated',ops_id=c['Id'],manifest_after_sha256=sha(data),completed_at=datetime.datetime.now(datetime.timezone.utc).isoformat());save(sf,state)
  need(read(PENDING)['owner']==OWNER,'pending_owner');PENDING.unlink()
  print(json.dumps({'status':'PASS','action':action,'ops_id':c['Id'],'authority_active':True,'exact_files_verified':True,'unrelated_services_preserved':True,'database_mutated':False,'cloud_start_requested':False,'manifest_after_sha256':sha(data)}))
 finally:
  for fd in reversed(fds):os.close(fd)
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'status':'FAIL','code':str(e) if isinstance(e,RuntimeError) else type(e).__name__,'automatic_retry':False,'pending_requires_reconciliation':PENDING.exists()}));raise SystemExit(1)
