"""Activate the prepared node collector and require acknowledged history before success."""
import fcntl,hashlib,json,os,pathlib,shutil,stat,subprocess,sys,time,urllib.request
TARGET='ins-p4i0pcub'
BUNDLE='f3928f57c9f01a2f'
FILES={'common.py': 'f15f007fcc93b62dd53fa90e91f2c931e2d90ed557477c3a47f50f5fc60ea876', 'archive.py': '23b5bb4939760ab3ace38ff6bb5c37c385aa60a26f40aedc5b7c78f5492d57ca', 'collector.py': '60a03007a373bacf46e701040711510e0805bf248aaa46bf2bb103aa9d04377b', 'database.py': 'cb36ea3139b940ba8d809add603a738ad2b1f47bf127e8b9cc500894a43118a3', 'broker.py': 'c405321f40fea8d746d26b0b1d48b64fc33b98a6c7b16181971ed90b7f9644e7', 'entry.py': '8c61cded9f6f3567ec154db51cad61521cd862db69a754d322c8e137b367930b', 'console.py': '52c521d8fa43c0917f43918634f498683170419c42c70a5fd94a36a0ec5f1d1a', 'read-content.mjs': '9f3fae75ffad49ee2c9841bc3d197c75d706bf37f70d5b993cf5893899e0d486', 'install.py': '178de2440bae5340d2eff3215be600c64800a06e33f5040b140af169261a11a5', 'bondbuddy-diagnostics-collect.service': 'c1bf548521013e4400a178e1c536572882413b05ed6e87e110bf22878ec0aeac', 'bondbuddy-diagnostics-collect.timer': 'cdc9dc9a4f40db1df827ccded6add8877813158347f027df322afa5adde91040', 'bondbuddy-diagnostics-ready.service': 'f217b76d3ac68ff73a2acd19b502027cd6a7b158e70d20c0e2ebd71c669b650b', 'execution-bootstrap.drop-in.conf': '6a23beb82ce73c51f797d8e90c64b1fb6160d0715d93a394c1e760641cb6f37e'}
RELEASE=pathlib.Path('/var/lib/bondbuddy/diagnostics-node-release-20261116-ac818a21241e')
ETC=pathlib.Path('/etc/bondbuddy-diagnostics')
STATE=pathlib.Path('/var/lib/bondbuddy-diagnostics')
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'}
STEPS=[]

def regular(path):
    path=pathlib.Path(path);info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise RuntimeError('unsafe_existing_file')
    return path.read_bytes()

def run(args,timeout=30):
    p=subprocess.run(args,stdin=subprocess.DEVNULL,capture_output=True,timeout=timeout,env=ENV)
    if p.returncode:raise RuntimeError('command_failed:'+pathlib.Path(args[0]).name)
    return p.stdout

def exclusive(path,data):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())

def snapshot():
    ids=run(['/usr/bin/docker','ps','-aq','--filter','label=com.docker.compose.project=bondbuddy-execution']).decode().split()
    if len(ids)!=2:raise RuntimeError('execution_container_scope_changed')
    return run(['/usr/bin/docker','inspect','--format','{{.Id}}|{{.Image}}|{{.State.StartedAt}}',*sorted(ids)]).decode().splitlines()

