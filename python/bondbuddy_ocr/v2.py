"""Algorithm-only OCR v2 processor.

The processor creates checkpoint-shaped values and their source images in memory.
It does not persist, authorize, or certify checkpoints; those are worker/storage jobs.
"""
from __future__ import annotations

import base64
from decimal import Decimal
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import tempfile

from PIL import Image, ImageOps, __version__ as pillow_version
import pypdfium2 as pdfium
from pypdf import PdfReader

from . import engine as v1

PROCESSOR_VERSION = "bondbuddy-ocr-2.0.1"
INVOCATION_SCHEMA = "ocr-invocation-v2"
INVOCATION_RESPONSE_SCHEMA = "ocr-invocation-response-v2"
MAX_SOURCE_BYTES = 100 * 1024 * 1024
MAX_IMAGE_BYTES = 48 * 1024 * 1024
MAX_BATCH_IMAGE_BYTES = 128 * 1024 * 1024

_ENGINE_CONFIG = {
    "line_psm": "3",
    "cell_psm": "6",
    "tesseract_config": ["tessedit_create_tsv=1"],
    "orientation": {"model": "osd", "minimum_confidence": 8, "rotations": [0, 90, 180, 270]},
    "table_recovery": {
        "algorithm": "closed-ruled-grid-v1", "luma_threshold": 140,
        "minimum_line_length_px": 40, "relative_line_length_divisor": 30,
        "line_merge_distance_px": 8, "maximum_segments": 1500,
        "maximum_cells_per_table": 2000, "cell_crop_inset_px": 6,
        "cell_crop_inset_strategy": "per-axis-positive-interior-v1",
        "recognition_padding_px": 16,
    },
    "numeric_parser": "explicit-decimal-unit-v1",
    "record_uncertainty": "needs-confirmation-v1",
    "word_confidence_warning_below": 0.90,
    "maximum_tsv_bytes": 8 * 1024 * 1024,
    "maximum_words_per_page": 10000,
}


class V2Failure(Exception):
    def __init__(self, code: str, *, retryable: bool = False, attempted: bool = False):
        super().__init__(code)
        self.code = code
        self.retryable = retryable
        self.attempted = attempted


def _number(value: int | float) -> str:
    """ECMAScript JSON.stringify number spelling for finite Python JSON numbers."""
    if isinstance(value, bool):
        raise TypeError("boolean is not a number")
    if isinstance(value, int):
        return str(value)
    if not math.isfinite(value):
        raise ValueError("non-finite JSON number")
    if value == 0:
        return "0"
    decimal = Decimal(repr(value))
    magnitude = abs(decimal)
    if Decimal("1e-6") <= magnitude < Decimal("1e21"):
        rendered = format(decimal, "f")
        if "." in rendered:
            rendered = rendered.rstrip("0").rstrip(".")
        return rendered
    mantissa, exponent = format(decimal.normalize(), "e").split("e")
    mantissa = mantissa.rstrip("0").rstrip(".")
    exponent_value = int(exponent)
    return f"{mantissa}e{'+' if exponent_value >= 0 else ''}{exponent_value}"


