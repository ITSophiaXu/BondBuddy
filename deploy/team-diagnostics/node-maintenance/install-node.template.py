"""Install the fixed independent collector, without activating or touching business services."""
import base64,fcntl,hashlib,io,json,os,pathlib,shutil,stat,subprocess,sys,tarfile,time,urllib.request
TARGET='ins-p4i0pcub'
COMMIT='ac818a21241e9427f5bd8755d8aa5f4e0da1f304'
BUNDLE='f3928f57c9f01a2f'
PACKAGE_SHA=__PACKAGE_SHA__
PACKAGE=__PACKAGE__
FILES=__FILES__
EXPECTED=__EXPECTED__
RELEASE=pathlib.Path('/var/lib/bondbuddy/diagnostics-node-release-20261116-ac818a21241e')
ETC=pathlib.Path('/etc/bondbuddy-diagnostics')
STATE=pathlib.Path('/var/lib/bondbuddy-diagnostics')
HOST_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIBaPtAPo5EQqml1lG/WGu3CqGzWtMEoV9fqt1436Ra+'
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'}


def run(args,timeout=30):
    p=subprocess.run(args,stdin=subprocess.DEVNULL,capture_output=True,timeout=timeout,env=ENV)
    if p.returncode:raise RuntimeError('command_failed:'+pathlib.Path(args[0]).name)
    return p.stdout


def regular(path):
    path=pathlib.Path(path);info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
        raise RuntimeError('unsafe_existing_file')
    return path.read_bytes()


def checked_directory(path,mode=0o700):
    path.mkdir(parents=True,exist_ok=True,mode=mode)
    for parent in [*reversed(path.parents),path]:
        info=parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
            raise RuntimeError('unsafe_directory')


def exclusive(path,data,mode=0o600):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    with os.fdopen(fd,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())


def snapshot():
    ids=run(['/usr/bin/docker','ps','-aq','--filter','label=com.docker.compose.project=bondbuddy-execution']).decode().split()
    if len(ids)!=2:raise RuntimeError('execution_container_scope_changed')
    return run(['/usr/bin/docker','inspect','--format','{{.Id}}|{{.Image}}|{{.State.StartedAt}}',*sorted(ids)]).decode().splitlines()


