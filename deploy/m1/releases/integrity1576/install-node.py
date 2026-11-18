"""Update only the persisted overlay pin while managed consumers are stopped.
The caller holds the shared production deployment/control window and reconciles
the existing cloud Start before this runs. No cloud API or forced stop occurs.
"""
import datetime,fcntl,hashlib,json,os,pathlib,stat,subprocess,urllib.request
ROOT=pathlib.Path('/var/lib/bondbuddy/integrity1576-install')
OLD_PIN='b0080b09ab87f97f1e1533902b671757fa8b44a207c79dfb28b0a667791bb0b9'
NEW_PIN='51600119c096e2d5dab5e3827687e1dfc307e89695a04823876c449faa885a6b'
EXPECTED={'node-adapter.mjs':'432e7a88730d65c3497b9f027a5f49d240d53491bbe43e5071445f8d078e228b','business-overlay.mjs':'61d183f3391da82578ed7cdb875509feb9668e61bfc1b80909050958012b0bbd','private-egress.mjs':'690e49ef8ae15f1ac93a4ec6e7e4a963702ff8d9881fcb95b23bda232b8392cb'}
def need(ok,code):
 if not ok:raise RuntimeError(code)
def sha(b):return hashlib.sha256(b).hexdigest()
def run(a):
 p=subprocess.run(a,capture_output=True,timeout=20);need(p.returncode==0,'command_failed');return p.stdout

def atomic(p,b,mode=0o600):
 t=p.with_name(p.name+'.integrity1576-new');fd=os.open(t,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 with os.fdopen(fd,'wb') as f:f.write(b);f.flush();os.fsync(f.fileno())
 os.chmod(t,mode);os.replace(t,p);fd=os.open(p.parent,os.O_DIRECTORY);os.fsync(fd);os.close(fd)
def regular(p):
 st=p.lstat();need(stat.S_ISREG(st.st_mode) and st.st_uid==0 and st.st_mode&0o022==0,'unsafe_file');return p.read_bytes(),stat.S_IMODE(st.st_mode)
def main():
 need(os.geteuid()==0,'root');opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 with opener.open('http://metadata.tencentyun.com/latest/meta-data/instance-id',timeout=5) as r:need(r.read(128).decode().strip()=='ins-p4i0pcub','target')
 ROOT.mkdir(mode=0o700,parents=True,exist_ok=True);st=ROOT.lstat();need(stat.S_ISDIR(st.st_mode) and st.st_uid==0 and st.st_mode&0o077==0,'receipt_root')
 fd=os.open(ROOT/'install.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 nc=pathlib.Path('/etc/bondbuddy/elastic-node.json');bc=pathlib.Path('/etc/bondbuddy/elastic-bootstrap.json');raw,mode=regular(nc);br,_=regular(bc);n=json.loads(raw);b=json.loads(br)
 adapter=pathlib.Path(b['adapter_path']);need(str(adapter).startswith('/opt/bondbuddy/') and adapter.name=='node-adapter.mjs' and '..' not in adapter.parts,'adapter_scope')
 for name,h in EXPECTED.items():need(sha(regular(adapter.parent/name)[0])==h,'module_drift:'+name)
 need(b['adapter_sha256']==EXPECTED['node-adapter.mjs'],'adapter_config_drift')
 need(sha(regular(pathlib.Path(n['compose_file']))[0])==n['compose_sha256']=='3c604483ef133e97c6edd3b2b1b222490b269906129b9ec2debf98e677ec4ed4','compose_drift')
 need(n['images']=={'authoring':'sha256:861a93b76a21edd03764a02d22cf4f3ad66579b9d1d6e79fcc21616c9b1c3576','review':'sha256:ea4f4de5d307485ecda4c22c6d105132bc51549b4b6bbe477e6d7db6f2a684a2'},'image_drift')
 receipt=ROOT/'installed.safe.json'
 if n.get('business_overlay_sha256')==NEW_PIN:
  need(receipt.exists(),'partial_install_requires_reconciliation');print(json.dumps({'status':'ALREADY_INSTALLED','receipt':str(receipt),'bootstrap_requested':False}));return
 need(n.get('business_overlay_sha256')==OLD_PIN,'pin_preimage');need(not (ROOT/'elastic-node.before.json').exists(),'prior_attempt_requires_reconciliation')
 need(not run(['docker','ps','-q','--filter','label=com.docker.compose.project=bondbuddy-execution']).strip(),'active_consumers')
 need(run(['systemctl','show','bondbuddy-execution-bootstrap.service','--property=ActiveState','--value']).decode().strip() in ['failed','inactive'],'bootstrap_busy')
 atomic(ROOT/'elastic-node.before.json',raw);n['business_overlay_sha256']=NEW_PIN;after=(json.dumps(n,separators=(',',':'))+'\n').encode()
 need(regular(nc)[0]==raw and regular(bc)[0]==br,'fresh_cas');atomic(nc,after,mode)
 rec={'status':'INSTALLED','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'instance':'ins-p4i0pcub','old_pin':OLD_PIN,'new_pin':NEW_PIN,'config_before_sha256':sha(raw),'config_after_sha256':sha(after),'helper_and_browser_files_unchanged':True,'bootstrap_requested':False}
 atomic(receipt,(json.dumps(rec,sort_keys=True)+'\n').encode())
 run(['systemctl','start','--no-block','bondbuddy-execution-bootstrap.service']);rec['bootstrap_requested']=True;atomic(receipt,(json.dumps(rec,sort_keys=True)+'\n').encode());print(json.dumps(rec))
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'status':'FAIL','code':str(e) if isinstance(e,RuntimeError) else type(e).__name__,'automatic_retry':False}));raise SystemExit(1)