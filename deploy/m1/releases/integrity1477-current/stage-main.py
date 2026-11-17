"""Stage pinned browser deployment files; do not activate or touch task processes."""
import base64,datetime,hashlib,importlib.util,json,os,pathlib,re,stat,subprocess,sys
ROOT=pathlib.Path('/var/lib/bondbuddy/integrity1477-current-20261117');P=ROOT/'private';CODE=pathlib.Path('/opt/bondbuddy-elastic-control')
MANIFEST_SHA='c02f8a900fc787e38c702e8504d33de4366fc7c43f5a21eacdc6c87a710b9b50'
PIN='c9449fc3294e0a1590ddc5081d99cb9387ea439acf4d096db4ea41e790391770'
def need(ok,code):
 if not ok:raise RuntimeError(code)
def sha(b):return hashlib.sha256(b).hexdigest()
def run(a,b=None,timeout=60):
 p=subprocess.run(a,input=b,capture_output=True,timeout=timeout);need(p.returncode==0,'command_failed');return p.stdout

def write(p,b,mode=0o600):
 need(not p.is_symlink(),'symlink')
 if p.exists():need(p.read_bytes()==b,'stage_drift');return
 p.parent.mkdir(parents=True,mode=0o700,exist_ok=True)
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 with os.fdopen(fd,'wb') as f:f.write(b);f.flush();os.fsync(f.fileno())
def save(p,d):write(p,(json.dumps(d,sort_keys=True,indent=2)+'\n').encode())
def inspect(n):return json.loads(run(['docker','inspect',n]))[0]
def main():
 need(os.geteuid()==0,'root');v=json.load(sys.stdin);need(re.fullmatch('[a-f0-9]{40}',v['source_commit']),'source')
 ROOT.mkdir(mode=0o700,exist_ok=True);need(ROOT.stat().st_uid==0 and ROOT.stat().st_mode&0o077==0,'root_mode');P.mkdir(mode=0o700,exist_ok=True)
 manifest=v['manifest'];need(sha(json.dumps(manifest,sort_keys=True,separators=(',',':')).encode())==MANIFEST_SHA,'manifest_hash')
 for name,m in manifest.items():
  b=base64.b64decode(v['files'][name],validate=True);need(len(b)==m['bytes'] and sha(b)==m['sha256'],'candidate_hash');write(ROOT/'public'/name,b,0o644)
 c=inspect('bb-main-ops-1');need(c['State']['Running'],'ops_running');env=dict(x.split('=',1) for x in c['Config']['Env']);poolpath=env['BB_EXECUTION_POOL_CONFIG'];poolraw=(pathlib.Path('/proc')/str(c['State']['Pid'])/'root'/poolpath.lstrip('/')).read_bytes();pool=json.loads(poolraw)
 authraw=pathlib.Path('/var/lib/bondbuddy/elastic-pg-mtls/authority.json').read_bytes();auth=json.loads(authraw)
 need(pool['business_overlay_sha256']==auth['pool']['business_overlay_sha256']==PIN,'business_pin');need([pool[k] for k in ['node_model_limit','global_model_limit','max_owned','min_running','idle_seconds']]==[8,8,2,0,300],'capacity')
 templates=[]
 for x in pool['node_secrets']:
  p=pathlib.Path(x['service_template_file']);b=p.read_bytes();need(json.loads(b)['business_overlay']['sha256']==PIN,'template_pin');templates.append({'path':str(p),'sha256':sha(b)})
 changes=[]
 for name,m in manifest.items():
  if name.endswith(('private-integrity-server.conf','private-integrity-server.service')):continue
  host=CODE/name;before=host.read_bytes() if host.exists() else None
  # Optional profiles may be absent from the controller checkout; runtime modules may not.
  optional='/m1/security/' in name
  need(before is not None and sha(before)==m['before_sha256'] or optional and before is None,'code_preimage:'+name)
  s=host.stat() if before is not None else None
  changes.append({'name':name,'path':str(host),'before_sha256':sha(before) if before is not None else None,'after_sha256':m['sha256'],'mode':stat.S_IMODE(s.st_mode) if s else 0o644,'uid':s.st_uid if s else 0,'gid':s.st_gid if s else 0})
 mounts=[{'type':'bind','source':str(ROOT/'public'/x['name']),'target':'/app/'+x['name'],'read_only':True} for x in changes]
 # Reuse the already reviewed renderer; no original service is stopped or started.
 support=base64.b64decode(v['renderer'],validate=True);need(sha(support)=='59818258171123633d3c4d5a7cc8037e4ec2082a997bf18e7bfefd7a54849a4c','renderer_hash');supportpath=ROOT/'renderer.py';write(supportpath,support,0o644)
 spec=importlib.util.spec_from_file_location('release_renderer',supportpath);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);classes=[x for x in vars(m).values() if isinstance(x,type) and hasattr(x,'render')];need(len(classes)==1,'renderer_class')
 class Renderer:
  root=P
  def run(self,argv,input=None,timeout=90):return run(argv,input,timeout)
  def atomic(self,p,data):write(p,data)
 service,networks,volumes=classes[0].render(Renderer(),'ops',c)
 import copy
 old={'name':'bb-main','services':{'ops':copy.deepcopy(service)},'networks':networks,'volumes':volumes};bytarget={x['target']:x for x in service.get('volumes',[])};bytarget.update({x['target']:x for x in mounts});service['volumes']=list(bytarget.values());new={**old,'services':{'ops':service}}
 save(P/'ops.before.inspect.private.json',c);save(P/'ops.rollback.compose.private.json',m.escape(old));save(P/'ops.candidate.compose.private.json',m.escape(new))
 save(P/'ops.compose.private.json',{'services':{'ops':{'volumes':mounts}}})
 # Evaluate real role names, hashes and immutable launch settings against 16KiB.
 source=ROOT/'public/deploy/tencent-elasticity/bootstrap.mjs'
 # policy is unchanged and intentionally imported from the reviewed checkout.
 policy=(CODE/'deploy/tencent-elasticity/policy.mjs').read_bytes();need(sha(policy)=='0d10b87f4cabd06381eb638f9d47df7b9ce3a04449bb1a4555e7cf15d6498b5c','policy_hash');write(source.parent/'policy.mjs',policy,0o644)
 js="import {bootstrapUserData} from '"+str(source)+"';let b='';for await(const x of process.stdin)b+=x;let c=JSON.parse(b);let r={account_id:c.account_id,region:c.region,source_sha256:c.source_sha256,image_sha256:c.image_sha256,services:c.services};let a=[0,1].map(s=>({slot:s,bytes:Buffer.byteLength(bootstrapUserData(c,r,s))}));if(a.some(x=>x.bytes>16384))throw Error('USERDATA_BOUND');console.log(JSON.stringify(a));"
 sizes=json.loads(run(['node','--input-type=module','-e',js],json.dumps(pool).encode()))
 state=pathlib.Path('/var/lib/bondbuddy/migration-908/state-main');plan={'source_commit':v['source_commit'],'ops_id':c['Id'],'ops_image':c['Image'],'pool_target':poolpath,'pool_sha256':sha(poolraw),'authority_sha256':sha(authraw),'manifest_before_sha256':sha((state/'current-components.json').read_bytes()),'templates':templates,'control_lock':pool['registration_directory']+'/control-tick.lock','changes':changes,'mounts':mounts,'userdata':sizes,'business_pin':PIN,'activated':False}
 save(P/'plan.safe.json',plan);print(json.dumps(plan))
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'status':'FAIL','code':str(e) if isinstance(e,RuntimeError) else type(e).__name__,'production_changed':False}));raise SystemExit(1)
