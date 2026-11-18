"""Main-only PR1420 adapter; root orchestrates ingress and off-host backup.
Imports are inert. Does not stop workers, call cloud APIs, restore DB, or update tasks.
Every production mutation is an explicit JSON action in a root-owned locked session.
"""
import argparse,copy,datetime,hashlib,json,os,pathlib,re,select,stat,subprocess,sys,time
try: import fcntl
except ImportError: fcntl=None
MIGRATION='0185_performance_spans.sql'
ROLES=('api','ops','web')
PENDING=pathlib.Path('/var/lib/bondbuddy/migration-908/state-main/pending-release.json')
LABEL='com.bondbuddy.main1420.'
PINNED_IMAGES={
 'api':'sha256:e995a4928f4ec16048ac6b5c5cc136bf9582baf758bc71361cb08e20f4a9eb85',
 'ops':'sha256:22cc3fc268cad7bd2f77ae7f7e85680a939f2d06a2424c53a8aa11a5d0017a1d',
 'web':'sha256:1f49ae4d66c277e023901b2ec7b28b4f4a97e048d5110e35ad805ff9b80129be'}
def need(ok,why):
 if not ok: raise RuntimeError(why)
def rawsha(b): return hashlib.sha256(b).hexdigest()
def canon(v): return json.dumps(v,sort_keys=True,separators=(',',':')).encode()
def sha(v): return rawsha(canon(v))
def read(p): return json.loads(pathlib.Path(p).read_bytes())
def utc(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def escape(v):
 if isinstance(v,str): return v.replace('$','$$')
 if isinstance(v,list): return [escape(x) for x in v]
 if isinstance(v,dict): return {k:escape(x) for k,x in v.items()}
 return v
def file_record(p):
 p=pathlib.Path(p)
 try: s=p.lstat()
 except FileNotFoundError: return None
 need(stat.S_ISREG(s.st_mode) and not p.is_symlink(),'REGULAR_FILE_REQUIRED:'+str(p))
 return {'bytes':s.st_size,'sha256':rawsha(p.read_bytes()),'mode':stat.S_IMODE(s.st_mode),'uid':s.st_uid,'gid':s.st_gid}
def same_file(actual,expected):
 return actual is None if expected is None else actual is not None and all(actual[k]==expected[k] for k in ('bytes','sha256','mode','uid','gid') if k in expected)
def closed_caddy(config):
 handlers=[]
 def walk(x):
  if isinstance(x,dict):
   if 'handler' in x: handlers.append(x)
   for v in x.values(): walk(v)
  elif isinstance(x,list):
   for v in x: walk(v)
 walk(config)
 need(not any(x.get('handler')=='reverse_proxy' for x in handlers),'CADDY_HAS_REVERSE_PROXY')
 need(any(x.get('handler')=='static_response' and str(x.get('status_code'))=='503' for x in handlers),'CADDY_503_REQUIRED')
 return True
def direct_loopback(c):
 need(c['HostConfig'].get('NetworkMode')!='host','HOST_NETWORK_FORBIDDEN')
 for items in (c['HostConfig'].get('PortBindings') or {}).values():
  for x in items or []: need(x.get('HostIp') in ('127.0.0.1','::1'),'DIRECT_PUBLIC_BIND_FORBIDDEN')
def validate_plan(p):
 need(p['schema']=='main1420-node8-cutover-plan-v1','PLAN_SCHEMA')
 need(p['base_source']=='325c88248a41b33fccbb31d8262b57dab41d6659','CURRENT_NODE8_SOURCE_REQUIRED')
 need(p['ledger_before']==sorted(set(p['ledger_before'])) and len(p['ledger_before'])==188 and MIGRATION not in p['ledger_before'],'EXACT188_REQUIRED')
 need(p['ledger_after']==sorted(p['ledger_before']+[MIGRATION]),'EXACT189_REQUIRED')
 need('0188_execution_node_eight_capacity.sql' in p['ledger_before'],'PRESERVE0188')
 need(set(p['targets'])==set(ROLES) and [len(p['targets'][r]) for r in ROLES]==[23,2,4],'PAYLOAD_SCOPE')
 need(len(p['snapshot']['components']['api']['code_mounts'])==13 and len(p['snapshot']['components']['ops']['mounts'])==45,'MOUNT_SCOPE')
 need([p[k] for k in ('preserve_node_model_limit','preserve_global_model_limit','preserve_max_nodes')]==[8,8,2],'NODE8_POLICY')
 need(all(p.get(r+'_image')==PINNED_IMAGES[r] for r in ROLES),'PINNED_IMAGES_REQUIRED')
 need(p['migration_sha256']=='20f7e159dca10fc86137f03e93d79a073c1787b4e6455693314a4f0d83dc347b','CANONICAL_MIGRATION_HASH')
 need(p['acl_sha256']=='d331cfdc523df6cbeba4daf47bd31df87bb32e72c6f98deb4081ee5e1f7c0a0b','CANONICAL_ACL_HASH')
 need(len(p['mount_file_preimages'])==50,'MOUNT_FILE_PREIMAGE_SCOPE')
 return True
class Main:
 def __init__(self,plan,root,owner,resume=False):
  validate_plan(plan);need(sys.platform=='linux' and os.geteuid()==0 and fcntl is not None,'LINUX_ROOT_REQUIRED')
  self.p=plan;self.root=pathlib.Path(root);self.owner=owner;self.fds=[]
  need(self.root.is_absolute() and self.root.parent==pathlib.Path('/var/lib/bondbuddy') and not self.root.is_symlink(),'PRIVATE_ROOT_REQUIRED')
  need(self.root.exists() is resume,'EXPLICIT_RESUME_OR_NEW_ROOT_REQUIRED')
  try:
   for item in self.p['snapshot']['locks']:
    if pathlib.Path(item['path']).parent!=PENDING.parent: continue
    p=pathlib.Path(item['path']);s=p.lstat();need(stat.S_ISREG(s.st_mode) and not p.is_symlink() and (s.st_dev,s.st_ino)==(item['device'],item['inode']),'LOCK_INODE_DRIFT')
    fd=os.open(p,os.O_RDWR|os.O_NOFOLLOW);self.fds.append((fd,item));fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
   if resume:
    s=self.root.stat();need(s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o700,'PRIVATE_ROOT_MODE')
    self.state=read(self.root/'state.json');need(self.state['owner']==owner and self.state['source']==plan['base_source'] and self.state['plan_sha256']==sha(plan) and read(self.root/'plan.json')==plan,'RESUME_IDENTITY')
    self.pending_check()
   else:
    need(not PENDING.exists() and not PENDING.is_symlink(),'FOREIGN_PENDING_RELEASE')
    self.root.mkdir(mode=0o700);self.state={'owner':owner,'source':plan['base_source'],'plan_sha256':sha(plan),'created_at':utc(),'phase':'locked','actions':[],'switched':{}}
    self.save('plan.json',plan);self.save('state.json',self.state);self.write_pending(create=True)
  except BaseException:
   for fd,_ in reversed(self.fds): os.close(fd)
   self.fds=[];raise
 def save(self,name,value):
  p=self.root/name;need(p.resolve().is_relative_to(self.root.resolve()),'OUTPUT_PATH')
  self.atomic(p,canon(value)+b'\n')
 def atomic(self,p,data):
  need(not p.is_symlink(),'OUTPUT_SYMLINK');tmp=p.with_name(p.name+'.tmp-'+str(os.getpid())+'-'+str(time.time_ns()))
  fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'wb') as f: f.write(data);f.flush();os.fsync(f.fileno())
  os.replace(tmp,p)
  fd=os.open(p.parent,os.O_RDONLY|os.O_DIRECTORY)
  try: os.fsync(fd)
  finally: os.close(fd)
 def pending_check(self):
  need(PENDING.is_file() and not PENDING.is_symlink(),'PENDING_MISSING')
  p=read(PENDING);need(all(p.get(k)==v for k,v in {'owner':self.owner,'source':self.p['base_source'],'root':str(self.root),'plan_sha256':sha(self.p)}.items()),'FOREIGN_PENDING_RELEASE')
 def write_pending(self,create=False):
  d={'schema':'main1420-owned-pending-v1','owner':self.owner,'source':self.p['base_source'],'root':str(self.root),'plan_sha256':sha(self.p),'phase':self.state['phase'],'updated_at':utc()}
  if create:
   fd=os.open(PENDING,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
   with os.fdopen(fd,'wb') as f: f.write(canon(d)+b'\n');f.flush();os.fsync(f.fileno())
  else: self.pending_check();self.atomic(PENDING,canon(d)+b'\n')
 def commit_state(self,phase=None):
  if phase: self.state['phase']=phase
  self.save('state.json',self.state);self.write_pending()
 def locks(self):
  for fd,item in self.fds:
   p=pathlib.Path(item['path']);s=p.lstat();f=os.fstat(fd);need((s.st_dev,s.st_ino)==(f.st_dev,f.st_ino)==(item['device'],item['inode']),'LOCK_INODE_LOST')
  return {'pid':os.getpid(),'process_start':pathlib.Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19],'paths':[x['path'] for _,x in self.fds],'held':True,'same_inode':True}
 def run(self,argv,input=None,timeout=90):
  self.locks();self.pending_check()
  try: r=subprocess.run(argv,input=input,capture_output=True,timeout=timeout)
  except subprocess.TimeoutExpired as e:
   self.save('command-timeout-'+str(time.time_ns())+'.private.json',{'argv':argv,'timeout':timeout,'stdout':(e.stdout or b'').decode(errors='replace'),'stderr':(e.stderr or b'').decode(errors='replace')});raise RuntimeError('COMMAND_OUTCOME_UNKNOWN_RECONCILE:'+argv[0]) from e
  self.save('command-'+str(time.time_ns())+'.private.json',{'argv':argv,'exit':r.returncode,'stdout':r.stdout.decode(errors='replace'),'stderr':r.stderr.decode(errors='replace')})
  need(r.returncode==0,'COMMAND_FAILED:'+argv[0]);return r.stdout
 def inspect(self,r):
  need(r in (*ROLES,'postgres','egress','worker-parse'),'INSPECT_ROLE_SCOPE')
  return json.loads(self.run(['docker','inspect','bb-main-'+r+'-1']))[0]
 def sql(self,q):
  a=['docker','exec','-i','-e','PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=1500','bb-main-postgres-1','psql','-X','-qAt','-U','bondbuddy','-d','bondbuddy','-v','ON_ERROR_STOP=1']
  return json.loads(self.run(a,('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'+q+'ROLLBACK;').encode()))
 def observe(self):
  return self.sql("SELECT json_build_object('ledger',(SELECT json_agg(filename ORDER BY filename) FROM bb_schema_migrations),'jobs_running',(SELECT count(*) FROM bb_jobs WHERE state='running'),'runs_active_states',(SELECT count(*) FROM bb_runs WHERE state IN ('preparing','running','validating','delivering')),'leases',(SELECT count(*) FROM bb_jobs WHERE lease_token IS NOT NULL),'holders',(SELECT count(*) FROM bb_model_capacity_holders),'ready_sessions',(SELECT count(*) FROM bb_execution_node_sessions WHERE state='active' AND ready),'ops_leases',(SELECT count(*) FROM bb_ops_schedule WHERE lease_token IS NOT NULL),'upload_leases',(SELECT count(*) FROM bb_outbox WHERE event_type='upload.complete_requested' AND lease_token IS NOT NULL),'review_leases',(SELECT count(*) FROM bb_review_messages WHERE lease_token IS NOT NULL),'queued_jobs',(SELECT count(*) FROM bb_jobs WHERE state='queued'),'queued_runs',(SELECT count(*) FROM bb_runs WHERE state='queued'),'policy',(SELECT row_to_json(p) FROM bb_execution_capacity_policy p WHERE singleton));")
 def queued_fingerprint(self):
  q=self.sql("SELECT json_build_object('jobs',COALESCE((SELECT json_agg(q ORDER BY q.id) FROM bb_jobs q WHERE state='queued'),'[]'::json),'runs',COALESCE((SELECT json_agg(q ORDER BY q.id) FROM bb_runs q WHERE state='queued'),'[]'::json));")
  return {k:{'count':len(v),'sha256':sha(v)} for k,v in q.items()}
 def protected(self):
  for r,w in self.p['snapshot']['preserved'].items():
   c=self.inspect(r);need(c['Id']==w['id'] and c['Image']==w['image'] and sha({'Config':c['Config'],'HostConfig':c['HostConfig']})==w['configuration_sha256'] and c['State']['StartedAt']==w['started_at'] and c['State']['Running']==w['running'],'PRESERVED_COMPONENT_DRIFT:'+r)
 def caddy(self): return json.loads(self.run(['curl','--fail','--silent','--show-error','--noproxy','*','--max-time','10','http://127.0.0.1:2019/config/']))
 def guard(self,proof,backup=True,producer_activity=True):
  self.locks();self.pending_check();need(len(self.fds)==len(self.p['snapshot']['locks']),'CONTROL_LOCK_BARRIER_REQUIRED');self.protected();need(proof.get('owner')==self.owner and proof.get('source')==self.p['base_source'],'GUARD_IDENTITY')
  config=self.caddy();closed_caddy(config);need(proof.get('closed_caddy_sha256')==sha(config),'CADDY_CLOSED_PROOF_DRIFT')
  need(proof.get('ingress_closed') is True and proof.get('direct_public_write_paths_closed') is True,'INGRESS_BARRIER_REQUIRED')
  for r in ('api','web'): direct_loopback(self.inspect(r))
  d=self.observe()
  if producer_activity: need(d['ops_leases']==0 and d['upload_leases']==0,'MAIN_PRODUCER_LEASES_REQUIRED_ZERO')
  need([d['policy'][k] for k in ('node_model_limit','global_model_limit','max_nodes')]==[8,8,2],'NODE8_POLICY_DRIFT')
  # Dynamic budget authorization is observed only; main-only release never writes policy.
  # Existing worker jobs, reviews, model calls and queued rows may advance normally.
  if backup:
   b=proof.get('backup',{});need(b.get('producer_exit')==0 and b.get('decoder_exit')==0 and b.get('full_archive_decoded') is True and b.get('bytes',0)>10000,'OFFHOST_FULL_BACKUP_REQUIRED')
   need(re.fullmatch('[a-f0-9]{64}',b.get('sha256','')) and b.get('source_container_id')==self.p['snapshot']['preserved']['postgres']['id'] and b.get('ledger_sha256')==sha(self.p['ledger_before']),'BACKUP_SOURCE_BINDING')
   age=(datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(b['completed_at'])).total_seconds();need(0<=age<=3600,'BACKUP_EXPIRED')
  return d
 def original(self,r):
  need(r in ROLES,'ROLE_SCOPE');c=self.inspect(r);w=self.p['snapshot']['components'][r]
  need(c['Id']==w['id'] and c['Image']==w['image'] and sha(c['Config'])==w['config_sha256'] and sha(c['HostConfig'])==w['host_config_sha256'],'CURRENT_COMPONENT_DRIFT:'+r)
  return c
 def preimages(self,r,c,effective=True):
  if effective: need(c['State']['Running'] and c['State']['Pid']>0,'RUNNING_PREIMAGE_REQUIRED')
  root=pathlib.Path('/proc')/str(c['State']['Pid'])/'root'
  if effective:
   for target,x in self.p['snapshot']['components'][r]['targets'].items(): need(same_file(file_record(str(root)+target),x['actual']),'TARGET_PREIMAGE_DRIFT:'+target)
  for x in self.p['mount_file_preimages']:
   if x['role']!=r: continue
   want={'bytes':x['bytes'],'sha256':x['sha256']};need(same_file(file_record(x['host']),want),'HOST_MOUNT_PREIMAGE_DRIFT:'+x['target'])
   if effective: need(same_file(file_record(str(root)+x['target']),want),'VISIBLE_MOUNT_PREIMAGE_DRIFT:'+x['target'])
  for x in self.p['snapshot']['components'][r]['code_mounts']:
   need(same_file(file_record(x['mount']['Source']),x['host_file']),'CODE_PREIMAGE_METADATA_DRIFT')
  for path,want in self.p['snapshot']['components'][r]['config_files'].items(): need(same_file(file_record(path),want),'COMPOSE_FILE_PREIMAGE_DRIFT:'+path)
 def render(self,r,c):
  labels=c['Config']['Labels'];directory=labels['com.docker.compose.project.working_dir'];args=['docker','compose','--project-name','bb-main','--project-directory',directory,'--profile','*']
  for f in labels.get('com.docker.compose.project.environment_file','').split(','):
   if f: args+=['--env-file',f]
  for f in labels['com.docker.compose.project.config_files'].split(','): args+=['-f',f]
  d=json.loads(self.run(args+['config','--format','json']));s=copy.deepcopy(d['services'][r]);image=json.loads(self.run(['docker','image','inspect',c['Image']]))[0]
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
   name=d['networks'][k].get('name','bb-main_'+k);need(name in c['NetworkSettings']['Networks'],'NETWORK_DRIFT');networks[k]={'name':name,'external':True}
  security=[]
  for x in s.get('security_opt',[]):
   if x.startswith(('seccomp:','seccomp=')):
    source=pathlib.Path(x.split(':',1)[1] if x.startswith('seccomp:') else x.split('=',1)[1]);source=source if source.is_absolute() else pathlib.Path(directory)/source
    need(source.is_file() and not source.is_symlink(),'SECCOMP_SOURCE');raw=source.read_bytes();effective=[x.split('=',1)[1] for x in c['HostConfig'].get('SecurityOpt',[]) if x.startswith('seccomp=')];need(len(effective)==1 and json.loads(effective[0])==json.loads(raw),'SECCOMP_DRIFT')
    p=self.root/(rawsha(raw)+'.seccomp.json');self.atomic(p,raw);security.append('seccomp='+str(p))
   else: security.append(x)
  s['security_opt']=security;s['environment']=dict(x.split('=',1) for x in c['Config']['Env']);s['image']=c['Image']
  for key in ('env_file','depends_on','build'): s.pop(key,None)
  return s,networks,volumes
 def host_expected(self,r,kind):
  old=read(self.root/(r+'.inspect.private.json'));host=copy.deepcopy(old['HostConfig'])
  if r=='api' and kind=='candidate':
   targets={x['mount']['Destination'] for x in self.p['snapshot']['components']['api']['code_mounts']}
   host['Binds']=[x for x in host.get('Binds') or [] if x.split(':')[1] not in targets]
   if host.get('Mounts'): host['Mounts']=[x for x in host['Mounts'] if x['Target'] not in targets]
  return old,host
 def config_check(self,r,current,kind):
  old,host=self.host_expected(r,kind);a=copy.deepcopy(old['Config']);b=copy.deepcopy(current['Config'])
  for x in (a,b):
   for k in ('Image','Hostname'): x.pop(k,None)
   x['Env']=sorted(x.get('Env',[]));x['Labels']={k:v for k,v in (x.get('Labels') or {}).items() if not k.startswith(('com.docker.compose.','com.bondbuddy.patch.',LABEL))}
  need(a==b,'EFFECTIVE_PROCESS_CONFIG_DRIFT:'+r);observed=copy.deepcopy(current['HostConfig'])
  for x in (host,observed):
   # Docker API null and Compose explicit false both keep the kernel OOM killer enabled.
   # Normalize only this default; true and all other HostConfig fields stay strict.
   if x.get('OomKillDisable') is None: x['OomKillDisable']=False
   for k in ('Binds','SecurityOpt','CapDrop','CapAdd'):
    if isinstance(x.get(k),list): x[k]=sorted(x[k])
  need(host==observed,'EFFECTIVE_HOST_CONFIG_DRIFT:'+r);return True
 def ownership(self,c,kind):
  labels=c['Config'].get('Labels') or {};need(labels.get(LABEL+'owner')==self.owner and labels.get(LABEL+'kind')==kind and labels.get(LABEL+'plan')==sha(self.p),'OWNED_CONTAINER_REQUIRED')
 def prepare(self):
  need(self.state['phase'] in ('locked','preparing'),'PREPARE_ONCE');self.protected();candidate={'name':'bb-main','services':{},'networks':{},'volumes':{}};rollback=copy.deepcopy(candidate)
  self.commit_state('preparing')
  for r in ROLES:
   c=self.original(r);self.preimages(r,c);direct_loopback(c);self.save(r+'.inspect.private.json',c);s,n,v=self.render(r,c);rollback['services'][r]=copy.deepcopy(s)
   for cfg in (candidate,rollback):
    for key,values in (('networks',n),('volumes',v)):
     for name,value in values.items(): need(name not in cfg[key] or cfg[key][name]==value,'RESOURCE_ALIAS_DRIFT');cfg[key][name]=value
   s['image']=self.p[r+'_image']
   if r=='api':
    targets={x['mount']['Destination'] for x in self.p['snapshot']['components']['api']['code_mounts']};need(sum(x['target'] in targets for x in s['volumes'])==13,'EXACT13_ABSORPTION');s['volumes']=[x for x in s['volumes'] if x['target'] not in targets]
   candidate['services'][r]=s
  for kind,cfg in (('candidate',candidate),('rollback',rollback)):
   for s in cfg['services'].values(): s.setdefault('labels',{}).update({LABEL+'owner':self.owner,LABEL+'kind':kind,LABEL+'plan':sha(self.p)})
   self.save(kind+'.compose.private.json',escape(cfg))
  for r in ROLES:
   probe=copy.deepcopy(candidate);probe['services']={r:probe['services'][r]};name='bb1420-probe-'+r+'-'+self.owner[-10:];probe['services'][r]['container_name']=name;file=self.root/(r+'.probe.private.json');self.save(file.name,escape(probe))
   # Never clean an existing name: even our previous partial probe requires explicit cleanup.
   listing=self.run(['docker','container','ls','-a','-q','--no-trunc','--filter','name=^/'+name+'$']).strip()
   need(not listing,'PROBE_NAME_EXISTS_RECONCILE')
   try:
    self.run(['docker','compose','-p','bb1420-probe-'+self.owner[-10:],'-f',str(file),'create','--no-build','--pull','never',r],timeout=120)
    c=json.loads(self.run(['docker','inspect',name]))[0];self.ownership(c,'candidate');need(not c['State']['Running'] and c['State']['StartedAt'].startswith('0001-'),'PROBE_STARTED');self.config_check(r,c,'candidate')
   finally:
    p=subprocess.run(['docker','inspect',name],capture_output=True,timeout=30)
    if p.returncode==0:
     c=json.loads(p.stdout)[0];self.ownership(c,'candidate');need(not c['State']['Running'] and c['State']['StartedAt'].startswith('0001-'),'PROBE_UNEXPECTEDLY_STARTED');self.run(['docker','rm',c['Id']])
  for r in ROLES: self.preimages(r,self.original(r))
  self.state['manifest_before']=read(PENDING.parent/'current-components.json');self.state['manifest_before_metadata']=file_record(PENDING.parent/'current-components.json')
  need(same_file(self.state['manifest_before_metadata'],self.p['snapshot']['protected_files'][str(PENDING.parent/'current-components.json')]),'MANIFEST_PREIMAGE_DRIFT');self.commit_state('prepared');return {'prepared':True,'create_only_config_verified':3,'production_services_started_or_stopped':False,'root':str(self.root),'locks':self.locks()}
 def stop_producers(self,proof):
  need(len(self.fds)==len(self.p['snapshot']['locks']),'CONTROL_LOCK_BARRIER_REQUIRED')
  self.guard(proof,backup=False);need(self.state['phase'] in ('prepared','ingress_closed','stopping_producers'),'PREPARE_REQUIRED');self.commit_state('stopping_producers')
  for r in ('api','ops'):
   c=self.original(r);self.preimages(r,c,effective=c['State']['Running'])
   if c['State']['Running']: self.run(['docker','kill','--signal=TERM',c['Id']]);self.run(['docker','wait',c['Id']],timeout=180)
   c=self.original(r);need(not c['State']['Running'] and c['State']['ExitCode']==0 and not c['State']['OOMKilled'],'PRODUCER_NOT_CLEANLY_STOPPED')
  self.guard(proof,backup=False);self.state['business_observation_before']=self.observe();self.commit_state('producers_stopped')
  return {'stopped':['api','ops'],'no_sigkill':True,'workers_stopped':False,'business_observation':self.state['business_observation_before'],'existing_worker_progress_allowed':True}
 def producers_stopped(self):
  for r in ('api','ops'):
   c=self.original(r);need(not c['State']['Running'] and c['State']['ExitCode']==0,'PRODUCER_STILL_RUNNING');self.preimages(r,c,effective=False)
 def migrate(self,proof):
  d=self.guard(proof);self.producers_stopped();need(self.state['phase']=='producers_stopped' and d['ledger']==self.p['ledger_before'],'MIGRATION_PREIMAGE')
  migration=(self.root/MIGRATION).read_bytes();need(rawsha(migration)==self.p['migration_sha256'],'SQL_HASH');need(not self.state.get('migration_attempt'),'RECONCILE_PRIOR_MIGRATION_FIRST')
  need(self.sql("SELECT json_build_object('sessions',to_regclass('public.bb_performance_sessions') IS NOT NULL,'spans',to_regclass('public.bb_performance_spans') IS NOT NULL);")=={'sessions':False,'spans':False},'PERFORMANCE_TABLES_PREEXIST')
  self.state['migration_attempt']={'started_at':utc(),'commit_confirmed':False};self.commit_state('migration_inflight')
  argv=['docker','exec','-i','-e','PGAPPNAME=main1420-migrate-'+self.owner,'-e','PGOPTIONS=-c lock_timeout=1500 -c statement_timeout=45000 -c idle_in_transaction_session_timeout=30000','bb-main-postgres-1','psql','-X','-qAt','-U','bondbuddy','-d','bondbuddy','-v','ON_ERROR_STOP=1']
  process=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,bufsize=0)
  self.state['migration_attempt']['client_pid']=process.pid;self.commit_state()
  try:
   process.stdin.write(b"BEGIN; SELECT 'BB1420_XID='||txid_current();\n");process.stdin.flush()
   need(bool(select.select([process.stdout],[],[],10)[0]),'MIGRATION_XID_TIMEOUT');line=process.stdout.readline().decode().strip();need(line.startswith('BB1420_XID=') and line[11:].isdigit(),'MIGRATION_XID')
   self.state['migration_attempt']['xid']=line[11:];self.commit_state()
   expected='ARRAY['+','.join("'"+x.replace("'","''")+"'" for x in self.p['ledger_before'])+']::text[]'
   check="DO $bb$ BEGIN IF (SELECT array_agg(filename ORDER BY filename) FROM bb_schema_migrations) IS DISTINCT FROM "+expected+" THEN RAISE EXCEPTION 'ledger drift'; END IF; END $bb$;\n"
   data=check.encode()+migration+b"\nINSERT INTO bb_schema_migrations(filename) VALUES ('0185_performance_spans.sql');\nCOMMIT;\nSELECT 'BB1420_COMMIT_CONFIRMED';\n"
   stdout,stderr=process.communicate(data,timeout=90);self.save('migration-command.private.json',{'exit':process.returncode,'stdout':stdout.decode(errors='replace'),'stderr':stderr.decode(errors='replace')})
   need(process.returncode==0 and b'BB1420_COMMIT_CONFIRMED' in stdout,'MIGRATION_COMMIT_UNKNOWN_RECONCILE_XID')
  except BaseException:
   # Closing our pipe is not a DB rollback guarantee. XID reconciliation remains mandatory.
   try: process.stdin.close()
   except Exception: pass
   self.state['migration_attempt']['outcome_unknown']=True;self.commit_state('migration_unknown');raise
  return self.reconcile_migration()
 def reconcile_migration(self):
  a=self.state.get('migration_attempt',{});x=a.get('xid')
  if x is None:
   d=self.sql("SELECT json_build_object('active',(SELECT count(*) FROM pg_stat_activity WHERE application_name='main1420-migrate-"+self.owner+"'),'ledger',(SELECT json_agg(filename ORDER BY filename) FROM bb_schema_migrations),'sessions',to_regclass('public.bb_performance_sessions') IS NOT NULL,'spans',to_regclass('public.bb_performance_spans') IS NOT NULL);")
   need(d['active']==0 and d['ledger']==self.p['ledger_before'] and not d['sessions'] and not d['spans'],'NO_XID_MIGRATION_STILL_UNKNOWN');self.state['migration_attempt']['reconciliation']=d;self.commit_state('migration_aborted');return {'xid_status':'aborted_before_xid','ledger_count':188,'automatic_retry':False}
  need(isinstance(x,str) and x.isdigit(),'SAVED_XID_REQUIRED')
  d=self.sql("SELECT json_build_object('xid_status',pg_xact_status('"+x+"'::xid8),'ledger',(SELECT json_agg(filename ORDER BY filename) FROM bb_schema_migrations),'sessions',to_regclass('public.bb_performance_sessions') IS NOT NULL,'spans',to_regclass('public.bb_performance_spans') IS NOT NULL);")
  self.state['migration_attempt']['reconciliation']=d
  if d['xid_status']=='committed':
   need(d['ledger']==self.p['ledger_after'] and d['sessions'] and d['spans'],'COMMITTED_SCHEMA_MISMATCH');self.state['migration_attempt']['commit_confirmed']=True;self.commit_state('migration_committed')
  elif d['xid_status']=='aborted':
   need(d['ledger']==self.p['ledger_before'] and not d['sessions'] and not d['spans'],'ABORTED_SCHEMA_MISMATCH');self.commit_state('migration_aborted')
  else: self.commit_state('migration_unknown');raise RuntimeError('MIGRATION_STILL_IN_PROGRESS_OR_UNKNOWN')
  return {'canonical_migration':MIGRATION,'xid_status':d['xid_status'],'ledger_count':len(d['ledger']),'automatic_retry':False,'acl_applied':self.state.get('acl_applied',False)}
 def apply_acl(self,proof):
  d=self.guard(proof);need(d['ledger']==self.p['ledger_after'] and self.state.get('migration_attempt',{}).get('commit_confirmed'),'CANONICAL_COMMIT_REQUIRED')
  acl=(self.root/'managed-performance-grants.sql').read_bytes();need(rawsha(acl)==self.p['acl_sha256'],'ACL_HASH')
  argv=['docker','exec','-i','bb-main-postgres-1','psql','-X','-qAt','-U','bondbuddy','-d','bondbuddy','-v','ON_ERROR_STOP=1']
  self.run(argv,input=acl,timeout=60);self.state['acl_applied']=True;self.commit_state('schema_ready');return {'acl_applied':True,'ledger_count':189,'roles_created':False}
 def reconcile(self,r,kind):
  need(r in ROLES and kind in ('candidate','rollback'),'RECONCILE_SCOPE');intent=self.state.get('mutation_intent',{});need(intent.get('role')==r and intent.get('kind')==kind,'OWNED_MUTATION_INTENT_REQUIRED')
  c=self.inspect(r);self.ownership(c,kind);need(c['Image']==(self.p[r+'_image'] if kind=='candidate' else self.p['snapshot']['components'][r]['image']),'IMAGE_ID_DRIFT');self.config_check(r,c,kind)
  self.state['switched'][r]={'id':c['Id'],'image':c['Image'],'kind':kind};self.commit_state('reconciled_'+r+'_'+kind)
  return self.verify(r,kind=='rollback')
 def switch(self,r,proof,rollback=False):
  need(r in ROLES,'ROLE_SCOPE');d=self.guard(proof,backup=not rollback,producer_activity=(rollback and r=='ops') or (not rollback and self.state['switched'].get('ops',{}).get('kind')!='candidate'));kind='rollback' if rollback else 'candidate'
  need(d['ledger'] in (self.p['ledger_before'],self.p['ledger_after']) if rollback else d['ledger']==self.p['ledger_after'] and self.state.get('migration_attempt',{}).get('commit_confirmed'),'SCHEMA_NOT_READY')
  if rollback:
   if self.state.get('migration_attempt'):
    self.reconcile_migration()
   current=self.inspect(r)
   if current['Id']==self.p['snapshot']['components'][r]['id']:
    self.original(r);self.preimages(r,current,effective=current['State']['Running'])
    if not current['State']['Running']: self.run(['docker','start',current['Id']])
    self.state['restored_original']=sorted(set(self.state.get('restored_original',[])+[r]));self.commit_state('restored_original_'+r)
    self.wait_health(r);return self.verify(r,True,original_ok=True)
   self.ownership(current,'candidate');need(current['Id']==self.state['switched'].get(r,{}).get('id'),'ROLLBACK_RECONCILE_REQUIRED')
   if current['State']['Running']: self.run(['docker','kill','--signal=TERM',current['Id']]);self.run(['docker','wait',current['Id']],timeout=180)
   need(not self.inspect(r)['State']['Running'],'ROLLBACK_CANDIDATE_STILL_RUNNING')
  else:
   current=self.original(r);self.preimages(r,current,effective=current['State']['Running'])
   if r in ('api','ops'): need(not current['State']['Running'],'STOP_PRODUCERS_FIRST')
   need('business_observation_before' in self.state,'STOP_OBSERVATION_REQUIRED')
  self.state['mutation_intent']={'role':r,'kind':kind,'at':utc()};self.commit_state('switching_'+r+'_'+kind)
  file=self.root/(kind+'.compose.private.json');self.run(['docker','compose','--project-name','bb-main','--project-directory',str(self.root),'-f',str(file),'up','-d','--no-deps','--no-build','--pull','never','--force-recreate','--wait','--wait-timeout','90',r],timeout=150)
  return self.reconcile(r,kind)
 def wait_health(self,r):
  deadline=time.monotonic()+120
  while True:
   c=self.inspect(r)
   if c['State']['Running'] and c['State'].get('Health',{}).get('Status','healthy')=='healthy': return
   need(time.monotonic()<deadline,'HEALTH_TIMEOUT:'+r);time.sleep(1)
 def verify(self,r,rollback=False,original_ok=False):
  need(r in ROLES,'ROLE_SCOPE');c=self.inspect(r);need(c['State']['Running'] and c['State'].get('Health',{}).get('Status','healthy')=='healthy','ROLE_UNHEALTHY');kind='rollback' if rollback else 'candidate'
  if not original_ok: self.ownership(c,kind)
  else: need(c['Id']==self.p['snapshot']['components'][r]['id'],'ORIGINAL_ID_REQUIRED')
  need(c['Image']==(self.p['snapshot']['components'][r]['image'] if rollback else self.p[r+'_image']),'VERIFY_IMAGE_MISMATCH');self.config_check(r,c,kind);root=pathlib.Path('/proc')/str(c['State']['Pid'])/'root'
  targets=({p:x['actual']['sha256'] if x['actual'] else None for p,x in self.p['snapshot']['components'][r]['targets'].items()} if rollback else self.p['targets'][r])
  for p,h in targets.items():
   file=pathlib.Path(str(root)+p);need((rawsha(file.read_bytes()) if file.exists() else None)==h,'EFFECTIVE_FILE_MISMATCH:'+p)
  # Existing worker jobs, reviews, model calls and queued rows may advance normally.
  self.protected();return {'role':r,'id':c['Id'],'image':c['Image'],'files':len(targets),'config_verified':True,'rollback':rollback,'database_restored':False,'existing_worker_progress_allowed':True}


 def abort_unmutated(self):
  need(not self.state.get('ingress_close_intent') and not self.state.get('migration_attempt') and not self.state.get('mutation_intent'),'UNMUTATED_ABORT_REQUIRED')
  for r in ROLES: self.preimages(r,self.original(r))
  need(sha(self.caddy())==self.p['snapshot']['caddy_config_sha256'] and self.observe()['ledger']==self.p['ledger_before'],'UNMUTATED_BASELINE_CHANGED');self.pending_check();self.state['phase']='aborted_unmutated';self.save('state.json',self.state);self.save('completed-pending.json',read(PENDING));PENDING.unlink();fd=os.open(PENDING.parent,os.O_RDONLY|os.O_DIRECTORY)
  try: os.fsync(fd)
  finally: os.close(fd)
  return {'aborted_unmutated':True,'production_services_changed':False}
 def restore_original(self,r):
  need(r in ROLES and not self.state.get('public_write_boundary'),'ORIGINAL_RESTORE_SCOPE');self.pending_check();self.protected();need(sha(self.caddy())==self.state.get('closed_caddy_sha256'),'RESTORE_REQUIRES_CLOSED_INGRESS')
  if self.state.get('migration_attempt'): self.reconcile_migration()
  need(self.observe()['ledger'] in (self.p['ledger_before'],self.p['ledger_after']),'RESTORE_SCHEMA_UNKNOWN');c=self.original(r);self.preimages(r,c,effective=c['State']['Running'])
  if not c['State']['Running']:
   self.state['original_start_intent']={'role':r,'id':c['Id'],'at':utc()};self.commit_state('restoring_original_'+r);self.run(['docker','start',c['Id']])
  self.wait_health(r);self.state['restored_original']=sorted(set(self.state.get('restored_original',[])+[r]));self.commit_state('restored_original_'+r);return self.verify(r,True,original_ok=True)

 def hold_control(self):
  held={x['path'] for _,x in self.fds};new=[]
  try:
   for item in self.p['snapshot']['locks']:
    if item['path'] in held: continue
    p=pathlib.Path(item['path']);s=p.lstat();need(stat.S_ISREG(s.st_mode) and not p.is_symlink() and (s.st_dev,s.st_ino)==(item['device'],item['inode']),'CONTROL_LOCK_INODE_DRIFT')
    fd=os.open(p,os.O_RDWR|os.O_NOFOLLOW);new.append((fd,item));fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BaseException:
   for fd,_ in reversed(new): os.close(fd)
   raise
  self.fds.extend(new);return self.locks()
 def caddy_set(self,value,expected):
  need(sha(self.caddy())==expected,'CADDY_CAS_CHANGED')
  self.run(['curl','--fail','--silent','--show-error','--noproxy','*','--max-time','15','-H','Content-Type: application/json','--data-binary','@-','http://127.0.0.1:2019/load'],input=canon(value),timeout=20)
  need(sha(self.caddy())==sha(value),'CADDY_APPLIED_CONFIG_MISMATCH')
 def http_check(self,path,status,origin=False,direct=False,expected_sha256=None):
  need(path.startswith('/') and '\\' not in path and not path.startswith('//'),'HTTP_PATH_SCOPE')
  url=('http://127.0.0.1:18090' if direct else 'https://bondbuddy.gululai.com')+path
  argv=['curl','--silent','--show-error','--noproxy','*','--connect-timeout','5','--max-time','20','--max-filesize','10485760','--write-out','\n%{http_code}']
  if origin and not direct: argv+=['--resolve','bondbuddy.gululai.com:443:127.0.0.1']
  data=self.run(argv+[url],timeout=25);body,code=data.rsplit(b'\n',1);need(int(code)==status,'HTTP_STATUS_MISMATCH:'+path+':'+code.decode())
  if expected_sha256: need(rawsha(body)==expected_sha256,'STATIC_BODY_HASH_MISMATCH:'+path)
  return {'path':path,'status':int(code),'body_sha256':rawsha(body),'origin':origin,'direct':direct}
 def close_ingress(self):
  need(self.state['phase'] in ('prepared','closing_ingress','ingress_closed'),'PREPARE_BEFORE_INGRESS')
  for r in ('api','web'): direct_loopback(self.inspect(r))
  if self.state.get('ingress_close_intent'):
   current=sha(self.caddy());closed=self.state['closed_caddy_sha256'];original=read(self.root/'caddy-before.private.json')
   if current==sha(original): self.caddy_set(read(self.root/'caddy-closed.private.json'),current)
   else: need(current==closed,'INGRESS_CAS_UNKNOWN')
  else:
   original=self.caddy();need(sha(original)==self.p['snapshot']['caddy_config_sha256'],'CADDY_PREIMAGE_DRIFT');closed=copy.deepcopy(original);count=0
   def patch(v):
    nonlocal count
    if isinstance(v,list):
     for x in v: patch(x)
    elif isinstance(v,dict):
     if v.get('handler')=='reverse_proxy':
      need(not v.get('dynamic_upstreams') and [x.get('dial') for x in v.get('upstreams',[])]==['127.0.0.1:18090'],'UNREVIEWED_CADDY_WRITE_ROUTE')
      v.clear();v.update(handler='static_response',status_code=503,body='BondBuddy maintenance');count+=1
     else:
      for x in list(v.values()): patch(x)
   patch(closed);need(count>0,'NO_REVIEWED_INGRESS_ROUTE');closed_caddy(closed)
   self.save('caddy-before.private.json',original);self.save('caddy-closed.private.json',closed);self.state.update(ingress_close_intent=True,closed_caddy_sha256=sha(closed));self.commit_state('closing_ingress');self.caddy_set(closed,sha(original))
  checks=[self.http_check('/healthz',503,origin=True),self.http_check('/healthz',503)]
  self.state.update(ingress_closed=True,direct_public_write_paths_closed=True);self.commit_state('ingress_closed');return {'ingress_closed':True,'closed_caddy_sha256':self.state['closed_caddy_sha256'],'checks':checks}
 def proof(self,backup=None):
  return {'owner':self.owner,'source':self.p['base_source'],'closed_caddy_sha256':self.state.get('closed_caddy_sha256'),'ingress_closed':self.state.get('ingress_closed') is True,'direct_public_write_paths_closed':self.state.get('direct_public_write_paths_closed') is True,'backup':backup or {}}
 def verify_internal(self,proof):
  self.guard(proof,producer_activity=False);checks=[self.verify(r) for r in ROLES];need(self.state.get('acl_applied'),'ACL_REQUIRED_FOR_RELEASE')
  checks += [self.http_check('/healthz',200,direct=True),self.http_check('/api/v1/me',401,direct=True),self.http_check('/api/v1/admin/performance/summary',401,direct=True),self.http_check('/api/v1/admin/performance/runs/00000000-0000-4000-8000-000000000000',401,direct=True)]
  for path,h in self.p['targets']['web'].items(): checks.append(self.http_check(path.removeprefix('/usr/share/nginx/html'),200,direct=True,expected_sha256=h))
  self.state['internal_verified']=True;self.commit_state('internal_verified');return {'checks':checks,'internal_verified':True,'authenticated_admin_read_tested':False,'models_called':0,'task_replayed':False}
 def open_ingress(self,rollback=False):
  original=read(self.root/'caddy-before.private.json');current=sha(self.caddy());need(current in (sha(original),self.state['closed_caddy_sha256']),'INGRESS_CAS_UNKNOWN')
  if rollback:
   need(not self.state.get('public_write_boundary'),'PUBLIC_WRITE_BOUNDARY_ROLLBACK_FORBIDDEN')
   for r in ROLES:
    c=self.inspect(r)
    self.verify(r,True,original_ok=c['Id']==self.p['snapshot']['components'][r]['id'])
  else: need(self.state.get('internal_verified'),'INTERNAL_VERIFICATION_REQUIRED');self.state['public_write_boundary']=True
  self.commit_state('opening_original_ingress' if rollback else 'opening_ingress')
  if current!=sha(original): self.caddy_set(original,self.state['closed_caddy_sha256'])
  self.state.update(ingress_closed=False,ingress_opened=True,restored_after_failure=rollback);self.commit_state('original_ingress_restored' if rollback else 'ingress_opened')
  return {'ingress_opened':True,'rollback':rollback,'public_write_boundary':self.state.get('public_write_boundary',False)}
 def verify_live(self,rollback=False):
  need(self.state.get('ingress_opened'),'INGRESS_NOT_OPEN');checks=[]
  for origin in (True,False):
   checks += [self.http_check('/healthz',200,origin=origin),self.http_check('/api/v1/me',401,origin=origin)]
   if not rollback:
    checks.append(self.http_check('/api/v1/admin/performance/summary',401,origin=origin))
    for path,h in self.p['targets']['web'].items(): checks.append(self.http_check(path.removeprefix('/usr/share/nginx/html'),200,origin=origin,expected_sha256=h))
  self.state['live_verified']=True;self.commit_state('live_original_verified' if rollback else 'live_verified');return {'live_verified':True,'checks':checks,'rollback':rollback}
 def commit_components(self,rollback=False):
  need(self.state.get('live_verified'),'LIVE_VERIFICATION_REQUIRED');path=PENDING.parent/'current-components.json';before=self.state['manifest_before_metadata'];current=file_record(path)
  need(same_file(current,before),'COMPONENT_RECORD_CAS');old=self.state['manifest_before'];need(read(path)==old,'COMPONENT_RECORD_CONTENT_CAS');new=copy.deepcopy(old);need(isinstance(new.get('components'),dict),'COMPONENT_RECORD_SCHEMA')
  for r in ROLES:
   c=self.inspect(r);record=copy.deepcopy(old['components'].get(r,{}));record.update(image_id=c['Image'],container_id=c['Id'],started_at=c['State']['StartedAt'],configuration_sha256=sha({k:c[k] for k in ('Config','HostConfig')}),configuration_path=str(self.root/('rollback.compose.private.json' if rollback else 'candidate.compose.private.json')),owner=self.owner,receipt_root=str(self.root),prior_component_record_sha256=sha(old['components'].get(r)))
   if not rollback: record.update(source=self.p['base_source'],base_source=self.p['base_source'],base_image_id=self.p['snapshot']['components'][r]['image'],patch_source=self.p['feature_commit'],patch_pull_requests=[1420,1428],source_mode='preserved_live_composition_plus_scoped_logging_patch')
   record.update(started_utc=c['State']['StartedAt'],running=c['State']['Running'],health=c['State'].get('Health',{}).get('Status'),configuration_files=c['Config']['Labels'].get('com.docker.compose.project.config_files','').split(','))
   record['main1420_release']={'plan_sha256':sha(self.p),'at':utc(),'rollback':rollback,'performance_schema_retained':self.observe()['ledger']==self.p['ledger_after']}
   new['components'][r]=record
  for k,v in old.items():
   if k!='components': need(new[k]==v,'TOP_LEVEL_RECORD_CHANGED')
  need({k:v for k,v in new['components'].items() if k not in ROLES}=={k:v for k,v in old['components'].items() if k not in ROLES},'UNRELATED_COMPONENT_RECORD_CHANGED')
  self.save('components-before.private.json',old);self.save('components-after.private.json',new)
  need(same_file(file_record(path),before),'COMPONENT_RECORD_FINAL_CAS');self.atomic(path,canon(new)+b'\n');os.chmod(path,before['mode']);os.chown(path,before['uid'],before['gid'])
  need(read(path)==new,'COMPONENT_RECORD_POSTWRITE_MISMATCH');self.state['components_committed']=True;self.state['component_record_sha256']=file_record(path)['sha256'];self.commit_state('components_committed')
  return {'scope':list(ROLES),'before_sha256':before['sha256'],'after_sha256':self.state['component_record_sha256'],'other_records_preserved':True,'rollback':rollback}
 def complete(self):
  need(self.state.get('live_verified') and self.state.get('components_committed'),'COMPLETION_REQUIRES_VERIFIED_MANIFEST');need(file_record(PENDING.parent/'current-components.json')['sha256']==self.state['component_record_sha256'],'COMMITTED_RECORD_CHANGED');self.pending_check()
  self.state['phase']='complete';self.state['completed_at']=utc();self.save('state.json',self.state);self.save('completed-pending.json',read(PENDING));PENDING.unlink();fd=os.open(PENDING.parent,os.O_RDONLY|os.O_DIRECTORY)
  try: os.fsync(fd)
  finally: os.close(fd)
  return {'complete':True,'scope':list(ROLES),'database_restored':False,'managed_deployment_included':False}

 def action(self,q):
  a=q['action'];proof=q.get('guard',{});self.locks();self.pending_check()
  if a=='abort_unmutated': return self.abort_unmutated()
  if a=='restore_original': return self.restore_original(q['role'])
  if a=='hold_control': return self.hold_control()
  if a=='close_ingress': return self.close_ingress()
  if a=='verify_internal': return self.verify_internal(proof)
  if a=='open_ingress': return self.open_ingress(q.get('rollback',False))
  if a=='verify_live': return self.verify_live(q.get('rollback',False))
  if a=='commit_components': return self.commit_components(q.get('rollback',False))
  if a=='complete': return self.complete()
  if a=='observe': return {'database':self.observe(),'locks':self.locks(),'state':self.state}
  if a=='prepare': return self.prepare()
  if a=='stop_producers': return self.stop_producers(proof)
  if a=='migrate': return self.migrate(proof)
  if a=='reconcile_migration': return self.reconcile_migration()
  if a=='apply_acl': return self.apply_acl(proof)
  if a in ('switch','rollback'): return self.switch(q['role'],proof,a=='rollback')
  if a=='reconcile': return self.reconcile(q['role'],q['kind'])
  if a=='verify': return self.verify(q['role'],q.get('rollback',False),q.get('original_ok',False))
  raise RuntimeError('ACTION_SCOPE')
