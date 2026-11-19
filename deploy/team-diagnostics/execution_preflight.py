#!/usr/bin/python3 -I
"""Wait only before exec; never restart an uncertain runtime process."""
import os
import subprocess
import sys
import time


def start_execution(run=subprocess.run, execute=os.execv, now=time.monotonic, wait=time.sleep):
    if os.geteuid() != 0: raise ValueError('Privileged bootstrap required')
    deadline=now()+1800
    while now()<deadline:
        try:
            result = run(['/usr/bin/systemctl', 'start', 'bondbuddy-diagnostics-ready.service'],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         timeout=min(620,deadline-now()))
            if result.returncode==0:
                execute('/usr/bin/node', ['/usr/bin/node', '/opt/bondbuddy/deploy/tencent-elasticity/bootstrap-entry.mjs'])
                raise RuntimeError('exec must not return')
        except subprocess.TimeoutExpired: pass
        print('{"event":"execution_preflight_pending","stage":"diagnostics_ready"}', file=sys.stderr,flush=True)
        wait(max(0,min(30,deadline-now())))
    return 1


if __name__ == '__main__':
    sys.exit(start_execution())
