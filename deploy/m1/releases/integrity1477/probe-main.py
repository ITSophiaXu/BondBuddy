"""Create-only probe for the exact existing ops service plus seven browser deployment mounts."""
import copy,hashlib,importlib.util,json,os,pathlib,subprocess,sys
ROOT=pathlib.Path('/var/lib/bondbuddy/integrity1477-20261117');PRIVATE=ROOT/'private'
SUPPORT=ROOT/'renderer.py'
SUPPORT_SHA='00e5291ed4b70aa21dfab3f616cea10b427952aeee8f17cd8e974e323255ef67'
def need(ok,code):
 if not ok:raise RuntimeError(code)
def sha(b):return hashlib.sha256(b).hexdigest()
def run(a,b=None,timeout=90):
 p=subprocess.run(a,input=b,capture_output=True,timeout=timeout);need(p.returncode==0,'probe_command_failed');return p.stdout

def write(path,data):
 if path.exists():need(path.read_bytes()==data,'existing_probe_artifact_drift');return
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as out:out.write(data);out.flush();os.fsync(out.fileno())
def save(name,value):write(PRIVATE/name,(json.dumps(value,sort_keys=True,indent=2)+'\n').encode())
def main():
 need(os.geteuid()==0,'root_required');plan=json.loads((PRIVATE/'plan.safe.json').read_bytes());c=json.loads(run(['docker','inspect','bb-main-ops-1']))[0];need(c['Id']==plan['ops_id'] and c['Image']==plan['ops_image'],'ops_drift')
 need(sha(SUPPORT.read_bytes())==SUPPORT_SHA,'support_hash');spec=importlib.util.spec_from_file_location('timing1420_prior_adapter',SUPPORT);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 classes=[v for v in vars(module).values() if isinstance(v,type) and hasattr(v,'render')];need(len(classes)==1,'support_class')
 class Renderer:
  root=PRIVATE
  def run(self,argv,input=None,timeout=90):return run(argv,input,timeout)
  def atomic(self,p,data):write(p,data)
 service,networks,volumes=classes[0].render(Renderer(),'ops',c)
 before={'name':'bb-main','services':{'ops':copy.deepcopy(service)},'networks':networks,'volumes':volumes}
 overlay=json.loads((PRIVATE/'ops.compose.private.json').read_bytes())['services']['ops']['volumes'];need(len(overlay)==7,'overlay_scope')
 mapping={v['target']:v for v in service['volumes']}
 for v in overlay:mapping[v['target']]=v
 service['volumes']=list(mapping.values());after={'name':'bb-main','services':{'ops':service},'networks':networks,'volumes':volumes}
 save('ops.before.inspect.private.json',c);save('ops.rollback.compose.private.json',module.escape(before));save('ops.candidate.compose.private.json',module.escape(after))
 name='bb-integrity1477-create-probe';probe=copy.deepcopy(after);probe['services']['ops']['container_name']=name;probe['services']['ops'].setdefault('labels',{})['com.bondbuddy.integrity1477.probe']='integrity1477';save('ops.probe.compose.private.json',module.escape(probe))
 need(not run(['docker','ps','-aq','--filter','name=^/'+name+'$']).strip(),'probe_exists_reconcile')
 result=None
 try:
  run(['docker','compose','-p','bb-integrity1477-probe','-f',str(PRIVATE/'ops.probe.compose.private.json'),'create','--no-build','--pull','never','ops'],timeout=120)
  p=json.loads(run(['docker','inspect',name]))[0];need(not p['State']['Running'] and p['State']['StartedAt'].startswith('0001-'),'probe_started');need(p['Image']==c['Image'],'probe_image')
  a=copy.deepcopy(c['Config']);b=copy.deepcopy(p['Config'])
  for x in [a,b]:
   x.pop('Hostname',None);x.pop('Image',None);x['Env']=sorted(x.get('Env',[]));x['Labels']={k:v for k,v in x.get('Labels',{}).items() if not k.startswith(('com.docker.compose.','com.bondbuddy.integrity1477.'))}
  need(a==b,'process_config_drift')
  expected=copy.deepcopy(c['HostConfig']);actual=copy.deepcopy(p['HostConfig']);binds={s.split(':')[1]:s for s in expected['Binds']}
  for v in overlay:binds[v['target']]=v['source']+':'+v['target']+':ro'
  expected['Binds']=list(binds.values())
  for x in [expected,actual]:
   if x.get('OomKillDisable') is None:x['OomKillDisable']=False
   for k in ['Binds','SecurityOpt','CapDrop','CapAdd']:
    if isinstance(x.get(k),list):x[k]=sorted(x[k])
  save('probe-hostconfig-diff.private.json',{'expected':expected,'actual':actual})
  need(expected==actual,'host_config_drift')
  need(json.loads(run(['docker','inspect','bb-main-ops-1']))[0]['Id']==c['Id'],'concurrent_ops_drift')
  result={'status':'PASS','ops_id':c['Id'],'image':c['Image'],'probe_id':p['Id'],'started':False,'process_config_preserved':True,'host_config_preserved_except_exact_mounts':True,'new_mounts':overlay,'candidate_compose_sha256':sha((PRIVATE/'ops.candidate.compose.private.json').read_bytes()),'rollback_compose_sha256':sha((PRIVATE/'ops.rollback.compose.private.json').read_bytes())}
 finally:
  q=subprocess.run(['docker','inspect',name],capture_output=True,timeout=20)
  if q.returncode==0:
   p=json.loads(q.stdout)[0];need(p['Config']['Labels'].get('com.bondbuddy.integrity1477.probe')=='integrity1477' and not p['State']['Running'] and p['State']['StartedAt'].startswith('0001-'),'probe_cleanup_scope');run(['docker','rm',p['Id']])
 if result:result['probe_removed']=True;save('probe.safe.json',result);print(json.dumps(result))
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'status':'FAIL','error_type':type(e).__name__,'code':str(e) if isinstance(e,RuntimeError) else 'sanitized_error'}));raise SystemExit(1)
