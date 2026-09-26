"""Render a bounded no-history draft JSON value as an editable DOCX.

This is a structural writer only. It does not select references, assess factual or
professional correctness, run delivery checks, or participate in production runtime.
Fact claim IDs are checked against the separately trusted allow-list and emitted as
explicit associations only; they are not evidence anchors or factual verification.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import unicodedata
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from docx import Document

REQUEST_SCHEMA_VERSION = "no-history-manuscript-draft-render-request-v1"
RESPONSE_SCHEMA_VERSION = "no-history-manuscript-draft-render-response-v1"
DRAFT_SCHEMA_VERSION = "no-history-manuscript-draft-v1"
WRITER_VERSION = "bondbuddy-no-history-draft-writer-1.1.0"
OUTPUT_NAME = "no-history-manuscript-draft.docx"
MAX_INPUT_BYTES = 2 * 1024 * 1024
MAX_SECTIONS = 100
MAX_FACT_CLAIMS = 500
MAX_FACT_IDS = 1000
MAX_OPEN_QUESTIONS = 100
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
FIXED_TIME = (2000, 1, 1, 0, 0, 0)
FIXED_CORE_TIME = datetime(2000, 1, 1, tzinfo=timezone.utc)


class DraftError(ValueError):
    """An input or output that violates this renderer's bounded contract."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _fail(code: str) -> None:
    raise DraftError(code)


def _exact_keys(value: dict[str, Any], keys: set[str], code: str) -> None:
    if set(value) != keys:
        _fail(code)


def _json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("JSON_DUPLICATE_KEY")
        result[key] = value
    return result


def _plain_text(value: Any, *, field: str, maximum: int, allow_newlines: bool) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum or not value.strip():
        _fail(f"{field.upper()}_INVALID")
    for char in value:
        if char == "\n" and allow_newlines:
            continue
        if unicodedata.category(char).startswith("C"):
            _fail("TEXT_CONTROL_CHARACTER_UNSUPPORTED")
    return value


def validate_request(value: Any) -> tuple[dict[str, Any], tuple[str, ...]]:
    if not isinstance(value, dict):
        _fail("REQUEST_SHAPE_INVALID")
    _exact_keys(value, {"schema_version", "draft", "allowed_target_fact_ids"}, "REQUEST_KEYS_INVALID")
    if value["schema_version"] != REQUEST_SCHEMA_VERSION:
        _fail("REQUEST_VERSION_UNSUPPORTED")

    allowed = value["allowed_target_fact_ids"]
    if not isinstance(allowed, list) or not allowed or len(allowed) > MAX_FACT_IDS:
        _fail("ALLOWED_FACT_IDS_INVALID")
    allowed_ids: list[str] = []
    allowed_set: set[str] = set()
    for fact_id in allowed:
        item = _plain_text(fact_id, field="fact_id", maximum=128, allow_newlines=False)
        if item in allowed_set:
            _fail("FACT_ID_DUPLICATE")
        allowed_ids.append(item)
        allowed_set.add(item)

    draft = value["draft"]
    if not isinstance(draft, dict):
        _fail("DRAFT_SHAPE_INVALID")
    _exact_keys(draft, {"schema_version", "sections", "fact_claims", "open_questions"}, "DRAFT_KEYS_INVALID")
    if draft["schema_version"] != DRAFT_SCHEMA_VERSION:
        _fail("DRAFT_VERSION_UNSUPPORTED")

    sections = draft["sections"]
    if not isinstance(sections, list) or not sections or len(sections) > MAX_SECTIONS:
        _fail("SECTIONS_INVALID")
    for section in sections:
        if not isinstance(section, dict):
            _fail("SECTION_SHAPE_INVALID")
        _exact_keys(section, {"heading", "body"}, "SECTION_KEYS_INVALID")
        _plain_text(section["heading"], field="heading", maximum=200, allow_newlines=False)
        _plain_text(section["body"], field="body", maximum=30000, allow_newlines=True)

    claims = draft["fact_claims"]
    if not isinstance(claims, list) or not claims or len(claims) > MAX_FACT_CLAIMS:
        _fail("FACT_CLAIMS_INVALID")
    seen_ids: set[str] = set()
    for claim in claims:
        if not isinstance(claim, dict):
            _fail("FACT_CLAIM_SHAPE_INVALID")
        _exact_keys(claim, {"claim", "target_fact_ids"}, "FACT_CLAIM_KEYS_INVALID")
        _plain_text(claim["claim"], field="claim", maximum=4000, allow_newlines=False)
        fact_ids = claim["target_fact_ids"]
        if not isinstance(fact_ids, list) or not fact_ids or len(fact_ids) > MAX_FACT_IDS:
            _fail("CLAIM_FACT_IDS_INVALID")
        for fact_id in fact_ids:
            if not isinstance(fact_id, str):
                _fail("FACT_ID_INVALID")
            if fact_id not in allowed_set:
                _fail("FACT_ID_NOT_ALLOWED")
            if fact_id in seen_ids:
                _fail("FACT_ID_DUPLICATE")
            seen_ids.add(fact_id)

    questions = draft["open_questions"]
    if not isinstance(questions, list) or len(questions) > MAX_OPEN_QUESTIONS:
        _fail("OPEN_QUESTIONS_INVALID")
    for question in questions:
        _plain_text(question, field="open_question", maximum=2000, allow_newlines=False)
    return draft, tuple(allowed_ids)