def main():
    os.umask(0o077)
    if os.geteuid()!=0 or sys.version_info<(3,11):raise RuntimeError('root_and_python311_required')
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://metadata.tencentyun.com/latest/meta-data/instance-id',timeout=5) as reply:
        if reply.read(128).decode().strip()!=TARGET:raise RuntimeError('target_mismatch')
    fd=os.open('/run/lock/bondbuddy-diagnostics-deploy.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    info=os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o077:raise RuntimeError('unsafe_lock')
    fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    if RELEASE.exists():raise RuntimeError('prior_attempt_exists_inspect_original_receipt')
    for filename,expected in EXPECTED.items():
        if hashlib.sha256(regular(filename)).hexdigest()!=expected:raise RuntimeError('business_preimage_changed')
    for filename in ('/usr/local/sbin/bb-diagnostics','/usr/local/bin/bb-diagnostics-console',
                     '/etc/sudoers.d/bondbuddy-diagnostics','/etc/ssh/sshd_config.d/90-bondbuddy-diagnostics.conf'):
        if os.path.lexists(filename):raise RuntimeError('diagnostics_already_present')
    for filename in ('config.json','upload-key','upload-key.pub','known_hosts','upload-ssh.conf'):
        if os.path.lexists(ETC/filename):raise RuntimeError('diagnostics_identity_already_present')
    if shutil.disk_usage('/var/lib').free<1536*1024*1024:raise RuntimeError('insufficient_headroom')
    before=snapshot()
    package=base64.b64decode(PACKAGE,validate=True)
    if hashlib.sha256(package).hexdigest()!=PACKAGE_SHA:raise RuntimeError('package_hash')
    payload={}
    with tarfile.open(fileobj=io.BytesIO(package),mode='r:gz') as archive:
        for member in archive:
            if not member.isfile() or member.name not in FILES or member.name in payload:raise RuntimeError('package_member')
            value=archive.extractfile(member).read()
            if hashlib.sha256(value).hexdigest()!=FILES[member.name]:raise RuntimeError('member_hash')
            payload[member.name]=value
    if set(payload)!=set(FILES):raise RuntimeError('package_incomplete')
    checked_directory(RELEASE.parent)
    RELEASE.mkdir(mode=0o700)
    exclusive(RELEASE/'preimage.json',json.dumps({'business_files':EXPECTED,'containers':before,'diagnostics_previously_installed':False},indent=2).encode())
    source=RELEASE/'source';source.mkdir(mode=0o755)
    for name,value in payload.items():exclusive(source/name,value,0o644)
    config={'version':3,'node':TARGET,'state_directory':str(STATE),'compose_projects':['bondbuddy-execution'],
        'explicit_containers':[],'journal_units':['bondbuddy-execution-bootstrap.service','bondbuddy-execution-pg.service'],
        'retention_days':180,'minimum_free_bytes':1073741824,'expected_sources':[],'actors':{},'ingest_sources':{},
        'upload':{'target':'bondbuddy-log-hub','ssh_config':str(ETC/'upload-ssh.conf')}}
    config_file=RELEASE/'approved-config.json';exclusive(config_file,(json.dumps(config,indent=2)+'\n').encode())
    sys.path.insert(0,str(source));import install
    receipt=install.install(config_file)
    if receipt['bundle']!=BUNDLE:raise RuntimeError('installed_bundle_mismatch')
    exclusive(RELEASE/'install-receipt.json',(json.dumps(receipt,indent=2)+'\n').encode())
    run(['/usr/bin/ssh-keygen','-q','-t','ed25519','-N','','-C','bb-diagnostics-'+TARGET,'-f',str(ETC/'upload-key')])
    os.chmod(ETC/'upload-key',0o600);os.chmod(ETC/'upload-key.pub',0o644)
    key=regular(ETC/'upload-key.pub').decode().strip()
    if not key.startswith('ssh-ed25519 ') or '\n' in key:raise RuntimeError('public_key_shape')
    exclusive(ETC/'known_hosts',('bondbuddy-log-hub '+HOST_KEY+'\n').encode(),0o600)
    ssh_config='Host bondbuddy-log-hub\n    HostName 10.2.0.5\n    HostKeyAlias bondbuddy-log-hub\n    User bb-ingest-ins-p4i0pcub\n    IdentityFile /etc/bondbuddy-diagnostics/upload-key\n    UserKnownHostsFile /etc/bondbuddy-diagnostics/known_hosts\n    IdentitiesOnly yes\n    StrictHostKeyChecking yes\n    BatchMode yes\n    ClearAllForwardings yes\n    ConnectTimeout 10\n    Compression yes\n    ControlMaster auto\n    ControlPersist 60\n    ControlPath /var/lib/bondbuddy-diagnostics/upload-control\n'
    exclusive(ETC/'upload-ssh.conf',ssh_config.encode(),0o600)
    after=snapshot()
    if before!=after:raise RuntimeError('business_containers_changed_during_install')
    for filename,expected in EXPECTED.items():
        if hashlib.sha256(regular(filename)).hexdigest()!=expected:raise RuntimeError('business_files_changed_during_install')
    result={'schema':'bb-diagnostics-node-prepared-v1','instance_id':TARGET,'commit':COMMIT,'bundle':BUNDLE,
        'archive_sha256':PACKAGE_SHA,'release':str(RELEASE),'install':receipt,'prepared_at':time.time(),
        'upload_public_key':key,'public_key_fingerprint':run(['/usr/bin/ssh-keygen','-lf',str(ETC/'upload-key.pub')]).decode().strip(),
        'application_containers_unchanged':True,'business_files_unchanged':True,'activated':False,
        'next':'Bind this public key on the main hub, then run the separately pinned activation request.'}
    exclusive(RELEASE/'prepared.json',(json.dumps(result,indent=2)+'\n').encode())
    exclusive(STATE/'deployment.json',(json.dumps(result,indent=2)+'\n').encode())
    print(json.dumps(result,sort_keys=True))


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'schema':'bb-diagnostics-node-prepared-v1','status':'FAIL','error_type':type(error).__name__,
            'code':str(error) if isinstance(error,RuntimeError) else 'inspect_original_attempt','release':str(RELEASE)}))
        raise SystemExit(1)
