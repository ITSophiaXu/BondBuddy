import json
import sys
from .engine import process

try:
    request = json.loads(sys.stdin.buffer.read(65537))
    result = process(request)
except Exception:
    result = {"schema_version": "ocr-response-v1", "status": "failed", "error": "INVALID_OCR_REQUEST"}
sys.stdout.write(json.dumps(result, ensure_ascii=False, allow_nan=False))
