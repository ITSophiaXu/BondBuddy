import base64,copy,fcntl,hashlib,importlib.util,json,os,pathlib,shutil,stat,subprocess,sys,datetime
ROOT=pathlib.Path('/var/lib/bondbuddy/audit-required1523-20261117');P=ROOT/'private';PUBLIC=ROOT/'public';STATE=pathlib.Path('/var/lib/bondbuddy/migration-908/state-main');OWNER='audit-required1523'
def need(ok,why):
 if not ok:raise RuntimeError(why)
def sha(b):return hashlib.sha256(b).hexdigest()
def read(p):return json.loads(p.read_bytes())
def run(a,b=None,timeout=90):
 p=subprocess.run(a,input=b,capture_output=True,timeout=timeout);need(p.returncode==0,'command_failed:'+a[0]);return p.stdout
def inspect(n):return json.loads(run(['docker','inspect',n]))[0]
def save(p,v):
 need(not p.is_symlink(),'symlink');b=(json.dumps(v,indent=2,sort_keys=True)+'\n').encode();fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb')as f:f.write(b);f.flush();os.fsync(f.fileno())
def effective(c,p):return (pathlib.Path('/proc')/str(c['State']['Pid'])/'root'/p.lstrip('/')).read_bytes()
def compare(old,c,overlay):
 need(old['Image']==c['Image'],'image_drift');a=copy.deepcopy(old['Config']);b=copy.deepcopy(c['Config'])
 for x in [a,b]:
  x.pop('Hostname',None);x.pop('Image',None);x['Env']=sorted(x.get('Env',[]));x['Labels']={k:v for k,v in x.get('Labels',{}).items()if not k.startswith('com.docker.compose.')}
 need(a==b,'process_configuration_drift');a=copy.deepcopy(old['HostConfig']);b=copy.deepcopy(c['HostConfig']);mounts={m['Target']:m for m in a.get('Mounts',[])}
 for m in overlay:mounts[m['target']]={'Type':'bind','Source':m['source'],'Target':m['target'],'ReadOnly':True,'BindOptions':{}}
 if mounts:a['Mounts']=list(mounts.values())
 for x in [a,b]:
  if x.get('OomKillDisable')is None:x['OomKillDisable']=False
  if x.get('Mounts')is not None:x['Mounts']=sorted(x['Mounts'],key=lambda m:m['Target'])
  for k in ['Binds','SecurityOpt','CapDrop','CapAdd']:
   if isinstance(x.get(k),list):x[k]=sorted(x[k])
 need(a==b,'host_configuration_drift')
