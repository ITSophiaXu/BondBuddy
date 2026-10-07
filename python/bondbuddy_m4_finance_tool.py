"""M4 arithmetic wrapper: the immutable host manifest alone authorizes sources."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from bondbuddy_m4_finance import calculate

VERSION = "m4-finance-host-v1"
MAX_JSON = 1024 * 1024


def _read(path: Path, maximum=MAX_JSON):
    info = path.lstat()
    if not path.is_file() or path.is_symlink() or info.st_nlink != 1 or not 0 < info.st_size <= maximum:
        raise ValueError("UNSAFE_REQUEST")
    return json.loads(path.read_text(encoding="utf-8"))


def calculate_authorized(request, workspace_input):
    """Never accept a model-supplied expansion of the host source allow-list."""
    allowed = workspace_input.get("authorized_sources") if isinstance(workspace_input, dict) else None
    if not isinstance(allowed, list) or len(allowed) > 100 or not isinstance(request, dict):
        raise ValueError("INVALID_HOST_INPUT")
    if "authorized_sources" in request and request["authorized_sources"] != allowed:
        raise ValueError("SOURCE_AUTHORIZATION_CHANGED")
    return calculate({**request, "authorized_sources": allowed})


def run(workspace: Path, request_path: Path, output_path: Path):
    workspace = workspace.resolve(strict=True)
    request_path = request_path.absolute()
    output_path = output_path.absolute()
    # Requests and receipts are run-local scratch/output files; readonly inputs are never output targets.
    for path in (request_path, output_path):
        relative = path.relative_to(workspace)
        if not relative.parts or relative.parts[0] not in ("scratch", "output") or ".." in relative.parts:
            raise ValueError("UNSAFE_REQUEST")
        if path.parent.resolve(strict=True) != path.parent:
            raise ValueError("UNSAFE_REQUEST")
    if output_path.exists() and (output_path.is_symlink() or output_path.lstat().st_nlink != 1):
        raise ValueError("UNSAFE_OUTPUT")
    result = calculate_authorized(_read(request_path), _read(workspace / "input.json", 4 * MAX_JSON))
    raw = (json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    descriptor = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(descriptor, "wb") as output:
        output.write(raw)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--workspace", default=".")
    args = parser.parse_args()
    try:
        run(Path(args.workspace), Path(args.input), Path(args.output))
    except (ValueError, OSError, RecursionError):
        parser.exit(2, "M4_FINANCE_INPUT_REJECTED\n")


if __name__ == "__main__":
    main()
