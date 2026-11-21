"""Run synthetic barrier groups using the repository's real host cgroup fixture."""
import argparse
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
TRACKED_INPUTS = [
    "apps/worker/src/managed-run-retries.ts", "apps/worker/src/task-execution.ts",
    "apps/worker/src/runtime.ts", "apps/worker/src/run-pipeline.ts",
    "apps/api/src/queue.ts", "apps/api/src/execution-capacity.ts",
    "deploy/tencent-elasticity/task-cgroup-broker.py", "deploy/tencent-elasticity/task-runner.py",
    "tests/worker-barrier/matrix.json", "tests/worker-barrier/scenario.mjs",
    "apps/worker/dist/runtime.js", "apps/worker/dist/task-execution.js",
    "apps/api/dist/queue.js", "apps/api/dist/execution-capacity.js",
]


def fingerprints():
    return {path: hashlib.sha256((REPO / path).read_bytes()).hexdigest() for path in TRACKED_INPUTS}


def load_groups(path):
    value = json.loads(path.read_text())
    if value.get("version") != "worker-barrier-matrix-v1" or value.get("synthetic") is not True:
        raise ValueError("Invalid synthetic matrix version.")
    groups = value.get("groups")
    if not isinstance(groups, list) or not groups or len(groups) > 30:
        raise ValueError("Matrix must contain 1-30 groups.")
    ids = set()
    keys = {"id", "description", "slots", "retry", "a_seconds", "retry_seconds",
            "peer_seconds", "c_seconds", "native_tail_seconds"}
    for group in groups:
        if set(group) != keys or not isinstance(group["id"], str) or not group["id"].replace("-", "").isalnum():
            raise ValueError("Invalid group fields or ID.")
        if group["id"] in ids or type(group["slots"]) is not int or not 2 <= group["slots"] <= 8:
            raise ValueError("Duplicate ID or unsupported slot count.")
        ids.add(group["id"])
        if type(group["retry"]) is not bool or len(group["peer_seconds"]) != group["slots"] - 1:
            raise ValueError("Each group needs slots-1 peers.")
        durations = [group["a_seconds"], group["retry_seconds"], group["c_seconds"], *group["peer_seconds"]]
        if any(type(n) not in (int, float) or not 0 < n <= 15 for n in durations):
            raise ValueError("Sleep durations must be finite numbers in (0,15].")
        tail = group["native_tail_seconds"]
        if type(tail) not in (int, float) or not 0 <= tail <= 10 or tail and not group["retry"]:
            raise ValueError("Invalid native tail.")
        if min(group["peer_seconds"]) <= group["a_seconds"] + tail + 2 * group["retry_seconds"] + 1:
            raise ValueError("Peer duration needs enough headroom to distinguish blocking from slot contention.")
    return groups


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--group", action="append")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--head")
    parser.add_argument("--no-systemd", action="store_true")
    args = parser.parse_args()
    if sys.platform != "linux" or os.geteuid() != 0:
        parser.error("Run on the local Linux Docker host as root; Windows uses run.ps1 through WSL.")
    if not 1 <= args.repeat <= 10:
        parser.error("--repeat must be 1-10.")
    if args.head is not None and not re.fullmatch(r"[a-f0-9]{40}", args.head):
        parser.error("--head must be an exact Git commit SHA supplied by the Windows wrapper.")
    if not (Path("/sys/fs/cgroup") / "cgroup.controllers").exists():
        parser.error("Writable cgroup v2 on the Docker host is required.")
    endpoint = subprocess.check_output(["docker", "context", "inspect", "--format",
                                        "{{.Endpoints.docker.Host}}"], text=True).strip()
    if not endpoint.startswith("unix://"):
        parser.error("Use a local Unix-socket Docker engine, not a remote/Desktop engine.")
    engine = json.loads(subprocess.check_output(["docker", "info", "--format", "{{json .}}"], text=True))
    if engine["Name"] != os.uname().nodename or engine["CgroupVersion"] != "2":
        parser.error("Docker must run on this same Linux host with cgroup v2.")
    if not args.no_systemd and subprocess.check_output(["ps", "-p", "1", "-o", "comm="], text=True).strip() != "systemd":
        parser.error("systemd is required; --no-systemd explicitly omits sandbox validation.")
    groups = load_groups(HERE / "matrix.json")
    if args.group:
        unknown = set(args.group) - {g["id"] for g in groups}
        if unknown:
            parser.error(f"Unknown groups: {sorted(unknown)}")
        groups = [g for g in groups if g["id"] in args.group]
    image = json.loads(subprocess.check_output(["docker", "image", "inspect", args.image], text=True))[0]
    subprocess.run(["docker", "image", "inspect", "postgres:16"], check=True, stdout=subprocess.DEVNULL)
    output = (args.output or HERE / ".runtime" / (time.strftime("%Y%m%d-%H%M%S") + "-" + str(os.getpid()))).resolve()
    output.mkdir(parents=True, exist_ok=False)
    before = fingerprints()
    os.environ.update(BB_TASK_CGROUP_TEST_IMAGE=args.image, BB_TASK_CGROUP_TEST_DATABASE="1")
    os.environ["BB_TASK_CGROUP_TEST_SYSTEMD"] = "0" if args.no_systemd else "1"
    spec = importlib.util.spec_from_file_location("barrier_native_fixture",
        REPO / "deploy/tencent-elasticity/task-cgroup-broker.test.py")
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    summary = {"version": "worker-barrier-results-v1", "synthetic": True,
               "image_id": image["Id"], "source_hashes": before, "systemd": not args.no_systemd,
               "head": args.head or subprocess.check_output(["git", "-C", str(REPO), "rev-parse", "HEAD"], text=True).strip(),
               "groups": [], "status": "running"}
    original_copy = shutil.copyfile

    for iteration in range(1, args.repeat + 1):
        for group in groups:
            label = f'{group["id"]}-{iteration}'
            print(f"\n=== {label} ===", flush=True)
            evidence = {}

            class MatrixCase(fixture.NativeDatabaseTests):
                def setUp(self):
                    def copy(source, destination, *a, **kw):
                        if Path(source) == fixture.HERE / "task-cgroup-database-fixture.mjs":
                            result = original_copy(HERE / "entry.mjs", destination, *a, **kw)
                            original_copy(HERE / "scenario.mjs", Path(destination).parent / "barrier-matrix.test.mjs")
                            (Path(destination).parent / "selected-group.json").write_text(json.dumps(group))
                            return result
                        return original_copy(source, destination, *a, **kw)
                    with patch.object(shutil, "copyfile", side_effect=copy):
                        super().setUp()

                def test_actual_pipeline_and_two_slot_runtime_with_native_peer(self):
                    stdout, _ = self.container.communicate(timeout=120)
                    (output / f"{label}.log").write_text(stdout)
                    for line in stdout.splitlines():
                        text = line[2:] if line.startswith("# ") else line
                        if text.startswith('{"barrier_evidence":'):
                            evidence.update(json.loads(text)["barrier_evidence"])
                    self.assertEqual(self.container.returncode, 0, stdout[-12000:])
                    self.assertIn("# fail 0", stdout)
                    self.assertIn("# skipped 0", stdout)
                    self.assertEqual(evidence.get("status"), "passed")

            result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite([
                MatrixCase("test_actual_pipeline_and_two_slot_runtime_with_native_peer")]))
            record = {"id": group["id"], "iteration": iteration,
                      "status": "passed" if result.wasSuccessful() and result.testsRun == 1
                      and not result.skipped and evidence.get("status") == "passed" else "failed",
                      "skipped": len(result.skipped),
                      "evidence": evidence}
            summary["groups"].append(record)
            (output / f"{label}.json").write_text(json.dumps(record, indent=2))
            (output / "report.json").write_text(json.dumps(summary, indent=2))
            if evidence.get("status") == "passed":
                print(f'C wait={evidence["c_wait_ms"]}ms; earliest peer exit={evidence["earliest_peer_exit_ms"]}ms; '
                      f'A attempts={evidence["a_attempts"]}', flush=True)
    summary["source_unchanged"] = fingerprints() == before
    summary["status"] = "passed" if summary["source_unchanged"] and all(
        g["status"] == "passed" for g in summary["groups"]) else "failed"
    (output / "report.json").write_text(json.dumps(summary, indent=2))
    print(f'\n{summary["status"].upper()}: {len(summary["groups"])} groups. Report: {output / "report.json"}', flush=True)
    return 0 if summary["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