def prepare(payload):
 need(os.geteuid()==0,'root');P.mkdir(mode=0o700,exist_ok=True);fds=[]
 try:
  for n in ['config.lock','deploy.lock','migration.lock']:
   p=STATE/n;need(not p.is_symlink()and stat.S_ISREG(p.stat().st_mode),'lock');fd=os.open(p,os.O_RDWR|os.O_NOFOLLOW);fds.append(fd);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  need(not(STATE/'pending-release.json').exists(),'other_pending');need(not(P/'plan.json').exists(),'existing_plan_reconcile');need(shutil.disk_usage(ROOT).free>=int(2.5*1024**3),'disk_margin')
  adapter=base64.b64decode(payload['adapter']);need(sha(adapter)==payload['adapter_sha256'],'adapter');ap=PUBLIC/'main-cutover-adapter.py';ap.write_bytes(adapter);os.chmod(ap,0o644)
  spec=importlib.util.spec_from_file_location('adapter',ap);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);cls=next(v for v in vars(m).values()if isinstance(v,type)and hasattr(v,'render'))
  class Renderer:
   root=P
   def run(self,argv,input=None,timeout=90):return run(argv,input,timeout)
   def atomic(self,p,data):
    if p.exists():need(p.read_bytes()==data,'existing_file_drift');return
    p.write_bytes(data);os.chmod(p,0o600)
  plan={'owner':OWNER,'source':payload['source'],'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'roles':{},'files':payload['manifest']['files'],'registry_sha256':sha((STATE/'current-components.json').read_bytes()),'protected':{n:inspect(n)['Id']for n in ['bb-main-postgres-1','bb-main-ops-1','bb-main-egress-1']},'full_quality_gate_passed':False,'activation_authorized_exception':False}
  for role in ['api','web']:
   c=inspect('bb-main-'+role+'-1');need(c['Id']==payload['manifest']['before'][role]['id'],'container_drift');need(c['State']['Running']and c['State'].get('Health',{}).get('Status','healthy')=='healthy','health')
   for f in payload['manifest']['before'][role]['files']:need(sha(effective(c,f['path']))==f['sha256'],'preimage_bytes')
   overlay=[]
   for f in [f for f in plan['files']if f['role']==role]:
    b=base64.b64decode(payload['files'][f['path']]);need(sha(b)==f['sha256'],'payload');p=PUBLIC/f['path'].lstrip('/');p.parent.mkdir(parents=True,exist_ok=True)
    if p.exists():need(p.read_bytes()==b,'staged_bytes_drift')
    else:p.write_bytes(b);os.chmod(p,0o644)
    overlay.append({'type':'bind','source':str(p),'target':f['path'],'read_only':True,'bind':{'create_host_path':False}})
   service,networks,volumes=cls.render(Renderer(),role,c);before={'name':'bb-main','services':{role:copy.deepcopy(service)},'networks':networks,'volumes':volumes};mapping={x['target']:x for x in service.get('volumes',[])}
   for x in overlay:mapping[x['target']]=x
   service['volumes']=list(mapping.values());after={'name':'bb-main','services':{role:service},'networks':networks,'volumes':volumes}
   save(P/(role+'.before.inspect.json'),c);save(P/(role+'.before.compose.json'),m.escape(before));save(P/(role+'.candidate.compose.json'),m.escape(after));probe=copy.deepcopy(after);name='bb-audit1523-'+role+'-probe';probe['services'][role]['container_name']=name;save(P/(role+'.probe.compose.json'),m.escape(probe))
   need(not run(['docker','ps','-aq','--filter','name=^/'+name+'$']).strip(),'prior_probe')
   try:
    run(['docker','compose','-p','bb-audit1523-'+role+'-probe','-f',str(P/(role+'.probe.compose.json')),'create','--no-build','--pull','never',role]);pr=inspect(name);need(not pr['State']['Running']and pr['State']['StartedAt'].startswith('0001-'),'probe_started');compare(c,pr,overlay)
   finally:
    q=subprocess.run(['docker','inspect',name],capture_output=True,timeout=20)
    if q.returncode==0:
     pr=json.loads(q.stdout)[0];need(not pr['State']['Running']and pr['Config']['Labels']['com.docker.compose.project']=='bb-audit1523-'+role+'-probe','probe_cleanup_scope');run(['docker','rm',pr['Id']])
   plan['roles'][role]={'before_id':c['Id'],'image':c['Image'],'overlay':overlay,'probe_passed':True,'source_configs':{x:sha(pathlib.Path(x).read_bytes())for x in c['Config']['Labels']['com.docker.compose.project.config_files'].split(',')},'config_sha256':{k:sha((P/(role+'.'+k+'.compose.json')).read_bytes())for k in ['before','candidate']}}
  need(sha((STATE/'current-components.json').read_bytes())==plan['registry_sha256'],'registry_drift');need(all(inspect(n)['Id']==v for n,v in plan['protected'].items()),'protected_drift');save(P/'plan.json',plan);save(P/'components.before.json',read(STATE/'current-components.json'))
  print(json.dumps({'status':'PREPARED','source':plan['source'],'probe_passed':list(plan['roles']),'files':len(plan['files']),'production_changed':False,'full_quality_gate_passed':False,'activation_authorized_exception':False,'plan_sha256':sha((P/'plan.json').read_bytes()),'rollback_path':str(P)}))
 finally:
  for fd in reversed(fds):os.close(fd)
if __name__ == "__main__": prepare(json.load(sys.stdin))
