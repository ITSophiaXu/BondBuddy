import os
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from backend.runner import cli_environment, cli_path, cli_status


class CliEnvironmentTests(unittest.TestCase):
    def test_windows_uses_existing_profile_without_mutating_parent(self):
        with TemporaryDirectory() as tmp:
            configured=Path(tmp)/'.codex'; configured.mkdir()
            inherited={'USERPROFILE':tmp,'CUSTOM_SETTING':'preserved'}
            child=cli_environment(inherited,'nt')
            self.assertEqual(str(configured),child['CODEX_HOME'])
            self.assertNotIn('CODEX_HOME',inherited)
            self.assertEqual('preserved',child['CUSTOM_SETTING'])

    def test_inherited_codex_home_is_respected(self):
        inherited={'CODEX_HOME':'configured-by-user','USERPROFILE':'unused'}
        self.assertEqual(inherited,cli_environment(inherited,'nt'))

    def test_task_override_requires_existing_absolute_directory(self):
        with TemporaryDirectory() as tmp:
            self.assertEqual(tmp,cli_environment({'BOND_CODEX_HOME':tmp,'CODEX_HOME':'inherited'},'nt')['CODEX_HOME'])
        with self.assertRaises(ValueError):
            cli_environment({'BOND_CODEX_HOME':'relative/path'},'nt')

    def test_non_windows_environment_is_unchanged(self):
        with TemporaryDirectory() as tmp:
            (Path(tmp)/'.codex').mkdir()
            self.assertEqual({'USERPROFILE':tmp},cli_environment({'USERPROFILE':tmp},'posix'))

    def test_profile_fallback_does_not_create_a_new_directory(self):
        with TemporaryDirectory() as tmp:
            self.assertNotIn('CODEX_HOME',cli_environment({'USERPROFILE':tmp},'nt'))
            self.assertFalse((Path(tmp)/'.codex').exists())

    def test_login_check_receives_same_resolved_environment(self):
        child={'CODEX_HOME':'configured-directory'}
        run=subprocess.CompletedProcess([],0,stdout='Logged in',stderr='')
        with patch('backend.runner.cli_path',return_value='codex.exe'), patch('backend.runner.cli_environment',return_value=child), patch('backend.runner.subprocess.run',return_value=run) as invoked:
            self.assertTrue(cli_status()['ready'])
            self.assertEqual(child,invoked.call_args.kwargs['env'])

    def test_binary_discovery_does_not_need_os_home_when_localappdata_exists(self):
        with TemporaryDirectory() as tmp:
            folder=Path(tmp)/'OpenAI/Codex/bin/test'; folder.mkdir(parents=True)
            binary=folder/'codex.exe'; binary.touch()
            with patch.dict(os.environ,{'LOCALAPPDATA':tmp},clear=True), patch('backend.runner.shutil.which',return_value=None), patch('backend.runner.Path.home',side_effect=RuntimeError('No OS profile')):
                self.assertEqual(str(binary),cli_path())