def canonical_json(value: object) -> str:
    """Match packages/contracts/src/ocr-v2.ts canonical() exactly."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return _number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise TypeError("JSON object keys must be strings")
        keys = sorted(value, key=lambda key: key.encode("utf-16-be", "surrogatepass"))
        return "{" + ",".join(
            canonical_json(key) + ":" + canonical_json(value[key]) for key in keys
        ) + "}"
    raise TypeError("value is not JSON serializable")


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _canonical_sha256(value: object) -> str:
    return _sha256(canonical_json(value).encode("utf-8"))


def page_identity_sha256(identity: dict) -> str:
    return _canonical_sha256({"schema_version": "ocr-page-identity-v2", "identity": identity})


def page_result_sha256(identity_sha: str, source_request_id: str, result: dict) -> str:
    return _canonical_sha256({
        "schema_version": "ocr-page-result-v2",
        "identity_sha256": identity_sha,
        "source_request_id": source_request_id,
        "result": result,
    })


def _valid_id(value: object) -> bool:
    return isinstance(value, str) and len(value) <= 128 and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]*", value) is not None


def _valid_version(value: object) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 100 and re.search(r"\S", value) is not None


def _run(args: list[str], timeout: int = 15) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(args, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as error:
        raise V2Failure("OCR_ENGINE_TIMEOUT", retryable=True, attempted=True) from error
    except OSError as error:
        raise V2Failure("OCR_ENGINE_UNAVAILABLE", retryable=True, attempted=False) from error


def _tesseract_runtime(language: str) -> tuple[str, dict[str, str]]:
    version_result = _run(["tesseract", "--version"], timeout=5)
    if version_result.returncode:
        raise V2Failure("OCR_ENGINE_UNAVAILABLE", retryable=True)
    version = version_result.stdout.decode("utf-8", errors="replace").splitlines()[0][:100]
    listing_result = _run(["tesseract", "--list-langs"], timeout=5)
    if listing_result.returncode:
        raise V2Failure("OCR_LANGUAGE_VERSION_UNAVAILABLE")
    listing = listing_result.stdout.decode("utf-8", errors="replace")
    available = set(listing.splitlines()[1:])
    languages = language.split("+")
    if any(item not in available for item in languages):
        raise V2Failure("OCR_LANGUAGE_UNAVAILABLE")
    data_directory_match = re.search(r'in "([^"]+)"', listing)
    if not data_directory_match:
        raise V2Failure("OCR_LANGUAGE_VERSION_UNAVAILABLE")
    data_directory = Path(data_directory_match[1])
    hashes = {}
    for item in languages + (["osd"] if "osd" in available and "osd" not in languages else []):
        traineddata = data_directory / f"{item}.traineddata"
        try:
            hashes[item] = _sha256(traineddata.read_bytes())
        except OSError as error:
            raise V2Failure("OCR_LANGUAGE_VERSION_UNAVAILABLE") from error
    return version, hashes


def _pdfium_version() -> str:
    # The loaded native PDFium version is part of the rendering identity.
    try:
        return str(pdfium.PDFIUM_INFO.version)
    except Exception as error:
        raise V2Failure("OCR_RENDERER_VERSION_UNAVAILABLE") from error


def _expected_parameter_hashes(document: dict, engine_version: str, language_hashes: dict[str, str]) -> tuple[str, str, str, str]:
    media_type = document["material"]["media_type"]
    rendering = document["rendering"]
    renderer = "pdfium" if media_type == "application/pdf" else "pillow"
    renderer_version = _pdfium_version() if renderer == "pdfium" else pillow_version
    engine_manifest = {
        "processor_version": PROCESSOR_VERSION,
        "engine": "tesseract",
        "engine_version": engine_version,
        "language": document["engine"]["language"],
        "language_data_sha256": language_hashes,
        "config": _ENGINE_CONFIG,
        "pillow_version": pillow_version,
        "numpy_version": v1.np.__version__,
    }
    rendering_manifest = {
        "renderer": renderer,
        "renderer_version": renderer_version,
        "dpi": rendering["dpi"],
        "max_page_pixels": rendering["max_page_pixels"],
        "config": {
            "pdf_scale": "dpi/72",
            "image_exif": "transpose-before-rgb-v1",
            "output": "rgb-png-v1",
            "orientation": _ENGINE_CONFIG["orientation"],
            "pillow_version": pillow_version,
        },
    }
    return renderer, renderer_version, _canonical_sha256(engine_manifest), _canonical_sha256(rendering_manifest)


def _validate_document_runtime(document: dict) -> tuple[str, dict[str, str]]:
    engine = document["engine"]
    media_type = document["material"]["media_type"]
    if document["processor_version"] != PROCESSOR_VERSION or engine["name"] != "tesseract":
        raise V2Failure("OCR_RUNTIME_IDENTITY_MISMATCH")
    if media_type not in {"application/pdf", "image/png", "image/jpeg"}:
        raise V2Failure("MATERIAL_FORMAT_UNSUPPORTED")
    if document["page_count"] < 1 or document["page_count"] > 1500:
        raise V2Failure("OCR_INPUT_LIMIT")
    if media_type != "application/pdf" and document["page_count"] != 1:
        raise V2Failure("OCR_RUNTIME_IDENTITY_MISMATCH")
    engine_version, language_hashes = _tesseract_runtime(engine["language"])
    renderer, renderer_version, engine_hash, rendering_hash = _expected_parameter_hashes(
        document, engine_version, language_hashes
    )
    rendering = document["rendering"]
    if (engine["version"] != engine_version or engine["language_data_sha256"] != language_hashes
            or engine["parameters_sha256"] != engine_hash or rendering["renderer"] != renderer
            or rendering["renderer_version"] != renderer_version
            or rendering["parameters_sha256"] != rendering_hash):
        raise V2Failure("OCR_RUNTIME_IDENTITY_MISMATCH")
    return engine_version, language_hashes


def probe_v2_identity(envelope: dict) -> dict:
    """Derive the immutable document identity from actual source bytes and installed tools."""
    if not isinstance(envelope, dict) or set(envelope) != {"schema_version", "material_path", "owner_user_id", "project_id", "material", "language"}:
        raise V2Failure("INVALID_OCR_INVOCATION")
    material = envelope["material"]
    if (envelope["schema_version"] != "ocr-identity-probe-v2"
            or not _valid_id(envelope["owner_user_id"]) or not _valid_id(envelope["project_id"])
            or not isinstance(material, dict) or set(material) != {"material_id", "material_version", "media_type", "sha256"}
            or not _valid_id(material["material_id"]) or type(material["material_version"]) is not int
            or material["material_version"] < 1 or material["media_type"] not in {"application/pdf", "image/png", "image/jpeg"}
            or not isinstance(material["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", material["sha256"])
            or envelope["language"] not in {"eng", "chi_sim+eng"}):
        raise V2Failure("INVALID_OCR_INVOCATION")
    path = Path(envelope["material_path"])
    if not path.is_absolute() or not path.is_file() or not 0 < path.stat().st_size <= MAX_SOURCE_BYTES:
        raise V2Failure("OCR_INPUT_LIMIT")
    if _sha256(path.read_bytes()) != material["sha256"]:
        raise V2Failure("OCR_SOURCE_HASH_MISMATCH")
    if material["media_type"] == "application/pdf":
        reader = PdfReader(path)
        if reader.is_encrypted:
            raise V2Failure("MATERIAL_ENCRYPTED")
        page_count = len(reader.pages)
        pdf = pdfium.PdfDocument(path)
        try:
            if len(pdf) != page_count:
                raise V2Failure("OCR_RUNTIME_IDENTITY_MISMATCH")
        finally:
            pdf.close()
    else:
        with Image.open(path) as image:
            if image.format != ("PNG" if material["media_type"] == "image/png" else "JPEG") or getattr(image, "n_frames", 1) != 1:
                raise V2Failure("MATERIAL_CONTENT_MISMATCH")
        page_count = 1
    if not 1 <= page_count <= 1500:
        raise V2Failure("OCR_INPUT_LIMIT")
    engine_version, language_hashes = _tesseract_runtime(envelope["language"])
    document = {
        "owner_user_id": envelope["owner_user_id"], "project_id": envelope["project_id"],
        "material": material, "page_count": page_count, "processor_version": PROCESSOR_VERSION,
        "engine": {"name": "tesseract", "version": engine_version, "language": envelope["language"],
                   "language_data_sha256": language_hashes, "parameters_sha256": ""},
        "rendering": {"renderer": "", "renderer_version": "", "dpi": 250,
                      "max_page_pixels": 20_000_000, "parameters_sha256": ""},
    }
    renderer, renderer_version, engine_hash, rendering_hash = _expected_parameter_hashes(document, engine_version, language_hashes)
    document["engine"]["parameters_sha256"] = engine_hash
    document["rendering"].update(renderer=renderer, renderer_version=renderer_version, parameters_sha256=rendering_hash)
    _validate_document_runtime(document)
    return {"schema_version": "ocr-identity-probe-response-v2", "document": document}


def _validate_request(request: dict) -> None:
    if set(request) != {"schema_version", "request_id", "document", "context", "pages", "reuse"}:
        raise V2Failure("INVALID_OCR_REQUEST")
    if (request.get("schema_version") != "ocr-request-v2"
            or not isinstance(request.get("request_id"), str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", request["request_id"])):
        raise V2Failure("INVALID_OCR_REQUEST")
    document = request.get("document")
    context = request.get("context")
    if not isinstance(document, dict) or not isinstance(context, dict):
        raise V2Failure("INVALID_OCR_REQUEST")
    if set(document) != {"owner_user_id", "project_id", "material", "page_count", "processor_version", "engine", "rendering"}:
        raise V2Failure("INVALID_OCR_REQUEST")
    material = document.get("material")
    engine = document.get("engine")
    rendering = document.get("rendering")
    page_count = document.get("page_count")
    if (not _valid_id(document.get("owner_user_id")) or not _valid_id(document.get("project_id"))
            or not _valid_version(document.get("processor_version"))
            or not isinstance(material, dict) or set(material) != {"material_id", "material_version", "media_type", "sha256"}
            or not _valid_id(material.get("material_id"))
            or not re.fullmatch(r"[a-f0-9]{64}", str(material.get("sha256", "")))
            or material.get("media_type") not in {"application/pdf", "image/png", "image/jpeg"}
            or type(material.get("material_version")) is not int or material["material_version"] < 1
            or type(page_count) is not int or page_count < 1 or page_count > 1500
            or not isinstance(engine, dict) or not isinstance(rendering, dict)
            or set(engine) != {"name", "version", "language", "language_data_sha256", "parameters_sha256"}
            or set(rendering) != {"renderer", "renderer_version", "dpi", "max_page_pixels", "parameters_sha256"}
            or not _valid_version(engine.get("name")) or not _valid_version(engine.get("version"))
            or not re.fullmatch(r"[a-z_]+(?:\+[a-z_]+)*", str(engine.get("language", "")))
            or not isinstance(engine.get("language_data_sha256"), dict) or not engine["language_data_sha256"]
            or any(not re.fullmatch(r"[a-z_]+", str(key)) or not re.fullmatch(r"[a-f0-9]{64}", str(value))
                   for key, value in engine["language_data_sha256"].items())
            or not re.fullmatch(r"[a-f0-9]{64}", str(engine.get("parameters_sha256", "")))
            or not _valid_version(rendering.get("renderer")) or not _valid_version(rendering.get("renderer_version"))
            or type(rendering.get("dpi")) is not int or not 1 <= rendering["dpi"] <= 1200
            or type(rendering.get("max_page_pixels")) is not int or not 1 <= rendering["max_page_pixels"] <= 20_000_000
            or not re.fullmatch(r"[a-f0-9]{64}", str(rendering.get("parameters_sha256", "")))):
        raise V2Failure("INVALID_OCR_REQUEST")
    languages = engine["language"].split("+")
    if len(languages) != len(set(languages)) or any(lang not in engine["language_data_sha256"] for lang in languages):
        raise V2Failure("INVALID_OCR_REQUEST")
    purpose = context.get("purpose")
    if (context.get("billable") is not False or context.get("cost_payer") != "platform"
            or purpose not in {"source_preflight", "full_ocr"}):
        raise V2Failure("INVALID_OCR_REQUEST")
    expected_context_keys = {"purpose", "run", "billable", "cost_payer"}
    if set(context) != expected_context_keys:
        raise V2Failure("INVALID_OCR_REQUEST")
    if material["media_type"] != "application/pdf" and page_count != 1:
        raise V2Failure("INVALID_OCR_REQUEST")
    if purpose == "source_preflight":
        if context.get("run") is not None:
            raise V2Failure("INVALID_OCR_REQUEST")
    else:
        run = context.get("run")
        if (not isinstance(run, dict) or set(run) != {"run_id", "execution_request_id", "input_revision", "input_hash"}
                or not _valid_id(run.get("run_id")) or not _valid_id(run.get("execution_request_id"))
                or type(run.get("input_revision")) is not int or run["input_revision"] < 1
                or not re.fullmatch(r"[a-f0-9]{64}", str(run.get("input_hash", "")))):
            raise V2Failure("OCR_EXECUTION_REQUIRED")
    pages = request.get("pages")
    if (not isinstance(pages, list) or not pages or len(pages) > 50
            or any(type(page) is not int or page < 1 or page > page_count for page in pages)
            or pages != sorted(set(pages))):
        raise V2Failure("INVALID_OCR_PAGE_SELECTION")
    if purpose == "source_preflight" and (len(pages) > 5 or any(page > 5 for page in pages)):
        raise V2Failure("OCR_PREFLIGHT_BUDGET_EXCEEDED")
    reuse = request.get("reuse")
    if (not isinstance(reuse, list) or len(reuse) > 50
            or any(not isinstance(ref, dict) or type(ref.get("page")) is not int or ref.get("page") not in pages for ref in reuse)
            or any(set(ref) != {"page", "identity_sha256", "result_sha256", "source_request_id"} for ref in reuse)
            or [ref["page"] for ref in reuse] != sorted({ref["page"] for ref in reuse})):
        raise V2Failure("INVALID_OCR_REUSE_REFERENCE")
    for ref in reuse:
        expected_identity = page_identity_sha256({"document": document, "page": ref["page"]})
        if (ref.get("identity_sha256") != expected_identity
                or not re.fullmatch(r"[a-f0-9]{64}", str(ref.get("result_sha256", "")))
                or not _valid_id(ref.get("source_request_id"))
                or ref["source_request_id"] == request["request_id"]):
            raise V2Failure("INVALID_OCR_REUSE_REFERENCE")


def _validate_checkpoint(checkpoint: dict, image_bytes: bytes, document: dict, page_number: int) -> None:
    identity = {"document": document, "page": page_number}
    result = checkpoint.get("result")
    if (checkpoint.get("schema_version") != "ocr-page-checkpoint-v2"
            or checkpoint.get("identity") != identity
            or checkpoint.get("identity_sha256") != page_identity_sha256(identity)
            or checkpoint.get("source_request_id") == ""):
        raise V2Failure("OCR_REUSE_MISMATCH")
    if not isinstance(result, dict) or result.get("status") != "needs_confirmation" or result.get("eligible_for_manuscript") is not False:
        raise V2Failure("OCR_REUSE_MISMATCH")
    page = result.get("page", {})
    if (page.get("page") != page_number or page.get("coordinate_system") != "rendered_pixels_top_left"
            or page.get("image_sha256") != _sha256(image_bytes)
            or not image_bytes.startswith(b"\x89PNG\r\n\x1a\n") or len(image_bytes) < 24
            or len(image_bytes) > MAX_IMAGE_BYTES):
        raise V2Failure("OCR_REUSE_MISMATCH")
    width = int.from_bytes(image_bytes[16:20], "big")
    height = int.from_bytes(image_bytes[20:24], "big")
    if (page.get("width") != width or page.get("height") != height
            or width * height > document["rendering"]["max_page_pixels"]):
        raise V2Failure("OCR_REUSE_MISMATCH")
    if checkpoint.get("result_sha256") != page_result_sha256(
        checkpoint["identity_sha256"], checkpoint["source_request_id"], result
    ):
        raise V2Failure("OCR_REUSE_MISMATCH")


def _failure(page: int, code: str, *, attempted: bool | None, retryable: bool) -> dict:
    return {"page": page, "status": "failed", "attempted": attempted,
            "retryable": retryable, "error": code, "warnings": []}


def process_v2(envelope: dict) -> dict:
    """Process one trusted local invocation and return response plus transient outputs.

    Envelope: {schema_version, request, material_path, reuse_checkpoints}. Reuse entries
    contain a previously read-back checkpoint and image_base64; no path is accepted from
    the immutable request itself. The caller remains responsible for ownership checks,
    persistence and read-back validation.
    """
    if not isinstance(envelope, dict) or envelope.get("schema_version") != INVOCATION_SCHEMA:
        raise V2Failure("INVALID_OCR_INVOCATION")
    request = envelope.get("request")
    if not isinstance(request, dict) or request.get("schema_version") != "ocr-request-v2":
        raise V2Failure("INVALID_OCR_REQUEST")
    _validate_request(request)
    document = request.get("document")
    context = request.get("context")
    pages = request.get("pages")
    reuse_refs = request.get("reuse")
    if not isinstance(document, dict) or not isinstance(context, dict) or not isinstance(pages, list) or not isinstance(reuse_refs, list):
        raise V2Failure("INVALID_OCR_REQUEST")
    page_count = document.get("page_count")
    if (not pages or len(pages) > 50 or len(set(pages)) != len(pages)
            or any(type(page) is not int or page < 1 or page > page_count for page in pages)
            or pages != sorted(pages)):
        raise V2Failure("INVALID_OCR_PAGE_SELECTION")
    if context.get("purpose") == "source_preflight" and (
            context.get("run") is not None or len(pages) > 5 or any(page > 5 for page in pages)):
        raise V2Failure("OCR_PREFLIGHT_BUDGET_EXCEEDED")
    if context.get("purpose") != "source_preflight" and context.get("purpose") != "full_ocr":
        raise V2Failure("INVALID_OCR_REQUEST")
    if context.get("billable") is not False or context.get("cost_payer") != "platform":
        raise V2Failure("INVALID_OCR_REQUEST")
    if context.get("purpose") == "full_ocr" and not isinstance(context.get("run"), dict):
        raise V2Failure("OCR_EXECUTION_REQUIRED")
    if request.get("request_id") is None or len(request.get("request_id", "")) > 128:
        raise V2Failure("INVALID_OCR_REQUEST")

    refs_by_page = {ref.get("page"): ref for ref in reuse_refs if isinstance(ref, dict)}
    reuse_inputs = envelope.get("reuse_checkpoints", [])
    if not isinstance(reuse_inputs, list):
        raise V2Failure("INVALID_OCR_REUSE_REFERENCE")
    reuse_by_page = {}
    for entry in reuse_inputs:
        checkpoint = entry.get("checkpoint") if isinstance(entry, dict) else None
        identity = checkpoint.get("identity") if isinstance(checkpoint, dict) else None
        page = identity.get("page") if isinstance(identity, dict) else None
        if type(page) is not int or page not in refs_by_page or page in reuse_by_page:
            raise V2Failure("INVALID_OCR_REUSE_REFERENCE")
        if not isinstance(entry.get("image_base64"), str):
            raise V2Failure("INVALID_OCR_REUSE_REFERENCE")
        reuse_by_page[page] = entry
    outcomes: dict[int, dict] = {}
    checkpoint_outputs: list[dict] = []
    for page in pages:
        ref = refs_by_page.get(page)
        if ref is None:
            continue
        supplied = reuse_by_page.get(page)
        if supplied is None:
            outcomes[page] = _failure(page, "OCR_REUSE_MISMATCH", attempted=False, retryable=False)
            continue
        try:
            checkpoint = supplied["checkpoint"]
            image_bytes = base64.b64decode(supplied["image_base64"], validate=True)
            _validate_checkpoint(checkpoint, image_bytes, document, page)
            if any(checkpoint.get(key) != ref.get(key) for key in ("source_request_id", "identity_sha256", "result_sha256")):
                raise V2Failure("OCR_REUSE_MISMATCH")
            if ref.get("source_request_id") == request["request_id"]:
                raise V2Failure("OCR_REUSE_MISMATCH")
            outcomes[page] = {"page": page, "status": "succeeded", "reused": True,
                              "checkpoint": {key: ref[key] for key in ("page", "identity_sha256", "result_sha256", "source_request_id")}}
        except (KeyError, ValueError, TypeError, V2Failure):
            outcomes[page] = _failure(page, "OCR_REUSE_MISMATCH", attempted=False, retryable=False)

    needs_engine = any(page not in outcomes for page in pages)
    source_path = Path(envelope.get("material_path", ""))
    pdf_document = None
    try:
        if needs_engine:
            if not source_path.is_absolute() or not source_path.is_file() or source_path.stat().st_size > MAX_SOURCE_BYTES:
                raise V2Failure("OCR_INPUT_LIMIT")
            material = document.get("material", {})
            if _sha256(source_path.read_bytes()) != material.get("sha256"):
                raise V2Failure("OCR_SOURCE_HASH_MISMATCH")
            _validate_document_runtime(document)
            media_type = material.get("media_type")
            if media_type == "application/pdf":
                reader = PdfReader(source_path)
                if reader.is_encrypted:
                    raise V2Failure("MATERIAL_ENCRYPTED")
                if len(reader.pages) != page_count:
                    raise V2Failure("OCR_RUNTIME_IDENTITY_MISMATCH")
                pdf_document = pdfium.PdfDocument(source_path)
                if len(pdf_document) != page_count:
                    raise V2Failure("OCR_RUNTIME_IDENTITY_MISMATCH")
            elif media_type in {"image/png", "image/jpeg"} and page_count == 1:
                pass
            else:
                raise V2Failure("MATERIAL_FORMAT_UNSUPPORTED")

            batch_image_bytes = 0
            with tempfile.TemporaryDirectory(prefix="bb-ocr-v2-") as directory:
                for page_number in pages:
                    if page_number in outcomes:
                        continue
                    attempt_tracker = {"attempted": False}
                    try:
                        if media_type == "application/pdf":
                            source_page = pdf_document[page_number - 1]
                            width_points, height_points = source_page.get_size()
                            dpi = document["rendering"]["dpi"]
                            width, height = round(width_points * dpi / 72), round(height_points * dpi / 72)
                            if (width < 1 or height < 1 or width > 20_000 or height > 20_000
                                    or width * height > document["rendering"]["max_page_pixels"]):
                                raise V2Failure("OCR_PIXEL_LIMIT")
                            bitmap = source_page.render(scale=dpi / 72)
                            image = bitmap.to_pil().convert("RGB")
                            bitmap.close()
                            source_page.close()
                            if (image.width > 20_000 or image.height > 20_000
                                    or image.width * image.height > document["rendering"]["max_page_pixels"]):
                                raise V2Failure("OCR_PIXEL_LIMIT")
                        else:
                            with Image.open(source_path) as original:
                                expected_format = "PNG" if media_type == "image/png" else "JPEG"
                                if original.format != expected_format or getattr(original, "n_frames", 1) != 1:
                                    raise V2Failure("MATERIAL_CONTENT_MISMATCH")
                                if (original.width > 20_000 or original.height > 20_000
                                        or original.width * original.height > document["rendering"]["max_page_pixels"]):
                                    raise V2Failure("OCR_PIXEL_LIMIT")
                                image = ImageOps.exif_transpose(original).convert("RGB")
                        page_data, records = v1.extract_page(
                            image, document["engine"]["language"], directory, page_number,
                            attempt_tracker=attempt_tracker,
                        )
                        # extract_page applies accepted OSD rotation before writing its PNG.
                        png = base64.b64decode(page_data["image_base64"], validate=True)
                        if len(png) > MAX_IMAGE_BYTES:
                            raise V2Failure("OCR_OUTPUT_LIMIT", attempted=True)
                        batch_image_bytes += len(png)
                        if batch_image_bytes > MAX_BATCH_IMAGE_BYTES:
                            raise V2Failure("OCR_OUTPUT_LIMIT", attempted=True)
                        result = {
                            "page": {key: value for key, value in page_data.items() if key != "image_base64"},
                            "records": records,
                            "status": "needs_confirmation",
                            "eligible_for_manuscript": False,
                        }
                        identity = {"document": document, "page": page_number}
                        identity_sha = page_identity_sha256(identity)
                        checkpoint = {
                            "schema_version": "ocr-page-checkpoint-v2",
                            "identity": identity,
                            "identity_sha256": identity_sha,
                            "source_request_id": request["request_id"],
                            "result_sha256": page_result_sha256(identity_sha, request["request_id"], result),
                            "result": result,
                        }
                        ref = {"page": page_number, "identity_sha256": identity_sha,
                               "result_sha256": checkpoint["result_sha256"],
                               "source_request_id": request["request_id"]}
                        outcomes[page_number] = {"page": page_number, "status": "succeeded",
                                                 "reused": False, "checkpoint": ref}
                        checkpoint_outputs.append({"checkpoint": checkpoint,
                                                   "image_base64": base64.b64encode(png).decode("ascii")})
                    except V2Failure as error:
                        outcomes[page_number] = _failure(
                            page_number, error.code,
                            attempted=True if error.attempted or attempt_tracker["attempted"] else False,
                            retryable=error.retryable,
                        )
                    except v1.Failure as error:
                        code = str(error)
                        outcomes[page_number] = _failure(
                            page_number, code,
                            attempted=attempt_tracker["attempted"],
                            retryable=code in {"OCR_ENGINE_TIMEOUT", "OCR_ENGINE_UNAVAILABLE", "OCR_ENGINE_FAILED"},
                        )
                    except Exception:
                        outcomes[page_number] = _failure(
                            page_number, "OCR_PAGE_FAILED",
                            attempted=attempt_tracker["attempted"],
                            retryable=False,
                        )
    except V2Failure as error:
        for page_number in pages:
            if page_number not in outcomes:
                outcomes[page_number] = _failure(page_number, error.code, attempted=False, retryable=error.retryable)
    except Exception:
        for page_number in pages:
            if page_number not in outcomes:
                outcomes[page_number] = _failure(page_number, "MATERIAL_UNREADABLE", attempted=False, retryable=False)
    finally:
        if pdf_document is not None:
            pdf_document.close()

    page_results = [outcomes[page] for page in pages]
    unknown_attempt = any(item["status"] == "failed" and item["attempted"] is None for item in page_results)
    attempted_pages = None if unknown_attempt else sum(
        1 for item in page_results if item["status"] == "failed" and item["attempted"] is True
    ) + sum(1 for item in page_results if item["status"] == "succeeded" and not item["reused"])
    response = {
        "schema_version": "ocr-response-v2",
        "request_id": request["request_id"],
        "document": document,
        "context": context,
        "page_results": page_results,
        "attempted_pages": attempted_pages,
        "coverage": "partial" if any(item["status"] == "succeeded" for item in page_results) else "none",
        "eligible_for_manuscript": False,
    }
    return {
        "schema_version": INVOCATION_RESPONSE_SCHEMA,
        "response": response,
        # These are transient algorithm outputs, not proof of durable checkpoints.
        "checkpoints": checkpoint_outputs,
    }
