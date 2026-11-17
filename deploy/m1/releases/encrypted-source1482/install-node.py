"""Install the exact #1482 recovery-compatible helper while consumers are stopped.
Control side must already hold the shared deployment/control window, bind the new
service templates, and complete one normal Start operation before this request.
No direct cloud action, credential access, migration or force-stop is performed.
"""
import base64,datetime,fcntl,gzip,hashlib,json,os,pathlib,stat,subprocess,urllib.request
TARGET='ins-p4i0pcub'
OLD_PIN='183e5240e6cefc09314943fc270b009fd547e497437af111a99fd77235e17dd0'
NEW_PIN='c9449fc3294e0a1590ddc5081d99cb9387ea439acf4d096db4ea41e790391770'
OLD_HELPER='db4c77793f576d9e7203673da7121d163aaeef74cb6cec35373d389a1684f43e'
NEW_HELPER='87c4b69a0c9f0ba3e5a016bf17fd9661a35afff6643ce39949952857e0741ca5'
HELPER_GZIP_BASE64='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'
RECEIPT=pathlib.Path('/var/lib/bondbuddy/encrypted1482-install')
def sha(b):return hashlib.sha256(b).hexdigest()
def need(ok,code):
 if not ok:raise RuntimeError(code)
def command(args):
 p=subprocess.run(args,capture_output=True,timeout=20);need(p.returncode==0,'command_failed');return p.stdout

def regular(path):
 p=pathlib.Path(path);s=p.lstat();need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_mode&0o022==0,'unsafe_file');return p.read_bytes(),s

def atomic(path,data,mode):
 temp=path.with_name(path.name+'.encrypted1482-new')
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
 record={'schema':'encrypted1482-node-helper-install-v1','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'instance_id':instance,'old_pin':OLD_PIN,'new_pin':NEW_PIN,'old_helper_sha256':OLD_HELPER,'new_helper_sha256':NEW_HELPER,'node_config_before_sha256':sha(raw),'node_config_after_sha256':sha(after),'helper_path':str(helper),'backup_directory':str(RECEIPT),'node_config_mode':stat.S_IMODE(ns.st_mode),'helper_mode':stat.S_IMODE(hs.st_mode),'consumers_running_before':0,'unrelated_configuration_preserved':True,'bootstrap_requested':False}
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
