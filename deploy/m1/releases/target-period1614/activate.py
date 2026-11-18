"""PR1614 web-only activation; exact live preimages, shared locks, CAS and rollback."""
import base64,copy,datetime,fcntl,hashlib,importlib.util,json,os,pathlib,shutil,stat,subprocess,sys,time,urllib.request
ROOT=pathlib.Path('/var/lib/bondbuddy/target1614-20261118');P=ROOT/'private';PUBLIC=ROOT/'public';STATE=pathlib.Path('/var/lib/bondbuddy/migration-908/state-main');OWNER='target1614-web';PENDING=STATE/'pending-release.json'
def need(ok,code):
 if not ok:raise RuntimeError(code)
def sha(b):return hashlib.sha256(b).hexdigest()
def read(p):return json.loads(p.read_bytes())
def run(a,b=None,timeout=90):
 p=subprocess.run(a,input=b,capture_output=True,timeout=timeout)
 if p.returncode!=0:atomic(P/('command-failed-'+str(time.time_ns())+'.private.log'),p.stdout+p.stderr)
 need(p.returncode==0,'command_failed:'+a[0]);return p.stdout
def inspect(n):return json.loads(run(['docker','inspect',n]))[0]
def atomic(p,b,mode=0o600):
 need(not p.is_symlink(),'symlink_rejected');tmp=p.with_name(p.name+'.target1614-tmp');fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 with os.fdopen(fd,'wb') as f:f.write(b);f.flush();os.fsync(f.fileno())
 os.replace(tmp,p)
def save(p,v):atomic(p,(json.dumps(v,indent=2,sort_keys=True)+'\n').encode())
def effective(c,path):return (pathlib.Path('/proc')/str(c['State']['Pid'])/'root'/path.lstrip('/')).read_bytes()
def healthy(c):return c['State']['Running'] and c['State'].get('Health',{}).get('Status','healthy')=='healthy'
def check_config(old,current,overlay):
 need(current['Image']==old['Image'],'image_drift');a=copy.deepcopy(old['Config']);b=copy.deepcopy(current['Config'])
 for x in [a,b]:
  x.pop('Hostname',None);x.pop('Image',None);x['Env']=sorted(x.get('Env',[]));x['Labels']={k:v for k,v in x.get('Labels',{}).items() if not k.startswith(('com.docker.compose.','com.bondbuddy.target1614.'))}
 need(a==b,'process_configuration_drift');a=copy.deepcopy(old['HostConfig']);b=copy.deepcopy(current['HostConfig'])
 need(a.get('Binds') is None and b.get('Binds') is None,'unexpected_short_web_bind')
 mounts={m['Target']:m for m in a.get('Mounts',[])}
 for v in overlay:mounts[v['target']]={'Type':'bind','Source':v['source'],'Target':v['target'],'ReadOnly':True,'BindOptions':{}}
 a['Mounts']=list(mounts.values())
 for x in [a,b]:
  if x.get('OomKillDisable') is None:x['OomKillDisable']=False
  x['Mounts']=sorted(x.get('Mounts',[]),key=lambda m:m['Target'])
  for k in ['Binds','SecurityOpt','CapDrop','CapAdd']:
   if isinstance(x.get(k),list):x[k]=sorted(x[k])
 need(a==b,'host_configuration_drift')
def recreate(kind):
 path=P/('web.'+kind+'.compose.private.json');run(['docker','compose','-p','bb-main','-f',str(path),'up','-d','--no-deps','--no-build','--pull','never','--force-recreate','--wait','--wait-timeout','90','web'],timeout=120);c=inspect('bb-main-web-1');need(healthy(c),'web_health');return c
def protected(names):
 return {n:{'id':c['Id'],'image':c['Image'],'configuration':sha(json.dumps({'Config':c['Config'],'HostConfig':c['HostConfig']},sort_keys=True).encode()),'started':c['State']['StartedAt'],'running':c['State']['Running']}for n in names for c in [inspect(n)]}

