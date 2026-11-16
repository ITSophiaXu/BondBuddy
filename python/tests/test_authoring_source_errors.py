"""Actual prepare CLI source-fault classification; synthetic files only."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from zipfile import ZIP_STORED, ZipFile

from bondbuddy_file_authoring.fixed_edit import prepare_source_manifest
from bondbuddy_file_authoring.template_manifest import sha


class AuthoringSourceErrors(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.docx'
        self.input = self.root / 'input.json'
        self.parts = {
            '[Content_Types].xml': b'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
            '_rels/.rels': b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
            'word/document.xml': b'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>SYNTHETIC source</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
        }
        self.write_package()

    def tearDown(self):
        self.temp.cleanup()

    def write_package(self, parts=None):
        with ZipFile(self.source, 'w', ZIP_STORED) as archive:
            for name, raw in (self.parts if parts is None else parts).items():
                archive.writestr(name, raw)

    def run_prepare(self, expected_hash=None, destination=None):
        self.input.write_text(json.dumps({
            'input_hash': 'a' * 64, 'revision_author': 'BondBuddy-synthetic',
            'baseline_path': 'source.docx', 'baseline_sha256': expected_hash or sha(self.source.read_bytes()),
        }), encoding='utf-8')
        return subprocess.run([sys.executable, '-B', '-s', '-m', 'bondbuddy_file_authoring.fixed_edit',
            'prepare', '--input', str(self.input), '--manifest', str(destination or self.root / 'manifest.json')],
            capture_output=True, encoding='utf-8', timeout=30)

    def assert_unreadable(self):
        result = self.run_prepare()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertEqual(json.loads(result.stderr), {'error': 'WORD_EDIT_SOURCE_UNREADABLE'})
        self.assertFalse((self.root / 'manifest.json').exists())

    def test_valid_source_produces_actual_manifest(self):
        result = self.run_prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((self.root / 'manifest.json').read_text(encoding='utf-8'))
        self.assertEqual(manifest['baseline_sha256'], sha(self.source.read_bytes()))
        self.assertEqual(manifest['nodes'][0]['text'], 'SYNTHETIC source')

    def test_truncated_zip_is_confirmed_unreadable(self):
        self.source.write_bytes(self.source.read_bytes()[:150])
        self.assert_unreadable()

    def test_not_a_zip_is_confirmed_unreadable(self):
        self.source.write_bytes(b'SYNTHETIC mislabeled data')
        self.assert_unreadable()

    def test_encrypted_office_source_has_specific_error(self):
        raw = bytearray(1536)
        raw[:8] = bytes.fromhex('d0cf11e0a1b11ae1')
        raw[28:32] = b'\xfe\xff\x09\x00'
        for offset, name in [(512, 'EncryptionInfo'), (640, 'EncryptedPackage')]:
            marker = (name + '\0').encode('utf-16le')
            raw[offset:offset + len(marker)] = marker
            raw[offset + 64:offset + 66] = len(marker).to_bytes(2, 'little')
            raw[offset + 66] = 2
        self.source.write_bytes(raw)
        result = self.run_prepare()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stderr), {'error': 'WORD_EDIT_SOURCE_ENCRYPTED'})
        self.assertFalse((self.root / 'manifest.json').exists())
        # A pinned-input integrity failure remains authoritative, even for encryption.
        mismatch = self.run_prepare(expected_hash='b' * 64)
        self.assertEqual(json.loads(mismatch.stderr), {'error': 'WORD_EDIT_SOURCE_HASH_MISMATCH'})
        # Rights-managed packages may use DataSpaces rather than EncryptionInfo.
        raw[578] = 0
        self.source.write_bytes(raw)
        self.assertEqual(json.loads(self.run_prepare().stderr), {'error': 'WORD_EDIT_SOURCE_ENCRYPTED'})
        # Names alone in ordinary legacy content are not encryption stream records.
        raw[706] = 0
        self.source.write_bytes(raw)
        self.assert_unreadable()

    def test_missing_required_parts_are_confirmed_unreadable(self):
        for name in self.parts:
            with self.subTest(missing=name):
                self.write_package({key: value for key, value in self.parts.items() if key != name})
                self.assert_unreadable()

    def test_malformed_document_or_auxiliary_xml_is_confirmed_unreadable(self):
        for name in ['word/document.xml', 'word/styles.xml']:
            with self.subTest(part=name):
                self.write_package({**self.parts, name: b'<w:document'})
                self.assert_unreadable()

    def test_bad_crc_is_confirmed_unreadable(self):
        raw = self.source.read_bytes()
        self.source.write_bytes(raw.replace(b'SYNTHETIC source', b'SYNTHETIC broken', 1))
        self.assert_unreadable()

    def test_unsafe_xml_is_confirmed_unreadable(self):
        self.write_package({**self.parts, 'word/styles.xml': b'<!DOCTYPE x [<!ENTITY y "synthetic">]><x/>'})
        self.assert_unreadable()

    def test_unsafe_member_path_is_confirmed_unreadable(self):
        self.write_package({**self.parts, '../synthetic.xml': b'<x/>'})
        self.assert_unreadable()

    def test_hash_mismatch_keeps_input_integrity_error(self):
        result = self.run_prepare(expected_hash='b' * 64)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stderr), {'error': 'WORD_EDIT_SOURCE_HASH_MISMATCH'})

    def test_manifest_write_failure_does_not_blame_the_source(self):
        result = self.run_prepare(destination=self.root / 'missing' / 'manifest.json')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stderr), {'error': 'WORD_EDIT_FAILED'})

    def test_io_and_unexpected_manifest_failures_are_not_reclassified(self):
        for error in [PermissionError('synthetic read denied'), FileNotFoundError('synthetic absent'),
                      TypeError('synthetic manifest bug'), ValueError('synthetic other data')]:
            with self.subTest(error=type(error).__name__):
                with patch('bondbuddy_file_authoring.fixed_edit.build_manifest', side_effect=error):
                    with self.assertRaises(type(error)) as raised:
                        prepare_source_manifest(self.source)
                    self.assertIs(raised.exception, error)


if __name__ == '__main__':
    unittest.main()
