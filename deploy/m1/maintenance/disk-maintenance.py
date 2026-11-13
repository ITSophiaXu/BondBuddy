#!/usr/bin/env python3
"""Bounded, opt-in maintenance. Never prune containers, volumes or task data."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import time


class Retain(Exception):
    """An unavailable safety fact must retain the resource."""


class Deadline(Exception):
    """Must escape per-resource retention handlers and stop the whole invocation."""


def signature(s):
    return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_nlink)


@contextlib.contextmanager
def directory(path):
    """Open every component without following a symlink, including ancestors."""
    p = Path(path)
    if not p.is_absolute() or '..' in p.parts:
        raise Retain('invalid_directory')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in p.parts[1:]:
            new = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = new
        yield fd
    finally:
        os.close(fd)


def read_file(path):
    with directory(Path(path).parent) as parent:
        fd = os.open(Path(path).name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            s = os.fstat(fd)
            if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_size > 4 * 1024 * 1024:
                raise Retain('unsafe_file')
            with os.fdopen(os.dup(fd), 'rb') as f:
                data = f.read()
            if signature(os.fstat(fd)) != signature(s):
                raise Retain('file_changed')
            return data, s
        finally:
            os.close(fd)


@contextlib.contextmanager
def locked(path, posix=False, create=False):
    with directory(Path(path).parent) as parent:
        fd = os.open(Path(path).name, (os.O_RDWR if posix or create else os.O_RDONLY) | os.O_NOFOLLOW |
                     (os.O_CREAT if create else 0), 0o600, dir_fd=parent)
        try:
            s = os.fstat(fd)
            if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
                raise Retain('unsafe_lock')
            if create and s.st_uid != os.geteuid():
                raise Retain('foreign_maintenance_lock')
            lock = fcntl.lockf if posix else fcntl.flock
            try:
                lock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as e:
                raise Retain('lock_busy') from e
            yield
        finally:
            os.close(fd)


def run(argv):
    # Never include command output in an exception: stderr may contain private data.
    p = subprocess.run(argv, capture_output=True, text=True, timeout=12)
    if p.returncode:
        raise Retain('command_failed')
    return p.stdout


def delete_entry(fd, name, expected, apply):
    now = os.stat(name, dir_fd=fd, follow_symlinks=False)
    if not stat.S_ISREG(now.st_mode) or now.st_nlink != 1 or signature(now) != signature(expected):
        raise Retain('entry_changed')
    if apply:
        os.unlink(name, dir_fd=fd)


class Maintenance:
    def __init__(self, policy, apply=False, runner=run):
        self.p = policy
        self.apply = apply
        self.run = runner
        self.events = []

    def event(self, kind, result, **kw):
        self.events.append(dict(kind=kind, result=result, **kw))

    def apt(self):
        if not self.p.get('apt_downloads', False):
            return
        root = self.p.get('apt_directory', '/var/cache/apt/archives')
        with locked(str(Path(root) / 'lock'), posix=True):
            with directory(root) as fd:
                for name in sorted(os.listdir(fd)):
                    if not name.endswith('.deb'):
                        continue
                    try:
                        s = os.stat(name, dir_fd=fd, follow_symlinks=False)
                        delete_entry(fd, name, s, self.apply)
                        self.event('apt_download', 'deleted' if self.apply else 'candidate', bytes=s.st_size)
                    except (OSError, Retain):
                        self.event('apt_download', 'retained_unsafe_or_changed')

    def journal(self):
        days = self.p.get('journal_retention_days', 30)
        if not isinstance(days, int) or days < 30:
            raise Retain('journal_retention_too_short')
        if not self.p.get('archived_journal', False):
            return
        root = self.p.get('journal_directory', '/var/log/journal')
        cutoff = int((time.time() - days * 86400) * 1000000)
        with directory(root) as base:
            # Only machine-ID directories and journald archive names; no audit paths.
            for machine in os.listdir(base):
                if not re.fullmatch(r'[a-f0-9]{32}', machine):
                    continue
                try:
                    with directory(str(Path(root) / machine)) as fd:
                        for name in os.listdir(fd):
                            if not re.fullmatch(r'(system|user-[0-9]+)@[a-f0-9-]+\.journal', name):
                                continue
                            try:
                                s = os.stat(name, dir_fd=fd, follow_symlinks=False)
                                if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
                                    raise Retain('unsafe_archive')
                                txt = self.run(['journalctl', '--file', str(Path(root) / machine / name),
                                                '--reverse', '--lines=1', '--output=json',
                                                '--output-fields=__REALTIME_TIMESTAMP', '--no-pager'])
                                rows = [json.loads(x) for x in txt.splitlines() if x.strip()]
                                if len(rows) != 1 or int(rows[0]['__REALTIME_TIMESTAMP']) >= cutoff:
                                    self.event('journal_archive', 'retained_recent_or_empty')
                                    continue
                                delete_entry(fd, name, s, self.apply)
                                self.event('journal_archive', 'deleted' if self.apply else 'candidate', bytes=s.st_size)
                            except (OSError, Retain, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
                                self.event('journal_archive', 'retained_unverified')
                except OSError:
                    self.event('journal_archive', 'retained_unsafe_directory')

    def verify_guards(self):
        guards = self.p.get('guards', [])
        # Image deletion requires an explicit complete release protection snapshot.
        if not guards or not self.p.get('protection_inventory_complete', False):
            raise Retain('missing_release_protection')
        for g in guards:
            if g.get('type') == 'directory':
                with directory(g['path']) as fd:
                    if sorted(os.listdir(fd)) != sorted(g['entries']):
                        raise Retain('release_directory_drift')
            elif g.get('type') == 'absent':
                with directory(Path(g['path']).parent) as fd:
                    try:
                        os.stat(Path(g['path']).name, dir_fd=fd, follow_symlinks=False)
                    except FileNotFoundError:
                        continue
                    raise Retain('new_release_guard')
            else:
                data, _ = read_file(g['path'])
                if hashlib.sha256(data).hexdigest() != g['sha256']:
                    raise Retain('release_file_drift')

    def container_refs(self):
        ids = self.run(['docker', 'container', 'ls', '--all', '--quiet', '--no-trunc']).split()
        if any(not re.fullmatch(r'[a-f0-9]{64}', i) for i in ids):
            raise Retain('invalid_container_inventory')
        if not ids:
            return set()
        rows = json.loads(self.run(['docker', 'container', 'inspect', *ids]))
        if len(rows) != len(ids) or {r['Id'] for r in rows} != set(ids):
            raise Retain('incomplete_container_inventory')
        return {r['Image'] for r in rows}

    def images(self):
        candidates = self.p.get('image_candidates', [])
        if not candidates:
            self.event('images', 'disabled_no_reviewed_candidates')
            return
        locks = self.p.get('deployment_locks', [])
        if not locks:
            raise Retain('missing_deployment_locks')
        with contextlib.ExitStack() as stack:
            # Same order as deployment: config lock, then deploy lock.
            for path in locks:
                stack.enter_context(locked(path))
            self.verify_guards()
            refs = self.container_refs()
            protected = set(self.p.get('protected_images', []))
            if not protected:
                raise Retain('missing_protected_images')
            for candidate in candidates:
                image = candidate['id']
                if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
                    raise Retain('invalid_image_id')
                if image in refs or image in protected:
                    self.event('image', 'retained_protected', id=image)
                    continue
                # Inspect first; missing image is an idempotent retained result, never a force removal.
                try:
                    rows = json.loads(self.run(['docker', 'image', 'inspect', image]))
                    if len(rows) != 1 or rows[0]['Id'] != image:
                        raise Retain('image_identity_mismatch')
                    labels = rows[0].get('Config', {}).get('Labels') or {}
                    expected = candidate.get('labels', {})
                    if not expected or any(labels.get(k) != v for k, v in expected.items()):
                        raise Retain('unknown_image_ownership')
                    self.verify_guards()
                    if image in self.container_refs():
                        raise Retain('new_container_reference')
                    if self.apply:
                        # Docker itself refuses a new container reference; never --force.
                        self.run(['docker', 'image', 'rm', image])
                    self.event('image', 'deleted' if self.apply else 'candidate', id=image,
                               logical_bytes=rows[0].get('Size', 0))
                except (OSError, Retain, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
                    self.event('image', 'retained_unverified_or_referenced', id=image)

    def execute(self):
        for kind, action in [('apt', self.apt), ('journal', self.journal), ('images', self.images)]:
            try:
                action()
            except (OSError, Retain, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as e:
                self.event(kind, 'retained_safety_unavailable', reason=str(e) if isinstance(e, Retain) else type(e).__name__)
        return self.events


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--policy', required=True)
    parser.add_argument('--apply', action='store_true', help='Without this flag, only inspect candidates')
    args = parser.parse_args()
    report = {'schema': 'bondbuddy-disk-maintenance-v1', 'apply': args.apply, 'events': []}
    def expired(*_):
        raise Deadline('overall_deadline')
    signal.signal(signal.SIGALRM, expired)
    signal.alarm(100)
    try:
        data, s = read_file(args.policy)
        if s.st_uid != 0 or s.st_mode & 0o022:
            raise Retain('policy_not_root_owned_or_writable')
        policy = json.loads(data)
        report['policy_sha256'] = hashlib.sha256(data).hexdigest()
        before = {p: os.statvfs(p).f_bavail * os.statvfs(p).f_frsize for p in policy.get('space_paths', ['/'])}
        with locked(policy['maintenance_lock'], create=True):
            maintenance = Maintenance(policy, args.apply)
            report['events'] = maintenance.events
            maintenance.execute()
        after = {p: os.statvfs(p).f_bavail * os.statvfs(p).f_frsize for p in before}
        report.update(before_available_bytes=before, after_available_bytes=after,
                      net_available_change_bytes={p: after[p] - before[p] for p in before}, completed=True)
    except (OSError, Retain, Deadline, ValueError, KeyError, TypeError) as e:
        report.update(completed=False, retained=True,
                      reason=str(e) if isinstance(e, (Retain, Deadline)) else type(e).__name__)
    finally:
        signal.alarm(0)
    print(json.dumps(report, sort_keys=True))
    return 0 if report.get('completed') else 1


if __name__ == '__main__':
    raise SystemExit(main())