def _canonicalize_docx(path: Path) -> bytes:
    """Normalize ZIP ordering and metadata so identical input yields identical bytes."""
    with tempfile.NamedTemporaryFile(prefix="bb-no-history-zip-", suffix=".zip", dir=path.parent, delete=False) as temporary:
        canonical_path = Path(temporary.name)
    try:
        with zipfile.ZipFile(path, "r") as source, zipfile.ZipFile(canonical_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as target:
            for name in sorted(source.namelist()):
                info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 0
                info.external_attr = 0
                info.flag_bits = 0
                target.writestr(info, source.read(name), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        return canonical_path.read_bytes()
    finally:
        canonical_path.unlink(missing_ok=True)


def _locate_claims(draft: dict[str, Any]) -> dict[tuple[int, int], list[tuple[int, int, dict[str, Any]]]]:
    """Require each claim to occur once, verbatim, in one chapter paragraph."""
    locations: dict[tuple[int, int], list[tuple[int, int, dict[str, Any]]]] = {}
    claimed_spans: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for claim in draft["fact_claims"]:
        matches: list[tuple[int, int, int]] = []
        for section_index, section in enumerate(draft["sections"]):
            for paragraph_index, paragraph_text in enumerate(section["body"].split("\n")):
                search_from = 0
                while True:
                    start = paragraph_text.find(claim["claim"], search_from)
                    if start < 0:
                        break
                    matches.append((section_index, paragraph_index, start))
                    # Count overlapping occurrences too, so repeated or ambiguous text fails closed.
                    search_from = start + 1
        if len(matches) != 1:
            _fail("CLAIM_TEXT_NOT_UNIQUE_IN_BODY")
        section_index, paragraph_index, start = matches[0]
        end = start + len(claim["claim"])
        key = (section_index, paragraph_index)
        spans = claimed_spans.setdefault(key, [])
        if any(start < previous_end and previous_start < end for previous_start, previous_end in spans):
            _fail("CLAIM_TEXT_OVERLAP_AMBIGUOUS")
        spans.append((start, end))
        locations.setdefault(key, []).append((start, end, claim))
    for matches in locations.values():
        matches.sort(key=lambda item: item[0])
    return locations


def render(request: Any, output_dir: str | os.PathLike[str]) -> dict[str, Any]:
    """Render to one fixed filename in an existing private staging directory."""
    try:
        if len(json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_INPUT_BYTES:
            _fail("INPUT_SIZE_LIMIT_EXCEEDED")
    except DraftError:
        raise
    except (TypeError, ValueError, RecursionError):
        _fail("REQUEST_SHAPE_INVALID")
    draft, _ = validate_request(request)
    claim_locations = _locate_claims(draft)
    requested_directory = Path(output_dir)
    if not requested_directory.is_absolute() or ".." in requested_directory.parts or requested_directory.is_symlink() or not requested_directory.is_dir():
        _fail("OUTPUT_DIRECTORY_UNSAFE")
    # The absolute path is worker configuration, never request/model data. Resolve ancestor
    # symlinks once, then require the resulting existing stage to be private and worker-owned.
    directory = requested_directory.resolve(strict=True)
    if not directory.is_dir():
        _fail("OUTPUT_DIRECTORY_UNSAFE")
    if os.name == "posix":
        stage_stat = directory.stat()
        if stage_stat.st_uid != os.geteuid() or stage_stat.st_mode & 0o077:
            _fail("OUTPUT_DIRECTORY_UNSAFE")
    output_path = directory / OUTPUT_NAME
    if output_path.is_symlink() or output_path.exists():
        _fail("OUTPUT_PATH_UNSAFE")

    document = Document()
    document.core_properties.author = "BondBuddy"
    document.core_properties.title = "募集说明书工作稿"
    document.core_properties.subject = "无历史稿首稿"
    document.core_properties.created = FIXED_CORE_TIME
    document.core_properties.modified = FIXED_CORE_TIME
    document.core_properties.last_modified_by = "BondBuddy"

    for section_index, section in enumerate(draft["sections"]):
        document.add_heading(section["heading"], level=1)
        for paragraph_index, paragraph_text in enumerate(section["body"].split("\n")):
            paragraph = document.add_paragraph()
            cursor = 0
            for start, end, claim in claim_locations.get((section_index, paragraph_index), []):
                paragraph.add_run(paragraph_text[cursor:start])
                paragraph.add_run(paragraph_text[start:end])
                encoded_ids = json.dumps(claim["target_fact_ids"], ensure_ascii=False, separators=(",", ":"))
                paragraph.add_run(
                    f"【claim 关联 ID（非证据定位、非事实核验）：[[BB_FACT_IDS_V1:{encoded_ids}]]】"
                )
                cursor = end
            paragraph.add_run(paragraph_text[cursor:])

    if draft["open_questions"]:
        document.add_heading("待人工确认事项", level=1)
        for question in draft["open_questions"]:
            document.add_paragraph(f"【待人工确认：{question}】")

    with tempfile.NamedTemporaryFile(prefix="bb-no-history-", suffix=".docx", dir=directory, delete=False) as temporary:
        temp_path = Path(temporary.name)
    try:
        document.save(temp_path)
        canonical = _canonicalize_docx(temp_path)
        if not canonical or len(canonical) > MAX_OUTPUT_BYTES:
            _fail("OUTPUT_SIZE_INVALID")
        # Verify this generated package contains no tracked revision markup.
        with zipfile.ZipFile(temp_path, "r") as archive:
            for part in archive.namelist():
                if part.endswith(".xml") or part.endswith(".rels"):
                    root = ET.fromstring(archive.read(part))
                    if any(element.tag.rsplit("}", 1)[-1] in {"ins", "del", "moveFrom", "moveTo"} for element in root.iter()):
                        _fail("OUTPUT_REVISION_MARKUP_UNEXPECTED")
        temp_path.write_bytes(canonical)
        # A hard link is an atomic create-if-absent and does not follow an output symlink.
        try:
            os.link(temp_path, output_path)
        except FileExistsError:
            _fail("OUTPUT_PATH_UNSAFE")
    finally:
        temp_path.unlink(missing_ok=True)

    return {
        "schema_version": RESPONSE_SCHEMA_VERSION,
        "status": "rendered",
        "writer_version": WRITER_VERSION,
        "output_sha256": hashlib.sha256(canonical).hexdigest(),
        "output_size_bytes": len(canonical),
        "section_count": len(draft["sections"]),
        "fact_claim_count": len(draft["fact_claims"]),
        "pending_question_count": len(draft["open_questions"]),
    }


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            _fail("INPUT_SIZE_LIMIT_EXCEEDED")
        request = json.loads(raw.decode("utf-8"), object_pairs_hook=_json_object)
        output_dir = os.environ.get("BONDBUDDY_WORD_OUTPUT_DIR")
        if not output_dir:
            _fail("OUTPUT_DIRECTORY_REQUIRED")
        result = render(request, output_dir)
    except (DraftError, UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        code = error.code if isinstance(error, DraftError) else "INPUT_JSON_INVALID"
        print(json.dumps({"schema_version": RESPONSE_SCHEMA_VERSION, "status": "failed", "error_code": code}, ensure_ascii=False))
        return 2
    except Exception:
        print(json.dumps({"schema_version": RESPONSE_SCHEMA_VERSION, "status": "failed", "error_code": "RENDER_FAILED"}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