def main():
    os.umask(0o077)
    if os.geteuid()!=0:raise RuntimeError('root_required')
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://metadata.tencentyun.com/latest/meta-data/instance-id',timeout=5) as reply:
        if reply.read(128).decode().strip()!=TARGET:raise RuntimeError('target_mismatch')
    fd=os.open('/run/lock/bondbuddy-diagnostics-deploy.lock',os.O_RDWR|os.O_NOFOLLOW)
    info=os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o077:raise RuntimeError('unsafe_lock')
    fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    if (RELEASE/'activation-preimage.json').exists():raise RuntimeError('prior_activation_attempt_inspect_receipt')
    prepared=json.loads(regular(RELEASE/'prepared.json'))
    if prepared['instance_id']!=TARGET or prepared['bundle']!=BUNDLE or prepared['activated']:raise RuntimeError('prepared_identity_mismatch')
    source=RELEASE/'source';installed=pathlib.Path('/usr/local/lib/bondbuddy-diagnostics-'+BUNDLE)
    for name,expected in FILES.items():
        if hashlib.sha256(regular(source/name)).hexdigest()!=expected:raise RuntimeError('source_hash_changed')
        if name.endswith('.service') or name.endswith('.timer'):
            if hashlib.sha256(regular(pathlib.Path('/etc/systemd/system')/name)).hexdigest()!=expected:raise RuntimeError('installed_unit_changed')
        if name in ('common.py','archive.py','collector.py','database.py','broker.py','entry.py','console.py','read-content.mjs'):
            if hashlib.sha256(regular(installed/name)).hexdigest()!=expected:raise RuntimeError('installed_bundle_changed')
    expected_launcher=('#!/bin/sh\nexec /usr/bin/python3 -I '+str(installed)+'/entry.py "$@"\n').encode()
    if regular('/usr/local/sbin/bb-diagnostics')!=expected_launcher:raise RuntimeError('launcher_changed')
    if json.loads(regular(ETC/'config.json'))!=json.loads(regular(RELEASE/'approved-config.json')):raise RuntimeError('config_changed')
    fingerprint=run(['/usr/bin/ssh-keygen','-lf',str(ETC/'upload-key.pub')]).decode().strip()
    if fingerprint!=prepared['public_key_fingerprint'] or 'SHA256:dyhdgfLiFMRM2ZuMLb3BcKrhYlZjjJiT/qdnrkirrcw' not in fingerprint:raise RuntimeError('upload_identity_changed')
    if regular(ETC/'upload-key.pub').decode().strip()!=prepared['upload_public_key']:raise RuntimeError('public_key_changed')
    if regular(ETC/'known_hosts')!=b'bondbuddy-log-hub ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIBaPtAPo5EQqml1lG/WGu3CqGzWtMEoV9fqt1436Ra+\n':raise RuntimeError('host_key_changed')
    ssh=run(['/usr/bin/ssh','-G','-F',str(ETC/'upload-ssh.conf'),'bondbuddy-log-hub']).decode().splitlines()
    if not all(v in ssh for v in ['hostname 10.2.0.5','user bb-ingest-ins-p4i0pcub','stricthostkeychecking true','identitiesonly yes','batchmode yes']):raise RuntimeError('upload_transport_changed')
    if shutil.disk_usage(STATE).free<1536*1024*1024:raise RuntimeError('insufficient_headroom')
    business={name:hashlib.sha256(regular(name)).hexdigest() for name in json.loads(regular(RELEASE/'preimage.json'))['business_files']}
    before=snapshot()
    exclusive(RELEASE/'activation-preimage.json',(json.dumps({'business_files':business,'containers':before,'previous_deployment':json.loads(regular(STATE/'deployment.json'))},indent=2)+'\n').encode())
    STEPS.append('preimage_saved')
    passes=[];deadline=time.monotonic()+430
    for number in range(12):
        if time.monotonic()>deadline:raise RuntimeError('backfill_time_bound')
        status=json.loads(run(['/usr/local/sbin/bb-diagnostics','--collect'],timeout=120))
        summary={k:status.get(k) for k in ('node','checked_at','errors','backlog','upload_backlog','last_sequence')}
        passes.append(summary)
        exclusive(RELEASE/('sync-pass-'+str(number)+'.json'),(json.dumps(summary)+'\n').encode())
        if status['errors']:raise RuntimeError('capture_errors_inspect_sync_receipt')
        if not status['backlog'] and not status.get('upload_backlog'):break
    else:raise RuntimeError('backfill_pass_bound')
    STEPS.append('first_history_acknowledged')
    run(['/usr/bin/systemctl','daemon-reload'])
    run(['/usr/bin/systemctl','start','bondbuddy-diagnostics-ready.service'],timeout=120)
    if run(['/usr/bin/systemctl','is-active','bondbuddy-diagnostics-ready.service']).strip()!=b'active':raise RuntimeError('ready_gate_inactive')
    STEPS.append('ready_gate_active')
    run(['/usr/bin/systemctl','enable','--now','bondbuddy-diagnostics-collect.timer'])
    if run(['/usr/bin/systemctl','is-active','bondbuddy-diagnostics-collect.timer']).strip()!=b'active':raise RuntimeError('timer_inactive')
    if run(['/usr/bin/systemctl','is-enabled','bondbuddy-diagnostics-collect.timer']).strip()!=b'enabled':raise RuntimeError('timer_not_enabled')
    STEPS.append('timer_enabled')
    topology=run(['/usr/bin/systemctl','show','bondbuddy-execution-bootstrap.service','bondbuddy-execution-pg.service','-p','Id','-p','After','-p','Before','-p','Requires','-p','Wants']).decode()
    after=snapshot()
    changed=[name for name,expected in business.items() if hashlib.sha256(regular(name)).hexdigest()!=expected]
    result={'schema':'bb-diagnostics-node-activation-v1','instance_id':TARGET,'bundle':BUNDLE,'activated_at':time.time(),'activated':True,
        'first_sync':passes,'ready_gate_active':True,'timer_enabled_active':True,'bootstrap_gate_installed':False,
        'application_containers_unchanged':before==after,'business_files_unchanged':not changed,'business_files_changed':changed,
        'business_topology':topology,'steps':STEPS,'backup':str(RELEASE/'activation-preimage.json')}
    exclusive(RELEASE/'activation-receipt.json',(json.dumps(result,indent=2)+'\n').encode())
    temporary=STATE/'deployment.json.activation-new'
    exclusive(temporary,(json.dumps({**prepared,'activated':True,'activation':result},indent=2)+'\n').encode());os.replace(temporary,STATE/'deployment.json')
    print(json.dumps(result,sort_keys=True))
    if changed or before!=after:raise RuntimeError('concurrent_business_drift_no_automatic_rollback')

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'status':'FAIL','error_type':type(error).__name__,'code':str(error) if isinstance(error,RuntimeError) else 'inspect_original_attempt','steps':STEPS}))
        raise SystemExit(1)
