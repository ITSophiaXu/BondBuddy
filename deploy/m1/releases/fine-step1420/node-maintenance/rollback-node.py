"""Restore only the prior helper and business pin while node consumers are stopped."""
import pathlib,json,hashlib,os,subprocess,urllib.request,fcntl,stat
R=pathlib.Path('/var/lib/bondbuddy/timing1420-recovery-install')
def need(ok,code):
 if not ok:raise RuntimeError(code)
def sha(b):return hashlib.sha256(b).hexdigest()
def run(a):
 p=subprocess.run(a,capture_output=True,timeout=30);need(p.returncode==0,'command_failed');return p.stdout

def atomic(p,b):
 st=p.stat();tmp=p.with_name(p.name+'.timing1420-rollback');fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,stat.S_IMODE(st.st_mode))
 with os.fdopen(fd,'wb') as out:out.write(b);out.flush();os.fsync(out.fileno())
 os.chown(tmp,st.st_uid,st.st_gid);os.replace(tmp,p)
def main():
 need(os.geteuid()==0,'root_required');opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 with opener.open('http://metadata.tencentyun.com/latest/meta-data/instance-id',timeout=5) as r:need(r.read(128).decode().strip()=='ins-p4i0pcub','instance_mismatch')
 fd=os.open(R/'install.lock',os.O_RDWR|os.O_NOFOLLOW);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 need(not run(['docker','ps','-q','--filter','label=com.docker.compose.project=bondbuddy-execution']).strip(),'active_consumers')
 need(run(['systemctl','show','bondbuddy-execution-bootstrap.service','--property=ActiveState','--value']).decode().strip() in ('inactive','failed'),'bootstrap_busy')
 record=json.loads((R/'installed.safe.json').read_bytes());p=pathlib.Path('/etc/bondbuddy/elastic-node.json');raw=p.read_bytes();n=json.loads(raw);helper=pathlib.Path(record['helper_path']);h=helper.read_bytes()
 need(n['business_overlay_sha256'] in (record['new_pin'],record['old_pin']) and sha(h) in (record['new_helper_sha256'],record['old_helper_sha256']),'rollback_preimage')
 before=(R/'business-overlay.before.mjs').read_bytes();need(sha(before)==record['old_helper_sha256'],'backup_hash')
 if n['business_overlay_sha256']==record['old_pin'] and sha(h)==record['old_helper_sha256']:print(json.dumps({'status':'ALREADY_RESTORED'}));return
 need(p.read_bytes()==raw and helper.read_bytes()==h,'fresh_cas');n['business_overlay_sha256']=record['old_pin'];atomic(helper,before);atomic(p,(json.dumps(n,separators=(',',':'))+'\n').encode())
 print(json.dumps({'status':'PASS','restored_pin':record['old_pin'],'helper_sha256':sha(helper.read_bytes()),'bootstrap_started':False,'other_node_fields_preserved':True}))
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'status':'FAIL','code':str(e) if isinstance(e,RuntimeError) else type(e).__name__}));raise SystemExit(1)
