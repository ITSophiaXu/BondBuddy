"""Run only in the disposable, privileged local systemd test container.
Real systemd dependencies/restart behaviour; archive transport and model are synthetic.
"""
import json
import pathlib
import shutil
import subprocess
import time
import sys

ROOT=pathlib.Path('/etc/systemd/system')
HERE=pathlib.Path(__file__).parent

def run(*args,check=True):
    return subprocess.run(args,check=check,capture_output=True,text=True,timeout=25)

def wait_for(check,seconds=20):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        if check(): return
        time.sleep(.2)
    raise AssertionError('condition did not converge')

def state(unit): return run('systemctl','is-active',unit,check=False).stdout.strip()

def write(path,content,mode=0o644):
    path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(content);path.chmod(mode)

assert pathlib.Path('/run/systemd/system').exists(), 'real systemd PID1 required'
if not pathlib.Path('/usr/bin/node').exists(): pathlib.Path('/usr/bin/node').symlink_to(shutil.which('node'))
write(ROOT/'docker.service','[Service]\nType=oneshot\nExecStart=/bin/true\nRemainAfterExit=yes\n')
# Install historic dependencies to prove the regression, then use the real installer.
for unit in ('bondbuddy-diagnostics-collect.service','bondbuddy-diagnostics-collect.timer'):
    write(ROOT/(unit+'.d')/'ready.conf','[Unit]\nRequires=bondbuddy-diagnostics-ready.service\nAfter=bondbuddy-diagnostics-ready.service\n')
write(ROOT/'bondbuddy-execution-bootstrap.service.d/diagnostics.conf','[Unit]\nRequires=bondbuddy-diagnostics-ready.service\nAfter=bondbuddy-diagnostics-ready.service\n')
for name in ('bondbuddy-diagnostics-collect.service','bondbuddy-diagnostics-collect.timer','bondbuddy-diagnostics-ready.service'):
    write(ROOT/name,(HERE/name).read_text())
write(ROOT/'bondbuddy-execution-bootstrap.service',(HERE.parent/'tencent-elasticity/bootstrap.service').read_text())
# The production install/rollback backs up and replaces the exact historic dropins.
import install
cfg={'version':3,'node':'synthetic','state_directory':'/var/lib/bondbuddy-diagnostics','compose_projects':['synthetic'],'actors':{},'execution_bootstrap':True}
write('/root/diagnostics-config.json',json.dumps(cfg),0o600)
pathlib.Path('/run/sshd').mkdir(exist_ok=True)
run('ssh-keygen','-A')
receipt=install.install('/root/diagnostics-config.json')
for unit in ('bondbuddy-diagnostics-collect.service','bondbuddy-diagnostics-collect.timer'):
    assert 'Requires=' not in (ROOT/(unit+'.d')/'ready.conf').read_text()
install.restore(receipt['backup'])
assert 'Requires=bondbuddy-diagnostics-ready.service' in (ROOT/'bondbuddy-diagnostics-collect.timer.d/ready.conf').read_text()
# Restore historic units and inject an unavailable archive transport.
for name in ('bondbuddy-diagnostics-collect.service','bondbuddy-diagnostics-collect.timer','bondbuddy-diagnostics-ready.service'):
    write(ROOT/name,(HERE/name).read_text())
write('/usr/local/sbin/bb-diagnostics','#!/bin/sh\nif [ "$2" = "--require-synced" ] && [ -f /run/archive-down ]; then exit 2; fi\necho collected >> /var/lib/bondbuddy-diagnostics/test-collections\n',0o755)
write('/run/archive-down','fault')
write(ROOT/'bondbuddy-diagnostics-collect.service.d/test.conf','[Unit]\nStartLimitIntervalSec=0\n')
write(ROOT/'bondbuddy-diagnostics-collect.timer.d/test.conf','[Timer]\nOnBootSec=1s\nOnUnitInactiveSec=1s\nAccuracySec=100ms\n')
run('systemctl','daemon-reload')
assert run('systemctl','start','bondbuddy-execution-bootstrap.service',check=False).returncode!=0
assert state('bondbuddy-diagnostics-ready.service')=='failed'
assert run('systemctl','start','bondbuddy-diagnostics-collect.service',check=False).returncode!=0
print('PASS original failed prerequisite blocks both bootstrap and collection',flush=True)
# Apply the real installer; synthetic command bodies replace IO only, not topology.
receipt=install.install('/root/diagnostics-config.json')
write('/usr/local/sbin/bb-diagnostics','#!/bin/sh\nif [ "$2" = "--require-synced" ] && [ -f /run/archive-down ]; then exit 2; fi\necho collected >> /var/lib/bondbuddy-diagnostics/test-collections\n',0o755)
write('/opt/bondbuddy/deploy/tencent-elasticity/bootstrap-entry.mjs',"import fs from 'node:fs';fs.appendFileSync('/run/runtime-attempts','attempt\\n');if(fs.existsSync('/run/enrollment-pending'))process.exit(75);if(fs.existsSync('/run/runtime-fatal'))process.exit(1);fs.appendFileSync('/run/runtime-started','started\\n');")
# Speed up only the test clock; production waits 30 seconds.
launcher=pathlib.Path('/usr/local/sbin/bb-execution-preflight').read_text()
preflight=pathlib.Path(launcher.split(' -I ')[1].split(' ')[0])
preflight.write_text(preflight.read_text().replace('min(30,deadline-now())','min(1,deadline-now())'))
run('systemctl','daemon-reload');run('systemctl','reset-failed')
run('systemctl','start','bondbuddy-diagnostics-collect.timer')
run('systemctl','start','--no-block','bondbuddy-execution-bootstrap.service')
wait_for(lambda:pathlib.Path('/var/lib/bondbuddy-diagnostics/test-collections').exists())
wait_for(lambda:'execution_preflight_pending' in run('journalctl','-u','bondbuddy-execution-bootstrap.service','--no-pager').stdout)
assert not pathlib.Path('/run/runtime-attempts').exists()
pathlib.Path('/run/archive-down').unlink()
wait_for(lambda:state('bondbuddy-execution-bootstrap.service')=='active')
assert pathlib.Path('/run/runtime-attempts').read_text().count('attempt')==1
print('PASS archive outage recovers automatically; collector stayed active; runtime starts exactly once',flush=True)
# Explicit pre-runtime enrollment pending retries; runtime failure must not replay.
run('systemctl','stop','bondbuddy-execution-bootstrap.service')
write('/run/runtime-fatal','fault')
run('systemctl','start','bondbuddy-execution-bootstrap.service',check=False)
wait_for(lambda:state('bondbuddy-execution-bootstrap.service')=='failed')
before=pathlib.Path('/run/runtime-attempts').read_text();time.sleep(3)
assert pathlib.Path('/run/runtime-attempts').read_text()==before
print('PASS fatal runtime remains fenced without automatic restart',flush=True)
print('PASS installer restores previous dependency files during rollback',flush=True)