def bindings(c):
 return {m['Source']:sha(pathlib.Path(m['Source']).read_bytes())for m in c['Mounts']if m['Type']=='bind' and pathlib.Path(m['Source']).is_file()}

def verify_files(c,files,http=False):
 for f in files:
  need(sha(effective(c,'/usr/share/nginx/html/'+f['path']))==f['sha256'],'effective_file:'+f['path'])
  if http:
   with urllib.request.urlopen('http://127.0.0.1:18090/'+(''if f['path']=='index.html'else f['path']),timeout=20)as response:need(response.status==200 and sha(response.read())==f['sha256'],'served_file:'+f['path'])

def pending(value,create=False):
 if create:
  fd=os.open(PENDING,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'wb')as f:f.write(json.dumps(value).encode());f.flush();os.fsync(f.fileno())
 else:
  need(read(PENDING).get('owner')==OWNER,'pending_owner');save(PENDING,value)

def main(payload):
 need(os.geteuid()==0,'root');action=payload['action'];need(action in ['prepare','activate','rollback'],'action')
 ROOT.mkdir(mode=0o700,parents=True,exist_ok=True);P.mkdir(mode=0o700,exist_ok=True);PUBLIC.mkdir(mode=0o700,exist_ok=True)
 fds=[]
 try:
  for n in ['config.lock','deploy.lock']:
   path=STATE/n;s=path.lstat();need(stat.S_ISREG(s.st_mode)and not path.is_symlink(),'lock_file');fd=os.open(path,os.O_RDWR|os.O_NOFOLLOW);fds.append((fd,path,s.st_dev,s.st_ino));fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  def lock_check():
   for fd,p,d,i in fds:
    s=p.lstat();t=os.fstat(fd);need((s.st_dev,s.st_ino)==(t.st_dev,t.st_ino)==(d,i),'lock_inode_changed')
  lock_check()
  if action=='prepare':
   need(not PENDING.exists(),'other_pending');need(not (P/'web.prepared.json').exists(),'prior_prepare_reconcile');v=payload['manifest'];need(v['source_pr']==1614 and v['api_changed']==False and v['migrations']==0 and v['full_quality_gate_passed']==False,'scope');need(len(v['files'])==2 and len(v['prior_web_files'])==7 and len(v['candidate_web_files'])==7,'files')
   need(sha((STATE/'current-components.json').read_bytes())==v['registry_before_sha256'],'registry_drift');c=inspect('bb-main-web-1');need(c['Id']==v['web_before']['id']and c['Image']==v['web_before']['image']and healthy(c),'web_preimage')
   for p,h in v['source_configs'].items():need(sha(pathlib.Path(p).read_bytes())==h,'source_config_drift')
   before_protected=protected(v['protected_ids'])
   for n,h in v['protected_ids'].items():need(before_protected[n]['id']==h,'protected_id_drift')
   verify_files(c,v['prior_web_files'],True);mounts=bindings(c)
   for f in v['files']:
    need(f['path']=='index.html'or f['path'].startswith('assets/')and '..'not in f['path'],'path');b=base64.b64decode(payload['files'][f['path']]);need(sha(b)==f['sha256']and len(b)==f['bytes'],'file_hash');path=PUBLIC/'web'/f['path'];path.parent.mkdir(parents=True,exist_ok=True);atomic(path,b,0o644)
   adapter=base64.b64decode(payload['adapter']);need(sha(adapter)==v['adapter_sha256'],'adapter_hash');atomic(PUBLIC/'main-cutover-adapter.py',adapter,0o644)
   script=base64.b64decode(payload['script']);need(sha(script)==v['activation_script_sha256'],'script_hash');atomic(PUBLIC/'activate.py',script,0o644);save(PUBLIC/'manifest.json',v)
   spec=importlib.util.spec_from_file_location('adapter',PUBLIC/'main-cutover-adapter.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);cls=next(x for x in vars(module).values()if isinstance(x,type)and hasattr(x,'render'))
   class Renderer:
    root=P
    def run(self,argv,input=None,timeout=90):return run(argv,input,timeout)
    def atomic(self,p,data):atomic(p,data)
   service,networks,volumes=cls.render(Renderer(),'web',c);before={'name':'bb-main','services':{'web':copy.deepcopy(service)},'networks':networks,'volumes':volumes}
   overlay=[{'type':'bind','source':str(PUBLIC/'web'/f['path']),'target':'/usr/share/nginx/html/'+f['path'],'read_only':True,'bind':{'create_host_path':False}}for f in v['files']];mapping={x['target']:x for x in service['volumes']}
   for x in overlay:mapping[x['target']]=x
   service['volumes']=list(mapping.values());after={'name':'bb-main','services':{'web':service},'networks':networks,'volumes':volumes}
   save(P/'web.before.inspect.private.json',c);save(P/'web.before.compose.private.json',module.escape(before));save(P/'web.candidate.compose.private.json',module.escape(after));probe=copy.deepcopy(after);name='bb-target1614-web-probe';probe['services']['web']['container_name']=name;probe['services']['web'].setdefault('labels',{})['com.bondbuddy.target1614.probe']=OWNER;save(P/'web.probe.compose.private.json',module.escape(probe))
   need(not run(['docker','ps','-aq','--filter','name=^/'+name+'$']).strip(),'probe_exists')
   try:
    run(['docker','compose','-p','bb-target1614-web-probe','-f',str(P/'web.probe.compose.private.json'),'create','--no-build','--pull','never','web']);probe=inspect(name);need(not probe['State']['Running']and probe['State']['StartedAt'].startswith('0001-'),'probe_started');check_config(c,probe,overlay)
   finally:
    q=subprocess.run(['docker','inspect',name],capture_output=True,timeout=20)
    if q.returncode==0:
     probe=json.loads(q.stdout)[0];need(probe['Config']['Labels'].get('com.bondbuddy.target1614.probe')==OWNER and not probe['State']['Running'],'probe_cleanup_scope');run(['docker','rm',probe['Id']])
   for f in v['prior_web_files']:
    p=P/'baseline'/f['path'];p.parent.mkdir(parents=True,exist_ok=True);atomic(p,effective(c,'/usr/share/nginx/html/'+f['path']))
   plan={'manifest':v,'web_id':c['Id'],'overlay':overlay,'registry_hash':v['registry_before_sha256'],'binding_hash':sha((STATE/'environment-binding.json').read_bytes()),'compose_hashes':{k:sha((P/('web.'+k+'.compose.private.json')).read_bytes())for k in ['before','candidate']},'protected':before_protected,'probe_passed':True,'source_configs':v['source_configs'],'mount_preimages':mounts,'network_ids':{k:x['NetworkID']for k,x in c['NetworkSettings']['Networks'].items()}}
   need(protected(v['protected_ids'])==before_protected,'protected_drift');lock_check();save(P/'web.prepared.json',plan);print(json.dumps({'status':'PREPARED','web_id':c['Id'],'probe_config_preserved':True,'baseline_files_verified':7,'services_changed':False}));return
  plan=read(P/'web.prepared.json');v=plan['manifest'];old=read(P/'web.before.inspect.private.json');c=inspect('bb-main-web-1');sf=P/'web.activation.json';prior=read(sf)if sf.exists()else None;rollback=action=='rollback'
  need(plan['probe_passed']and shutil.disk_usage(ROOT).free>=int(2.5*1024**3),'release_preflight');need(sha((STATE/'environment-binding.json').read_bytes())==plan['binding_hash'],'environment_binding_drift')
  for k,h in plan['compose_hashes'].items():need(sha((P/('web.'+k+'.compose.private.json')).read_bytes())==h,'compose_hash')
  need(protected(plan['protected'])==plan['protected'],'protected_drift')
  for p,h in plan['mount_preimages'].items():need(sha(pathlib.Path(p).read_bytes())==h,'original_asset_drift')
  for p,h in plan['source_configs'].items():need(sha(pathlib.Path(p).read_bytes())==h,'config_preimage')
  if not rollback:
   need(not prior and not PENDING.exists(),'prior_attempt_or_other_pending');need(c['Id']==plan['web_id'],'web_preimage');need(sha((STATE/'current-components.json').read_bytes())==plan['registry_hash'],'registry_drift');check_config(old,c,[]);verify_files(c,v['prior_web_files'],True)
   for f in v['files']:need(sha((PUBLIC/'web'/f['path']).read_bytes())==f['sha256'],'candidate_hash')
   atomic(P/'web.registry.before.json',(STATE/'current-components.json').read_bytes());save(sf,{'owner':OWNER,'phase':'activating','source_commit':payload['source_commit']})
  else:
   need(prior and prior['owner']==OWNER,'owned_attempt_required');need(not PENDING.exists()or read(PENDING).get('owner')==OWNER,'other_pending');check_config(old,c,plan['overlay']if c['Id']!=plan['web_id']else [])
   need(sha((STATE/'current-components.json').read_bytes())in {plan['registry_hash'],prior.get('registry_after_sha256')},'rollback_registry_drift')
  lock_check();pending({'owner':OWNER,'source':payload['source_commit'],'root':str(ROOT),'phase':'web_'+action},create=not PENDING.exists());c=recreate('before'if rollback else 'candidate');check_config(old,c,[]if rollback else plan['overlay']);need({k:x['NetworkID']for k,x in c['NetworkSettings']['Networks'].items()}==plan['network_ids'],'network_drift')
  files=v['prior_web_files']if rollback else v['candidate_web_files'];verify_files(c,files,True);need(protected(plan['protected'])==plan['protected'],'protected_service_drift')
  with urllib.request.urlopen('http://127.0.0.1:18090/healthz',timeout=20)as response:need(response.status==200,'healthz')
  need(sha((STATE/'current-components.json').read_bytes())in ({plan['registry_hash'],prior.get('registry_after_sha256')}if rollback else {plan['registry_hash']}),'registry_final_cas');registry=read(P/'web.registry.before.json')if rollback else read(STATE/'current-components.json');record=registry['components']['web'];cfg=str(P/('web.'+('before'if rollback else 'candidate')+'.compose.private.json'));record.update(container_id=c['Id'],image_id=c['Image'],configuration_path=cfg,configuration_files=[cfg],configuration_sha256=sha(pathlib.Path(cfg).read_bytes()),config_env_sha256=sha(json.dumps(c['Config'],sort_keys=True).encode()),host_config_sha256=sha(json.dumps(c['HostConfig'],sort_keys=True).encode()),running=True,health='healthy',started_at=c['State']['StartedAt'],started_utc=c['State']['StartedAt'])
  receipt={'owner':OWNER,'phase':'rolled_back'if rollback else 'deployed_and_verified','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_commit':payload['source_commit'],'source_pr':1614,'scope':'web labels only','manifest_sha256':sha((PUBLIC/'manifest.json').read_bytes()),'web_container':c['Id'],'web_image':c['Image'],'files':files,'other_services_preserved':True,'migrations':0,'new_dependencies':0,'real_model_calls':0,'full_quality_gate_passed':False,'user_acceptance_recorded':False,'scoped_browser_tests_passed':v['candidate_browser_tests_passed'],'rollback_config':str(P/'web.before.compose.private.json')}
  record['target_reporting_period1614']=receipt;lock_check();save(STATE/'current-components.json',registry);receipt['registry_after_sha256']=sha((STATE/'current-components.json').read_bytes());save(sf,receipt);save(STATE/'release-target1614-web-20261118.json',receipt);need(read(PENDING)['owner']==OWNER,'pending_owner');PENDING.unlink();print(json.dumps(receipt))
 finally:
  for fd,_,_,_ in reversed(fds):os.close(fd)

if __name__=='__main__':
 try:main(json.load(sys.stdin))
 except Exception as e:print(json.dumps({'status':'FAIL','code':str(e)if isinstance(e,RuntimeError)else type(e).__name__,'pending':PENDING.exists(),'automatic_retry':False}));raise SystemExit(1)
