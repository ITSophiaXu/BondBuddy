"""Verify the configured Codex execution permissions without invoking a model.

Full access is used only when explicitly selected in the container config.
A failed restricted probe never changes the selected permission mode.
"""
from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import tempfile
from pathlib import Path
from .codex_config import full_access_enabled


def policy_options(legacy=False):
    return ['--enable' if legacy else '--disable', 'use_legacy_landlock',
            '-c', 'sandbox_workspace_write.network_access=false',
            '-c', 'sandbox_workspace_write.writable_roots=[]',
            '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
            '-c', 'sandbox_workspace_write.exclude_slash_tmp=true']


PROBE = '''import json,socket,sys
from pathlib import Path
outside,port,marker=sys.argv[1:]
root=Path.cwd()
assert (root/'original.txt').read_text()==marker
for name in ('output/word.tmp','scratch/script.tmp'):
 p=root/name
 p.write_text(marker)
 assert p.read_text()==marker
try:
 Path(outside).write_text('sandbox probe')
except OSError: pass
else: raise RuntimeError('outside_write_allowed')
try:
 connection=socket.create_connection(('127.0.0.1',int(port)),timeout=2)
except OSError: pass
else:
 connection.close()
 raise RuntimeError('tool_network_allowed')
print(json.dumps({'marker':marker,'write':True,'outside_blocked':True,'network_blocked':True}))
'''


FULL_PROBE = '''import json,socket,sys
from pathlib import Path
outside,port,marker=sys.argv[1:]
root=Path.cwd()
assert (root/'original.txt').read_text()==marker
for name in ('output/word.tmp','scratch/script.tmp',outside):
 p=Path(name)
 p.write_text(marker)
 assert p.read_text()==marker
Path(outside).unlink()
with socket.create_connection(('127.0.0.1',int(port)),timeout=2): pass
print(json.dumps({'marker':marker,'write':True,'outside_allowed':True,'network_allowed':True}))
'''


def verify_workspace(cli, environment, parent):
    if os.name == 'nt':
        raise RuntimeError('此版本的原生 Word 执行器只在 Azure Linux 容器启用。')
    failures = []
    full_access = full_access_enabled(environment)
    with tempfile.TemporaryDirectory(prefix='.cli-permissions-', dir=parent) as folder:
        base = Path(folder).resolve()
        task = base / 'task'
        for name in ('scratch', 'output'):
            (task / name).mkdir(parents=True)
        # A clean probe configuration cannot trigger a model request or access
        # production credentials. The real command overrides the same policies.
        home = base / 'probe-config'
        home.mkdir()
        env = dict(environment, CODEX_HOME=str(home), TMPDIR=str(task / 'scratch'),
                   TMP=str(task / 'scratch'), TEMP=str(task / 'scratch'))
        for key in ('BOND_CODEX_HOME', 'BOND_AUTH_USERNAME', 'BOND_AUTH_PASSWORD',
                    'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'):
            env.pop(key, None)
        marker = base.name
        (task / 'original.txt').write_text(marker)
        (task / 'probe.py').write_text(FULL_PROBE if full_access else PROBE, encoding='utf-8')
        help_result = subprocess.run([cli, 'sandbox', '--help'], env=env,
            capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=20)
        if help_result.returncode:
            raise RuntimeError('无法读取 Codex 文件权限测试入口；尚未调用模型。')
        subcommand = ['sandbox', 'linux'] if re.search(r'^\s+linux\s+', help_result.stdout, re.M) else ['sandbox']
        outside = base / 'must-not-exist'
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen(2)
            port = listener.getsockname()[1]
            with socket.create_connection(('127.0.0.1', port), timeout=2):
                peer, _ = listener.accept()
                peer.close()
            for legacy in ((False,) if full_access else (False, True)):
                opts = (['--disable', 'use_legacy_landlock', '-c', 'sandbox_mode="danger-full-access"',
                         '-c', 'approval_policy="never"'] if full_access else policy_options(legacy))
                mode_options = [] if full_access else ['-c', 'sandbox_mode="workspace-write"']
                command = [cli, *opts, *mode_options,
                           *subcommand, '--', sys.executable, '-B', str(task / 'probe.py'),
                           str(outside), str(port), marker]
                result = subprocess.run(command, cwd=task, env=env, capture_output=True,
                    text=True, encoding='utf-8', errors='replace', timeout=45)
                expected = ({'marker': marker, 'write': True, 'outside_allowed': True, 'network_allowed': True}
                            if full_access else {'marker': marker, 'write': True, 'outside_blocked': True, 'network_blocked': True})
                try:
                    ok = json.loads(result.stdout.strip().splitlines()[-1]) == expected
                except (ValueError, IndexError):
                    ok = False
                if outside.exists():
                    raise RuntimeError('Codex 权限测试发现目录外可写，已停止；尚未调用模型。')
                if result.returncode == 0 and ok and all(
                    (task / name).read_text() == marker for name in ('output/word.tmp', 'scratch/script.tmp')
                ):
                    return opts
                detail = re.sub(r'sk-[A-Za-z0-9_-]{12,}', '[REDACTED]', result.stderr + result.stdout)
                failures.append(('configured-full-access' if full_access else ('legacy' if legacy else 'modern')) + ': ' + detail[-2200:])
    raise RuntimeError('CLI_WORKSPACE_UNAVAILABLE：文件写入权限预检未通过，尚未调用模型。\n' + '\n'.join(failures))
