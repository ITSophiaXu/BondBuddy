import base64,copy,fcntl,hashlib,importlib.util,json,os,pathlib,shutil,stat,subprocess,sys,datetime
ROOT=pathlib.Path('/var/lib/bondbuddy/integrity1531-final-20261117');P=ROOT/'private';PUBLIC=ROOT/'public';STATE=pathlib.Path('/var/lib/bondbuddy/migration-908/state-main');OWNER='integrity1531'
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
 need(os.geteuid()==0,'root');ROOT.mkdir(mode=0o755,exist_ok=True);PUBLIC.mkdir(mode=0o755,exist_ok=True);P.mkdir(mode=0o700,exist_ok=True);fds=[]
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
   save(P/(role+'.before.inspect.json'),c);save(P/(role+'.before.compose.json'),m.escape(before));save(P/(role+'.candidate.compose.json'),m.escape(after));probe=copy.deepcopy(after);name='bb-integrity1531-'+role+'-probe';probe['services'][role]['container_name']=name;save(P/(role+'.probe.compose.json'),m.escape(probe))
   need(not run(['docker','ps','-aq','--filter','name=^/'+name+'$']).strip(),'prior_probe')
   try:
    run(['docker','compose','-p','bb-integrity1531-'+role+'-probe','-f',str(P/(role+'.probe.compose.json')),'create','--no-build','--pull','never',role]);pr=inspect(name);need(not pr['State']['Running']and pr['State']['StartedAt'].startswith('0001-'),'probe_started');compare(c,pr,overlay)
   finally:
    q=subprocess.run(['docker','inspect',name],capture_output=True,timeout=20)
    if q.returncode==0:
     pr=json.loads(q.stdout)[0];need(not pr['State']['Running']and pr['Config']['Labels']['com.docker.compose.project']=='bb-integrity1531-'+role+'-probe','probe_cleanup_scope');run(['docker','rm',pr['Id']])
   plan['roles'][role]={'before_id':c['Id'],'image':c['Image'],'overlay':overlay,'probe_passed':True,'source_configs':{x:sha(pathlib.Path(x).read_bytes())for x in c['Config']['Labels']['com.docker.compose.project.config_files'].split(',')},'config_sha256':{k:sha((P/(role+'.'+k+'.compose.json')).read_bytes())for k in ['before','candidate']}}
  need(sha((STATE/'current-components.json').read_bytes())==plan['registry_sha256'],'registry_drift');need(all(inspect(n)['Id']==v for n,v in plan['protected'].items()),'protected_drift');save(P/'plan.json',plan);save(P/'components.before.json',read(STATE/'current-components.json'))
  print(json.dumps({'status':'PREPARED','source':plan['source'],'probe_passed':list(plan['roles']),'files':len(plan['files']),'production_changed':False,'full_quality_gate_passed':False,'activation_authorized_exception':False,'plan_sha256':sha((P/'plan.json').read_bytes()),'rollback_path':str(P)}))
 finally:
  for fd in reversed(fds):os.close(fd)

import urllib.request,urllib.error,time
PENDING=STATE/'pending-release.json';REGISTRY=STATE/'current-components.json'
def atomic(p,b):
 need(not p.is_symlink(),'symlink');tmp=p.with_name(p.name+'.integrity1531-tmp');fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb')as f:f.write(b);f.flush();os.fsync(f.fileno())
 os.replace(tmp,p)
def update(p,v):atomic(p,(json.dumps(v,indent=2,sort_keys=True)+'\n').encode())
def healthy(c):return c['State']['Running']and c['State'].get('Health',{}).get('Status','healthy')=='healthy'
def request(path,expected=200):
 try:
  with urllib.request.urlopen('http://127.0.0.1:18090'+path,timeout=20)as r:need(r.status==expected,'http_status');return r.read()
 except urllib.error.HTTPError as e:
  need(e.code==expected,'http_status');return b''
