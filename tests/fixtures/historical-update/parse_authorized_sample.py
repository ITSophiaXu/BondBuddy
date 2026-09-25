"""Opt-in read-only parser check for the user-authorized rq-202509-01 sample."""
import hashlib
import json
from pathlib import Path

from bondbuddy_document_parser.parser import parse_request

root = Path(__file__).resolve().parents[3]
folder = root / "tests" / "samples" / "2026-09-25"
manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
record = next(f for case in manifest["cases"] for f in case["files"] if f["file_id"] == "rq-202509-01")
assert record["upload_role"] == "historical"
path = (folder / record["path"]).resolve()
assert path.is_relative_to(folder.resolve())
original = path.read_bytes()
assert len(original) == record["bytes"]
assert hashlib.sha256(original).hexdigest() == record["sha256"]
parsed = parse_request({
    "schema_version": "document-parse-request-v1",
    "request_id": "authorized-generation-chunk-check",
    "material": {"material_id": record["file_id"], "material_version": 1,
                 "media_type": record["media_type"], "sha256": record["sha256"],
                 "authorized_local_path": str(path)},
    "options": {},
})
assert hashlib.sha256(path.read_bytes()).hexdigest() == record["sha256"]
print(json.dumps(parsed, ensure_ascii=True))
