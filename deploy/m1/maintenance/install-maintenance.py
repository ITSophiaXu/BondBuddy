#!/usr/bin/env python3
"""Install only maintenance assets; retain byte-for-byte previous versions."""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess

HERE = Path(__file__).absolute().parent
spec = importlib.util.spec_from_file_location('maintenance', HERE / 'disk-maintenance.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def command(*args):
    p = subprocess.run(args, capture_output=True, timeout=20)
    if p.returncode:
        raise m.Retain('systemctl_failed')


def mkdir(path):
    with m.directory(Path(path).parent) as fd:
        try:
            os.mkdir(Path(path).name, 0o700, dir_fd=fd)
        except FileExistsError:
            pass
    with m.directory(path) as fd:
        s = os.fstat(fd)
        if s.st_uid != 0 or s.st_mode & 0o022:
            raise m.Retain('unsafe_install_directory')


def write(path, data, mode):
    with m.directory(Path(path).parent) as fd:
        name = Path(path).name
        temp = name + '.new-' + str(os.getpid())
        out = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=fd)
        try:
            with os.fdopen(out, 'wb') as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.rename(temp, name, src_dir_fd=fd, dst_dir_fd=fd)
            os.fsync(fd)
        finally:
            try:
                os.unlink(temp, dir_fd=fd)
            except FileNotFoundError:
                pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--policy')
    parser.add_argument('--disable', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise m.Retain('root_required')
    if args.disable:
        # Stop future scheduling even while the service holds its execution lock.
        # Stopping the timer does not stop the already running service.
        command('systemctl', 'disable', '--now', 'bondbuddy-disk-maintenance.timer')
        print(json.dumps({'disabled': True, 'business_services_changed': False}))
        return
    with m.locked('/run/lock/bondbuddy-disk-maintenance.lock', create=True):
        if not args.policy:
            parser.error('--policy is required to install')
        policy, s = m.read_file(args.policy)
        if s.st_uid != 0 or s.st_mode & 0o022:
            raise m.Retain('unsafe_policy_source')
        parsed = json.loads(policy)
        if parsed['maintenance_lock'] != '/run/lock/bondbuddy-disk-maintenance.lock':
            raise m.Retain('unexpected_maintenance_lock')
        for p in ['/usr/local/lib/bondbuddy-maintenance', '/etc/bondbuddy-maintenance',
                  '/var/lib/bondbuddy-maintenance', '/var/lib/bondbuddy-maintenance/install-backups']:
            mkdir(p)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        backup = Path('/var/lib/bondbuddy-maintenance/install-backups') / stamp
        mkdir(backup)
        assets = [('/usr/local/lib/bondbuddy-maintenance/disk-maintenance.py',
                   m.read_file(HERE / 'disk-maintenance.py')[0], 0o755),
                  ('/etc/bondbuddy-maintenance/policy.json', policy, 0o600)]
        for name in ['bondbuddy-disk-maintenance.service', 'bondbuddy-disk-maintenance.timer']:
            assets.append(('/etc/systemd/system/' + name, m.read_file(HERE / name)[0], 0o644))
        old = []
        for path, data, mode in assets:
            try:
                before, s = m.read_file(path)
                if s.st_uid != 0 or s.st_mode & 0o022:
                    raise m.Retain('unsafe_existing_asset')
                write(backup / Path(path).name, before, stat.S_IMODE(s.st_mode))
                old.append({'path': path, 'sha256': hashlib.sha256(before).hexdigest(),
                            'mode': stat.S_IMODE(s.st_mode), 'existed': True})
            except FileNotFoundError:
                old.append({'path': path, 'existed': False})
        write(backup / 'before.json', (json.dumps(old, indent=2) + '\n').encode(), 0o600)
        command('systemd-analyze', 'verify', str(HERE / 'bondbuddy-disk-maintenance.service'),
                str(HERE / 'bondbuddy-disk-maintenance.timer'))
        for path, data, mode in assets:
            write(path, data, mode)
        command('systemctl', 'daemon-reload')
        command('systemctl', 'enable', '--now', 'bondbuddy-disk-maintenance.timer')
        print(json.dumps({'installed': True, 'backup': str(backup),
                          'assets': [{'path': path, 'sha256': hashlib.sha256(data).hexdigest()} for path, data, _ in assets],
                          'business_services_changed': False}))


if __name__ == '__main__':
    main()
