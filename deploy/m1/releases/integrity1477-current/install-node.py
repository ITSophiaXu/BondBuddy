"""Install pinned public bootstrap payload only after normal persisted Start/new boot.
The earlier arm step prevents old consumers registering in the new epoch first.
"""
import base64,datetime,fcntl,gzip,hashlib,json,os,pathlib,stat,subprocess,sys,urllib.request
ROOT=pathlib.Path('/var/lib/bondbuddy/integrity1477-current-install');TARGET='ins-p4i0pcub'
PROGRAM_SHA='bb59278a47da8310a2c430d5bb4be40b58c5e3d14385bc519ecae73a7a17c789'
OLD={'node-adapter.mjs':'ce6d04c3fc8bba9cfe710a5006cfb8eb2b91447a1623e6d442041be9bbb8e248','business-overlay.mjs':'87c4b69a0c9f0ba3e5a016bf17fd9661a35afff6643ce39949952857e0741ca5','private-egress.mjs':'84397844bf60c424be352321d2ca87c7977cc9370d01e81fd669d45884f91563'}
def need(ok,code):
 if not ok:raise RuntimeError(code)
def sha(b):return hashlib.sha256(b).hexdigest()
def run(a):
 p=subprocess.run(a,capture_output=True,timeout=20);need(p.returncode==0,'command_failed');return p.stdout

def main():
 need(os.geteuid()==0,'root');v=json.load(sys.stdin);program=gzip.decompress(base64.b64decode(v['program_gzip_base64'],validate=True));need(sha(program)==PROGRAM_SHA,'program_hash')
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 with opener.open('http://metadata.tencentyun.com/latest/meta-data/instance-id',timeout=5) as r:need(r.read(128).decode().strip()==TARGET,'target')
 s=ROOT.lstat();need(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and s.st_mode&0o077==0,'receipt_root');lock=os.open(ROOT/'install.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 arm=json.loads((ROOT/'arm.safe.json').read_bytes());need(arm['target']==TARGET and arm['automatic_next_boot_disabled'],'arm_required');boot=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip();need(boot!=arm['boot_id'],'fresh_boot_required')
 need(not (ROOT/'install.started.safe.json').exists(),'prior_attempt_reconcile')
 need(not run(['docker','ps','-q','--filter','label=com.docker.compose.project=bondbuddy-execution']).strip(),'active_consumers')
 state=run(['systemctl','show','bondbuddy-execution-bootstrap.service','--property=ActiveState','--value']).decode().strip();need(state in ['failed','inactive'],'bootstrap_busy')
 nc=pathlib.Path('/etc/bondbuddy/elastic-node.json');bc=pathlib.Path('/etc/bondbuddy/elastic-bootstrap.json');n=json.loads(nc.read_bytes());b=json.loads(bc.read_bytes());parent=pathlib.Path(b['adapter_path']).parent
 need(n['business_overlay_sha256']=='c9449fc3294e0a1590ddc5081d99cb9387ea439acf4d096db4ea41e790391770','business_pin');need(sha(pathlib.Path(n['compose_file']).read_bytes())==n['compose_sha256']=='9f015499d74869af5e94c5b75233e0e339f6df97e70e9e1ecc2d88d54bfc14bd','compose_preimage')
 for name,h in OLD.items():need(sha((parent/name).read_bytes())==h,'module_preimage:'+name)
 backup=ROOT/'before';backup.mkdir(mode=0o700);paths=[nc,bc,pathlib.Path(n['compose_file']),pathlib.Path(n['private_pg']['config_file']),*[parent/name for name in OLD]];records=[]
 for index,p in enumerate(paths):
  s=p.lstat();need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_mode&0o022==0,'preimage_scope');raw=p.read_bytes();dest=backup/str(index);dest.write_bytes(raw);dest.chmod(0o600);records.append({'path':str(p),'backup':str(dest),'sha256':sha(raw),'mode':stat.S_IMODE(s.st_mode)})
 record={'target':TARGET,'boot_id':boot,'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'program_sha256':PROGRAM_SHA,'before':records,'current_consumers':0,'bootstrap_requested':False}
 def save(name):
  p=ROOT/name;fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'w') as f:json.dump(record,f,sort_keys=True);f.flush();os.fsync(f.fileno())
 save('install.started.safe.json');exec(compile(program,'pinned-public-browser-installer','exec'),{'__name__':'__public_installer__'})
 for name in OLD:run(['node','--check',str(parent/name)])
 n=json.loads(nc.read_bytes());need(n['seccomp_file'].endswith('/integrity-browser-seccomp.json'),'profile_install');need(sha(pathlib.Path(n['seccomp_file']).read_bytes())==n['seccomp_sha256']=='b6b702deb98325db37b881ac92e8891ffaded3fcd711359d51dcde15fcf00ac1','profile_hash')
 record.update(installed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),compose_sha256=n['compose_sha256'],seccomp_sha256=n['seccomp_sha256'],transport_sha256=n['private_pg']['config_sha256'],modules={name:sha((parent/name).read_bytes()) for name in OLD});save('installed.safe.json')
 # The same completed native Start/epoch is resumed; this never calls the cloud.
 run(['systemctl','start','--no-block','bondbuddy-execution-bootstrap.service']);record['bootstrap_requested']=True;save('installed.safe.json');print(json.dumps({k:x for k,x in record.items() if k!='before'}))
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'status':'FAIL','code':str(e) if isinstance(e,RuntimeError) else type(e).__name__,'automatic_retry':False}));raise SystemExit(1)
