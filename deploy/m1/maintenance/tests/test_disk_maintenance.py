import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location('maintenance', Path(__file__).parents[1] / 'disk-maintenance.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.apt = self.root / 'apt'
        self.apt.mkdir()
        (self.apt / 'lock').touch()

    def tearDown(self):
        self.tmp.cleanup()

    def apt_policy(self):
        return {'apt_downloads': True, 'apt_directory': str(self.apt)}

    def image_policy(self):
        g = self.root / 'current'
        g.write_text('immutable-release')
        lock = self.root / 'deploy.lock'
        lock.touch()
        image = 'sha256:' + 'a' * 64
        return {'image_candidates': [{'id': image, 'labels': {'service': 'bondbuddy'}}],
                'protected_images': ['sha256:' + 'b' * 64],
                'deployment_locks': [str(lock)], 'protection_inventory_complete': True,
                'guards': [{'path': str(g), 'sha256': m.hashlib.sha256(g.read_bytes()).hexdigest()}]}

    def fake_docker(self, protected=False, fail=False, drift=False, new_ref=False, labels=True):
        self.calls = []
        self.inventory_reads = 0
        image = 'sha256:' + 'a' * 64
        container = 'c' * 64
        def run(cmd):
            self.calls.append(cmd)
            if fail:
                raise m.Retain('command_failed')
            if cmd[1:3] == ['container', 'ls']:
                self.inventory_reads += 1
                return container if protected or (new_ref and self.inventory_reads > 1) else ''
            if cmd[1:3] == ['container', 'inspect']:
                return json.dumps([{'Id': container, 'Image': image}])
            if cmd[1:3] == ['image', 'inspect']:
                if drift:
                    (self.root / 'current').write_text('other-release')
                return json.dumps([{'Id': image, 'Config': {'Labels': {'service': 'bondbuddy'} if labels else {}}, 'Size': 1}])
            return ''
        return run

    def test_dry_run_and_apply_are_idempotent(self):
        cached = self.apt / 'cached.deb'
        cached.write_bytes(b'cache')
        (self.apt / 'partial').mkdir()
        (self.apt / 'keep.txt').write_text('keep')
        m.Maintenance(self.apt_policy()).execute()
        self.assertTrue(cached.exists())
        m.Maintenance(self.apt_policy(), True).execute()
        self.assertFalse(cached.exists())
        self.assertTrue((self.apt / 'keep.txt').exists())
        self.assertEqual([], [e for e in m.Maintenance(self.apt_policy(), True).execute() if e['kind'] == 'apt_download'])

    def test_symlink_and_hardlink_targets_survive(self):
        target = self.root / 'protected'
        target.write_text('protected')
        (self.apt / 'link.deb').symlink_to(target)
        os.link(target, self.apt / 'hard.deb')
        m.Maintenance(self.apt_policy(), True).execute()
        self.assertEqual('protected', target.read_text())
        self.assertTrue((self.apt / 'link.deb').is_symlink())
        self.assertTrue((self.apt / 'hard.deb').exists())

    def test_symlink_ancestor_refuses_traversal(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.apt, target_is_directory=True)
        (self.apt / 'keep.deb').write_text('keep')
        policy = self.apt_policy()
        policy['apt_directory'] = str(alias)
        events = m.Maintenance(policy, True).execute()
        self.assertTrue((self.apt / 'keep.deb').exists())
        self.assertEqual('retained_safety_unavailable', events[0]['result'])

    def test_replaced_inode_refuses_delete(self):
        f = self.apt / 'entry.deb'
        f.write_text('first')
        old = f.stat()
        f.unlink()
        f.write_text('replacement')
        with m.directory(self.apt) as fd:
            with self.assertRaises(m.Retain):
                m.delete_entry(fd, f.name, old, True)
        self.assertEqual('replacement', f.read_text())

    def test_actual_posix_apt_lock_contention(self):
        (self.apt / 'keep.deb').write_text('keep')
        code = 'import fcntl,sys;f=open(sys.argv[1],"r+");fcntl.lockf(f,fcntl.LOCK_EX);print("ready",flush=True);sys.stdin.read()'
        p = subprocess.Popen([sys.executable, '-c', code, str(self.apt / 'lock')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual('ready', p.stdout.readline().strip())
            events = m.Maintenance(self.apt_policy(), True).execute()
            self.assertEqual('lock_busy', events[0]['reason'])
            self.assertTrue((self.apt / 'keep.deb').exists())
        finally:
            p.communicate('', timeout=2)

    def test_actual_flock_contention(self):
        lock = self.root / 'maintenance.lock'
        lock.touch()
        code = 'import fcntl,sys;f=open(sys.argv[1],"r+");fcntl.flock(f,fcntl.LOCK_EX);print("ready",flush=True);sys.stdin.read()'
        p = subprocess.Popen([sys.executable, '-c', code, str(lock)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual('ready', p.stdout.readline().strip())
            with self.assertRaisesRegex(m.Retain, 'lock_busy'):
                with m.locked(lock):
                    self.fail('must not enter')
        finally:
            p.communicate('', timeout=2)

    def test_stopped_or_running_container_image_is_protected(self):
        policy = self.image_policy()
        run = self.fake_docker(protected=True)
        events = m.Maintenance(policy, True, run).execute()
        self.assertEqual('retained_protected', events[-1]['result'])
        self.assertFalse(any(c[1:3] == ['image', 'rm'] for c in self.calls))

    def test_explicit_rollback_image_is_protected(self):
        policy = self.image_policy()
        policy['protected_images'].append(policy['image_candidates'][0]['id'])
        run = self.fake_docker()
        self.assertEqual('retained_protected', m.Maintenance(policy, True, run).execute()[-1]['result'])
        self.assertFalse(any(c[1:3] == ['image', 'rm'] for c in self.calls))

    def test_inventory_failure_retains_images(self):
        events = m.Maintenance(self.image_policy(), True, self.fake_docker(fail=True)).execute()
        self.assertEqual('retained_safety_unavailable', events[-1]['result'])
        self.assertFalse(any(c[1:3] == ['image', 'rm'] for c in self.calls))

    def test_unknown_ownership_retains(self):
        events = m.Maintenance(self.image_policy(), True, self.fake_docker(labels=False)).execute()
        self.assertEqual('retained_unverified_or_referenced', events[-1]['result'])
        self.assertFalse(any(c[1:3] == ['image', 'rm'] for c in self.calls))

    def test_release_drift_and_new_container_reference_retain(self):
        for kwargs in [{'drift': True}, {'new_ref': True}]:
            policy = self.image_policy()
            run = self.fake_docker(**kwargs)
            events = m.Maintenance(policy, True, run).execute()
            self.assertEqual('retained_unverified_or_referenced', events[-1]['result'])
            self.assertFalse(any(c[1:3] == ['image', 'rm'] for c in self.calls))

    def test_delete_is_exact_id_without_force_or_prune(self):
        policy = self.image_policy()
        run = self.fake_docker()
        events = m.Maintenance(policy, True, run).execute()
        self.assertEqual('deleted', events[-1]['result'])
        self.assertEqual(['docker', 'image', 'rm', policy['image_candidates'][0]['id']], self.calls[-1])

    def test_journal_real_entry_time_not_mtime_and_active_is_retained(self):
        root = self.root / 'journal'
        machine = root / ('a' * 32)
        machine.mkdir(parents=True)
        old = machine / 'system@aaaa-bbbb-cccc.journal'
        recent = machine / 'user-1000@aaaa-bbbb-cccc.journal'
        active = machine / 'system.journal'
        for f in [old, recent, active]:
            f.write_text('synthetic archive')
        def journal(cmd):
            if cmd[2] == str(old) and any(x.startswith('--since=') for x in cmd):
                return ''
            timestamp = time.time() - (31 if cmd[2] == str(old) else 1) * 86400
            return json.dumps({'__REALTIME_TIMESTAMP': str(int(timestamp * 1000000))})
        policy = {'archived_journal': True, 'journal_directory': str(root)}
        m.Maintenance(policy, True, journal).execute()
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())
        self.assertTrue(active.exists())

    def test_bad_journal_read_preserves_archive(self):
        root = self.root / 'journal'
        machine = root / ('a' * 32)
        machine.mkdir(parents=True)
        archive = machine / 'system@aaaa-bbbb.journal'
        archive.write_text('archive')
        def invalid(cmd):
            return '' if any(x.startswith('--since=') for x in cmd) else 'invalid'
        events = m.Maintenance({'archived_journal': True, 'journal_directory': str(root)}, True, invalid).execute()
        self.assertTrue(archive.exists())
        self.assertEqual('retained_unverified', events[-2]['result'])

    def test_recent_record_survives_even_with_old_last_timestamp(self):
        root = self.root / 'journal'
        machine = root / ('a' * 32)
        machine.mkdir(parents=True)
        archive = machine / 'system@aaaa-bbbb.journal'
        archive.write_text('clock correction fixture')
        calls = []
        def journal(cmd):
            calls.append(cmd)
            timestamp = time.time() - (1 if any(x.startswith('--since=') for x in cmd) else 31) * 86400
            return json.dumps({'__REALTIME_TIMESTAMP': str(int(timestamp * 1000000))})
        m.Maintenance({'archived_journal': True, 'journal_directory': str(root)}, True, journal).execute()
        self.assertTrue(archive.exists())
        self.assertEqual(1, len(calls))

    def test_deadline_escapes_resource_handlers(self):
        policy = self.image_policy()
        run = self.fake_docker()
        maintenance = m.Maintenance(policy, True, run)
        def expire():
            raise m.Deadline('overall_deadline')
        maintenance.apt = expire
        with self.assertRaises(m.Deadline):
            maintenance.execute()
        self.assertEqual([], self.calls)

    def test_directory_and_absence_guards_reject_new_pending(self):
        policy = self.image_policy()
        guard_root = self.root / 'releases'
        guard_root.mkdir()
        policy['guards'].append({'type': 'directory', 'path': str(guard_root), 'entries': []})
        policy['guards'].append({'type': 'absent', 'path': str(guard_root / 'pending.json')})
        m.Maintenance(policy).verify_guards()
        (guard_root / 'pending.json').write_text('new protected release')
        with self.assertRaises(m.Retain):
            m.Maintenance(policy).verify_guards()


if __name__ == '__main__':
    unittest.main()
