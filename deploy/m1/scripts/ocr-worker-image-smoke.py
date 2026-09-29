"""Offline, synthetic-only smoke for the deployed worker image's real OCR CLI."""
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

from PIL import Image, ImageDraw


def require(condition, message):
    if not condition:
        raise RuntimeError(f"worker OCR image smoke: {message}")


def call_ocr(payload, timeout):
    started = time.monotonic()
    result = subprocess.run(
        [sys.executable, "-m", "bondbuddy_ocr"],
        input=json.dumps(payload), text=True, capture_output=True, timeout=timeout,
        check=True,
    )
    elapsed = time.monotonic() - started
    require(elapsed < timeout, f"OCR exceeded {timeout}s budget")
    return json.loads(result.stdout), elapsed


def smoke(path, media_type):
    source_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    material = {
        "material_id": "synthetic-ocr-image-smoke", "material_version": 1,
        "media_type": media_type, "sha256": source_hash,
    }
    identity, probe_seconds = call_ocr({
        "schema_version": "ocr-identity-probe-v2", "material_path": str(path),
        "owner_user_id": "synthetic-owner", "project_id": "synthetic-project",
        "material": material, "language": "chi_sim+eng",
    }, 30)
    require(identity.get("schema_version") == "ocr-identity-probe-response-v2",
            "identity probe failed")
    document = identity["document"]
    require(document["material"] == material and document["page_count"] == 1,
            "source identity/page count mismatch")
    require(document["engine"]["name"] == "tesseract" and
            document["engine"]["version"] == "tesseract 5.3.0" and
            document["engine"]["language"] == "chi_sim+eng", "engine identity mismatch")
    data_dir = Path("/usr/share/tesseract-ocr/5/tessdata")
    require(document["engine"]["language_data_sha256"] == {
        lang: hashlib.sha256((data_dir / f"{lang}.traineddata").read_bytes()).hexdigest()
        for lang in ("chi_sim", "eng", "osd")
    }, "probe language hashes mismatch")
    response, page_seconds = call_ocr({
        "schema_version": "ocr-invocation-v2",
        "request": {
            "schema_version": "ocr-request-v2", "request_id": f"synthetic-{path.suffix[1:]}",
            "document": document,
            "context": {
                "purpose": "source_preflight", "run": None,
                "billable": False, "cost_payer": "platform",
            },
            "pages": [1], "reuse": [],
        },
        "material_path": str(path), "reuse_checkpoints": [],
    }, 60)
    require(response.get("schema_version") == "ocr-invocation-response-v2",
            "invocation failed")
    batch = response["response"]
    require(len(batch["page_results"]) == 1 and
            batch["page_results"][0]["status"] == "succeeded" and
            batch["page_results"][0]["reused"] is False,
            f"page processing failed: {batch['page_results']}")
    require(batch["attempted_pages"] == 1 and len(response["checkpoints"]) == 1,
            "expected one newly processed page")
    checkpoint = response["checkpoints"][0]["checkpoint"]
    png = base64.b64decode(response["checkpoints"][0]["image_base64"], validate=True)
    require(png.startswith(b"\x89PNG\r\n\x1a\n") and
            checkpoint["result"]["page"]["image_sha256"] == hashlib.sha256(png).hexdigest(),
            "page image/hash mismatch")
    require(checkpoint["identity"]["document"] == document and
            checkpoint["result"]["status"] == "needs_confirmation" and
            checkpoint["result"]["eligible_for_manuscript"] is False,
            "checkpoint identity or confirmation boundary mismatch")
    records = checkpoint["result"]["records"]
    require(records and all(record["uncertainty"] and record["eligible_for_manuscript"] is False
                            for record in records), "synthetic text/uncertainty missing")
    require(hashlib.sha256(path.read_bytes()).hexdigest() == source_hash,
            "source changed during OCR")
    print(f"synthetic {media_type}: probe {probe_seconds:.1f}s/30s, page {page_seconds:.1f}s/60s")


def main():
    with tempfile.TemporaryDirectory(prefix="bb-ocr-image-smoke-") as directory:
        path = Path(directory)
        small = Image.new("RGB", (240, 55), "white")
        ImageDraw.Draw(small).text((8, 10), "BOND BUDDY 2026", fill="black")
        image = small.resize((960, 220), Image.Resampling.NEAREST)
        png = path / "synthetic.png"
        pdf = path / "synthetic.pdf"
        image.save(png)
        image.save(pdf, format="PDF", resolution=100.0)
        smoke(png, "image/png")
        smoke(pdf, "application/pdf")


if __name__ == "__main__":
    main()
