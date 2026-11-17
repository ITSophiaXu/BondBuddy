"""Add or restore only the independent authenticated official-site listener."""
import fcntl,hashlib,json,os,pathlib,subprocess,sys
ROOT=pathlib.Path('/var/lib/bondbuddy/integrity1477-20261117');STATE=pathlib.Path('/var/lib/bondbuddy/migration-908/state-main');BASE=pathlib.Path('/var/lib/bondbuddy/elastic-pg-mtls/proxy');UNIT='bondbuddy-integrity-proxy-mtls.service'
EXPECTED={'server.conf':'c609440cef66bfecce3a6e617947d0fc4100b8f741085e2c975ed9bfd3e0f210','squid.conf':'26ed2f8047b1c62f37f832fa229da2fecbd7432bfa1720a8919e852ae759206f'}
def need(ok,code):
 if not ok:raise RuntimeError(code)
def sha(b):return hashlib.sha256(b).hexdigest()
def run(a):
 p=subprocess.run(a,capture_output=True,timeout=20);need(p.returncode==0,'command_failed');return p.stdout

def main():
 need(os.geteuid()==0,'root');action=json.load(sys.stdin)['action'];need(action in ['install','rollback'],'action');fds=[]
 try:
  for n in ['config.lock','deploy.lock']:
   fd=os.open(STATE/n,os.O_RDWR|os.O_NOFOLLOW);fds.append(fd);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  need(not (STATE/'pending-release.json').exists(),'release_pending')
  for n,h in EXPECTED.items():need(sha((BASE/n).read_bytes())==h,'existing_proxy_drift')
  need(sha(pathlib.Path('/opt/bondbuddy-egress/current/proxy.mjs').read_bytes())=='e92e1389e7ef9c45bf6e962d2956d9a0a6d4b47a07224992f643b8e287915ab0','official_proxy_drift')
  run(['openssl','x509','-in',str(BASE/'server.pem'),'-noout','-checkhost','proxy-execution.internal','-checkend','3600'])
  need(run(['systemctl','is-active','bondbuddy-integrity-egress.service']).strip()==b'active','official_proxy_inactive')
  mapping=[(BASE/'integrity-server.conf',ROOT/'public/deploy/tencent-elasticity/private-integrity-server.conf'),(pathlib.Path('/etc/systemd/system')/UNIT,ROOT/'public/deploy/tencent-elasticity/private-integrity-server.service')]
  record=ROOT/'private/egress.safe.json'
  if action=='install':
   need(not record.exists(),'prior_attempt_reconcile')
   for p,_ in mapping:need(not p.exists() and not p.is_symlink(),'listener_preimage')
   need(not run(['ss','-Hln','sport = :15435']).strip(),'port_in_use');value={'phase':'installing','old_proxy_streams_restarted':False,'files':{str(p):sha(s.read_bytes()) for p,s in mapping}}
   record.write_text(json.dumps(value)+'\n');record.chmod(0o600)
   for p,s in mapping:
    raw=s.read_bytes();fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
   run(['systemctl','daemon-reload']);run(['systemctl','enable','--now',UNIT]);need(run(['systemctl','is-active',UNIT]).strip()==b'active','new_listener_inactive');need(b'10.2.0.5:15435' in run(['ss','-Hln','sport = :15435']),'listener_absent');value['phase']='installed';record.write_text(json.dumps(value)+'\n');print(json.dumps({'status':'PASS',**value,'official_query_performed':False}))
  else:
   value=json.loads(record.read_bytes());need(value['phase'] in ['installed','installing'],'owned_egress_record')
   for p,s in mapping:need(not p.exists() or sha(p.read_bytes())==value['files'][str(p)]==sha(s.read_bytes()),'rollback_cas')
   run(['systemctl','disable','--now',UNIT])
   for p,_ in mapping:
    if p.exists():p.unlink()
   run(['systemctl','daemon-reload']);value['phase']='rolled_back';record.write_text(json.dumps(value)+'\n');print(json.dumps({'status':'PASS','action':action,'old_proxy_streams_restarted':False}))
 finally:
  for fd in reversed(fds):os.close(fd)
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'status':'FAIL','code':str(e) if isinstance(e,RuntimeError) else type(e).__name__,'automatic_retry':False}));raise SystemExit(1)
