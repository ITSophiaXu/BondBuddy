"""Disable only the next automatic bootstrap; never stop a live service/container.
Run after exact main-database idle/unknown-call guards and coordination clear.
"""
import datetime,fcntl,hashlib,json,os,pathlib,subprocess,urllib.request
ROOT=pathlib.Path('/var/lib/bondbuddy/integrity1477-current-install');TARGET='ins-p4i0pcub'
def need(ok,code):
 if not ok:raise RuntimeError(code)
def run(a):
 p=subprocess.run(a,capture_output=True,timeout=15);need(p.returncode==0,'command_failed');return p.stdout

def main():
 need(os.geteuid()==0,'root');opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 with opener.open('http://metadata.tencentyun.com/latest/meta-data/instance-id',timeout=5) as r:need(r.read(128).decode().strip()==TARGET,'target')
 ROOT.mkdir(mode=0o700,exist_ok=True);need(ROOT.stat().st_uid==0 and ROOT.stat().st_mode&0o077==0,'root_mode');p=ROOT/'arm.safe.json';need(not p.exists(),'prior_attempt_reconcile')
 state=run(['systemctl','show','bondbuddy-execution-bootstrap.service','--property=ActiveState','--value']).decode().strip();need(state in ['active','inactive','failed'],'bootstrap_activating')
 ids=run(['docker','ps','-q','--filter','label=com.docker.compose.project=bondbuddy-execution','--filter','label=com.docker.compose.service=authoring']).decode().split();need(len(ids)==1,'one_authoring_required')
 c=json.loads(run(['docker','inspect',ids[0]]))[0];need(c['Image']=='sha256:861a93b76a21edd03764a02d22cf4f3ad66579b9d1d6e79fcc21616c9b1c3576' and c['State']['Running'],'container_preimage')
 n=json.loads(pathlib.Path('/etc/bondbuddy/elastic-node.json').read_bytes());need(n['business_overlay_sha256']=='c9449fc3294e0a1590ddc5081d99cb9387ea439acf4d096db4ea41e790391770' and n['compose_sha256']=='9f015499d74869af5e94c5b75233e0e339f6df97e70e9e1ecc2d88d54bfc14bd','configuration_preimage')
 enabled=run(['systemctl','is-enabled','bondbuddy-execution-bootstrap.service']).decode().strip();need(enabled=='enabled','enable_preimage')
 record={'target':TARGET,'armed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'boot_id':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'bootstrap_enabled_before':enabled,'original_container_id':c['Id'],'original_container_running':c['State']['Running'],'current_services_stopped':False,'automatic_next_boot_disabled':False}
 def save():
  raw=(json.dumps(record,sort_keys=True)+'\n').encode();fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
 save();run(['systemctl','disable','bondbuddy-execution-bootstrap.service']);record['automatic_next_boot_disabled']=True;save();need(json.loads(run(['docker','inspect',c['Id']]))[0]['State']['StartedAt']==c['State']['StartedAt'],'container_changed');print(json.dumps(record))
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'status':'FAIL','code':str(e) if isinstance(e,RuntimeError) else type(e).__name__,'automatic_retry':False}));raise SystemExit(1)
