"""Scoped #1611 deployment; preserves live runtime configuration and existing locks.
Only explicit dispatch actions mutate the four authorized components. No migrations,
model calls, shared role rollback, credential transport, or forced worker shutdown.
"""
import base64,copy,fcntl,hashlib,json,os,pathlib,shutil,stat,subprocess,sys,datetime,time
OWNER='audit-pdf1610-20261118'
ARCHIVE='19430979b0fa4af00e1feb9da0849993fff4a107b961621f7775abdc4618690e'
ROOT=pathlib.Path('/var/lib/bondbuddy/audit-pdf1610-20261118')
P=ROOT/'private'; PUBLIC=ROOT/'public'
SERVICES={'api':'api','web':'web','parser':'worker-parse','confirmation':'upload-confirmation'}

def configure(host):
 global STATE,PROJECT,ROLES,REGISTRY,PENDING
 need(host in ('main','azure'),'host')
 PROJECT='bb-main' if host=='main' else 'bb-execution'
 STATE=pathlib.Path('/var/lib/bondbuddy/migration-908/state-main' if host=='main' else '/home/azureuser/.local/share/bondbuddy/pg-forward-908/state-execution')
 ROLES=['api','web'] if host=='main' else ['parser','confirmation']
 REGISTRY=STATE/'current-components.json';PENDING=STATE/'pending-release.json'

def escape(v):
 if isinstance(v,str):return v.replace('$','$$')
 if isinstance(v,list):return [escape(x) for x in v]
 if isinstance(v,dict):return {k:escape(x) for k,x in v.items()}
 return v

def write_once(p,b):
 if p.exists():need(p.read_bytes()==b,'existing_bytes_drift:'+p.name);return
 p.parent.mkdir(parents=True,exist_ok=True)
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb')as f:f.write(b);f.flush();os.fsync(f.fileno())

def update(p,v):
 b=(json.dumps(v,indent=2,sort_keys=True)+'\n').encode();tmp=p.with_name(p.name+'.audit1610.tmp')
 write_once(tmp,b);os.replace(tmp,p)

def utc():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def name(role):return PROJECT+'-'+SERVICES[role]+'-1'
def healthy(c):return c['State']['Running'] and c['State'].get('Health',{}).get('Status','healthy')=='healthy'
def state_digest():return {f.name:sha(f.read_bytes()) for f in [REGISTRY,STATE/'environment-binding.json'] if f.exists()}
def snapshot(c):return {'id':c['Id'],'image':c['Image'],'running':c['State']['Running'],'started_at':c['State']['StartedAt'],'restarts':c['RestartCount']}

def protected_now():
 ids=run(['docker','ps','-aq','--filter','label=com.docker.compose.project='+PROJECT]).decode().split()
 return {c['Name'].lstrip('/'):snapshot(c) for c in [inspect(i)for i in ids] if c['Name'].lstrip('/') not in {name(r)for r in ROLES}}

def protected(plan):need(protected_now()==plan['protected'],'non_target_service_drift')

def preimages(manifest,role,c):
 for f in manifest['before'][role]['files']:need(sha(effective(c,f['path']))==f['sha256'],'preimage_bytes:'+f['path'])
 for f in manifest['files']:
  if f['role']==role and f['before_sha256'] is None:
   need(not (pathlib.Path('/proc')/str(c['State']['Pid'])/'root'/f['path'].lstrip('/')).exists(),'unexpected_new_path:'+f['path'])

def validate(plan):
 protected(plan);need(state_digest()==plan['state_digest'],'registry_or_binding_drift')
 for r,v in plan['roles'].items():
  for p,h in v['source_configs'].items():need(sha(pathlib.Path(p).read_bytes())==h,'source_configuration_drift')
  for kind,h in v['config_sha256'].items():need(sha((P/(r+'.'+kind+'.compose.json')).read_bytes())==h,'prepared_configuration_drift')
 for f in plan['files']:need(sha((PUBLIC/f['archive_path']).read_bytes())==f['sha256'],'staged_bytes_drift')

