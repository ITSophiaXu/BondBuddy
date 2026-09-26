from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from docx import Document
from lxml import etree

from bondbuddy_no_history_word.writer import (
    DRAFT_SCHEMA_VERSION,
    OUTPUT_NAME,
    REQUEST_SCHEMA_VERSION,
    DraftError,
    render,
    validate_request,
)


def sample_request() -> dict:
    return {
        "schema_version": REQUEST_SCHEMA_VERSION,
        "allowed_target_fact_ids": ["target-fact-a", "target-fact-b"],
        "draft": {
            "schema_version": DRAFT_SCHEMA_VERSION,
            "sections": [
                {"heading": "第一章 发行人情况", "body": "发行人基本信息。\n发行人主营业务收入按已核验材料列示。"},
                {"heading": "第二章 财务情况", "body": "报告期财务数据来自本发行人材料。"},
            ],
            "fact_claims": [
                {"claim": "发行人主营业务收入按已核验材料列示。", "target_fact_ids": ["target-fact-a"]},
                {"claim": "报告期财务数据来自本发行人材料。", "target_fact_ids": ["target-fact-b"]},
            ],
            "open_questions": ["请补充本期发行期限。", "请确认募集资金用途明细。"],
        },
    }


class NoHistoryWordWriterTest(unittest.TestCase):
    def test_versioned_json_cli_returns_bounded_summary(self):
        with tempfile.TemporaryDirectory() as temp:
            env = os.environ.copy()
            env["BONDBUDDY_WORD_OUTPUT_DIR"] = temp
            python_path = str(Path(__file__).resolve().parents[1])
            env["PYTHONPATH"] = python_path + os.pathsep + env.get("PYTHONPATH", "")
            result = subprocess.run([sys.executable, "-m", "bondbuddy_no_history_word"], input=json.dumps(sample_request(), ensure_ascii=False),
                                    capture_output=True, text=True, env=env, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            response = json.loads(result.stdout)
            self.assertEqual(response["schema_version"], "no-history-manuscript-draft-render-response-v1")
            self.assertEqual(response["status"], "rendered")
            self.assertNotIn("path", response)
            self.assertTrue((Path(temp) / OUTPUT_NAME).is_file())

            duplicate = subprocess.run([sys.executable, "-m", "bondbuddy_no_history_word"],
                                       input='{"schema_version":"ignored","schema_version":"ignored"}',
                                       capture_output=True, text=True, env=env, check=False)
            self.assertEqual(duplicate.returncode, 2)
            self.assertEqual(json.loads(duplicate.stdout)["error_code"], "JSON_DUPLICATE_KEY")

    def test_readback_order_questions_and_no_revision_markup(self):
        with tempfile.TemporaryDirectory() as temp:
            result = render(sample_request(), temp)
            path = Path(temp) / OUTPUT_NAME
            self.assertTrue(path.is_file())
            self.assertEqual(result["output_sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
            self.assertEqual(result["section_count"], 2)
            self.assertEqual(result["fact_claim_count"], 2)
            self.assertEqual(result["pending_question_count"], 2)

            readback = Document(path)
            paragraphs = [paragraph.text for paragraph in readback.paragraphs]
            self.assertEqual(paragraphs, [
                "第一章 发行人情况", "发行人基本信息。",
                "发行人主营业务收入按已核验材料列示。【claim 关联 ID（非证据定位、非事实核验）：[[BB_FACT_IDS_V1:[\"target-fact-a\"]]]】",
                "第二章 财务情况",
                "报告期财务数据来自本发行人材料。【claim 关联 ID（非证据定位、非事实核验）：[[BB_FACT_IDS_V1:[\"target-fact-b\"]]]】",
                "待人工确认事项",
                "【待人工确认：请补充本期发行期限。】", "【待人工确认：请确认募集资金用途明细。】",
            ])
            with zipfile.ZipFile(path) as package:
                document_xml = etree.fromstring(package.read("word/document.xml"))
                ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
                xml_paragraphs = [
                    "".join(paragraph.xpath(".//w:t/text()", namespaces=ns))
                    for paragraph in document_xml.xpath("/w:document/w:body/w:p", namespaces=ns)
                ]
                self.assertIn(
                    "发行人主营业务收入按已核验材料列示。"
                    "【claim 关联 ID（非证据定位、非事实核验）：[[BB_FACT_IDS_V1:[\"target-fact-a\"]]]】",
                    xml_paragraphs,
                )
                self.assertIn(
                    "报告期财务数据来自本发行人材料。"
                    "【claim 关联 ID（非证据定位、非事实核验）：[[BB_FACT_IDS_V1:[\"target-fact-b\"]]]】",
                    xml_paragraphs,
                )
                xml_parts = [name for name in package.namelist() if name.endswith(".xml")]
                for part in xml_parts:
                    root = etree.fromstring(package.read(part))
                    names = {element.tag.rsplit("}", 1)[-1] for element in root.iter()}
                    self.assertTrue(names.isdisjoint({"ins", "del", "moveFrom", "moveTo"}), part)
            text = "\n".join(paragraph.text for paragraph in readback.paragraphs)
            self.assertIn("target-fact-a", text)
            self.assertIn("发行人主营业务收入按已核验材料列示。", text)
            self.assertNotIn("reference_id", text)

    def test_output_bytes_are_stable(self):
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            a = render(sample_request(), first)
            b = render(sample_request(), second)
            self.assertEqual(a["output_sha256"], b["output_sha256"])
            self.assertEqual((Path(first) / OUTPUT_NAME).read_bytes(), (Path(second) / OUTPUT_NAME).read_bytes())

    def test_fact_id_boundary_rejects_unknown_and_duplicates(self):
        for mutate, expected in (
            (lambda request: request["draft"]["fact_claims"][0].update(target_fact_ids=["foreign-fact"]), "FACT_ID_NOT_ALLOWED"),
            (lambda request: request["draft"]["fact_claims"][1].update(target_fact_ids=["target-fact-a"]), "FACT_ID_DUPLICATE"),
            (lambda request: request.update(allowed_target_fact_ids=["target-fact-a", "target-fact-a"]), "FACT_ID_DUPLICATE"),
        ):
            request = sample_request()
            mutate(request)
            with self.subTest(expected=expected), self.assertRaisesRegex(DraftError, expected):
                validate_request(request)

    def test_claims_must_be_unique_verbatim_chapter_text(self):
        cases = (
            (lambda request: request["draft"]["sections"][0].update(body="无关正文。"), "CLAIM_TEXT_NOT_UNIQUE_IN_BODY"),
            (lambda request: request["draft"]["sections"][0].update(
                body=request["draft"]["sections"][0]["body"] + "\n发行人主营业务收入按已核验材料列示。"
            ), "CLAIM_TEXT_NOT_UNIQUE_IN_BODY"),
        )
        for mutate, expected in cases:
            request = sample_request()
            mutate(request)
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as temp:
                with self.assertRaisesRegex(DraftError, expected):
                    render(request, temp)

    def test_overlapping_claim_text_is_rejected(self):
        request = sample_request()
        request["draft"]["sections"][0]["body"] = "这是合成主张文本。"
        request["draft"]["fact_claims"] = [
            {"claim": "合成主张文本", "target_fact_ids": ["target-fact-a"]},
            {"claim": "这是合成主张文本。", "target_fact_ids": ["target-fact-b"]},
        ]
        with tempfile.TemporaryDirectory() as temp, self.assertRaisesRegex(DraftError, "CLAIM_TEXT_OVERLAP_AMBIGUOUS"):
            render(request, temp)

    def test_rejects_unknown_keys_malformed_text_and_oversized_input(self):
        request = sample_request()
        request["output_path"] = "../../unsafe.docx"
        with self.assertRaisesRegex(DraftError, "REQUEST_KEYS_INVALID"):
            validate_request(request)

        request = sample_request()
        request["draft"]["sections"][0]["heading"] = "第一章\n恶意段落"
        with self.assertRaisesRegex(DraftError, "TEXT_CONTROL_CHARACTER_UNSUPPORTED"):
            validate_request(request)

        request = sample_request()
        request["draft"]["sections"][0]["body"] = "坏\x00内容"
        with self.assertRaisesRegex(DraftError, "TEXT_CONTROL_CHARACTER_UNSUPPORTED"):
            validate_request(request)

        request = sample_request()
        request["draft"]["sections"][0]["body"] = "x" * (2 * 1024 * 1024)
        with self.assertRaisesRegex(DraftError, "INPUT_SIZE_LIMIT_EXCEEDED"):
            render(request, tempfile.gettempdir())

    def test_rejects_existing_output_and_unsafe_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            render(sample_request(), temp)
            with self.assertRaisesRegex(DraftError, "OUTPUT_PATH_UNSAFE"):
                render(sample_request(), temp)
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "alias"
            target.symlink_to(Path(temp), target_is_directory=True)
            with self.assertRaisesRegex(DraftError, "OUTPUT_DIRECTORY_UNSAFE"):
                render(sample_request(), target)
            stage = Path(temp) / "stage"
            stage.mkdir(mode=0o700)
            alias_stage = target / "stage"
            result = render(sample_request(), alias_stage)
            self.assertTrue((stage / OUTPUT_NAME).is_file())
            self.assertEqual(result["output_sha256"], hashlib.sha256((stage / OUTPUT_NAME).read_bytes()).hexdigest())
        with self.assertRaisesRegex(DraftError, "OUTPUT_DIRECTORY_UNSAFE"):
            render(sample_request(), "../unsafe")
        with tempfile.TemporaryDirectory() as temp:
            os.chmod(temp, 0o755)
            with self.assertRaisesRegex(DraftError, "OUTPUT_DIRECTORY_UNSAFE"):
                render(sample_request(), temp)


if __name__ == "__main__":
    unittest.main()
