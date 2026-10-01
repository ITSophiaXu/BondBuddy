"""Bounded, metadata-only local OCR v2 probe for the authorized Qixian audit PDFs.

No OCR text, page images, or invocation responses are written to persistent files.
The full_ocr context below is synthetic CLI input, not an authorized platform run.
"""

import argparse
import base64
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import uuid

from bondbuddy_ocr import v2


SAMPLES = Path(__file__).resolve().parent / "2026-09-25"
AUDIT_PAGES = {"qx-202606-02": 74, "qx-202606-03": 70}
CODE = re.compile(r"[a-z][a-z0-9_]*|[A-Z][A-Z0-9_]*")


class ProbeError(Exception):
    pass


def checked_code(value):
    if not isinstance(value, str) or not CODE.fullmatch(value):
        raise ProbeError("UNSAFE_METADATA_CODE")
    return value


def process_tree_resources(root):
    result = subprocess.run(
        ["ps", "-A", "-o", "pid=,ppid=,rss=,%cpu="],
        capture_output=True, text=True, check=True, timeout=3,
    )
    processes = {}
    for line in result.stdout.splitlines():
        pid, parent, rss, cpu = line.split()
        processes[int(pid)] = (int(parent), int(rss), float(cpu))
    members = {root}
    for _ in range(10):
        children = {pid for pid, (parent, _, _) in processes.items() if parent in members}
        if children <= members:
            break
        members.update(children)
    return (sum(processes[pid][1] for pid in members if pid in processes),
            sum(processes[pid][2] for pid in members if pid in processes))


def stop_process(proc):
    if proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()


