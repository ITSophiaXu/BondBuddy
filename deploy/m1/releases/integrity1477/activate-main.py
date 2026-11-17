"""Activate exact browser deployment modules only; rollback preserves audit/data."""
import copy,datetime,fcntl,hashlib,json,os,pathlib,stat,subprocess,sys
ROOT=pathlib.Path('/var/lib/bondbuddy/integrity1477-20261117');P=ROOT/'private';STATE=pathlib.Path('/var/lib/bondbuddy/migration-908/state-main');PENDING=STATE/'pending-release.json';OWNER='integrity1477-control'
def need(ok,code):
 if not ok:raise RuntimeError(code)
def sha(b):return hashlib.sha256(b).hexdigest()
def read(p):return json.loads(p.read_bytes())
def run(a,b=None,timeout=60):
 p=subprocess.run(a,input=b,capture_output=True,timeout=timeout);need(p.returncode==0,'command_failed:'+a[0]);return p.stdout

def atomic(p,b,mode=0o600,uid=0,gid=0):
 need(not p.is_symlink(),'symlink');p.parent.mkdir(parents=True,mode=0o755,exist_ok=True);tmp=p.with_name(p.name+'.integrity1477-tmp');fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 with os.fdopen(fd,'wb') as f:f.write(b);f.flush();os.fsync(f.fileno())
 os.chmod(tmp,mode);os.chown(tmp,uid,gid);os.replace(tmp,p);fd=os.open(p.parent,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
def save(p,d):atomic(p,(json.dumps(d,sort_keys=True,indent=2)+'\n').encode())
def inspect(n):return json.loads(run(['docker','inspect',n]))[0]
def healthy(c):return c['State']['Running'] and c['State'].get('Health',{}).get('Status','healthy')=='healthy'
def guard():
 q="SELECT json_build_object('leases',(SELECT count(*) FROM bb_jobs WHERE execution_node_id IS NOT NULL AND lease_token IS NOT NULL)+(SELECT count(*) FROM bb_review_messages WHERE execution_node_id IS NOT NULL AND lease_token IS NOT NULL),'holders',(SELECT count(*) FROM bb_model_capacity_holders),'not_stopped',(SELECT count(*) FROM bb_execution_nodes WHERE state<>'stopped'),'pending_ops',(SELECT count(*) FROM bb_execution_cloud_operations WHERE state NOT IN ('completed','cancelled','rejected')));"
 d=json.loads(run(['docker','exec','-i','bb-main-postgres-1','psql','-X','-qAt','-U','bondbuddy','-d','bondbuddy','-v','ON_ERROR_STOP=1'],('BEGIN READ ONLY;'+q+'ROLLBACK;').encode()));need(all(x==0 for x in d.values()),'native_drain_required');return d

def compare(old,c,mounts):
 need(c['Image']==old['Image'],'image');a=copy.deepcopy(old['Config']);b=copy.deepcopy(c['Config'])
 for x in [a,b]:
  x.pop('Hostname',None);x.pop('Image',None);x['Env']=sorted(x.get('Env',[]));x['Labels']={k:v for k,v in x.get('Labels',{}).items() if not k.startswith('com.docker.compose.')}
 need(a==b,'process_configuration');a=copy.deepcopy(old['HostConfig']);b=copy.deepcopy(c['HostConfig']);binds={s.split(':')[1]:s for s in a['Binds']}
 for v in mounts:binds[v['target']]=v['source']+':'+v['target']+':ro'
 a['Binds']=list(binds.values())
 for x in [a,b]:
  if x.get('OomKillDisable') is None:x['OomKillDisable']=False
  for k in ['Binds','SecurityOpt','CapDrop','CapAdd']:
   if isinstance(x.get(k),list):x[k]=sorted(x[k])
 need(a==b,'host_configuration')
def main():
 need(os.geteuid()==0,'root');action=json.load(sys.stdin)['action'];need(action in ['validate','activate','rollback'],'action');plan=read(P/'plan.safe.json');probe=read(P/'probe.safe.json');old=read(P/'ops.before.inspect.private.json');need(probe['status']=='PASS' and probe['probe_removed'],'create_only_proof')
 for k in ['candidate','rollback']:need(sha((P/f'ops.{k}.compose.private.json').read_bytes())==probe[k+'_compose_sha256'],'compose_hash')
 for x in plan['changes']:need(sha((ROOT/'public'/x['name']).read_bytes())==x['after_sha256'],'candidate_hash')
 fds=[]
 try:
  for p in [STATE/'config.lock',STATE/'deploy.lock',STATE/'migration.lock',pathlib.Path(plan['control_lock'])]:
   fd=os.open(p,os.O_RDWR|os.O_NOFOLLOW);fds.append(fd);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  db=guard();c=inspect('bb-main-ops-1');protected={n:inspect(n)['Id'] for n in ['bb-main-api-1','bb-main-web-1','bb-main-postgres-1']};sf=P/'activation.safe.json';rollback=action=='rollback';state=read(sf) if sf.exists() else None
  need(sha(pathlib.Path('/var/lib/bondbuddy/elastic-pg-mtls/authority.json').read_bytes())==plan['authority_sha256'],'authority_configuration_drift')
  for x in plan['templates']:need(sha(pathlib.Path(x['path']).read_bytes())==x['sha256'],'template_drift')
  def poolhash(c):return sha((pathlib.Path('/proc')/str(c['State']['Pid'])/'root'/plan['pool_target'].lstrip('/')).read_bytes())
  if not rollback:
   need(state is None and not PENDING.exists(),'pending_reconcile');need(c['Id']==plan['ops_id'] and healthy(c),'ops_preimage');compare(old,c,[]);need(poolhash(c)==plan['pool_sha256'],'pool_drift');need(sha((STATE/'current-components.json').read_bytes())==plan['manifest_before_sha256'],'manifest_drift')
   for x in plan['changes']:
    p=pathlib.Path(x['path']);need((sha(p.read_bytes()) if p.exists() else None)==x['before_sha256'],'code_preimage')
   if action=='validate':print(json.dumps({'status':'PASS','activation_ready':True,'database':db,'production_changed':False}));return
   state={'owner':OWNER,'phase':'backing_up','source_commit':plan['source_commit'],'protected':protected,'files':{}}
   for x in plan['changes']+[{'path':str(STATE/'current-components.json'),'before_sha256':plan['manifest_before_sha256']}]:
    p=pathlib.Path(x['path']);backup=P/(sha(str(p).encode())+'.before');need(not backup.exists(),'backup_exists');s=p.stat() if p.exists() else None
    if s:atomic(backup,p.read_bytes())
    state['files'][str(p)]={'backup':str(backup) if s else None,'sha256':x['before_sha256'],'mode':stat.S_IMODE(s.st_mode) if s else 0o644,'uid':s.st_uid if s else 0,'gid':s.st_gid if s else 0}
   save(sf,state);save(PENDING,{'owner':OWNER,'source_commit':plan['source_commit'],'root':str(ROOT),'phase':'activation'})
  else:
   need(state and state['owner']==OWNER,'owned_state');need(not PENDING.exists() or read(PENDING)['owner']==OWNER,'other_pending');compare(old,c,plan['mounts'] if c['Id']!=plan['ops_id'] else []);save(PENDING,{'owner':OWNER,'root':str(ROOT),'phase':'rollback'})
  state['phase']='stopping_ops';save(sf,state)
  if c['State']['Running']:run(['docker','kill','--signal=TERM',c['Id']]);run(['docker','wait',c['Id']],timeout=90)
  guard();state['phase']='updating_public_modules';save(sf,state)
  for x in plan['changes']:
   p=pathlib.Path(x['path']);rec=state['files'][str(p)];current=sha(p.read_bytes()) if p.exists() else None;need(current in [x['before_sha256'],x['after_sha256']],'code_fresh_cas')
   if rollback and rec['backup'] is None:
    if p.exists():p.unlink()
   else:
    data=pathlib.Path(rec['backup']).read_bytes() if rollback else (ROOT/'public'/x['name']).read_bytes();need(sha(data)==(rec['sha256'] if rollback else x['after_sha256']),'write_hash');atomic(p,data,rec['mode'],rec['uid'],rec['gid'])
  run(['systemctl','restart','bondbuddy-elastic-control-authority.service'],timeout=45);need(run(['systemctl','is-active','bondbuddy-elastic-control-authority.service']).strip()==b'active','authority')
  kind='rollback' if rollback else 'candidate';file=P/f'ops.{kind}.compose.private.json';state['phase']='starting_ops_'+kind;save(sf,state)
  run(['docker','compose','--project-name','bb-main','--project-directory',str(P),'-f',str(file),'up','-d','--no-deps','--no-build','--pull','never','--force-recreate','--wait','--wait-timeout','90','ops'],timeout=120)
  c=inspect('bb-main-ops-1');need(healthy(c),'ops_health');compare(old,c,[] if rollback else plan['mounts']);need(poolhash(c)==plan['pool_sha256'],'pool_changed');need(all(inspect(n)['Id']==v for n,v in state['protected'].items()),'protected_service_changed');guard()
  for x in plan['changes']:
   p=pathlib.Path(x['path']);need((sha(p.read_bytes()) if p.exists() else None)==(x['before_sha256'] if rollback else x['after_sha256']),'file_readback')
   if not rollback:need(sha((pathlib.Path('/proc')/str(c['State']['Pid'])/'root/app'/x['name']).read_bytes())==x['after_sha256'],'effective_module')
  mp=STATE/'current-components.json';raw=mp.read_bytes();rec=state['files'][str(mp)];need(sha(raw) in [rec['sha256'],state.get('manifest_after_sha256')],'manifest_cas');manifest=json.loads(raw);before=copy.deepcopy(manifest);m=manifest['components']['ops'];m.update(container_id=c['Id'],image_id=c['Image'],started_at=c['State']['StartedAt'],started_utc=c['State']['StartedAt'],running=True,configuration_path=str(file),configuration_files=[str(file)]);m['integrity1477_control']={'source_commit':plan['source_commit'],'rollback':rollback,'verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'business_pin_unchanged':plan['business_pin']};need({k:v for k,v in manifest['components'].items() if k!='ops'}=={k:v for k,v in before['components'].items() if k!='ops'},'manifest_scope');data=(json.dumps(manifest,sort_keys=True,indent=2)+'\n').encode();atomic(mp,data,rec['mode'],rec['uid'],rec['gid']);state.update(phase='rolled_back' if rollback else 'activated',ops_id=c['Id'],manifest_after_sha256=sha(data));save(sf,state);need(read(PENDING)['owner']==OWNER,'pending_owner');PENDING.unlink();print(json.dumps({'status':'PASS','action':action,'ops_id':c['Id'],'protected_services_preserved':True,'business_pin_unchanged':True,'database_changed':False,'cloud_start_requested':False}))
 finally:
  for fd in reversed(fds):os.close(fd)
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'status':'FAIL','code':str(e) if isinstance(e,RuntimeError) else type(e).__name__,'automatic_retry':False,'pending_requires_reconciliation':PENDING.exists()}));raise SystemExit(1)