def prepare(payload):
 manifest=payload['manifest'];need(manifest['archive_sha256']==ARCHIVE and len(manifest['files'])==27,'scope')
 need(not PENDING.exists(),'other_pending');need(not (P/'plan.json').exists(),'existing_plan')
 need(shutil.disk_usage(ROOT).free>=int(2.5*1024**3),'disk_margin')
 plan={'owner':OWNER,'at':utc(),'manifest':manifest,'files':[f for f in manifest['files']if f['role']in ROLES],'roles':{},'protected':protected_now(),'state_digest':state_digest(),'full_quality_gate_passed':False}
 write_once(P/'components.before.json',REGISTRY.read_bytes());write_once(P/'binding.before.json',(STATE/'environment-binding.json').read_bytes())
 for role in ROLES:
  c=inspect(name(role));need(c['Id']==manifest['before'][role]['id']and c['Image']==manifest['before'][role]['image']and healthy(c),'target_drift:'+role);preimages(manifest,role,c)
  overlay=[]
  for f in [f for f in plan['files']if f['role']==role]:
   b=base64.b64decode(payload['files'][f['archive_path']]);need(sha(b)==f['sha256'],'payload');p=PUBLIC/f['archive_path'];write_once(p,b);os.chmod(p,0o644)
   overlay.append({'type':'bind','source':str(p),'target':f['path'],'read_only':True,'bind':{'create_host_path':False}})
  service,networks,volumes=render(SERVICES[role],c);before={'name':PROJECT,'services':{SERVICES[role]:copy.deepcopy(service)},'networks':networks,'volumes':volumes}
  mapping={x['target']:x for x in service.get('volumes',[])}
  for x in overlay:mapping[x['target']]=x
  service['volumes']=list(mapping.values());after={'name':PROJECT,'services':{SERVICES[role]:service},'networks':networks,'volumes':volumes}
  for kind,v in [('before',before),('candidate',after)]:write_once(P/(role+'.'+kind+'.compose.json'),(json.dumps(escape(v),indent=2)+'\n').encode())
  write_once(P/(role+'.before.inspect.json'),json.dumps(c).encode());probe=copy.deepcopy(after);pn='bb-audit1610-'+role+'-probe';probe['services'][SERVICES[role]]['container_name']=pn
  probe_file=P/(role+'.probe.compose.json');write_once(probe_file,json.dumps(escape(probe)).encode())
  need(not run(['docker','ps','-aq','--filter','name=^/'+pn+'$']).strip(),'existing_probe')
  try:
   run(['docker','compose','-p',pn,'-f',str(probe_file),'create','--no-build','--pull','never',SERVICES[role]],timeout=120)
   pr=inspect(pn);need(not pr['State']['Running']and pr['State']['StartedAt'].startswith('0001-'),'probe_started');compare(c,pr,overlay)
  finally:
   q=subprocess.run(['docker','inspect',pn],capture_output=True,timeout=20)
   if q.returncode==0:
    pr=json.loads(q.stdout)[0];need(not pr['State']['Running']and pr['Config']['Labels']['com.docker.compose.project']==pn,'probe_cleanup_scope');run(['docker','rm',pr['Id']])
  plan['roles'][role]={'before_id':c['Id'],'image':c['Image'],'overlay':overlay,'probe_passed':True,'source_configs':{x:sha(pathlib.Path(x).read_bytes())for x in (c['Config']['Labels']['com.docker.compose.project.config_files']+','+c['Config']['Labels'].get('com.docker.compose.project.environment_file','')).split(',')if x},'config_sha256':{k:sha((P/(role+'.'+k+'.compose.json')).read_bytes())for k in ['before','candidate']}}
 validate(plan);save(P/'plan.json',plan)
 return {'status':'PREPARED','at':utc(),'roles':ROLES,'files':len(plan['files']),'probe_passed':True,'plan_sha256':sha((P/'plan.json').read_bytes()),'production_changed':False,'free_bytes':shutil.disk_usage(ROOT).free}

