"""Read/search bounded PDF page evidence; OCR is local and only runs for a requested page.

Run inside the authoring workspace. Cache files are reusable input data, not an
approval of OCR values or proof that the entire document has been reviewed.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.metadata
import io
import json
import math
import os
from pathlib import Path
import re
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


def png_digest(image):
    digest = hashlib.sha256()

    class Sink:
        def write(self, data):
            digest.update(data)
            return len(data)

    image.save(Sink(), format="PNG")
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


def render_rgb_page(source, page_number):
    import pypdfium2 as pdfium
    from bondbuddy_ocr.engine import MAX_PIXELS
    document = pdfium.PdfDocument(source)
    try:
        page = document[page_number - 1]
        try:
            width, height = page.get_size()
            if width <= 0 or height <= 0 or width * height * (250 / 72) ** 2 > MAX_PIXELS:
                raise PdfPageError("PDF_PAGE_PIXEL_LIMIT")
            bitmap = page.render(scale=250 / 72)
            try:
                return bitmap.to_pil().convert("RGB")
            finally:
                bitmap.close()
        finally:
            page.close()
    finally:
        document.close()


def render_ocr_page(source, page_number, language):
    from bondbuddy_ocr.engine import extract_page
    with render_rgb_page(source, page_number) as image:
        with tempfile.TemporaryDirectory(prefix="bb-pdf-page-ocr-") as temporary:
            metadata, records = extract_page(image, language, temporary, page_number)
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
        except (KeyError, TypeError, json.JSONDecodeError, UnicodeDecodeError, OSError) as error:
            raise PdfPageError("PDF_CACHE_INVALID") from error

    def _existing_ocr(self, page):
        # A forced OCR read can add evidence to a page with only vector drawing
        # and a partial text layer. Do not infer cache availability from images.
        # Avoid requiring the optional OCR runtime for uncached native pages.
        native_path, _ = self._cache_path(page, "native")
        if self._ocr_identity is None and not any(
                candidate != native_path
                for candidate in native_path.parent.parent.glob(f"*/{native_path.name}")):
            return None
        return self._cached(page, "ocr")

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
        if ocr == "never":
            return native
        if ocr != "force" and native["records"] and not native["image_count"]:
            cached = self._existing_ocr(number)
            return cached if cached is not None else native
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

    def crop(self, page, ids, clip=None):
        """Recover original page pixels for visual checking, without repeating OCR."""
        if (type(page) is not int or not 1 <= page <= self.page_count
                or not isinstance(ids, list) or not 1 <= len(ids) <= 8
                or any(not isinstance(i, str) or not re.fullmatch(fr'p{page}-r[1-9][0-9]{{0,4}}', i) for i in ids)
                or len(set(ids)) != len(ids)):
            raise PdfPageError("PDF_CROP_RECORD_INVALID")
        self._unchanged()
        data = self._cached(page, "ocr")
        if data is None:
            raise PdfPageError("PDF_CROP_READ_OCR_PAGE_FIRST")
        selected = [r for r in data["records"] if r.get("record_id") in ids]
        if len(selected) != len(ids) or {r['record_id'] for r in selected} != set(ids):
            raise PdfPageError("PDF_CROP_RECORD_INVALID")
        rotation = data.get("rotation_clockwise")
        if type(rotation) is not int or rotation not in (0, 90, 180, 270):
            raise PdfPageError("PDF_CROP_RENDER_MISMATCH")
        with render_rgb_page(self.source, page) as raw:
            upright = raw.rotate(-rotation, expand=True) if rotation else raw
            try:
                # The OCR boxes are in the oriented 250dpi page, not PDF points
                # or a resized overview. Use the same PNG encoder as extract_page.
                digest = png_digest(upright)
                if (upright.size != (data['width'], data['height']) or digest != data.get('image_sha256')
                        or data.get('coordinate_system') != 'rendered_pixels_top_left'):
                    raise PdfPageError("PDF_CROP_RENDER_MISMATCH")
                boxes = [r['bbox'] for r in selected]
                if any(not all(type(n) is int for n in box)
                       or not (0 <= box[0] < box[2] <= upright.width and 0 <= box[1] < box[3] <= upright.height)
                       for box in boxes):
                    raise PdfPageError("PDF_CROP_RECORD_INVALID")
                left, top = min(b[0] for b in boxes), min(b[1] for b in boxes)
                right, bottom = max(b[2] for b in boxes), max(b[3] for b in boxes)
                if clip is not None:
                    if (len(clip) != 4 or any(type(n) is not int for n in clip)
                            or not (left <= clip[0] < clip[2] <= right and top <= clip[1] < clip[3] <= bottom)):
                        raise PdfPageError("PDF_CROP_CLIP_INVALID")
                    left, top, right, bottom = clip
                if ((right-left)*(bottom-top) > 2_000_000
                        or [left, top, right, bottom] == [0, 0, upright.width, upright.height]):
                    raise PdfPageError("PDF_CROP_SELECT_FEWER_RECORDS_OR_CLIP")
                bbox = [left, top, right, bottom]
                with upright.crop(tuple(bbox)) as region, io.BytesIO() as buf:
                    region.save(buf, format="PNG")
                    content = buf.getvalue()
            finally:
                if rotation:
                    upright.close()
        if len(content) > 4 * 1024 * 1024:
            raise PdfPageError("PDF_CROP_SELECT_FEWER_RECORDS_OR_CLIP")
        self._unchanged()
        crop_hash = hashlib.sha256(content).hexdigest()
        # A recoverable workspace includes all scratch files. Keep only the
        # current regenerable crop; the viewer checks its expected hash.
        path = Path("scratch/pdf-crops/current.png")
        atomic_write(path, content)
        return {"source_sha256": self.source_hash, "page": page, "record_ids": ids,
                "coordinate_system": "rendered_pixels_top_left", "rotation_clockwise": rotation,
                "page_image_sha256": digest, "bbox": bbox, "crop_sha256": crop_hash,
                "path": path.as_posix(), "byte_size": len(content), "eligible_for_manuscript": False,
                "note": "Use bb_images.view_image with path and expected_sha256=crop_sha256. Check labels, period, unit, sign and digits against these pixels. A crop is not a verified fact."}

    def search(self, query, page=1, offset=0, limit=30, max_pages=10):
        if not isinstance(query, str) or not query or len(query) > 200 or type(page) is not int or not 1 <= page <= self.page_count:
            raise PdfPageError("PDF_SEARCH_INVALID")
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100 or type(max_pages) is not int or not 1 <= max_pages <= 20:
            raise PdfPageError("PDF_RANGE_INVALID")
        result = {"source_sha256": self.source_hash, "page_count": self.page_count, "matches": [], "pages_without_ocr": [],
                  "searched_pages": [], "next_cursor": None,
                  "note": "Search does not run OCR. Missing scans are not evidence of absence; use read --ocr auto/force, then search again."}
        end = min(self.page_count, page + max_pages - 1)
        # Tesseract joins individual Han words with spaces. Match those optional
        # separators only for Chinese labels, within one OCR record. Do not edit
        # the evidence or normalize numbers, signs, punctuation or table cells.
        label = (re.compile(r'[ \t\u3000]?'.join(query))
                 if re.fullmatch(r'[\u3400-\u4dbf\u4e00-\u9fff]{2,200}', query) else None)
        for number in range(page, end + 1):
            data = self._page(number, "never")
            try:
                cached = self._existing_ocr(number)
            except Exception as error:
                # Lack of an OCR runtime never starts OCR or hides a corrupt cache.
                if isinstance(error, PdfPageError):
                    raise
                cached = None
            if cached is not None:
                data = cached
            elif not data["records"]:
                result["pages_without_ocr"].append(number)
                continue
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
                    match = label.search(candidate) if label and data.get("mode") == "ocr" else None
                    if not match or match.start() >= len(record["text"]):
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
    parser.add_argument("command", choices=["outline", "read", "search", "crop"])
    parser.add_argument("--cache-dir", default="scratch/pdf-pages")
    parser.add_argument("--language", default="chi_sim+eng", choices=["eng", "chi_sim+eng"])
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--ocr", choices=["auto", "never", "force"], default="auto")
    parser.add_argument("--query")
    parser.add_argument("--max-pages", type=int, default=10)
    parser.add_argument("--record-id", dest="record_ids", action="append", help="OCR record to crop (repeat for adjacent labels/columns)")
    parser.add_argument("--clip", type=int, nargs=4, metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"), help="Smaller region inside selected OCR boxes, in oriented page pixels")
    args = parser.parse_args(argv)
    try:
        with PdfPages(args.source, args.cache_dir, args.language) as pdf:
            if args.command == "crop":
                result = pdf.crop(args.page, args.record_ids, args.clip)
            elif args.command == "outline":
                result = pdf.outline(args.offset, args.limit)
            elif args.command == "read":
                result = pdf.read(args.page, args.offset, args.limit, args.ocr)
            else:
                result = pdf.search(args.query, args.page, args.offset, args.limit, args.max_pages)
        print(encoded(result).decode("utf-8"))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, PdfPageError) or str(error).startswith("OCR_") else "PDF_PAGE_READ_FAILED"
        print(json.dumps({"error": code, "note": "No missing page or uncertain value has been accepted as read."}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
