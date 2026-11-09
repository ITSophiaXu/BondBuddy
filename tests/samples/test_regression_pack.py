"""Fail-closed checks for portable fixture integrity and offline preparation."""
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from regression_pack import prepare_case, verify_batch


class RegressionPackTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.batch = self.root / "batch"
        (self.batch / "originals/f1").mkdir(parents=True)
        (self.batch / "cases").mkdir()
        source = self.batch / "originals/f1/original.txt"
        source.write_bytes(b"immutable customer input\n")
        input_path = self.batch / "cases/example.json"
        input_path.write_text(json.dumps({"case_id": "case-one", "materials": [{"file_id": "file-one"}]}))
        self.manifest = {
            "manifest_version": 2, "authorization": {"git_commit_authorized": True},
            "file_count": 1, "total_bytes": source.stat().st_size,
            "assets": [{"file_id": "file-one", "path": "originals/f1/original.txt", "original_filename": "original.txt",
                        "sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "bytes": source.stat().st_size}],
            "cases": [{"case_id": "case-one", "title": "Example", "task_type": "update", "file_ids": ["file-one"],
                       "input_path": "cases/example.json", "checks": ["Check the delivered content"], "readiness": "inputs_ready"}],
            "metadata_files": [{"path": "cases/example.json", "sha256": hashlib.sha256(input_path.read_bytes()).hexdigest()}],
        }
        self.write_manifest()

    def tearDown(self):
        self.tmp.cleanup()

    def write_manifest(self):
        (self.batch / "manifest.json").write_text(json.dumps(self.manifest))

    def test_prepared_materials_keep_bytes_and_never_claim_business_pass(self):
        output = self.root / "run"
        receipt = prepare_case(self.batch, "case-one", output)
        self.assertEqual(receipt["business_test_status"], "not_run")
        self.assertEqual((output / "materials/file-one/original.txt").read_bytes(), b"immutable customer input\n")
        self.assertTrue((output / "RUN-RECORD.md").is_file())
        with self.assertRaisesRegex(ValueError, "already exists"):
            prepare_case(self.batch, "case-one", output)

    def test_tampered_original_or_input_is_rejected(self):
        path = self.batch / "originals/f1/original.txt"
        path.write_bytes(b"changed customer facts!\n")
        with self.assertRaisesRegex(ValueError, "size/hash"):
            verify_batch(self.batch)
        path.write_bytes(b"immutable customer input\n")
        (self.batch / "cases/example.json").write_text('{"case_id":"case-one","materials":[],"requirements":"changed"}')
        with self.assertRaisesRegex(ValueError, "Metadata checksum"):
            verify_batch(self.batch)

    def test_unresolved_file_and_missing_authorization_are_rejected(self):
        original = copy.deepcopy(self.manifest)
        self.manifest["cases"][0]["file_ids"] = ["missing-file"]
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "Unresolved"):
            verify_batch(self.batch)
        self.manifest = original
        self.manifest["authorization"]["git_commit_authorized"] = False
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "authorization"):
            verify_batch(self.batch)

    def test_paths_cannot_escape_and_transfer_secrets_are_rejected(self):
        self.manifest["assets"][0]["path"] = "../outside.txt"
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "escapes"):
            verify_batch(self.batch)
        self.manifest["assets"][0]["path"] = "originals/f1/original.txt"
        self.write_manifest()
        (self.batch / "leaked.json").write_text('{"url":"https://example.invalid/file?sig=temporary-secret"}')
        with self.assertRaisesRegex(ValueError, "Authentication"):
            verify_batch(self.batch)

    def test_incomplete_capture_cannot_be_prepared_as_complete_case(self):
        self.manifest["cases"][0]["preparable"] = False
        self.write_manifest()
        verify_batch(self.batch)
        with self.assertRaisesRegex(ValueError, "incomplete"):
            prepare_case(self.batch, "case-one", self.root / "run")
        self.assertFalse((self.root / "run").exists())

    def test_prepared_source_snapshot_remains_portable_and_hashed(self):
        snapshot = self.batch / "cases/source.json"
        snapshot.write_text('{"capture":"original saved input"}')
        input_path = self.batch / "cases/example.json"
        data = json.loads(input_path.read_text())
        data["source_snapshot"] = "cases/source.json"
        input_path.write_text(json.dumps(data))
        self.manifest["metadata_files"][0]["sha256"] = hashlib.sha256(input_path.read_bytes()).hexdigest()
        self.manifest["metadata_files"].append({"path": "cases/source.json", "sha256": hashlib.sha256(snapshot.read_bytes()).hexdigest()})
        self.write_manifest()
        output = self.root / "run"
        receipt = prepare_case(self.batch, "case-one", output)
        prepared = json.loads((output / "input.json").read_text())
        self.assertEqual((output / prepared["source_snapshot"]).read_bytes(), snapshot.read_bytes())
        self.assertEqual(receipt["source_input_sha256"], hashlib.sha256(input_path.read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()
