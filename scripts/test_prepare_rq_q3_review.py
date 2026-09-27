"""Synthetic guard tests; never read or print customer materials."""
import hashlib
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('prepare_rq_q3_review.py')
spec = importlib.util.spec_from_file_location('rq_review', SCRIPT)
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


class ReviewGuards(unittest.TestCase):
    def test_repository_and_other_worktree_outputs_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repo = base / 'repo'
            repo.mkdir()
            worktree = base / 'other-worktree'
            worktree.mkdir()
            (worktree / '.git').write_text('gitdir: synthetic', encoding='utf-8')
            other = base / 'other-repository'
            (other / '.git').mkdir(parents=True)
            for path in [repo / 'docs' / 'values.json', repo / '.hidden' / 'values.md',
                         worktree / 'output.json', other / 'nested' / 'output.md']:
                with self.subTest(path=path), self.assertRaises(ValueError):
                    review.validate_outputs(repo, [path])
                self.assertFalse(path.exists())
            outside = base / 'private-output' / 'values.json'
            self.assertEqual(review.validate_outputs(repo, [outside]), [outside.resolve()])
            with self.assertRaises(ValueError):
                review.validate_outputs(repo, [outside, outside.parent / '.' / outside.name])

    def test_symlink_alias_into_repository_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repo = base / 'repo'
            repo.mkdir()
            alias = base / 'alias'
            try:
                alias.symlink_to(repo, target_is_directory=True)
            except OSError:
                self.skipTest('Creating symlinks is not permitted on this host')
            with self.assertRaises(ValueError):
                review.validate_outputs(repo, [alias / 'values.json'])

    def test_source_verification_remains_enabled_under_python_optimization(self):
        code = '''import runpy,sys,hashlib
verify=runpy.run_path(sys.argv[1])['verify_source']
data=b'synthetic'
verify(data, {'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
for item in [{'bytes':len(data)+1,'sha256':hashlib.sha256(data).hexdigest()},
             {'bytes':len(data),'sha256':'0'*64}]:
    try: verify(data,item)
    except ValueError: pass
    else: raise RuntimeError('source verification bypassed')
'''
        result = subprocess.run([sys.executable, '-O', '-c', code, str(SCRIPT)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
