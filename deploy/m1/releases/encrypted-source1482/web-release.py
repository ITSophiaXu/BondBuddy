"""Scoped #1482 web activation over the verified #1495 web/API; shared lock and fresh CAS."""
import base64,copy,datetime,fcntl,hashlib,importlib.util,json,os,pathlib,shutil,stat,subprocess,sys,time,urllib.request
ROOT=pathlib.Path('/var/lib/bondbuddy/encrypted1482-20261117');P=ROOT/'private';PUBLIC=ROOT/'public';STATE=pathlib.Path('/var/lib/bondbuddy/migration-908/state-main');OWNER='encrypted1482-web';PENDING=STATE/'pending-release.json'
def need(ok,code):
 if not ok:raise RuntimeError(code)
def sha(b):return hashlib.sha256(b).hexdigest()
def read(p):return json.loads(p.read_bytes())
def run(a,b=None,timeout=90):
 p=subprocess.run(a,input=b,capture_output=True,timeout=timeout);need(p.returncode==0,'command_failed:'+a[0]);return p.stdout
def inspect(n):return json.loads(run(['docker','inspect',n]))[0]
def atomic(p,b,mode=0o600):
 need(not p.is_symlink(),'symlink_rejected');tmp=p.with_name(p.name+'.encrypted1482-tmp');fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 with os.fdopen(fd,'wb') as f:f.write(b);f.flush();os.fsync(f.fileno())
 os.replace(tmp,p)