def main():
 p=argparse.ArgumentParser();p.add_argument('--plan',required=True);p.add_argument('--root');p.add_argument('--owner');p.add_argument('--serve',action='store_true');p.add_argument('--resume',action='store_true');p.add_argument('--validate-only',action='store_true');args=p.parse_args();plan=read(args.plan);validate_plan(plan)
 if args.validate_only: print(json.dumps({'plan_valid':True,'production_changed':False}));return
 need(args.serve and args.root and re.fullmatch('[a-z0-9-]{8,64}',args.owner or ''),'EXPLICIT_ROOT_ORCHESTRATION_REQUIRED');session=Main(plan,args.root,args.owner,args.resume);print(json.dumps({'ready':True,'locks':session.locks(),'root':str(session.root),'pending_owned':True}),flush=True)
 try:
  for line in sys.stdin:
   try:
    request=json.loads(line);result=session.action(request);print(json.dumps({'status':'PASS','action':request['action'],'result':result}),flush=True)
   except Exception as error: print(json.dumps({'status':'FAIL','error':type(error).__name__+':'+str(error),'pending_root':str(session.root),'automatic_rollback':False}),flush=True)
 finally:
  # Disconnect releases FDs only. Owned pending remains; resume must reconcile outcomes.
  for fd,_ in reversed(session.fds): os.close(fd)
if __name__=='__main__': main()