"""Real disposable PG+cgroup fixture; synthetic JSON provider, no cloud/models."""
import argparse
import importlib.util
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tempfile
import unittest
import uuid
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent

def copy_tracked_deployment_sources(relative, destination):
    """Copy only tracked verification sources, never local bundle/runtime data."""
    marker = REPO / ".git"
    git_directory = marker
    if marker.is_file():
        pointer = marker.read_text().removeprefix("gitdir:").strip().replace("\\", "/")
        if re.match(r"^[A-Za-z]:/", pointer): pointer = "/mnt/" + pointer[0].lower() + pointer[2:]
        git_directory = Path(pointer) if Path(pointer).is_absolute() else REPO / pointer
    listed = subprocess.check_output(["git", "--git-dir", str(git_directory), "--work-tree", str(REPO), "ls-files", "-z", "--", relative]).decode().split("\0")
    destination.mkdir(parents=True, exist_ok=True)
    for name in filter(None, listed):
        path = PurePosixPath(name).relative_to(relative)
        if relative == "deploy/tencent-elasticity" and len(path.parts) != 1: continue
        if path.suffix not in (".mjs", ".py", ".sql", ".json", ".md", ".sh"): continue
        source = (REPO / name).resolve()
        if not source.is_relative_to(REPO.resolve()) or not source.is_file(): raise ValueError("Tracked verification source escaped repository")
        target = destination / str(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--suite", choices=["workflow", "managed-recovery", "retention", "demand", "postgres"], default="workflow")
    parser.add_argument("--case", choices=["all", "controlled", "delivery", "direct"], default="all")
    parser.add_argument("--test-file", action="append", default=[], help="Explicit repo-relative API/worker dist test or db PostgreSQL test (postgres suite only).")
    args = parser.parse_args()
    if args.suite == "postgres" and not args.test_file: parser.error("postgres suite requires at least one --test-file")
    if args.suite != "postgres" and args.test_file: parser.error("--test-file is only valid for postgres suite")
    for value in args.test_file:
        path = PurePosixPath(value)
        allowed = re.fullmatch(r"apps/(?:api|worker)/dist/[a-zA-Z0-9._-]+\.test\.js|db/[a-zA-Z0-9._-]+\.pg\.test\.mjs", value)
        resolved = (REPO / value).resolve()
        if not allowed or path.is_absolute() or any(part in (".", "..") for part in path.parts) or path.as_posix() != value or not resolved.is_relative_to(REPO.resolve()) or not resolved.is_file():
            parser.error(f"Not an existing repository test in the permitted API/worker/db paths: {value}")
    if len(args.test_file) != len(set(args.test_file)): parser.error("Duplicate --test-file would repeat the test denominator")
    if os.geteuid() != 0: parser.error("Use the local WSL Linux Docker host as root.")
    subprocess.run(["docker", "image", "inspect", args.image], check=True, stdout=subprocess.DEVNULL)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    os.environ.update(BB_TASK_CGROUP_TEST_IMAGE=args.image, BB_TASK_CGROUP_TEST_DATABASE="1", BB_TASK_CGROUP_TEST_SYSTEMD="0")
    # The native fixture's opt-in decorators evaluate at import time.
    spec = importlib.util.spec_from_file_location("workflow_native", REPO / "deploy/tencent-elasticity/task-cgroup-broker.test.py")
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    original_copy, original_popen = shutil.copyfile, subprocess.Popen
    def postgres_entry(case):
        # The original API demand test requires the real node --test process.
        # It does not enroll a model runtime; copying sources to native Linux
        # files isolates Windows mount latency without changing its 30s budget.
        case.directory = Path(tempfile.mkdtemp(prefix="workflow-postgres-native-"))
        case.directory.chmod(0o755)
        case.name = "bb-workflow-postgres-" + uuid.uuid4().hex[:12]
        mounts = []
        paths = ["apps/api/dist", "apps/api/package.json", "apps/worker/dist", "apps/worker/package.json", "python", "knowledge/workpaper-templates"]
        if args.suite == "postgres": paths += ["db", "apps/worker/src/fixtures", "apps/worker/test-fixtures", "deploy/m1/security", "deploy/m1/scripts", "deploy/tencent-elasticity"]
        paths += [f"packages/{package}/{part}" for package in ["contracts", "domain", "rule-applicability-context", "rule-pack-registry"] for part in ["dist", "package.json"]]
        for relative in paths:
            source, destination = REPO / relative, case.directory / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            if relative.startswith("deploy/"):
                copy_tracked_deployment_sources(relative, destination)
            elif source.is_dir(): shutil.copytree(source, destination)
            else: shutil.copyfile(source, destination)
            mounts += ["-v", f"{destination}:/app/{relative}:ro"]
        test_files = args.test_file if args.suite == "postgres" else ["apps/api/dist/execution-capacity-demand.pg.test.js"]
        network, test_database = case.network, f"postgresql://postgres@{case.postgres}/bondbuddy_fixture"
        if args.suite == "postgres":
            # The restore regression deliberately accepts only a named local
            # synthetic template. Share this disposable PG network namespace
            # instead of weakening that test's target guard.
            subprocess.run(["docker", "exec", case.postgres, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "CREATE DATABASE bb_middle_template_native TEMPLATE bondbuddy_fixture"], check=True, stdout=subprocess.DEVNULL)
            network, test_database = f"container:{case.postgres}", "postgresql://postgres@127.0.0.1/bb_middle_template_native"
        machine_id = case.directory / "synthetic-machine-id"
        machine_id.write_text(uuid.uuid4().hex + "\n")
        machine_id.chmod(0o444)
        mounts += ["-v", f"{machine_id}:/etc/machine-id:ro"]
        case.container = original_popen([
            "docker", "run", "--name", case.name, "--pull", "never", "-i", "--init", "--read-only",
            "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--network", network, "--pids-limit", "128", "--tmpfs", "/tmp:rw,mode=1777,size=536870912",
            "-e", f"BB_TEST_DATABASE_URL={test_database}",
            "-e", "BONDBUDDY_WORD_PYTHON=/opt/venv/bin/python", *mounts,
            "--entrypoint", "node", args.image, "--test", "--test-concurrency=1", *test_files,
        ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        def cleanup():
            if case.container.poll() is None:
                subprocess.run(["docker", "kill", case.name], check=True, stdout=subprocess.DEVNULL)
            case.container.wait(timeout=10)
            subprocess.run(["docker", "rm", case.name], check=True, stdout=subprocess.DEVNULL)
            case.container.stdin.close()
            case.container.stdout.close()
            shutil.rmtree(case.directory)
        case.addCleanup(cleanup)
    class WorkflowCase(fixture.NativeDatabaseTests):
        def setUp(self):
            if args.suite in ("demand", "postgres"):
                with patch.object(fixture.NativeCgroupFixture, "setUp", postgres_entry):
                    super().setUp()
                return
            def copy(source, destination, *a, **kw):
                if args.suite in ("workflow","retention") and Path(source) == fixture.HERE / "task-cgroup-database-fixture.mjs":
                    return original_copy(HERE / ("retention-entry.mjs" if args.suite=="retention" else "workflow-entry.mjs"), destination, *a, **kw)
                return original_copy(source, destination, *a, **kw)
            def popen(command, *a, **kw):
                if isinstance(command, list) and command[:2] == ["docker", "run"] and "apps/worker/dist/runtime.js" in command:
                    index = command.index("--entrypoint")
                    command = command[:index] + [
                        "--tmpfs", "/tmp:rw,mode=1777,size=536870912",
                        "-v", f"{REPO / 'apps/api/package.json'}:/app/apps/api/package.json:ro",
                        "-v", f"{REPO / 'packages'}:/app/packages:ro",
                        "-v", f"{REPO / 'apps/worker/test-fixtures'}:/app/apps/worker/test-fixtures:ro",
                        "-v", f"{REPO / 'python'}:/app/python:ro",
                        "-e", "BONDBUDDY_WORD_PYTHON=/opt/venv/bin/python",
                        "-e", f"BB_WORKFLOW_NATIVE_CASE={args.case}",
                        *(["-e",f"BB_RETENTION_NATIVE_CASE={self.retention_case}"] if args.suite=="retention" else []),
                    ] + command[index:]
                return original_popen(command, *a, **kw)
            with patch.object(shutil, "copyfile", side_effect=copy), patch.object(subprocess, "Popen", side_effect=popen):
                super().setUp()
        def test_workflow(self):
            stdout, _ = self.container.communicate(timeout=300)
            if args.suite=="retention":
                with args.output.open('a') as evidence: evidence.write(stdout+'\n')
            else: args.output.write_text(stdout)
            self.assertEqual(self.container.returncode, 0, stdout[-18000:])
            self.assertIn("# fail 0", stdout)
            self.assertIn("# skipped 0", stdout)
            if args.suite == "demand": self.assertIn("# tests 1", stdout)
            if args.suite == "retention": self.assertIn("# tests 1", stdout)
    cases=[]
    if args.suite=="retention":
        args.output.write_text('')
        for name in ('pending','unreadable','admission'):
            case=WorkflowCase('test_workflow');case.retention_case=name;cases.append(case)
    else:cases=[WorkflowCase('test_workflow')]
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(cases))
    return 0 if result.wasSuccessful() and not result.skipped else 1

if __name__ == "__main__": raise SystemExit(main())
