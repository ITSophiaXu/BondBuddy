#!/usr/bin/python3
"""Explicit administrator installation. Does not deploy/restart application services."""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ETC = pathlib.Path('/etc/bondbuddy-diagnostics')
STATE = pathlib.Path('/var/lib/bondbuddy-diagnostics')
GROUP = 'bb-diagnostics'
SOURCES = ['common.py','archive.py','collector.py','database.py','broker.py','entry.py','console.py','read-content.mjs']


def run(args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def atomic(path, content, mode=0o600):
    if path.is_symlink(): raise ValueError('Refusing symbolic-link destination')
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    temporary = path.with_name(path.name + '.new')
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(content); file.flush(); os.fsync(file.fileno())
        temporary.chmod(mode); os.replace(temporary, path)
    finally:
        if temporary.exists(): temporary.unlink()


def install(config_path):
    config = json.loads(pathlib.Path(config_path).read_text())
    if config.get('version') != 3 or config.get('state_directory') != str(STATE):
        raise ValueError('Use the reviewed v3 configuration and state directory')
    if 'REPLACE_' in json.dumps(config): raise ValueError('Fill all deployment-specific values first')
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    ETC.mkdir(parents=True, exist_ok=True, mode=0o755)
    from common import trusted_file
    trusted_file(STATE, directory=True); trusted_file(ETC, directory=True)
    # sshd opens authorized_keys as the target identity; public-key parents must be traversable.
    ETC.chmod(0o755)
    (ETC/'docker').mkdir(exist_ok=True, mode=0o700)
    bundle = hashlib.sha256(b''.join((HERE/f).read_bytes() for f in SOURCES)).hexdigest()[:16]
    destination = pathlib.Path('/usr/local/lib') / ('bondbuddy-diagnostics-' + bundle)
    destination.mkdir(exist_ok=True, mode=0o755)
    trusted_file(destination, directory=True)
    destination.chmod(0o755)
    for name in SOURCES:
        content = (HERE/name).read_bytes(); target = destination/name
        if target.exists() and target.read_bytes() != content: raise ValueError('Installed bundle hash mismatch')
        if not target.exists(): atomic(target, content, 0o644)
    import grp
    try: grp.getgrnam(GROUP)
    except KeyError: run(['/usr/sbin/groupadd','--system',GROUP])
    files = {
        ETC/'config.json': (json.dumps(config,indent=2).encode()+b'\n', 0o600),
        pathlib.Path('/usr/local/sbin/bb-diagnostics'): (f'#!/bin/sh\nexec /usr/bin/python3 -I {destination}/entry.py "$@"\n'.encode(), 0o755),
        pathlib.Path('/usr/local/bin/bb-diagnostics-console'): ((HERE/'console.py').read_bytes(), 0o755),
        pathlib.Path('/etc/sudoers.d/bondbuddy-diagnostics'): (f'Defaults:%{GROUP} env_reset,!setenv\nDefaults:%{GROUP} secure_path="/usr/sbin:/usr/bin:/sbin:/bin"\n%{GROUP} ALL=(root) NOPASSWD: /usr/local/sbin/bb-diagnostics\n'.encode(), 0o440),
        pathlib.Path('/etc/ssh/sshd_config.d/90-bondbuddy-diagnostics.conf'): (f'Match Group {GROUP}\n    AuthenticationMethods publickey\n    PasswordAuthentication no\n    KbdInteractiveAuthentication no\n    AuthorizedKeysFile /etc/bondbuddy-diagnostics/keys/%u\n    DisableForwarding yes\n    X11Forwarding no\n    PermitTunnel no\n    PermitUserRC no\n    PermitTTY yes\n    ForceCommand /usr/local/bin/bb-diagnostics-console\nMatch all\n'.encode(), 0o644),
    }
    for name in ('bondbuddy-diagnostics-collect.service','bondbuddy-diagnostics-collect.timer','bondbuddy-diagnostics-ready.service'):
        files[pathlib.Path('/etc/systemd/system')/name] = ((HERE/name).read_bytes(), 0o644)
    backup = STATE/'install-backups'/datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup.mkdir(parents=True,mode=0o700)
    manifest = []
    for index,(path,(content,mode)) in enumerate(files.items()):
        if path.is_symlink(): raise ValueError('Unsafe existing managed file')
        entry = {'path':str(path),'backup':str(index),'existed':path.exists()}
        if path.exists(): shutil.copy2(path,backup/str(index))
        manifest.append(entry)
    atomic(backup/'manifest.json',json.dumps(manifest).encode())
    try:
        for path,(content,mode) in files.items(): atomic(path,content,mode)
        from common import load_config
        load_config()
        run(['/usr/sbin/visudo','-cf','/etc/sudoers.d/bondbuddy-diagnostics'])
        run(['/usr/sbin/sshd','-t'])
        import archive
        archive.connect(STATE/'archive.sqlite3',write=True).close()
    except Exception:
        restore(backup)
        raise
    return {'bundle':bundle,'backup':str(backup),'activated':False,
            'next':'Install database views and individual public keys, then explicitly activate the diagnostic timer and reload SSH in the authorized release.'}


def restore(backup):
    from common import trusted_file
    backup = pathlib.Path(backup).resolve()
    if backup.parent != STATE/'install-backups': raise ValueError('Invalid backup location')
    trusted_file(backup,directory=True)
    for item in json.loads(trusted_file(backup/'manifest.json').read_text()):
        path=pathlib.Path(item['path'])
        allowed = path in (ETC/'config.json',pathlib.Path('/usr/local/sbin/bb-diagnostics'),pathlib.Path('/usr/local/bin/bb-diagnostics-console'),pathlib.Path('/etc/sudoers.d/bondbuddy-diagnostics'),pathlib.Path('/etc/ssh/sshd_config.d/90-bondbuddy-diagnostics.conf')) or path.parent==pathlib.Path('/etc/systemd/system') and path.name in ('bondbuddy-diagnostics-collect.service','bondbuddy-diagnostics-collect.timer','bondbuddy-diagnostics-ready.service')
        if not allowed or not re.fullmatch(r'\d+',item['backup']): raise ValueError('Invalid managed backup')
        if item['existed']:
            original=trusted_file(backup/item['backup']); atomic(path,original.read_bytes(),original.stat().st_mode & 0o777)
        elif path.exists(): path.unlink()


def account(user, public_key, role, source=None):
    import pwd
    from common import load_config, identifier, trusted_file
    identifier(user)
    if not re.fullmatch(r'bb-(?:log|ingest)-[a-z0-9-]{1,24}|bb-logs',user): raise ValueError('Use a dedicated diagnostic account')
    if (role=='ingest') != bool(source): raise ValueError('Ingestion requires one fixed source identity')
    if source: identifier(source)
    key=pathlib.Path(public_key).read_text().strip()
    if '\n' in key or not re.fullmatch(r'(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]+(?: [^\r\n]*)?',key): raise ValueError('Expected one public key, never a private key')
    config=load_config()
    try:
        current=pwd.getpwnam(user)
        if current.pw_uid==0: raise ValueError('Invalid privileged identity')
        groups=run(['/usr/bin/id','-nG',user]).decode().split()
        if set(groups)&{'sudo','docker','adm','wheel','systemd-journal'}: raise ValueError('Existing account has privileges outside diagnostics')
    except KeyError:
        run(['/usr/sbin/useradd','--system','--no-create-home','--home-dir','/var/empty','--shell','/usr/local/bin/bb-diagnostics-console',user])
    run(['/usr/sbin/usermod','--lock','--shell','/usr/local/bin/bb-diagnostics-console','-a','-G',GROUP,user])
    if role=='ingest' and source in config.get('ingest_sources',{}).values() and config.get('ingest_sources',{}).get(user)!=source:
        raise ValueError('Source already bound to another machine account')
    if user in config['actors'] and config['actors'][user]!=role: raise ValueError('Do not repurpose an existing diagnostic identity')
    config['actors'][user]=role
    if role=='ingest':
        config.setdefault('ingest_sources',{})[user]=source
        config['expected_sources']=sorted(set(config.get('expected_sources',[]))|{source})
    key_directory=ETC/'keys'
    key_directory.mkdir(exist_ok=True,mode=0o755)
    trusted_file(key_directory,directory=True); key_directory.chmod(0o755)
    atomic(key_directory/user,('restrict,pty '+key+'\n').encode(),0o644)
    atomic(ETC/'config.json',(json.dumps(config,indent=2)+'\n').encode())
    run(['/usr/sbin/sshd','-t'])
    return {'account':user,'role':role,'source':source,'private_key_created':False}


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    sub=parser.add_subparsers(dest='action',required=True)
    sub.add_parser('install').add_argument('config')
    sub.add_parser('rollback').add_argument('backup')
    add=sub.add_parser('account'); add.add_argument('user'); add.add_argument('public_key'); add.add_argument('--role',choices=['reader','ingest'],default='reader'); add.add_argument('--source')
    args=parser.parse_args()
    if os.geteuid()!=0: raise SystemExit('Run only in an authorized administrator session')
    os.umask(0o077)
    if args.action=='install': result=install(args.config)
    elif args.action=='rollback': restore(args.backup); result={'restored':True,'activation_required':True}
    else: result=account(args.user,args.public_key,args.role,args.source)
    print(json.dumps(result,indent=2))