def save(p,v):atomic(p,(json.dumps(v,indent=2,sort_keys=True)+'\n').encode())
def effective(c,path):return (pathlib.Path('/proc')/str(c['State']['Pid'])/'root'/path.lstrip('/')).read_bytes()
def healthy(c):return c['State']['Running'] and c['State'].get('Health',{}).get('Status','healthy')=='healthy'
def check_config(old,current,overlay):
 need(current['Image']==old['Image'],'image_drift');a=copy.deepcopy(old['Config']);b=copy.deepcopy(current['Config'])
 for x in [a,b]:
  x.pop('Hostname',None);x.pop('Image',None);x['Env']=sorted(x.get('Env',[]));x['Labels']={k:v for k,v in x.get('Labels',{}).items() if not k.startswith(('com.docker.compose.','com.bondbuddy.encrypted1482.'))}
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
def main():
 need(os.geteuid()==0,'root');payload=json.load(sys.stdin);action=payload['action'];need(action in ['prepare','activate','rollback'],'action')
 ROOT.mkdir(mode=0o700,parents=True,exist_ok=True);P.mkdir(mode=0o700,exist_ok=True);PUBLIC.mkdir(mode=0o700,exist_ok=True)
 fds=[]
 try:
  for n in ['config.lock','deploy.lock']:
   path=STATE/n;s=path.lstat();need(stat.S_ISREG(s.st_mode) and not path.is_symlink(),'lock_file');fd=os.open(path,os.O_RDWR|os.O_NOFOLLOW);fds.append(fd);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  if action=='prepare':
   need(not PENDING.exists(),'other_pending');need(not (P/'web.prepared.json').exists(),'prior_prepare_reconcile');v=payload['manifest'];need(v['websiteEnabled']==44 and v['apiChanged']==False and v['migrations']==0,'scope');need(len(v['files'])==7 and len(v['priorWebFiles'])==7,'file_count')
   c=inspect('bb-main-web-1');api=inspect('bb-main-api-1');need(healthy(c) and healthy(api),'live_health')
   for f in v['priorWebFiles']:need(sha(effective(c,'/usr/share/nginx/html/'+f['path'].removeprefix('web/')))==f['expected']==f['actual'],'1495_preimage')
   for f in payload['api_files']:need(sha(effective(api,'/'+f['path']))==f['sha256'],'1495_api_preimage')
   for f in v['files']:
    need(f['path']=='index.html' or f['path'].startswith('assets/') and '..' not in f['path'],'path');b=base64.b64decode(payload['files'][f['path']]);need(sha(b)==f['sha256'] and len(b)==f['bytes'],'file_hash');path=PUBLIC/'web'/f['path'];path.parent.mkdir(parents=True,exist_ok=True);atomic(path,b,0o644)
   adapter=base64.b64decode(payload['adapter']);need(sha(adapter)=='59818258171123633d3c4d5a7cc8037e4ec2082a997bf18e7bfefd7a54849a4c','adapter_hash');atomic(PUBLIC/'main-cutover-adapter.py',adapter,0o644)
   spec=importlib.util.spec_from_file_location('adapter',PUBLIC/'main-cutover-adapter.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);cls=next(x for x in vars(module).values() if isinstance(x,type) and hasattr(x,'render'))
   class Renderer:
    root=P
    def run(self,argv,input=None,timeout=90):return run(argv,input,timeout)
    def atomic(self,p,data):atomic(p,data)
   service,networks,volumes=cls.render(Renderer(),'web',c);before={'name':'bb-main','services':{'web':copy.deepcopy(service)},'networks':networks,'volumes':volumes}
   overlay=[{'type':'bind','source':str(PUBLIC/'web'/f['path']),'target':'/usr/share/nginx/html/'+f['path'],'read_only':True,'bind':{'create_host_path':False}} for f in v['files']];mapping={x['target']:x for x in service['volumes']}
   for x in overlay:mapping[x['target']]=x
   service['volumes']=list(mapping.values());after={'name':'bb-main','services':{'web':service},'networks':networks,'volumes':volumes}
   save(P/'web.before.inspect.private.json',c);save(P/'web.before.compose.private.json',module.escape(before));save(P/'web.candidate.compose.private.json',module.escape(after));probe=copy.deepcopy(after);name='bb-encrypted1482-web-probe';probe['services']['web']['container_name']=name;probe['services']['web'].setdefault('labels',{})['com.bondbuddy.encrypted1482.probe']=OWNER;save(P/'web.probe.compose.private.json',module.escape(probe))
   need(not run(['docker','ps','-aq','--filter','name=^/'+name+'$']).strip(),'probe_exists')
   try:
    run(['docker','compose','-p','bb-encrypted1482-web-probe','-f',str(P/'web.probe.compose.private.json'),'create','--no-build','--pull','never','web']);probe=inspect(name);need(not probe['State']['Running'] and probe['State']['StartedAt'].startswith('0001-'),'probe_started');check_config(c,probe,overlay)
   finally:
    q=subprocess.run(['docker','inspect',name],capture_output=True,timeout=20)
    if q.returncode==0:
     probe=json.loads(q.stdout)[0];need(probe['Config']['Labels'].get('com.bondbuddy.encrypted1482.probe')==OWNER and not probe['State']['Running'],'probe_cleanup_scope');run(['docker','rm',probe['Id']])
   plan={'source_commit':payload['source_commit'],'manifest':v,'api_files':payload['api_files'],'web_id':c['Id'],'api_id':api['Id'],'overlay':overlay,'registry_hash':sha((STATE/'current-components.json').read_bytes()),'compose_hashes':{k:sha((P/('web.'+k+'.compose.private.json')).read_bytes())for k in ['before','candidate']},'protected':{n:inspect(n)['Id']for n in ['bb-main-api-1','bb-main-postgres-1','bb-main-ops-1']},'probe_passed':True,'source_configs':{x:sha(pathlib.Path(x).read_bytes())for x in c['Config']['Labels']['com.docker.compose.project.config_files'].split(',')}};save(P/'web.prepared.json',plan);print(json.dumps({'status':'PREPARED','web_id':c['Id'],'api_id':api['Id'],'config_preserved':True,'baseline1495_verified':True,'services_changed':False}));return
  plan=read(P/'web.prepared.json');old=read(P/'web.before.inspect.private.json');c=inspect('bb-main-web-1');sf=P/'web.activation.json';prior=read(sf)if sf.exists()else None
  need(plan['probe_passed'] and shutil.disk_usage(ROOT).free>=int(2.5*1024**3),'release_preflight');rollback=action=='rollback'
  for k,h in plan['compose_hashes'].items():need(sha((P/('web.'+k+'.compose.private.json')).read_bytes())==h,'compose_hash')
  for n,h in plan['protected'].items():need(inspect(n)['Id']==h,'protected_service_drift')
  if not rollback:
   need(not prior and not PENDING.exists(),'prior_attempt_or_other_pending');need(c['Id']==plan['web_id'],'web_preimage');need(sha((STATE/'current-components.json').read_bytes())==plan['registry_hash'],'registry_drift');check_config(old,c,[])
   for p,h in plan['source_configs'].items():need(sha(pathlib.Path(p).read_bytes())==h,'config_preimage')
   for f in plan['manifest']['files']:need(sha((PUBLIC/'web'/f['path']).read_bytes())==f['sha256'],'candidate_hash')
   atomic(P/'web.registry.before.json',(STATE/'current-components.json').read_bytes());save(sf,{'owner':OWNER,'phase':'activating','source_commit':plan['source_commit']})
  else:
   need(prior and prior['owner']==OWNER,'owned_attempt_required');need(not PENDING.exists() or read(PENDING).get('owner')==OWNER,'other_pending');check_config(old,c,plan['overlay'] if c['Id']!=plan['web_id'] else [])
  save(PENDING,{'owner':OWNER,'source':plan['source_commit'],'root':str(ROOT),'phase':'web_'+action});c=recreate('before'if rollback else 'candidate');check_config(old,c,[]if rollback else plan['overlay'])
  files=[{'path':x['path'].removeprefix('web/'),'sha256':x['expected']}for x in plan['manifest']['priorWebFiles']]if rollback else plan['manifest']['files']
  for f in files:
   need(sha(effective(c,'/usr/share/nginx/html/'+f['path']))==f['sha256'],'effective_file');url='http://127.0.0.1:18090/'+(''if f['path']=='index.html'else f['path'])
   with urllib.request.urlopen(url,timeout=20)as response:need(response.status==200 and sha(response.read())==f['sha256'],'served_file')
  for n,h in plan['protected'].items():need(inspect(n)['Id']==h,'protected_service_drift')
  for f in plan['api_files']:need(sha(effective(inspect('bb-main-api-1'),'/'+f['path']))==f['sha256'],'1495_api_preserved')
  with urllib.request.urlopen('http://127.0.0.1:18090/healthz',timeout=20)as response:need(response.status==200,'healthz')
  registry=read(STATE/'current-components.json');need(sha((STATE/'current-components.json').read_bytes())in ({plan['registry_hash'],prior.get('registry_after_sha256')}if rollback else {plan['registry_hash']}),'registry_final_cas');record=registry['components']['web'];record.update(container_id=c['Id'],image_id=c['Image'],configuration_path=str(P/('web.'+('before'if rollback else 'candidate')+'.compose.private.json')))
  receipt={'owner':OWNER,'phase':'rolled_back'if rollback else 'deployed_and_verified','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_commit':plan['source_commit'],'web_container':c['Id'],'web_image':c['Image'],'files':files,'baseline1495_preserved':True,'website_enabled':44,'website_paused':85,'other_services_preserved':True,'migrations':0,'real_model_calls':0,'full_quality_gate_passed':False,'known_document_defect':1500,'human_document_acceptance':False,'scoped_browser_tests_passed':23,'rollback_config':str(P/'web.before.compose.private.json')}
  record['encrypted_source1482']=receipt;save(STATE/'current-components.json',registry);receipt['registry_after_sha256']=sha((STATE/'current-components.json').read_bytes());save(P/'web.activation.json',receipt);save(STATE/'release-encrypted1482-web-20261117.json',receipt);need(read(PENDING)['owner']==OWNER,'pending_owner');PENDING.unlink();print(json.dumps(receipt))
 finally:
  for fd in reversed(fds):os.close(fd)
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'status':'FAIL','code':str(e)if isinstance(e,RuntimeError)else type(e).__name__,'pending':PENDING.exists(),'automatic_retry':False}));raise SystemExit(1)
