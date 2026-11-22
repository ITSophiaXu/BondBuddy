#!/usr/bin/python3 -I
"""SSH forced command; no shell interpretation, SCP, SFTP or arbitrary executable."""
import os
import shlex
import subprocess
import sys


def execute(line):
    if len(line) > 8192 or any(ord(c) < 32 for c in line): raise ValueError('Invalid command')
    args = shlex.split(line)
    if not args: args = ['help']
    if args[0] not in ('help','capabilities','sources','services','status','collections','logs','db','runs','run','attempt','content','exec-log','processes','ingest'):
        raise ValueError('Use help for allowed diagnostic commands')
    return subprocess.call(['/usr/bin/sudo', '-n', '/usr/local/sbin/bb-diagnostics', *args],
                           env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8','HOME':'/var/empty'})


def main():
    original = os.environ.get('SSH_ORIGINAL_COMMAND')
    if original:
        return execute(original)
    if len(sys.argv) > 1:
        if len(sys.argv) != 3 or sys.argv[1] != '-c' or sys.argv[2] != '/usr/local/bin/bb-diagnostics-console':
            raise ValueError('Invalid SSH invocation')
    execute('help')
    while True:
        try: line = input('bb-logs> ').strip()
        except (EOFError, KeyboardInterrupt): return 0
        if line in ('exit','quit'): return 0
        try: execute(line)
        except (ValueError, KeyboardInterrupt): print('Denied: use help for supported queries.', file=sys.stderr)


if __name__ == '__main__':
    try: sys.exit(main())
    except ValueError:
        print('Denied: restricted diagnostic command.', file=sys.stderr); sys.exit(2)