def get_seal(payload,plan):
 need(sha((P/'plan.json').read_bytes())==payload['plan_sha256'],'plan_hash')
 approval=payload['approval'];need(approval['answer']=='批准本批限定例外并继续部署' and approval['pr']==1611 and approval['source_prs']==[1610,1605,1591]and approval['archive_sha256']==ARCHIVE,'approval_scope')
 need(len(payload['release_commit'])==40,'release_commit')
 if PENDING.exists():
  seal=read(PENDING);need(seal['owner']==OWNER and seal['release_commit']==payload['release_commit']and seal['plan_sha256']==payload['plan_sha256'],'pending_owner');return seal
 need(not(P/'activation-state.json').exists(),'previous_activation_requires_reconcile')
 for r,v in plan['roles'].items():
  c=inspect(name(r));need(c['Id']==v['before_id']and healthy(c),'target_preimage');compare(read(P/(r+'.before.inspect.json')),c,[]);preimages(plan['manifest'],r,c)
 seal={'owner':OWNER,'phase':'sealed','at':utc(),'release_commit':payload['release_commit'],'plan_sha256':payload['plan_sha256'],'archive_sha256':ARCHIVE,'approval':approval,'activated':{},'full_quality_gate_passed':False,'root':str(ROOT)}
 update(P/'authorization.json',approval);update(P/'activation-state.json',seal);update(PENDING,seal);return seal

def activate(payload):
 plan=read(P/'plan.json');validate(plan);need(shutil.disk_usage(ROOT).free>=int(2.5*1024**3),'disk_margin');seal=get_seal(payload,plan)
 role=payload['role'];need(role in ROLES and role not in seal['activated'],'role_state');v=plan['roles'][role];old=read(P/(role+'.before.inspect.json'));c=inspect(name(role));need(c['Id']==v['before_id']and healthy(c),'target_preimage');compare(old,c,[]);preimages(plan['manifest'],role,c)
 if role=='confirmation':need('parser'in seal['activated'],'parser_first')
 if role=='web':need('api'in seal['activated'],'api_first')
 seal['phase']='activating_'+role;update(P/'activation-state.json',seal);update(PENDING,seal)
 try:
  if role in ('parser','confirmation'):
   # docker stop --time -1 sends TERM and waits without SIGKILL; no new claims,
   # existing operations complete under the unchanged runtime drain contract.
   run(['docker','stop','--time','-1',c['Id']],timeout=1500)
   stopped=inspect(c['Id']);need(not stopped['State']['Running']and stopped['State']['ExitCode']==0,'drain_failed')
  run(['docker','compose','-p',PROJECT,'-f',str(P/(role+'.candidate.compose.json')),'up','-d','--no-deps','--no-build','--pull','never','--force-recreate','--wait','--wait-timeout','90',SERVICES[role]],timeout=150)
  c=inspect(name(role));compare(old,c,v['overlay']);need(healthy(c),'target_health');protected(plan)
  for f in plan['files']:
   if f['role']==role:need(sha(effective(c,f['path']))==f['sha256'],'effective_module_hash')
  seal['activated'][role]=snapshot(c);seal['phase']='activated_'+role;update(P/'activation-state.json',seal);update(PENDING,seal)
  return {'status':'COMPONENT_ACTIVATED','at':utc(),'role':role,'container':snapshot(c),'verified_files':sum(f['role']==role for f in plan['files']),'pending_retained':True}
 except Exception as e:
  seal['phase']='needs_reconcile_'+role;seal['error']=str(e)if isinstance(e,RuntimeError)else type(e).__name__;update(P/'activation-state.json',seal);update(PENDING,seal);raise