def invoke(envelope, max_seconds, max_rss_mib):
    payload = json.dumps(envelope, separators=(",", ":")).encode()
    start = time.monotonic()
    peak_kib = 0
    peak_cpu_percent = 0.0
    with tempfile.TemporaryFile() as output:
        proc = subprocess.Popen(
            [sys.executable, "-m", "bondbuddy_ocr"],
            stdin=subprocess.PIPE, stdout=output, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            proc.stdin.write(payload)
            proc.stdin.close()
            while proc.poll() is None:
                rss_kib, cpu_percent = process_tree_resources(os.getpid())
                peak_kib = max(peak_kib, rss_kib)
                peak_cpu_percent = max(peak_cpu_percent, cpu_percent)
                if peak_kib > max_rss_mib * 1024:
                    raise ProbeError("RSS_LIMIT_EXCEEDED")
                if time.monotonic() - start > max_seconds:
                    raise ProbeError("WALL_TIME_LIMIT_EXCEEDED")
                time.sleep(0.25)
            if proc.returncode:
                raise ProbeError("OCR_PROCESS_FAILED")
            if output.tell() > 80 * 1024 * 1024:
                raise ProbeError("OCR_OUTPUT_LIMIT")
            output.seek(0)
            result = json.load(output)
        finally:
            stop_process(proc)
    if not isinstance(result, dict) or result.get("error") or not isinstance(
        result.get("response", result.get("document")), dict
    ):
        raise ProbeError(checked_code(result.get("error", "INVALID_OCR_INVOCATION")))
    return result, time.monotonic() - start, peak_kib / 1024, peak_cpu_percent


def sample(file_id):
    manifest = json.loads((SAMPLES / "manifest.json").read_text(encoding="utf-8"))
    case = next(case for case in manifest["cases"] if case["case_id"] == "qx-202606")
    entry = next(file for file in case["files"] if file["file_id"] == file_id)
    source = (SAMPLES / entry["path"]).resolve()
    if not source.is_relative_to(SAMPLES.resolve()):
        raise ProbeError("UNSAFE_SOURCE_PATH")
    with source.open("rb") as stream:
        actual_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual_hash != entry["sha256"] or source.stat().st_size != entry["bytes"]:
        raise ProbeError("SOURCE_BYTES_MISMATCH")
    if entry["page_count"] != AUDIT_PAGES[file_id] or entry["media_type"] != "application/pdf":
        raise ProbeError("SOURCE_MANIFEST_MISMATCH")
    material = {
        "material_id": file_id, "material_version": 1,
        "media_type": entry["media_type"], "sha256": actual_hash,
    }
    return source, material


def validate_batch(result, request):
    response = result["response"]
    if (response.get("schema_version") != "ocr-response-v2"
            or response.get("request_id") != request["request_id"]
            or response.get("document") != request["document"]
            or response.get("context") != request["context"]
            or response.get("eligible_for_manuscript") is not False):
        raise ProbeError("OCR_RESPONSE_MISMATCH")
    outcomes = response.get("page_results")
    if not isinstance(outcomes, list) or [item.get("page") for item in outcomes] != request["pages"]:
        raise ProbeError("OCR_PAGE_RESULTS_MISMATCH")
    successful = {item["page"]: item for item in outcomes if item.get("status") == "succeeded"}
    failures = {item["page"]: checked_code(item["error"]) for item in outcomes if item.get("status") == "failed"}
    if len(successful) + len(failures) != len(outcomes) or any(item.get("reused") for item in successful.values()):
        raise ProbeError("OCR_OUTCOME_MISMATCH")
    attempted = sum(1 for item in outcomes if item.get("status") == "succeeded"
                    or item.get("attempted") is True)
    if (response.get("attempted_pages") != attempted
            or response.get("coverage") != ("partial" if successful else "none")
            or len(result.get("checkpoints", [])) != len(successful)):
        raise ProbeError("OCR_ATTEMPT_COUNT_MISMATCH")

    warnings, uncertainty, numeric = Counter(), Counter(), Counter()
    for item in result["checkpoints"]:
        checkpoint = item["checkpoint"]
        page = checkpoint["identity"]["page"]
        try:
            image_bytes = base64.b64decode(item["image_base64"], validate=True)
            v2._validate_checkpoint(checkpoint, image_bytes, request["document"], page)
        except (KeyError, ValueError, TypeError, v2.V2Failure) as error:
            raise ProbeError("OCR_CHECKPOINT_INVALID") from error
        if page not in successful or successful[page]["checkpoint"] != {
            key: checkpoint[key] for key in ("identity_sha256", "result_sha256", "source_request_id")
        } | {"page": page}:
            raise ProbeError("OCR_CHECKPOINT_REFERENCE_MISMATCH")
        contents = checkpoint["result"]
        warnings.update(checked_code(value) for value in contents["page"]["warnings"])
        for record in contents["records"]:
            if (record["page"] != page or record["eligible_for_manuscript"] is not False
                    or not record["uncertainty"]):
                raise ProbeError("OCR_UNCERTAINTY_MISMATCH")
            uncertainty.update(checked_code(value) for value in record["uncertainty"])
            numeric.update([checked_code(record["numeric"]["kind"])])
    return successful, failures, attempted, warnings, uncertainty, numeric


def run(args):
    source, material = sample(args.file_id)
    attempt_id = uuid.uuid4().hex[:12]
    selected = (list(range(1, AUDIT_PAGES[args.file_id] + 1)) if args.pages == "all"
                else [int(value) for value in args.pages.split(",")])
    if not selected or selected != sorted(set(selected)) or selected[0] < 1 or selected[-1] > AUDIT_PAGES[args.file_id]:
        raise ProbeError("INVALID_PAGE_SELECTION")
    print(f"source={args.file_id} sha256={material['sha256']} bytes={source.stat().st_size}", flush=True)
    probe = {
        "schema_version": "ocr-identity-probe-v2", "material_path": str(source),
        "owner_user_id": "local-probe", "project_id": "local-probe",
        "material": material, "language": "chi_sim+eng",
    }
    document = invoke(probe, args.max_batch_seconds, args.max_rss_mib)[0]["document"]
    if document["page_count"] != AUDIT_PAGES[args.file_id] or document["material"] != material:
        raise ProbeError("OCR_IDENTITY_MISMATCH")
    print(
        f"identity processor={document['processor_version']} engine={document['engine']['version']} "
        f"language={document['engine']['language']} models={json.dumps(document['engine']['language_data_sha256'], sort_keys=True)} "
        f"engine_parameters_sha256={document['engine']['parameters_sha256']} "
        f"renderer={document['rendering']['renderer']} renderer_version={document['rendering']['renderer_version']} "
        f"dpi={document['rendering']['dpi']} rendering_parameters_sha256={document['rendering']['parameters_sha256']}",
        flush=True,
    )
    started = time.monotonic()
    covered = set()
    attempts = 0
    peak_rss = 0.0
    peak_cpu_percent = 0.0
    warnings, uncertainty, numeric = Counter(), Counter(), Counter()
    for index in range(0, len(selected), args.batch_size):
        pages = selected[index:index + args.batch_size]
        remaining = args.max_total_seconds - (time.monotonic() - started)
        if remaining <= 0:
            raise ProbeError("TOTAL_WALL_TIME_LIMIT_EXCEEDED")
        request = {
            "schema_version": "ocr-request-v2",
            "request_id": f"local-{attempt_id}-{args.file_id}-{pages[0]}-{pages[-1]}",
            "document": document,
            "context": {
                "purpose": "full_ocr",
                "run": {"run_id": "local-unpersisted-probe", "execution_request_id": "local-unpersisted-probe",
                        "input_revision": 1, "input_hash": material["sha256"]},
                "billable": False, "cost_payer": "platform",
            },
            "pages": pages, "reuse": [],
        }
        envelope = {"schema_version": "ocr-invocation-v2", "request": request,
                    "material_path": str(source), "reuse_checkpoints": []}
        try:
            result, _, sampled_rss, sampled_cpu = invoke(
                envelope, min(remaining, args.max_batch_seconds), args.max_rss_mib
            )
        except ProbeError as error:
            print(f"interrupted_batch={pages[0]}-{pages[-1]} attempted_in_batch=unknown reason={error}", flush=True)
            print(f"partial_coverage={len(covered)}/{AUDIT_PAGES[args.file_id]} attempted_so_far={attempts} "
                  f"wall_s={time.monotonic()-started:.1f} sampled_peak_tree_rss_mib={peak_rss:.1f}",
                  flush=True)
            raise
        peak_rss = max(peak_rss, sampled_rss)
        peak_cpu_percent = max(peak_cpu_percent, sampled_cpu)
        success, failures, attempted, batch_warnings, batch_uncertainty, batch_numeric = validate_batch(result, request)
        covered.update(success)
        attempts += attempted
        warnings.update(batch_warnings)
        uncertainty.update(batch_uncertainty)
        numeric.update(batch_numeric)
        if failures:
            print(f"failed_pages={json.dumps(failures, sort_keys=True)}", flush=True)
            print(f"partial_coverage={len(covered)}/{AUDIT_PAGES[args.file_id]} attempted_so_far={attempts} "
                  f"wall_s={time.monotonic()-started:.1f} sampled_peak_tree_rss_mib={peak_rss:.1f}",
                  flush=True)
            raise ProbeError("OCR_PAGE_FAILED")
        if len(covered) % 10 == 0 or index + args.batch_size >= len(selected):
            print(f"progress={len(covered)}/{len(selected)} attempted={attempts} "
                  f"wall_s={time.monotonic()-started:.1f} sampled_peak_tree_rss_mib={peak_rss:.1f} "
                  f"sampled_peak_tree_cpu_percent={peak_cpu_percent:.1f}", flush=True)
    print(
        f"result={args.file_id} covered={len(covered)}/{AUDIT_PAGES[args.file_id]} "
        f"selected={len(selected)} attempted={attempts} wall_s={time.monotonic()-started:.1f} "
        f"sampled_peak_tree_rss_mib={peak_rss:.1f} sampled_peak_tree_cpu_percent={peak_cpu_percent:.1f} "
        f"needs_confirmation_pages={len(covered)} eligible_for_manuscript=false "
        f"warnings={json.dumps(dict(warnings), sort_keys=True)} "
        f"uncertainty={json.dumps(dict(uncertainty), sort_keys=True)} "
        f"numeric_kinds={json.dumps(dict(numeric), sort_keys=True)}",
        flush=True,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file-id", choices=AUDIT_PAGES, required=True)
    parser.add_argument("--pages", required=True, help="Increasing physical pages (e.g. 3,7), or all")
    parser.add_argument("--batch-size", type=int, default=1, choices=range(1, 6))
    parser.add_argument("--max-batch-seconds", type=int, default=180)
    parser.add_argument("--max-total-seconds", type=int, default=1200)
    parser.add_argument("--max-rss-mib", type=int, default=512)
    args = parser.parse_args()
    if min(args.max_batch_seconds, args.max_total_seconds, args.max_rss_mib) < 1:
        parser.error("resource limits must be positive")
    try:
        run(args)
    except (ProbeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        code = str(error) if isinstance(error, ProbeError) else type(error).__name__
        print(f"ABORT reason={checked_code(code)} (no raw response retained)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