def activate(payload):
 need(payload['action']=='activate','action');need(payload['approval']['answer']=='部署到服务器','specific_approval');need(payload['approval']['pr']==1531,'scope');need(not any(k.startswith('COMPOSE_')for k in os.environ),'compose_environment')
 need(sha((P/'plan.json').read_bytes())==payload['plan_sha256'],'plan_hash');plan=read(P/'plan.json');need(plan['source']==payload['source'],'source');need(len(plan['files'])==8,'scope_files');need(read(ROOT/'api-canary.json')['status']=='PASS','canary')
 fds=[];attempt=False;registry_after_hash=None;receipt=None;state_file=P/'activation-state.json'
 try:
  for n in ['config.lock','deploy.lock','migration.lock']:
   p=STATE/n;need(not p.is_symlink()and stat.S_ISREG(p.stat().st_mode),'lock');fd=os.open(p,os.O_RDWR|os.O_NOFOLLOW);fds.append(fd);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  need(not PENDING.exists(),'pending_requires_reconcile');need(not state_file.exists(),'prior_attempt_requires_reconcile');need(shutil.disk_usage(ROOT).free>=int(2.5*1024**3),'disk_margin')
  raw_registry=REGISTRY.read_bytes();need(sha(raw_registry)==payload['registry_sha256'],'registry_drift');registry=json.loads(raw_registry);prior=read(P/'components.before.json')
  need(all(registry['components'][r]==prior['components'][r]for r in ['api','web']),'target_component_record_drift')
  old={r:read(P/(r+'.before.inspect.json'))for r in ['api','web']};protected={**plan['protected'],'bb-main-ops-1':payload['ops_id']}
  def check_protected():
   for n,cid in protected.items():need(inspect(n)['Id']==cid,'protected_service_drift:'+n)
  def activity():
   sql=b"BEGIN READ ONLY;SELECT json_build_object('leases',(SELECT count(*) FROM bb_jobs WHERE lease_token IS NOT NULL)+(SELECT count(*) FROM bb_review_messages WHERE lease_token IS NOT NULL),'holders',(SELECT count(*) FROM bb_model_capacity_holders));ROLLBACK;"
   counts=json.loads(run(['docker','exec','-i','bb-main-postgres-1','psql','-X','-qAt','-U','bondbuddy','-d','bondbuddy','-v','ON_ERROR_STOP=1'],sql));return counts
  check_protected();guard=activity();ops=inspect('bb-main-ops-1');need(ops['Image']==registry['components']['ops']['image_id'],'ops_image_drift');need(ops['Config']['Labels']['com.docker.compose.project.config_files']==registry['components']['ops']['configuration_path'],'ops_config_drift')
  for role,item in plan['roles'].items():
   c=inspect('bb-main-'+role+'-1');need(c['Id']==item['before_id']and healthy(c),'target_preimage');compare(old[role],c,[])
   for p,h in item['source_configs'].items():need(sha(pathlib.Path(p).read_bytes())==h,'source_configuration_drift')
   for kind,h in item['config_sha256'].items():need(sha((P/(role+'.'+kind+'.compose.json')).read_bytes())==h,'prepared_configuration_drift')
  for role,item in payload['before'].items():
   c=inspect('bb-main-'+role+'-1')
   for f in item['files']:need(sha(effective(c,f['path']))==f['sha256'],'preimage_bytes_drift')
  for f in plan['files']:need(sha((PUBLIC/f['path'].lstrip('/')).read_bytes())==f['sha256'],'candidate_bytes_drift')
  request('/healthz');request('/api/v1/me',401)
  atomic(P/'components.before-activation.json',raw_registry);update(P/'authorization.json',payload['approval'])
  seal={'owner':OWNER,'phase':'activating','source':payload['source'],'release_commit':payload['release_commit'],'plan_sha256':payload['plan_sha256'],'registry_before_sha256':sha(raw_registry),'protected':protected,'approval':payload['approval'],'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'root':str(ROOT)}
  update(state_file,seal);update(PENDING,seal);attempt=True
  def switch(kind):
   for role in ['api','web']:
    check_protected();seal['phase']=kind+'_'+role;update(state_file,seal);update(PENDING,seal)
    f=P/(role+'.'+kind+'.compose.json');run(['docker','compose','-p','bb-main','-f',str(f),'up','-d','--no-deps','--no-build','--pull','never','--force-recreate','--wait','--wait-timeout','90',role],timeout=120)
    c=inspect('bb-main-'+role+'-1');compare(old[role],c,plan['roles'][role]['overlay']if kind=='candidate'else[]);need(healthy(c),'target_health');seal.setdefault('observed_ids',{})[role]=c['Id'];update(state_file,seal)
  try:
   switch('candidate');check_protected();actual={r:inspect('bb-main-'+r+'-1')for r in ['api','web']}
   for f in plan['files']:
    need(sha(effective(actual[f['role']],f['path']))==f['sha256'],'effective_module_hash')
    if f['role']=='web':need(sha(request('/'if f['path'].endswith('/index.html')else'/'+f['path'].removeprefix('/usr/share/nginx/html/')))==f['sha256'],'served_web_hash')
   request('/healthz');request('/api/v1/me',401)
   js=(PUBLIC/'canary.mjs').read_text()
   runtime=json.loads(run(['docker','exec','-i','bb-main-api-1','node','--input-type=module'],js.encode()))
   need(REGISTRY.read_bytes()==raw_registry,'registry_cas');now=datetime.datetime.now(datetime.timezone.utc).isoformat()
   receipt={'owner':OWNER,'phase':'deployed_and_verified','at':now,'source_commit':payload['source'],'release_commit':payload['release_commit'],'archive_sha256':payload['archive_sha256'],'plan_sha256':payload['plan_sha256'],'containers':{r:{'id':c['Id'],'image':c['Image']}for r,c in actual.items()},'files':plan['files'],'runtime_verification':runtime,'protected':protected,'other_services_preserved':True,'migrations':0,'model_calls':0,'full_quality_gate_passed':False,'specific_user_exception':payload['approval'],'human_document_acceptance':False,'rollback_root':str(P),'guard_before':guard}
   for role,c in actual.items():
    rec=registry['components'][role];rec.update(container_id=c['Id'],image_id=c['Image'],configuration_path=str(P/(role+'.candidate.compose.json')),configuration_files=[str(P/(role+'.candidate.compose.json'))],configuration_sha256=sha((P/(role+'.candidate.compose.json')).read_bytes()),runtime_configuration_sha256=sha(json.dumps({k:c[k]for k in ['Config','HostConfig']},sort_keys=True,separators=(',',':')).encode()),started_at=c['State']['StartedAt'],started_utc=c['State']['StartedAt'],running=True,health=c['State'].get('Health',{}).get('Status'))
    rec['integrity_accessibility1531']={'source_commit':payload['source'],'release_commit':payload['release_commit'],'archive_sha256':payload['archive_sha256'],'at':now,'receipt':str(P/'activation.json'),'rollback':False}
   new_registry=(json.dumps(registry,indent=2,sort_keys=True)+'\n').encode();registry_after_hash=sha(new_registry);seal['registry_after_sha256']=registry_after_hash;seal['phase']='verified_pending_registry';update(state_file,seal);update(PENDING,seal)
   atomic(REGISTRY,new_registry);receipt['registry_after_sha256']=registry_after_hash;update(P/'activation.json',receipt);update(STATE/'release-integrity1531-20261117.json',receipt)
   seal['phase']='deployed_and_verified';update(state_file,seal);need(read(PENDING)['owner']==OWNER,'pending_owner');PENDING.unlink();print(json.dumps(receipt));return
  except Exception as error:
   cause=str(error)if isinstance(error,RuntimeError)else type(error).__name__;seal.update(phase='failed',error=cause);update(state_file,seal);update(PENDING,seal)
   try:
    check_protected();need(sha(REGISTRY.read_bytes())in{sha(raw_registry),registry_after_hash},'rollback_registry_drift');need(read(PENDING)['owner']==OWNER,'rollback_pending_owner')
    for role in ['api','web']:
     if not run(['docker','ps','-aq','--filter','name=^/bb-main-'+role+'-1$']).strip():continue
     c=inspect('bb-main-'+role+'-1');need(c['Image']==old[role]['Image'],'rollback_unknown_image')
     try:compare(old[role],c,plan['roles'][role]['overlay'])
     except RuntimeError:compare(old[role],c,[])
    switch('before');check_protected()
    for role,item in payload['before'].items():
     c=inspect('bb-main-'+role+'-1')
     for f in item['files']:need(sha(effective(c,f['path']))==f['sha256'],'rollback_bytes')
    request('/healthz');request('/api/v1/me',401);restored=json.loads(raw_registry)
    for role in ['api','web']:
     c=inspect('bb-main-'+role+'-1');restored['components'][role].update(container_id=c['Id'],configuration_path=str(P/(role+'.before.compose.json')),configuration_files=[str(P/(role+'.before.compose.json'))],started_at=c['State']['StartedAt'],started_utc=c['State']['StartedAt'])
    update(REGISTRY,restored);seal.update(phase='rolled_back',error=cause);update(state_file,seal);update(P/'failed-and-rolled-back.json',seal);need(read(PENDING)['owner']==OWNER,'pending_owner');PENDING.unlink();print(json.dumps({'status':'ROLLED_BACK','error':cause,'production_healthy':True}));return
   except Exception as recovery:
    seal.update(phase='rollback_needs_reconcile',recovery_error=str(recovery)if isinstance(recovery,RuntimeError)else type(recovery).__name__);update(state_file,seal);update(PENDING,seal);raise
 finally:
  for fd in reversed(fds):os.close(fd)