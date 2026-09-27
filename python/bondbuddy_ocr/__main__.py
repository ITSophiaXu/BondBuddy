import json
import sys
from .engine import process

MAX_INPUT_BYTES = 192 * 1024 * 1024
MAX_OUTPUT_BYTES = 192 * 1024 * 1024
request = None
try:
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError("input limit")
    request = json.loads(raw)
    if isinstance(request, dict) and request.get("schema_version") == "ocr-invocation-v2":
        from .v2 import process_v2
        result = process_v2(request)
    else:
        if len(raw) > 65536:
            raise ValueError("v1 input limit")
        result = process(request)
except Exception:
    if isinstance(request, dict) and request.get("schema_version") == "ocr-invocation-v2":
        result = {"schema_version": "ocr-invocation-response-v2", "error": "INVALID_OCR_INVOCATION",
                  "response": None, "checkpoints": []}
    else:
        result = {"schema_version": "ocr-response-v1", "status": "failed", "error": "INVALID_OCR_REQUEST"}

serialized = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
if len(serialized.encode("utf-8")) > MAX_OUTPUT_BYTES and result.get("schema_version") == "ocr-invocation-response-v2":
    response = result["response"]
    if isinstance(response, dict):
        response["page_results"] = [
            ({"page": item["page"], "status": "failed",
              "attempted": item["status"] == "succeeded" and not item["reused"] if item["status"] == "succeeded" else item["attempted"],
              "retryable": False, "error": "OCR_OUTPUT_LIMIT", "warnings": []}
             if item["status"] == "succeeded" else item)
            for item in response["page_results"]
        ]
        response["coverage"] = "none"
        result["checkpoints"] = []
        serialized = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    else:
        serialized = '{"schema_version":"ocr-invocation-response-v2","error":"OCR_OUTPUT_LIMIT","response":null,"checkpoints":[]}'
sys.stdout.write(serialized)
