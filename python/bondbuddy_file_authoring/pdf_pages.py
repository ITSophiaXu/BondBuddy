"""Read/search bounded PDF page evidence; OCR is local and only runs for a requested page.

Run inside the authoring workspace. Cache files are reusable input data, not an
approval of OCR values or proof that the entire document has been reviewed.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import stat
import tempfile

import pdfplumber

VERSION = "pdf-pages-v2"
MAX_SOURCE_BYTES = 100 * 1024 * 1024
MAX_CACHE_BYTES = 16 * 1024 * 1024
MAX_IMAGE_BYTES = 48 * 1024 * 1024
# Recovery contexts cap shell tool output at 2048 tokens. Leave space for the
# CLI's output wrapper so the complete JSON and continuation cursor survive.
MAX_REPLY_BYTES = 6 * 1024
MAX_PAGES = 1500
MAX_RECORDS = 10000
FRAGMENT_CHARS = 1000


class PdfPageError(ValueError):
    pass


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def regular(path, maximum):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > maximum or info.st_nlink != 1:
        raise PdfPageError("PDF_FILE_UNSAFE_OR_TOO_LARGE")
    return info


def safe_directory(path):
    path = Path(os.path.abspath(path))
    for parent in reversed([path, *path.parents]):
        if parent.exists() or parent.is_symlink():
            if parent.is_symlink() or not parent.is_dir():
                raise PdfPageError("PDF_CACHE_PATH_UNSAFE")
        else:
            parent.mkdir(mode=0o700)
    return path


def atomic_write(path, data):
    safe_directory(path.parent)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".page-", delete=False) as handle:
        temporary = Path(handle.name)
        try:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def ocr_runtime_identity(language):
    # Reuse the production engine's version and language-data identities, so a
    # stale cache cannot survive a different OCR engine or traineddata file.
    from bondbuddy_ocr import engine
    from bondbuddy_ocr.v2 import _pdfium_version, _tesseract_runtime
    version, languages = _tesseract_runtime(language)
    return {"processor": engine.VERSION, "tesseract": version, "languages": languages,
            "language": language, "pdfium": _pdfium_version(), "pillow": importlib.metadata.version("Pillow"),
            "dpi": 250, "max_pixels": engine.MAX_PIXELS}


def render_ocr_page(source, page_number, language):
    import pypdfium2 as pdfium
    from bondbuddy_ocr.engine import MAX_PIXELS, extract_page
    document = pdfium.PdfDocument(source)
    try:
        page = document[page_number - 1]
        try:
            width, height = page.get_size()
            if width <= 0 or height <= 0 or width * height * (250 / 72) ** 2 > MAX_PIXELS:
                raise PdfPageError("PDF_PAGE_PIXEL_LIMIT")
            bitmap = page.render(scale=250 / 72)
            try:
                image = bitmap.to_pil().convert("RGB")
            finally:
                bitmap.close()
        finally:
            page.close()
        try:
            with tempfile.TemporaryDirectory(prefix="bb-pdf-page-ocr-") as temporary:
                metadata, records = extract_page(image, language, temporary, page_number)
        finally:
            image.close()
    finally:
        document.close()
    # Validate the full-resolution image then discard it. Keeping one PNG per
    # scanned page would exhaust the authoring workspace snapshot budget.
    pixels = base64.b64decode(metadata.pop("image_base64"), validate=True)
    if not pixels or len(pixels) > MAX_IMAGE_BYTES or hashlib.sha256(pixels).hexdigest() != metadata["image_sha256"]:
        raise PdfPageError("PDF_OCR_IMAGE_INVALID")
    return metadata, records


def fragments(records):
    result = []
    for record in records:
        text = record["text"]
        count = max(1, math.ceil(len(text) / FRAGMENT_CHARS))
        for part in range(count):
            result.append({**record, "text": text[part * FRAGMENT_CHARS:(part + 1) * FRAGMENT_CHARS],
                           "text_offset": part * FRAGMENT_CHARS, "text_total_chars": len(text),
                           "fragment_index": part, "fragment_count": count})
    return result


def validate_page(data, page, mode):
    allowed = {"page", "mode", "coordinate_system", "width", "height", "image_count", "warnings", "records",
               "rotation_clockwise", "image_sha256", "rendering"}
    record_keys = {"record_id", "page", "bbox", "text", "confidence", "uncertainty", "numeric", "cell", "eligible_for_manuscript"}
    if not isinstance(data, dict) or set(data) - allowed or data.get("page") != page or data.get("mode") != mode:
        raise PdfPageError("PDF_CACHE_INVALID")
    records = data.get("records")
    if not isinstance(records, list) or len(records) > MAX_RECORDS or not isinstance(data.get("warnings"), list):
        raise PdfPageError("PDF_CACHE_INVALID")
    def reject_pixels(value):
        if isinstance(value, dict):
            if "image_base64" in value:
                raise PdfPageError("PDF_CACHE_INVALID")
            for item in value.values():
                reject_pixels(item)
        elif isinstance(value, list):
            for item in value:
                reject_pixels(item)
    reject_pixels(data)
    for record in records:
        if not isinstance(record, dict) or set(record) - record_keys or record.get("page") != page or not isinstance(record.get("text"), str):
            raise PdfPageError("PDF_CACHE_INVALID")
        box = record.get("bbox")
        if not isinstance(box, list) or len(box) != 4 or any(type(n) not in {int, float} or not math.isfinite(n) for n in box):
            raise PdfPageError("PDF_CACHE_INVALID")
        if not isinstance(record.get("uncertainty"), list):
            raise PdfPageError("PDF_CACHE_INVALID")


class PdfPages:
    def __init__(self, source, cache_dir="scratch/pdf-pages", language="chi_sim+eng"):
        self.source = Path(source).absolute()
        before = regular(self.source, MAX_SOURCE_BYTES)
        if before.st_size < 1 or self.source.suffix.lower() != ".pdf":
            raise PdfPageError("PDF_SOURCE_INVALID")
        if language not in {"eng", "chi_sim+eng"}:
            raise PdfPageError("PDF_LANGUAGE_INVALID")
        self.source_hash = digest_file(self.source)
        self.source_stat = self.source.stat()
        if self.source_stat.st_size != before.st_size or self.source_stat.st_mtime_ns != before.st_mtime_ns:
            raise PdfPageError("PDF_SOURCE_CHANGED")
        self.cache_dir = safe_directory(Path(cache_dir))
        self.language = language
        self._ocr_identity = None
        self.document = pdfplumber.open(self.source)
        self.page_count = len(self.document.pages)
        if not 1 <= self.page_count <= MAX_PAGES:
            self.document.close()
            raise PdfPageError("PDF_PAGE_LIMIT")

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.document.close()

    def _unchanged(self):
        info = regular(self.source, MAX_SOURCE_BYTES)
        if (info.st_ino, info.st_size, info.st_mtime_ns) != (self.source_stat.st_ino, self.source_stat.st_size, self.source_stat.st_mtime_ns):
            raise PdfPageError("PDF_SOURCE_CHANGED")

    def _identity(self, mode):
        if mode == "ocr" and self._ocr_identity is None:
            self._ocr_identity = ocr_runtime_identity(self.language)
        engine = self._ocr_identity if mode == "ocr" else {"pdfplumber": pdfplumber.__version__, "x_tolerance": 2, "y_tolerance": 3}
        return {"version": VERSION, "source_sha256": self.source_hash, "mode": mode, "engine": engine}

    def _cache_path(self, page, mode):
        identity = self._identity(mode)
        key = hashlib.sha256(encoded(identity)).hexdigest()
        return self.cache_dir / self.source_hash / key / f"page-{page:04d}.json", identity

    def _cached(self, page, mode):
        path, identity = self._cache_path(page, mode)
        if not path.exists():
            return None
        try:
            regular(path, MAX_CACHE_BYTES)
            value = json.loads(path.read_bytes())
            data = value["data"]
            if value["identity"] != identity or value["sha256"] != hashlib.sha256(encoded(data)).hexdigest() or data["page"] != page:
                raise PdfPageError("PDF_CACHE_INVALID")
            validate_page(data, page, mode)
            if mode == "ocr" and data.get("rendering") != {"source_sha256": self.source_hash, "page": page, "engine": identity["engine"]}:
                raise PdfPageError("PDF_CACHE_INVALID")
            return data
        except (KeyError, TypeError, json.JSONDecodeError, OSError) as error:
            raise PdfPageError("PDF_CACHE_INVALID") from error

    def _store(self, data, mode):
        self._unchanged()
        validate_page(data, data["page"], mode)
        path, identity = self._cache_path(data["page"], mode)
        body = encoded({"identity": identity, "sha256": hashlib.sha256(encoded(data)).hexdigest(), "data": data})
        if len(body) > MAX_CACHE_BYTES:
            raise PdfPageError("PDF_PAGE_EVIDENCE_LIMIT")
        atomic_write(path, body)
        return data

    def _native(self, number):
        cached = self._cached(number, "native")
        if cached is not None:
            return cached
        page = self.document.pages[number - 1]
        try:
            words = page.extract_words(x_tolerance=2, y_tolerance=3) or []
            if len(words) > MAX_RECORDS:
                raise PdfPageError("PDF_PAGE_EVIDENCE_LIMIT")
            lines = []
            for word in words:
                if not lines or abs(lines[-1][0]["top"] - word["top"]) > 3:
                    lines.append([])
                lines[-1].append(word)
            records = [{"record_id": f"p{number}-l{index + 1}", "page": number,
                        "bbox": [min(w["x0"] for w in line), min(w["top"] for w in line),
                                 max(w["x1"] for w in line), max(w["bottom"] for w in line)],
                        "text": " ".join(w["text"] for w in line), "confidence": None, "uncertainty": []}
                       for index, line in enumerate(lines)]
            warnings = ["native_text_may_not_cover_page_images"] if page.images else []
            if not records:
                warnings.append("no_native_text_ocr_required")
            data = {"page": number, "mode": "native", "coordinate_system": "pdf_points_top_left",
                    "width": page.width, "height": page.height, "image_count": len(page.images),
                    "warnings": warnings, "records": records}
        finally:
            page.close()
        return self._store(data, "native")

    def _page(self, number, ocr="auto"):
        self._unchanged()
        if type(number) is not int or not 1 <= number <= self.page_count or ocr not in {"auto", "never", "force"}:
            raise PdfPageError("PDF_PAGE_REQUEST_INVALID")
        native = self._native(number)
        if ocr != "force" and native["records"] and not native["image_count"]:
            return native
        if ocr == "never":
            return native
        cached = self._cached(number, "ocr")
        if cached is not None:
            return cached
        if ocr != "force" and sum(len(record["text"]) for record in native["records"]) >= 80:
            return native
        metadata, records = render_ocr_page(self.source, number, self.language)
        if len(records) > MAX_RECORDS:
            raise PdfPageError("PDF_PAGE_EVIDENCE_LIMIT")
        return self._store({**metadata, "page": number, "mode": "ocr", "records": records,
                            "rendering": {"source_sha256": self.source_hash, "page": number, "engine": self._identity("ocr")["engine"]}}, "ocr")

    def outline(self, offset=0, limit=100):
        self._unchanged()
        if type(offset) is not int or not 0 <= offset <= self.page_count or type(limit) is not int or not 1 <= limit <= 200:
            raise PdfPageError("PDF_RANGE_INVALID")
        end = min(self.page_count, offset + limit)
        result = {"source_sha256": self.source_hash, "page_count": self.page_count, "pages": [], "next_offset": None,
                  "note": "An outline does not read page contents. Use read for every required page; OCR values require verification."}
        for number in range(offset + 1, end + 1):
            result["pages"].append({"page": number, "native_cached": self._cached(number, "native") is not None})
            result["next_offset"] = number if number < self.page_count else None
            if len(encoded(result)) > MAX_REPLY_BYTES:
                result["pages"].pop()
                result["next_offset"] = number - 1
                break
        return result

    def read(self, page, offset=0, limit=40, ocr="auto"):
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 200:
            raise PdfPageError("PDF_RANGE_INVALID")
        data = self._page(page, ocr)
        all_records = fragments(data["records"])
        if offset > len(all_records):
            raise PdfPageError("PDF_RANGE_INVALID")
        result = {key: value for key, value in data.items() if key != "records"}
        result.update(source_sha256=self.source_hash, page_count=self.page_count, records=[], offset=offset,
                      total_records=len(all_records), original_record_count=len(data["records"]), next_offset=None)
        if len(encoded(result)) > MAX_REPLY_BYTES:
            raise PdfPageError("PDF_PAGE_HEADER_LIMIT")
        for index in range(offset, min(len(all_records), offset + limit)):
            result["records"].append(all_records[index])
            result["next_offset"] = index + 1 if index + 1 < len(all_records) else None
            if len(encoded(result)) > MAX_REPLY_BYTES:
                result["records"].pop()
                result["next_offset"] = index
                if not result["records"]:
                    raise PdfPageError("PDF_PAGE_RECORD_LIMIT")
                break
        return result

    def search(self, query, page=1, offset=0, limit=30, max_pages=10):
        if not isinstance(query, str) or not query or len(query) > 200 or type(page) is not int or not 1 <= page <= self.page_count:
            raise PdfPageError("PDF_SEARCH_INVALID")
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100 or type(max_pages) is not int or not 1 <= max_pages <= 20:
            raise PdfPageError("PDF_RANGE_INVALID")
        result = {"source_sha256": self.source_hash, "page_count": self.page_count, "matches": [], "pages_without_ocr": [],
                  "searched_pages": [], "next_cursor": None,
                  "note": "Search does not run OCR. Missing scans are not evidence of absence; use read --ocr auto/force, then search again."}
        end = min(self.page_count, page + max_pages - 1)
        for number in range(page, end + 1):
            data = self._page(number, "never")
            if not data["records"] or data["image_count"]:
                try:
                    cached = self._cached(number, "ocr")
                except Exception as error:
                    # Lack of an OCR runtime never starts OCR or hides a corrupt cache.
                    if isinstance(error, PdfPageError):
                        raise
                    cached = None
                if cached is None and not data["records"]:
                    result["pages_without_ocr"].append(number)
                    continue
                if cached is not None:
                    data = cached
                elif data["image_count"]:
                    result["pages_without_ocr"].append(number)
            result["searched_pages"].append(number)
            records = fragments(data["records"])
            original_text = {record["record_id"]: record["text"] for record in data["records"]}
            start = offset if number == page else 0
            if start > len(records):
                raise PdfPageError("PDF_RANGE_INVALID")
            for index in range(start, len(records)):
                record = records[index]
                # Include enough lookahead to find matches spanning a fragment
                # boundary, and return the actual matching context in that case.
                text = original_text[record["record_id"]]
                candidate = text[record["text_offset"]:record["text_offset"] + FRAGMENT_CHARS + len(query) * 2]
                match_at = candidate.casefold().find(query.casefold())
                if match_at < 0 or match_at >= len(record["text"].casefold()):
                    continue
                record = {**record, "text": candidate}
                result["matches"].append(record)
                result["next_cursor"] = {"page": number, "offset": index + 1}
                if len(encoded(result)) > MAX_REPLY_BYTES:
                    result["matches"].pop()
                    result["next_cursor"] = {"page": number, "offset": index}
                    if not result["matches"]:
                        raise PdfPageError("PDF_PAGE_RECORD_LIMIT")
                    return result
                if len(result["matches"]) == limit:
                    return result
        result["next_cursor"] = {"page": end + 1, "offset": 0} if end < self.page_count else None
        return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source")
    parser.add_argument("command", choices=["outline", "read", "search"])
    parser.add_argument("--cache-dir", default="scratch/pdf-pages")
    parser.add_argument("--language", default="chi_sim+eng", choices=["eng", "chi_sim+eng"])
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--ocr", choices=["auto", "never", "force"], default="auto")
    parser.add_argument("--query")
    parser.add_argument("--max-pages", type=int, default=10)
    args = parser.parse_args(argv)
    try:
        with PdfPages(args.source, args.cache_dir, args.language) as pdf:
            result = pdf.outline(args.offset, args.limit) if args.command == "outline" else pdf.read(args.page, args.offset, args.limit, args.ocr) if args.command == "read" else pdf.search(args.query, args.page, args.offset, args.limit, args.max_pages)
        print(encoded(result).decode("utf-8"))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, PdfPageError) or str(error).startswith("OCR_") else "PDF_PAGE_READ_FAILED"
        print(json.dumps({"error": code, "note": "No missing page or uncertain value has been accepted as read."}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
