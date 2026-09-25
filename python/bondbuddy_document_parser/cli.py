"""stdin/stdout JSON CLI. stdout is reserved for exactly one response object."""

from __future__ import annotations

import json
import sys

from .parser import failure_response, parse_request, stream_parse_request


def main() -> None:
    stream_mode = sys.argv[1:] == ["--stream"]
    try:
        payload = json.load(sys.stdin)
        if stream_mode:
            stream_parse_request(payload, sys.stdout)
            return
        response = parse_request(payload)
    except Exception as exc:  # The worker must always receive a structured result.
        response = failure_response(
            request_id=None,
            material=None,
            code="INVALID_PARSE_REQUEST",
            message=f"Invalid parser request: {type(exc).__name__}",
        )
    json.dump(response, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")
