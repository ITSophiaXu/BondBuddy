"""Narrow API evidence-gate mount with exact configuration rollback and web DNS refresh."""
import copy,datetime,fcntl,hashlib,importlib.util,json,os,pathlib,subprocess,sys
ROOT=pathlib.Path('/var/lib/bondbuddy/db1484-20261117');P=ROOT/'private';STATE=pathlib.Path('/var/lib/bondbuddy/migration-908/state-main')
def need(ok,s):
 if not ok:raise RuntimeError(s)
def sha(b):return hashlib.sha256(b).hexdigest()
def run(a,b=None,timeout=90):
 p=subprocess.run(a,input=b,capture_output=True,timeout=timeout);need(p.returncode==0,'command_failed:'+a[0]);return p.stdout
def read(p):return json.loads(p.read_bytes())
def save(p,v):
 b=(json.dumps(v,sort_keys=True,indent=2)+'\n').encode()
 with p.open('xb') as f:f.write(b);f.flush();os.fsync(f.fileno())
 os.chmod(p,0o600)
def inspect(n):return json.loads(run(['docker','inspect',n]))[0]
def effective(c,path):return (pathlib.Path('/proc')/str(c['State']['Pid'])/'root'/path.lstrip('/')).read_bytes()
def compare(before,after,mount=None):
 need(before['Image']==after['Image'],'image_drift')
 a=copy.deepcopy(before['Config']);b=copy.deepcopy(after['Config'])
 for v in [a,b]:
  v.pop('Hostname',None);v.pop('Image',None);v['Env']=sorted(v.get('Env',[]));v['Labels']={k:x for k,x in v.get('Labels',{}).items() if not k.startswith('com.docker.compose.')}
 need(a==b,'process_config_drift')
 a=copy.deepcopy(before['HostConfig']);b=copy.deepcopy(after['HostConfig'])
 if mount:
  binds={s.split(':')[1]:s for s in a.get('Binds') or []};binds[mount['target']]=mount['source']+':'+mount['target']+':ro';a['Binds']=list(binds.values())
 for v in [a,b]:
  if v.get('OomKillDisable') is None:v['OomKillDisable']=False
  for k in ['Binds','SecurityOpt','CapDrop','CapAdd']:
   if isinstance(v.get(k),list):v[k]=sorted(v[k])
 need(a==b,'host_config_drift')
