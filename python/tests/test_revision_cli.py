"""Synthetic accepted-finding revision tool and artifact-integrity tests."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from docx import Document
from bondbuddy_word_delivery.revision_cli import generate, request_for, sha, encoded


def fixture(root):
    for directory in ("materials", "scratch", "output"):
        (root / directory).mkdir()
    doc = Document()
    doc.add_paragraph("Net assets 100.")
    doc.add_paragraph("Summary net assets 100.")
    doc.add_paragraph("Unselected paragraph stays unchanged.")
    path = root / "materials/source.docx"
    doc.save(path)
    material = {"material_id": "source", "material_version": 1, "sha256": sha(path.read_bytes())}
    records = [{"record_id": f"r{i}", "literal_quote": p.text,
                "locator": {"path": [{"paragraph": i + 1}], "stable_ref": f"docx:p{i+1:04d}"}}
               for i, p in enumerate(doc.paragraphs)]
    finding = {"finding_id": "F-1", "repairability": {"allowed_record_ids": ["r0", "r1"]},
               "evidence_refs": [{"material_id": "audit", "record_id": "a0"}]}
    data = {"version": "review-revision-cli-v1", "input_hash": "a" * 64, "date": "2026-10-03T00:00:00.000Z",
            "source": {"path": "materials/source.docx", "media_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
            "revision": {"source_material": material, "source_report": {"report_id": "report"}, "accepted_plan": {"plan_id": "accepted-plan"},
                         "selected_findings": [finding], "excluded_findings": [{"finding_id": "F-2", "reason": "Explicitly excluded."}]},
            "records": records, "executable_finding_ids": ["F-1"], "limitations": []}
    proposal = {"version": data["version"], "input_hash": data["input_hash"], "reviewed": ["r0", "r1"],
                "edits": [{"record_id": "r0", "after": "Net assets 120.", "evidence": ["audit/a0"], "finding_ids": ["F-1"]},
                          {"record_id": "r1", "after": "Summary net assets 120.", "evidence": ["audit/a0"], "finding_ids": ["F-1"]}],
                "additions": [], "handling": [{"finding_id": "F-1", "status": "modified", "reason": "Corrected both accepted locations.", "evidence": ["audit/a0"]}],
                "summary": ["Synthetic revision."]}
    (root / "input.json").write_bytes(encoded(data))
    (root / "scratch/proposal.json").write_bytes(encoded(proposal))
    return data, proposal


class RevisionCliTest(unittest.TestCase):
    def test_cli_tool_produces_real_pair_and_complete_honest_handling(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            data, proposal = fixture(root)
            original = (root / "materials/source.docx").read_bytes()
            result = generate(root, "scratch/proposal.json")
            self.assertEqual(result["replacements"], 2)
            self.assertFalse(result["review_passed"])
            self.assertEqual(Document(root / "output/clean.docx").paragraphs[2].text, data["records"][2]["literal_quote"])
            self.assertEqual(Document(root / "output/clean.docx").paragraphs[0].text, "Net assets 120.")
            with ZipFile(root / "output/tracked.docx") as archive:
                self.assertIn(b"w:del", archive.read("word/document.xml"))
                self.assertIn(b"w:ins", archive.read("word/document.xml"))
            handling = json.loads((root / "output/handling.json").read_text())
            self.assertEqual([item["status"] for item in handling["items"]], ["modified", "not_modified"])
            self.assertEqual([loc["record_id"] for loc in handling["items"][0]["locations"]], ["r0", "r1"])
            self.assertEqual(original, (root / "materials/source.docx").read_bytes())
            before = {p.name: p.read_bytes() for p in (root / "output").iterdir()}
            generate(root, "scratch/proposal.json")
            self.assertEqual(before, {p.name: p.read_bytes() for p in (root / "output").iterdir()}, "trusted replay is byte deterministic")

    def test_outside_scope_foreign_evidence_and_invented_handling_are_rejected(self):
        with tempfile.TemporaryDirectory() as name:
            data, proposal = fixture(Path(name))
            mutations = [
                lambda p: p["edits"][0].update(record_id="r2"),
                lambda p: p["edits"][0].update(evidence=["other-project/secret"]),
                lambda p: p["edits"][0].update(evidence=["requirements"]),
                lambda p: p["edits"][0].update(finding_ids=["F-2"]),
                lambda p: p["handling"][0].update(status="not_modified"),
                lambda p: p["handling"][0].update(finding_id="invented"),
                lambda p: p.update(reviewed=["r0"]),
                lambda p: p.update(edits=[]),
            ]
            for mutate in mutations:
                modified = copy.deepcopy(proposal)
                mutate(modified)
                with self.subTest(proposal=modified), self.assertRaises(ValueError):
                    request_for(data, modified)

    def test_finding_can_only_cite_its_own_locked_evidence(self):
        with tempfile.TemporaryDirectory() as name:
            data, proposal = fixture(Path(name))
            other = copy.deepcopy(data["revision"]["selected_findings"][0])
            other.update(finding_id="F-3", evidence_refs=[{"material_id": "audit", "record_id": "a1"}])
            data["revision"]["selected_findings"].append(other)
            data["executable_finding_ids"].append("F-3")
            proposal["handling"].append({"finding_id": "F-3", "status": "needs_evidence", "reason": "Preserved.", "evidence": []})
            proposal["edits"][0]["evidence"] = ["audit/a1"]
            with self.assertRaises(ValueError):
                request_for(data, proposal)

    def test_no_changes_keeps_actual_explanation_without_inventing_word_delivery(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            data, proposal = fixture(root)
            proposal["edits"] = []
            proposal["handling"][0].update(status="needs_evidence", reason="Missing reliable period evidence.")
            (root / "scratch/proposal.json").write_bytes(encoded(proposal))
            result = generate(root, "scratch/proposal.json")
            self.assertTrue(result["no_changes"])
            self.assertFalse((root / "output/tracked.docx").exists())
            self.assertEqual(json.loads((root / "output/handling.json").read_text())["items"][0]["status"], "needs_evidence")

    def test_original_source_tamper_and_proposal_path_escape_are_rejected(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            fixture(root)
            with self.assertRaises(ValueError):
                generate(root, "../proposal.json")
            (root / "materials/source.docx").write_bytes(b"tampered source")
            with self.assertRaisesRegex(ValueError, "WORD_SOURCE_HASH_MISMATCH"):
                generate(root, "scratch/proposal.json")


if __name__ == "__main__":
    unittest.main()