def finish(payload):
 plan=read(P/'plan.json');validate(plan);seal=get_seal(payload,plan);need(set(seal['activated'])==set(ROLES),'all_components_required');need(payload['functional_verification']['status']=='PASS','functional_verification')
 registry=read(REGISTRY);actual={}
 for r in ROLES:
  c=inspect(name(r));need(snapshot(c)==seal['activated'][r]and healthy(c),'activated_drift');compare(read(P/(r+'.before.inspect.json')),c,plan['roles'][r]['overlay']);actual[r]=snapshot(c)
  for f in plan['files']:
   if f['role']==r:need(sha(effective(c,f['path']))==f['sha256'],'effective_hash')
  rec=registry['components'].setdefault(SERVICES[r],{});cfg=P/(r+'.candidate.compose.json')
  rec.update(container_id=c['Id'],image_id=c['Image'],configuration_path=str(cfg),configuration_files=[str(cfg)],configuration_sha256=sha(cfg.read_bytes()),config_env_sha256=sha(json.dumps(c['Config'],sort_keys=True).encode()),host_config_sha256=sha(json.dumps(c['HostConfig'],sort_keys=True).encode()),started_at=c['State']['StartedAt'],started_utc=c['State']['StartedAt'],running=True,health=c['State'].get('Health',{}).get('Status'))
  rec['audit_pdf1610']={'release_commit':seal['release_commit'],'archive_sha256':ARCHIVE,'at':utc(),'source_prs':[1591,1605,1610],'receipt':str(P/'activation.json')}
 receipt={'status':'DEPLOYED_AND_VERIFIED','owner':OWNER,'at':utc(),'release_commit':seal['release_commit'],'archive_sha256':ARCHIVE,'roles':actual,'verified_files':len(plan['files']),'protected':plan['protected'],'other_services_preserved':True,'full_quality_gate_passed':False,'independent_human_document_acceptance':False,'migrations':0,'new_model_calls':0,'authorization':seal['approval'],'functional_verification':payload['functional_verification'],'rollback_root':str(P)}
 update(REGISTRY,registry);receipt['registry_sha256']=sha(REGISTRY.read_bytes());update(P/'activation.json',receipt);update(STATE/'release-audit-pdf1610-20261118.json',receipt);seal['phase']='deployed_and_verified';update(P/'activation-state.json',seal);need(read(PENDING)['owner']==OWNER,'pending_owner');PENDING.unlink();return receipt

def dispatch(payload):
 configure(payload['host']);need(os.geteuid()==0,'root');need(not any(k.startswith('COMPOSE_')for k in os.environ),'compose_environment')
 ROOT.mkdir(mode=0o755,exist_ok=True);P.mkdir(mode=0o700,exist_ok=True);PUBLIC.mkdir(mode=0o755,exist_ok=True);fds=[]
 try:
  for n in ('config.lock','deploy.lock','migration.lock'):
   p=STATE/n;need(not p.is_symlink()and stat.S_ISREG(p.stat().st_mode),'existing_lock');fd=os.open(p,os.O_RDWR|os.O_NOFOLLOW);fds.append(fd);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  need(payload['action']in ('prepare','activate','finish'),'action');return globals()[payload['action']](payload)
 finally:
  for fd in reversed(fds):os.close(fd)

def need(ok,why):
 if not ok:raise RuntimeError(why)
def sha(b):return hashlib.sha256(b).hexdigest()
def read(p):return json.loads(p.read_bytes())
def run(a,b=None,timeout=90,env=None):
 p=subprocess.run(a,input=b,capture_output=True,timeout=timeout,env=env)
 if p.returncode:
  update(P/'last-command-error.json',{'argv':a,'stderr':p.stderr.decode(errors='replace'),'stdout':p.stdout.decode(errors='replace')})
  raise RuntimeError('command_failed:'+':'.join(a[:5])+'; diagnostics retained privately')
 return p.stdout
def inspect(n):return json.loads(run(['docker','inspect',n]))[0]
def save(p,v):
 need(not p.is_symlink(),'symlink');b=(json.dumps(v,indent=2,sort_keys=True)+'\n').encode();fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb')as f:f.write(b);f.flush();os.fsync(f.fileno())
def effective(c,p):return (pathlib.Path('/proc')/str(c['State']['Pid'])/'root'/p.lstrip('/')).read_bytes()
def compare(old,c,overlay):
 need(old['Image']==c['Image'],'image_drift');a=copy.deepcopy(old['Config']);b=copy.deepcopy(c['Config'])
 for x in [a,b]:
  x.pop('Hostname',None);x.pop('Image',None);x['Env']=sorted(x.get('Env',[]));x['Labels']={k:v for k,v in x.get('Labels',{}).items()if not k.startswith('com.docker.compose.')}
 need(a==b,'process_configuration_drift:'+','.join(k for k in set(a)|set(b) if a.get(k)!=b.get(k)));a=copy.deepcopy(old['HostConfig']);b=copy.deepcopy(c['HostConfig']);mounts={m['Target']:m for m in a.get('Mounts',[])}
 for m in overlay:mounts[m['target']]={'Type':'bind','Source':m['source'],'Target':m['target'],'ReadOnly':True,'BindOptions':{}}
 if mounts:a['Mounts']=list(mounts.values())
 for x in [a,b]:
  if x.get('OomKillDisable')is None:x['OomKillDisable']=False
  if x.get('Mounts')is not None:x['Mounts']=sorted(x['Mounts'],key=lambda m:m['Target'])
  for k in ['Binds','SecurityOpt','CapDrop','CapAdd']:
   if isinstance(x.get(k),list):x[k]=sorted(x[k])
 need(a==b,'host_configuration_drift:'+','.join(k for k in set(a)|set(b) if a.get(k)!=b.get(k)))