def main():
 payload=json.load(sys.stdin);action=payload['action'];need(action in ['prepare','activate','rollback'],'action');fds=[]
 try:
  for name in ['config.lock','deploy.lock','migration.lock']:
   fd=os.open(STATE/name,os.O_RDWR|os.O_NOFOLLOW);fds.append(fd);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  pending=STATE/'pending-release.json';need(not pending.exists() or action=='rollback' and read(pending).get('owner')=='managed-db1484-api','release_pending')
  guard=json.loads(run(['docker','exec','-i','bb-main-postgres-1','psql','-X','-qAt','-U','bondbuddy','-d','bondbuddy'],b"BEGIN READ ONLY;SELECT json_build_object('holders',(SELECT count(*) FROM bb_model_capacity_holders),'leases',(SELECT count(*) FROM bb_jobs WHERE lease_token IS NOT NULL)+(SELECT count(*) FROM bb_review_messages WHERE lease_token IS NOT NULL),'nodes',(SELECT count(*) FROM bb_execution_nodes WHERE state<>'stopped'));ROLLBACK;"))
  need(all(v==0 for v in guard.values()),'drain_guard')
  mount={'type':'bind','source':str(ROOT/'public/evidence-gate.js'),'target':'/app/apps/api/dist/evidence-gate.js','read_only':True}
  if action=='prepare':
   import base64
   new=base64.b64decode(payload['evidence_gate']);need(sha(new)==payload['sha256'],'module_hash')
   c=inspect('bb-main-api-1');old=effective(c,'/app/apps/api/dist/evidence-gate.js')
   transformed=old.replace(b'LOCK TABLE bb_evidence_gate_events IN SHARE ROW EXCLUSIVE MODE',b'SELECT public.bb_lock_evidence_gate(true)').replace(b'LOCK TABLE bb_evidence_gate_events IN SHARE MODE',b'SELECT public.bb_lock_evidence_gate(false)')
   need(transformed==new and old!=new,'module_exact_three_statement_diff')
   (ROOT/'public/evidence-gate.js').write_bytes(new);os.chmod(ROOT/'public/evidence-gate.js',0o644)
   adapter=ROOT/'public/main-cutover-adapter.py';need(sha(adapter.read_bytes())=='00e5291ed4b70aa21dfab3f616cea10b427952aeee8f17cd8e974e323255ef67','adapter')
   spec=importlib.util.spec_from_file_location('adapter',adapter);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);cls=next(v for v in vars(m).values() if isinstance(v,type) and hasattr(v,'render'))
   class Renderer:
    root=P
    def run(self,argv,input=None,timeout=90):return run(argv,input,timeout)
    def atomic(self,p,data):p.write_bytes(data);os.chmod(p,0o600)
   receipt={'source':payload['source'],'module_sha256':sha(new),'before_sha256':sha(old),'roles':{}}
   for role in ['api','web']:
    c=inspect('bb-main-'+role+'-1');save(P/(role+'.before.inspect.private.json'),c)
    service,networks,volumes=cls.render(Renderer(),role,c)
    original={'name':'bb-main','services':{role:copy.deepcopy(service)},'networks':networks,'volumes':volumes}
    if role=='api':
     mapping={v['target']:v for v in service['volumes']};mapping[mount['target']]=mount;service['volumes']=list(mapping.values())
    candidate={'name':'bb-main','services':{role:service},'networks':networks,'volumes':volumes}
    for kind,value in [('candidate',candidate),('rollback',original)]:save(P/(role+'.'+kind+'.compose.private.json'),m.escape(value))
    name='bb-db1484-'+role+'-probe';probe=copy.deepcopy(candidate);probe['services'][role]['container_name']=name;save(P/(role+'.probe.compose.private.json'),m.escape(probe))
    need(not run(['docker','ps','-aq','--filter','name=^/'+name+'$']).strip(),'probe_exists')
    try:
     run(['docker','compose','-p','bb-db1484-'+role+'-probe','-f',str(P/(role+'.probe.compose.private.json')),'create','--no-build','--pull','never',role])
     pr=inspect(name);need(not pr['State']['Running'] and pr['State']['StartedAt'].startswith('0001-'),'probe_started')
     compare(c,pr,mount if role=='api' else None);receipt['roles'][role]={'before_id':c['Id'],'image':c['Image'],'probe_passed':True}
    finally:
     pr=inspect(name);need(not pr['State']['Running'],'probe_cleanup');run(['docker','rm',pr['Id']])
   save(P/'api-plan.safe.json',receipt);print(json.dumps(receipt));return
  plan=read(P/'api-plan.safe.json');rollback=action=='rollback'
  before={r:read(P/(r+'.before.inspect.private.json')) for r in ['api','web']}
  for r in before:
   c=inspect('bb-main-'+r+'-1')
   if not rollback:need(c['Id']==before[r]['Id'],'preimage_drift')
   compare(before[r],c,mount if rollback and r=='api' else None)
  component=STATE/'current-components.json';raw=component.read_bytes();backup=P/('components.before-api-'+action+'.json');backup.write_bytes(raw);os.chmod(backup,0o600)
  protected={n:inspect(n)['Id'] for n in ['bb-main-postgres-1','bb-main-ops-1']}
  if not pending.exists():save(pending,{'owner':'managed-db1484-api','source':plan['source'],'action':action,'rollback_files':str(P)})
  ids={}
  for role in ['api','web']:
   f=P/(role+'.'+('rollback' if rollback else 'candidate')+'.compose.private.json')
   run(['docker','compose','-p','bb-main','--project-directory',str(P),'-f',str(f),'up','-d','--no-deps','--no-build','--pull','never','--force-recreate','--wait','--wait-timeout','90',role],timeout=120)
   c=inspect('bb-main-'+role+'-1');compare(before[role],c,mount if role=='api' and not rollback else None)
   need(c['State']['Running'] and c['State'].get('Health',{}).get('Status','healthy')=='healthy','service_health');ids[role]=c['Id']
  need(all(inspect(n)['Id']==v for n,v in protected.items()),'unrelated_service_changed')
  actual=sha(effective(inspect('bb-main-api-1'),mount['target']));need(actual==plan['before_sha256' if rollback else 'module_sha256'],'effective_module')
  need(component.read_bytes()==raw,'manifest_cas');v=json.loads(raw)
  for role in ids:
   rec=v['components'][role];rec.update(container_id=ids[role],configuration_path=str(P/(role+'.'+('rollback' if rollback else 'candidate')+'.compose.private.json')))
   rec['managed_db1484']={'source':plan['source'],'rollback':rollback,'module_sha256':actual if role=='api' else None,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
  temp=component.with_name(component.name+'.db1484');temp.write_text(json.dumps(v,sort_keys=True,indent=2)+'\n');os.chmod(temp,0o600);os.replace(temp,component)
  save(P/('api-'+action+'.safe.json'),{'status':'PASS','containers':ids,'api_module_sha256':actual,'unrelated_preserved':True});need(read(pending)['owner']=='managed-db1484-api','pending_owner');pending.unlink()
  print(json.dumps({'status':'PASS','action':action,'containers':ids,'api_module_sha256':actual,'unrelated_preserved':True}))
 finally:
  for fd in reversed(fds):os.close(fd)
if __name__=='__main__':main()

