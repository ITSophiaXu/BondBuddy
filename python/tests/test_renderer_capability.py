"""Renderer infrastructure regressions; synthetic documents, no provider calls."""
import tempfile
import io
import os
import signal
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from bondbuddy_file_authoring import document_size


class RendererInfrastructureTests(unittest.TestCase):
    @unittest.skipUnless(os.name == 'posix', 'Production renderer uses Linux process groups')
    def test_cancelled_probe_terminates_native_renderer(self):
        with tempfile.TemporaryDirectory(prefix='bb-renderer-cancel-') as name:
            root = Path(name)
            marker = root / 'native.pid'
            executable = root / 'fake-renderer'
            executable.write_text('#!/usr/bin/env python3\nimport os,time\n'
                                  f'with open({str(marker)!r},"w") as f:f.write(str(os.getpid()))\n'
                                  'time.sleep(30)\n', encoding='utf-8')
            executable.chmod(0o700)
            process = subprocess.Popen([sys.executable, '-B', '-m', 'bondbuddy_file_authoring.document_size'],
                                       env={**os.environ, 'BONDBUDDY_WORD_LIBREOFFICE': str(executable)},
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            native_pid = None
            try:
                deadline = time.monotonic() + 10
                while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertTrue(marker.exists(), 'Probe must reach the native renderer')
                native_pid = int(marker.read_text())
                process.send_signal(signal.SIGTERM)
                stdout, _ = process.communicate(timeout=10)
                self.assertNotEqual(process.returncode, 0)
                self.assertIn(b'render_cancelled', stdout)
                with self.assertRaises(ProcessLookupError):
                    os.kill(native_pid, 0)
                native_pid = None
            finally:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=10)
                if native_pid is not None:
                    try:
                        os.killpg(native_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_native_stderr_retention_is_bounded_even_when_process_is_noisy(self):
        capture = document_size._RendererStderr(io.BytesIO(b'x' * (2 * 1024 * 1024)))
        diagnostic = capture.diagnostic(1)
        self.assertEqual(diagnostic['stderr_bytes'], 2 * 1024 * 1024)
        self.assertTrue(diagnostic['stderr_truncated'])
        self.assertLessEqual(len(capture.tail), 4096)

    def test_native_stderr_is_classified_without_returning_arbitrary_content(self):
        class RestrictedRenderer:
            pid = 123
            stderr = io.BytesIO(b'synthetic-private-text: /proc access denied')

            def wait(self, timeout=None):
                return 1

        with tempfile.TemporaryDirectory() as name, patch.object(
                document_size.subprocess, 'Popen', return_value=RestrictedRenderer()):
            with self.assertRaises(document_size.PageCountError) as caught:
                document_size.render_pages({}, Path(name), 'synthetic', '/synthetic/libreoffice')
        self.assertEqual(caught.exception.diagnostic['stderr_category'], 'proc_access_denied')
        self.assertEqual(caught.exception.diagnostic['exit_code'], 1)
        self.assertNotIn('private-text', repr(caught.exception.diagnostic))

    def test_native_failure_is_not_reported_as_invalid_document(self):
        class FailedRenderer:
            pid = 123
            stderr = None

            def wait(self, timeout=None):
                return 1

        with tempfile.TemporaryDirectory() as name, patch.object(
                document_size.subprocess, 'Popen', return_value=FailedRenderer()):
            with self.assertRaises(document_size.PageCountError) as caught:
                document_size.render_pages({}, Path(name), 'synthetic', '/synthetic/libreoffice')
        self.assertEqual(str(caught.exception), 'renderer_process_failed')

    def test_host_capability_checks_actual_render_output(self):
        probe = getattr(document_size, 'probe_renderer', None)
        self.assertTrue(callable(probe), 'Host renderer capability must be tested before a model call')
        with patch.object(document_size.shutil, 'which', return_value='/synthetic/libreoffice'), \
                patch.object(document_size, 'render_pages', return_value={'pages': 1}) as render:
            result = probe()
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['pages'], 1)
        render.assert_called_once()

    def test_host_capability_never_accepts_missing_renderer(self):
        probe = getattr(document_size, 'probe_renderer', None)
        self.assertTrue(callable(probe), 'Missing renderer must be found before provider intent')
        with patch.dict('os.environ', {'BONDBUDDY_WORD_LIBREOFFICE': ''}), \
                patch.object(document_size.shutil, 'which', return_value=None):
            result = probe()
        self.assertEqual(result['status'], 'unavailable')
        self.assertEqual(result['reason'], 'renderer_missing')

    def test_short_sources_do_not_gain_a_renderer_requirement(self):
        probe = getattr(document_size, 'probe_renderer', None)
        self.assertTrue(callable(probe))
        with patch.object(document_size, 'package', return_value={
                'word/document.xml': b'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>'}), \
                patch.object(document_size, 'render_pages') as render:
            result = probe(source='synthetic.docx')
        self.assertEqual(result['status'], 'not_required')
        render.assert_not_called()


if __name__ == '__main__':
    unittest.main()
