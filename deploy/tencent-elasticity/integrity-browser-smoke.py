"""Exercise the elastic authoring browser contract in a disposable container.

Run on Linux with Docker Compose and an already-installed immutable worker image:
  python3 deploy/tencent-elasticity/integrity-browser-smoke.py --image sha256:...

No service environment, enrollment, mounts, database, network or model calls are
copied. Resource limits and browser isolation come from the actual Compose file.
This verifies page creation/rendering, not official-site or business delivery.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
PROBE = """
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startIntegrityDesktop} from './dist/integrity-desktop.js';
let failures=0;
process.on('unhandledRejection', error => {
  failures++; process.exitCode=1;
  console.log(JSON.stringify({unhandled:String(error)}));
});
for(let cycle=0;cycle<3;cycle++) {
  const dir=await mkdtemp(join(tmpdir(),'integrity-smoke-'));
  let desktop,browser,timer;
  try {
    desktop=await startIntegrityDesktop(dir,process.env);
    browser=await chromium.launch({headless:false,chromiumSandbox:true,
      env:desktop.env,args:['--window-size=1440,952','--window-position=0,0',
      '--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--proxy-bypass-list=<-loopback>']});
    const context=await browser.newContext({viewport:null,locale:'zh-CN',
      timezoneId:'Asia/Shanghai',acceptDownloads:false,serviceWorkers:'block'});
    const page=await Promise.race([context.newPage(),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Error('NEW_PAGE_TIMEOUT')),10000);
    })]);
    clearTimeout(timer);
    await page.setContent('<title>Integrity browser smoke</title><p>Renderer ready</p>');
    if(await page.title()!=='Integrity browser smoke')throw Error('RENDER_FAILED');
    const screenshot=await page.screenshot({timeout:10000});
    if(screenshot.readUInt32BE(0)!==0x89504e47)throw Error('PNG_FAILED');
    console.log(JSON.stringify({cycle,status:'PASS',version:browser.version(),
      page_created:true,rendered:true,screenshot_bytes:screenshot.length}));
    await context.close();
  } catch(error) {
    failures++; process.exitCode=1;
    console.log(JSON.stringify({cycle,status:'FAIL',message:String(error)}));
    break;
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(()=>{});
    await desktop?.close();
    await rm(dir,{recursive:true,force:true});
  }
}
if(failures)process.exitCode=1;
"""


def command(args, **kwargs):
    return subprocess.run(args, capture_output=True, text=True, timeout=90, **kwargs)


def render(image):
    env = {**os.environ, 'BB_ELASTIC_IMAGE': image,
           'BB_ELASTIC_REVIEW_IMAGE': image, 'BB_ELASTIC_SERVICE_ENV': '/dev/null',
           'BB_ELASTIC_REGISTRATION_DIR': '/nonexistent/integrity-smoke',
           'BB_ELASTIC_NETWORK': 'integrity-smoke-unused'}
    p = command(['docker', 'compose', '-f', str(ROOT/'deploy/tencent-elasticity/compose.yaml'),
                 'config', '--format', 'json'], env=env)
    if p.returncode:
        raise RuntimeError(p.stderr)
    return json.loads(p.stdout)['services']['authoring']


def container_arguments(service, image, name):
    assert service['user'] == '1000:1000' and service['read_only'] is True
    assert service['cap_drop'] == ['ALL'] and service['init'] is True
    assert service['pids_limit'] == 512 and int(service['mem_limit']) == 6*1024**3
    assert float(service['cpus']) == 2
    assert 'no-new-privileges:true' in service['security_opt']
    assert 'apparmor=bondbuddy-codex-v1' in service['security_opt']
    profile = pathlib.Path(next(x.split('=', 1)[1] for x in service['security_opt'] if x.startswith('seccomp=')))
    if not profile.is_absolute():
        profile = (ROOT/'deploy/tencent-elasticity'/profile).resolve()
    assert profile.name == 'integrity-browser-seccomp.json'
    args = ['docker', 'create', '--pull', 'never', '--name', name, '--init',
            '--network', 'none', '--user', service['user'], '--read-only',
            '--memory', str(service['mem_limit']), '--cpus', str(service['cpus']),
            '--pids-limit', str(service['pids_limit']), '--cap-drop', 'ALL']
    for option in service['security_opt']:
        args += ['--security-opt', 'seccomp='+str(profile) if option.startswith('seccomp=') else option]
    for mount in service['tmpfs']:
        args += ['--tmpfs', mount]
    return args + ['--workdir', '/app/apps/worker', '--entrypoint', 'node',
                   image, '--input-type=module', '-e', PROBE], profile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', args.image):
        parser.error('An installed immutable image ID is required')
    service = render(args.image)
    name = 'bb-integrity-smoke-' + uuid.uuid4().hex[:12]
    argv, profile = container_arguments(service, args.image, name)
    created = command(argv)
    if created.returncode:
        raise RuntimeError(created.stderr)
    cid = created.stdout.strip()
    if not re.fullmatch(r'[a-f0-9]{64}', cid):
        raise RuntimeError('Invalid diagnostic container ID')
    try:
        inspected = command(['docker', 'inspect', cid])
        inspected.check_returncode()
        d = json.loads(inspected.stdout)[0]
        h = d['HostConfig']
        assert h['NetworkMode'] == 'none'
        assert all(m['Type'] == 'tmpfs' and m['Destination'] == '/tmp' for m in d['Mounts'])
        assert h['Init'] and h['ReadonlyRootfs'] and h['CapDrop'] == ['ALL']
        assert h['Memory'] == int(service['mem_limit']) and h['PidsLimit'] == 512
        assert h['NanoCpus'] == 2*10**9 and d['Config']['User'] == '1000:1000'
        # A fresh image supplies defaults only; never import a running worker's env.
        assert not any(e.startswith(('DATABASE_URL=', 'AZURE_STORAGE_CONNECTION_STRING='))
                       for e in d['Config']['Env'])
        result = command(['docker', 'start', '-a', cid])
        state_result = command(['docker', 'inspect', '--format', '{{json .State}}', cid])
        state_result.check_returncode()
        state = json.loads(state_result.stdout)
        rows = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
        passed = (result.returncode == 0 and not state['Running'] and state['ExitCode'] == 0
                  and len(rows) == 3 and all(r.get('status') == 'PASS' for r in rows))
        print(json.dumps({'status': 'PASS' if passed else 'FAIL', 'image': args.image,
            'compose_sha256': hashlib.sha256((ROOT/'deploy/tencent-elasticity/compose.yaml').read_bytes()).hexdigest(),
            'seccomp_sha256': hashlib.sha256(pathlib.Path(profile).read_bytes()).hexdigest(),
            'network': 'none', 'database_connected': False, 'model_calls': 0,
            'cycles': rows, 'exit_code': state['ExitCode'], 'docker_exit_code': result.returncode,
            'stderr': result.stderr[-4000:] if not passed else ''}))
        return 0 if passed else 1
    finally:
        cleanup = command(['docker', 'rm', '-f', cid])
        cleanup.check_returncode()


if __name__ == '__main__':
    raise SystemExit(main())
