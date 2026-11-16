"""Install the exact #1420 recovery-compatible helper while consumers are stopped.
Control side must already hold the shared deployment/control window, bind the new
service templates, and complete one normal Start operation before this request.
No direct cloud action, credential access, migration or force-stop is performed.
"""
import base64,datetime,fcntl,gzip,hashlib,json,os,pathlib,stat,subprocess,urllib.request
TARGET='ins-p4i0pcub'
OLD_PIN='2d86f1351c8c7cf1b49609d7ff442b06344a0c45aa003b5ca0efb4a64a7e7654'
NEW_PIN='c4749d922f49eaa8fcbdc334881552dd7db5bdaa540ef154064de5f29e375b5e'
OLD_HELPER='60afbcc278f3bac460235240bc2cff03600f61d42b992dbed0fed49ef32609ca'
NEW_HELPER='75e10607d1886e1b11e3be809d664a4cd362bc2597e238511175bc96487f44e4'
HELPER_GZIP_BASE64='__HELPER__'
RECEIPT=pathlib.Path('/var/lib/bondbuddy/timing1420-recovery-install')
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
