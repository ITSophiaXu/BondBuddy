"""Install the exact #1420 recovery-compatible helper while consumers are stopped.
Control side must already hold the shared deployment/control window, bind the new
service templates, and complete one normal Start operation before this request.
No direct cloud action, credential access, migration or force-stop is performed.
"""
import base64,datetime,fcntl,gzip,hashlib,json,os,pathlib,stat,subprocess,urllib.request
TARGET='ins-p4i0pcub'
OLD_PIN='c4749d922f49eaa8fcbdc334881552dd7db5bdaa540ef154064de5f29e375b5e'
NEW_PIN='183e5240e6cefc09314943fc270b009fd547e497437af111a99fd77235e17dd0'
OLD_HELPER='75e10607d1886e1b11e3be809d664a4cd362bc2597e238511175bc96487f44e4'
NEW_HELPER='db4c77793f576d9e7203673da7121d163aaeef74cb6cec35373d389a1684f43e'
HELPER_GZIP_BASE64='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'
RECEIPT=pathlib.Path('/var/lib/bondbuddy/managed-db1484-install')
def sha(b):return hashlib.sha256(b).hexdigest()
def need(ok,code):
 if not ok:raise RuntimeError(code)
def command(args):
 p=subprocess.run(args,capture_output=True,timeout=20);need(p.returncode==0,'command_failed');return p.stdout

def regular(path):
 p=pathlib.Path(path);s=p.lstat();need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_mode&0o022==0,'unsafe_file');return p.read_bytes(),s

def atomic(path,data,mode):
 temp=path.with_name(path.name+'.timing1420-new')
 fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 with os.fdopen(fd,'wb') as out:out.write(data);out.flush();os.fsync(out.fileno())
 os.chmod(temp,mode);os.replace(temp,path)
 fd=os.open(path.parent,os.O_DIRECTORY);os.fsync(fd);os.close(fd)

def main():
 need(os.geteuid()==0,'root_required')
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 with opener.open('http://metadata.tencentyun.com/latest/meta-data/instance-id',timeout=5) as r:instance=r.read(128).decode().strip()
 need(instance==TARGET,'target_mismatch')
 RECEIPT.mkdir(mode=0o700,parents=True,exist_ok=True)
 st=RECEIPT.lstat();need(stat.S_ISDIR(st.st_mode) and st.st_uid==0 and st.st_mode&0o077==0,'receipt_directory')
 lock=os.open(RECEIPT/'install.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 nc=pathlib.Path('/etc/bondbuddy/elastic-node.json');bc=pathlib.Path('/etc/bondbuddy/elastic-bootstrap.json');raw,ns=regular(nc);braw,bs=regular(bc);n=json.loads(raw);b=json.loads(braw)
 adapter=pathlib.Path(b['adapter_path']);need(str(adapter).startswith('/opt/bondbuddy/') and adapter.name=='node-adapter.mjs' and '..' not in adapter.parts,'adapter_scope')
 adapter_raw,_=regular(adapter);need(sha(adapter_raw)==b['adapter_sha256'],'adapter_drift')
 helper=adapter.parent/'business-overlay.mjs';prior,hs=regular(helper);candidate=gzip.decompress(base64.b64decode(HELPER_GZIP_BASE64));need(sha(candidate)==NEW_HELPER,'candidate_hash')
 if n.get('business_overlay_sha256')==NEW_PIN and sha(prior)==NEW_HELPER:
  need((RECEIPT/'installed.safe.json').is_file(),'partial_install_requires_reconciliation')
  print(json.dumps({'status':'ALREADY_INSTALLED','instance_id':instance,'bootstrap_restarted':False,'receipt':str(RECEIPT/'installed.safe.json')}));return
 need(n.get('business_overlay_sha256')==OLD_PIN and sha(prior)==OLD_HELPER,'preimage_drift')
 need(n['image_sha256']=='87690ba276e9b98b7eeb9c8d10b6dd52d265e1ee5b697e8209b4b15b948fb85b','image_bundle_drift')
 need(n['images']=={'authoring':'sha256:861a93b76a21edd03764a02d22cf4f3ad66579b9d1d6e79fcc21616c9b1c3576','review':'sha256:ea4f4de5d307485ecda4c22c6d105132bc51549b4b6bbe477e6d7db6f2a684a2'},'image_drift')
 compose,_=regular(n['compose_file']);need(sha(compose)==n['compose_sha256']=='9f015499d74869af5e94c5b75233e0e339f6df97e70e9e1ecc2d88d54bfc14bd','compose_drift')
 ids=command(['docker','ps','-q','--filter','label=com.docker.compose.project=bondbuddy-execution']).decode().split();need(not ids,'active_consumers')
 state=command(['systemctl','show','bondbuddy-execution-bootstrap.service','--property=ActiveState','--value']).decode().strip();need(state in ('failed','inactive'),'bootstrap_busy')
 for name,data in [('elastic-node.before.json',raw),('business-overlay.before.mjs',prior),('elastic-bootstrap.before.json',braw)]:
  p=RECEIPT/name
  need(not p.exists(),'prior_attempt_requires_reconciliation')
  fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'wb') as out:out.write(data);out.flush();os.fsync(out.fileno())
 need(regular(nc)[0]==raw and regular(helper)[0]==prior,'fresh_cas_failed')
 n['business_overlay_sha256']=NEW_PIN;after=(json.dumps(n,separators=(',',':'))+'\n').encode()
 atomic(helper,candidate,stat.S_IMODE(hs.st_mode));atomic(nc,after,stat.S_IMODE(ns.st_mode))
 need(regular(bc)[0]==braw and regular(adapter)[0]==adapter_raw and regular(n['compose_file'])[0]==compose,'unrelated_configuration_changed')
 command(['/usr/bin/node','--check',str(helper)])
 record={'schema':'timing1420-node-helper-install-v1','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'instance_id':instance,'old_pin':OLD_PIN,'new_pin':NEW_PIN,'old_helper_sha256':OLD_HELPER,'new_helper_sha256':NEW_HELPER,'node_config_before_sha256':sha(raw),'node_config_after_sha256':sha(after),'helper_path':str(helper),'backup_directory':str(RECEIPT),'node_config_mode':stat.S_IMODE(ns.st_mode),'helper_mode':stat.S_IMODE(hs.st_mode),'consumers_running_before':0,'unrelated_configuration_preserved':True,'bootstrap_requested':False}
 atomic(RECEIPT/'installed.safe.json',(json.dumps(record,sort_keys=True)+'\n').encode(),0o600)
 # This starts the same completed cloud Start/epoch; it never creates another epoch.
 # No repeat on an unknown result: query this invocation and unit state first.
 command(['systemctl','start','--no-block','bondbuddy-execution-bootstrap.service'])
 record['bootstrap_requested']=True
 atomic(RECEIPT/'installed.safe.json',(json.dumps(record,sort_keys=True)+'\n').encode(),0o600)
 print(json.dumps(record))
if __name__=='__main__':
 try:main()
 except Exception as e:
  print(json.dumps({'status':'FAIL','error_type':type(e).__name__,'code':str(e) if isinstance(e,RuntimeError) else 'sanitized_error','automatic_rollback':False}));raise SystemExit(1)