def render(r,c):
 labels=c['Config']['Labels'];directory=labels['com.docker.compose.project.working_dir'];args=['docker','compose','--project-name',PROJECT,'--project-directory',directory,'--profile','*']
 for f in labels.get('com.docker.compose.project.environment_file','').split(','):
  if f: args+=['--env-file',f]
 for f in labels['com.docker.compose.project.config_files'].split(','): args+=['-f',f]
 image=json.loads(run(['docker','image','inspect',c['Image']]))[0]
 render_env=dict(os.environ)
 revision=image['Config'].get('Labels',{}).get('org.opencontainers.image.revision')
 if revision:render_env['BB_IMAGE_TAG']=revision
 if PROJECT=='bb-execution':render_env['POSTGRES_PASSWORD']='unused-no-local-database'
 if r=='upload-confirmation':
  render_env.update(BB_ROLE_CONFIRMATION_PROFILE='bb-confirmation-active',BB_ROLE_CONFIRMATION_REPLICAS='1',BB_ROLE_CONFIRMATION_LANE=dict(e.split('=',1)for e in c['Config']['Env']).get('BB_UPLOAD_CONFIRMATION_LANE','general'))
 d=json.loads(run(args+['config','--format','json'],env=render_env));s=copy.deepcopy(d['services'][r])
 for key,cap in (('command','Cmd'),('entrypoint','Entrypoint'),('user','User'),('working_dir','WorkingDir')):
  want=s.get(key)
  if want is None: want=image['Config'].get(cap)
  need((want or None)==(c['Config'].get(cap) or None),'PROCESS_DRIFT:'+r+':'+key)
 need(len(s.get('volumes',[]))==len(c['Mounts']),'MOUNT_COUNT_DRIFT:'+r);volumes={};networks={}
 for v in s.get('volumes',[]):
  found=[m for m in c['Mounts'] if m['Destination']==v['target']];need(len(found)==1 and found[0]['Type']==v['type'] and found[0]['RW'] is (not bool(v.get('read_only'))),'MOUNT_DRIFT')
  if v['type']=='bind': need(v['source']==found[0]['Source'],'BIND_SOURCE_DRIFT')
  elif v['type']=='volume': volumes[v['source']]={'name':found[0]['Name'],'external':True}
  else: raise RuntimeError('UNREVIEWED_MOUNT_TYPE')
 for k in s.get('networks',{}):
  name=d['networks'][k].get('name',PROJECT+'_'+k);need(name in c['NetworkSettings']['Networks'],'NETWORK_DRIFT');networks[k]={'name':name,'external':True}
 security=[]
 for x in s.get('security_opt',[]):
  if x.startswith(('seccomp:','seccomp=')):
   source=pathlib.Path(x.split(':',1)[1] if x.startswith('seccomp:') else x.split('=',1)[1]);source=source if source.is_absolute() else pathlib.Path(directory)/source
   need(source.is_file() and not source.is_symlink(),'SECCOMP_SOURCE');raw=source.read_bytes();effective=[x.split('=',1)[1] for x in c['HostConfig'].get('SecurityOpt',[]) if x.startswith('seccomp=')];need(len(effective)==1 and json.loads(effective[0])==json.loads(raw),'SECCOMP_DRIFT')
   p=P/(sha(raw)+'.seccomp.json');write_once(p,raw);security.append('seccomp='+str(p))
  else: security.append(x)
 s['security_opt']=security;s['environment']=dict(x.split('=',1) for x in c['Config']['Env']);s['image']=c['Image']
 for key in ('env_file','depends_on','build'): s.pop(key,None)
 return s,networks,volumes
