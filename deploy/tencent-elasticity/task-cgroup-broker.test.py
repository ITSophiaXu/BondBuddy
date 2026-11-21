"""Synthetic local Linux checks. No provider, application DB or production access."""
import importlib.util
import json
import os
import re
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import struct
import sys
from unittest.mock import Mock, patch
import uuid

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("broker", HERE / "task-cgroup-broker.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
runner_spec = importlib.util.spec_from_file_location("runner", HERE / "task-runner.py")
runner_module = importlib.util.module_from_spec(runner_spec)
runner_spec.loader.exec_module(runner_module)


class BrokerUnitTests(unittest.TestCase):
    def test_runner_refuses_a_different_call_generation_before_business_exec(self):
        read_fd, write_fd = os.pipe()
        key, identity = "a" * 64, "synthetic:1:1"
        client = Mock();client.__enter__ = Mock(return_value=client);client.__exit__ = Mock(return_value=False)
        client.recvmsg.return_value = (b'{"status":"move-self"}\n', [(socket.SOL_SOCKET, socket.SCM_RIGHTS, struct.pack("i", write_fd))], 0, None)
        result = {"status": "ok", "key": key, "identity": identity, "sealed": False,
                  "callBinding": {"kind": "call", "parentKey": "b" * 64, "parentIdentity": "synthetic:1:2", "logicalCallId": "chapter-1", "generation": 1}}
        client.recv.return_value = (json.dumps(result) + "\n").encode()
        try:
            with patch.object(runner_module.socket, "socket", return_value=client), \
                    patch.object(sys, "argv", ["runner", key, identity, "--", "/usr/bin/true"]), \
                    patch.dict(os.environ, {"BB_TASK_CALL_PARENT_KEY": "b" * 64, "BB_TASK_CALL_PARENT_IDENTITY": "synthetic:1:2",
                                           "BB_TASK_CALL_LOGICAL_ID": "chapter-1", "BB_TASK_CALL_GENERATION": "2"}), \
                    patch.object(runner_module.os, "execvpe") as execute:
                with self.assertRaisesRegex(RuntimeError, "CALL_BINDING_REFUSED"): runner_module.main()
                execute.assert_not_called()
                with self.assertRaises(OSError): os.fstat(write_fd)
        finally:
            os.close(read_fd)

    def test_call_scope_closes_only_its_generation_and_keeps_parent_open(self):
        with tempfile.TemporaryDirectory(prefix="task-call-unit-") as directory:
            root = Path(directory)
            broker = object.__new__(module.Broker)
            broker.state = broker.root = root
            broker.boot = "synthetic"
            broker.binding = {"context": {"session_id": "session", "identity": {"epoch": "epoch"}}}
            broker.init = {"namespace": "pid:[1]", "group": "/synthetic"}
            broker.worker_file = root / "worker.json"
            worker = {"pid": 10, "start": "10", "parent": 1, "group": "/synthetic", "namespace": "pid:[1]"}
            key = "a" * 64
            parent = root / ("bb-task-" + key)
            parent.mkdir()
            (parent / "cgroup.events").write_text("populated 0\n")
            identity = f"synthetic:{parent.stat().st_dev}:{parent.stat().st_ino}"
            module.save(root / (key + ".json"), {"boot": broker.boot, "context": broker.binding["context"],
                "worker": worker, "identity": identity, "sealed": False, "scope": {"kind": "job", "id": "job", "token": "token"}})
            module.save(broker.worker_file, {"boot": broker.boot, "context": broker.binding["context"], "process": worker})
            original_mkdir = Path.mkdir
            original_rmdir = Path.rmdir
            def create_group(path, *args, **kwargs):
                original_mkdir(path, *args, **kwargs)
                if path.name.startswith("bb-call-"):
                    (path / "cgroup.events").write_text("populated 0\n")
                    (path / "cgroup.kill").write_text("")
            def remove_group(path):
                if path.name.startswith("bb-call-"):
                    for name in ["cgroup.events", "cgroup.kill"]: (path / name).unlink()
                original_rmdir(path)
            request = {"action": "open_call", "key": key, "identity": identity,
                "logicalCallId": "chapter-1", "generation": 1}
            with patch.object(module, "process", return_value=worker), patch.object(module.Broker, "worker", return_value={"process": worker}), \
                    patch.object(module.Broker, "pending_launchers", return_value=0), patch.object(Path, "mkdir", create_group), patch.object(Path, "rmdir", remove_group):
                first = broker.handle(request, 10, 1000)
                closed = broker.handle({"action": "close_call", "key": first["key"], "identity": first["identity"]}, 10, 1000)
                self.assertTrue(closed["sealed"])
                self.assertEqual(closed["nativeProcesses"], 0)
                self.assertFalse(module.private_json(root / (key + ".json"))["sealed"])
                with self.assertRaises(RuntimeError):
                    broker.handle(request, 10, 1000)
                broker.handle({"action": "retire", "key": first["key"], "identity": first["identity"]}, 10, 1000)
                second = broker.handle(dict(request, generation=2), 10, 1000)
                self.assertNotEqual(first["key"], second["key"])
                with self.assertRaises(RuntimeError):
                    broker.handle(dict(request, identity="synthetic:0:0", generation=3), 10, 1000)

    def test_parent_counts_pending_call_launcher_using_trusted_parent_binding(self):
        with tempfile.TemporaryDirectory(prefix="task-call-launcher-") as directory:
            broker = object.__new__(module.Broker)
            broker.state = Path(directory)
            broker.worker_file = broker.state / "worker.json"
            broker.boot = "synthetic"
            broker.binding = {"context": {"session_id": "session"}}
            broker.init = {"pid": 1, "namespace": "pid:[1]", "group": "/synthetic"}
            parent_key, call_key = "a" * 64, "b" * 64
            module.save(broker.worker_file, {"process": {"pid": 10}})
            module.save(broker.state / (parent_key + ".json"), {"boot": broker.boot, "context": broker.binding["context"], "identity": "synthetic:1:1"})
            module.save(broker.state / (call_key + ".json"), {"boot": broker.boot, "context": broker.binding["context"],
                "parent_key": parent_key, "parent_identity": "synthetic:1:1"})
            def read_text(path):
                if str(path) == "/proc/10/task/10/children": return "20"
                if str(path) == "/proc/1/task/1/children": return ""
                return "20 (runner) " + " ".join(["S", "10", *["0"] * 17, "20"])
            peer = {"pid": 20, "start": "20", "namespace": "pid:[1]", "group": "/synthetic", "parent": 10}
            with patch.object(Path, "read_text", read_text), patch.object(module, "process", return_value=peer), \
                    patch.object(Path, "read_bytes", return_value=b"BB_TASK_CGROUP_KEY=" + call_key.encode() + b"\0"):
                self.assertEqual(broker.pending_launchers(parent_key), 1)
                self.assertEqual(broker.pending_launchers(call_key), 1)

    def test_unexpected_capabilities_are_closed_without_exec(self):
        descriptors = [os.open("/dev/null", os.O_WRONLY), os.open("/dev/null", os.O_WRONLY)]
        client = Mock()
        client.__enter__ = Mock(return_value=client)
        client.__exit__ = Mock(return_value=False)
        client.recvmsg.return_value = (b'{"status":"move-self"}\n',
            [(socket.SOL_SOCKET, socket.SCM_RIGHTS, struct.pack("ii", *descriptors))], 0, None)
        with patch.object(runner_module.socket, "socket", return_value=client), \
                patch.object(sys, "argv", ["runner", "a" * 64, "synthetic:1:1", "--", "/usr/bin/true"]), \
                patch.object(runner_module.os, "execvpe") as execute:
            with self.assertRaisesRegex(RuntimeError, "ADMISSION_REFUSED"):
                runner_module.main()
            execute.assert_not_called()
        for descriptor in descriptors:
            with self.assertRaises(OSError):
                os.fstat(descriptor)

    def test_fragmented_admission_closes_cgroup_capability_before_exec(self):
        read_fd, write_fd = os.pipe()
        key, identity = "a" * 64, "synthetic:1:1"
        client = Mock()
        client.__enter__ = Mock(return_value=client)
        client.__exit__ = Mock(return_value=False)
        client.recvmsg.return_value = (b'{"status":"move', [(socket.SOL_SOCKET, socket.SCM_RIGHTS, struct.pack("i", write_fd))], 0, None)
        client.recv.side_effect = [b'-self"}\n', (json.dumps({"status": "ok", "key": key, "identity": identity, "sealed": False}) + "\n").encode()]
        def execute(*args):
            with self.assertRaises(OSError):
                os.fstat(write_fd)
        try:
            with patch.object(runner_module.socket, "socket", return_value=client), \
                    patch.object(sys, "argv", ["runner", key, identity, "--", "/usr/bin/true"]), \
                    patch.object(runner_module.os, "execvpe", side_effect=execute) as exec_mock:
                runner_module.main()
            exec_mock.assert_called_once()
            self.assertEqual(os.read(read_fd, 1), b"0")
        finally:
            os.close(read_fd)
            try:
                os.close(write_fd)
            except OSError:
                pass

    def test_pre_admission_tasks_are_independent_and_unknown_metadata_fails_closed(self):
        with tempfile.TemporaryDirectory(prefix="task-launchers-unit-") as directory:
            broker = object.__new__(module.Broker)
            broker.state = Path(directory)
            broker.worker_file = broker.state / "worker.json"
            broker.init = {"pid": 1, "namespace": "pid:[1]", "group": "/synthetic"}
            module.save(broker.worker_file, {"process": {"pid": 10}})
            key, other = "a" * 64, "b" * 64
            def read_text(path):
                if str(path) == "/proc/10/task/10/children":
                    return "20 21 22"
                if str(path) == "/proc/1/task/1/children":
                    return ""
                pid = int(str(path).split("/")[2])
                return f"{pid} (synthetic) " + " ".join(["Z" if pid == 22 else "S", "10", *["0"] * 17, str(pid)])
            def identity(pid):
                return {"pid": pid, "start": str(pid), "namespace": "pid:[1]", "group": "/synthetic", "parent": 10}
            def environment(path):
                pid = int(str(path).split("/")[2])
                self.assertNotEqual(pid, 22, "nonexecuting zombie needs no environment read")
                return b"BB_TASK_CGROUP_KEY=" + (key if pid == 20 else other).encode() + b"\0"
            with patch.object(Path, "read_text", read_text), patch.object(module, "process", side_effect=identity), patch.object(Path, "read_bytes", environment):
                self.assertEqual(broker.pending_launchers(key), 1)
                self.assertEqual(broker.pending_launchers(other), 1)
                self.assertEqual(broker.pending_launchers("c" * 64), 0)
                with patch.object(Path, "read_bytes", side_effect=PermissionError):
                    with self.assertRaises(PermissionError):
                        broker.pending_launchers(key)
    def test_recycled_peer_is_refused_without_numeric_pid_migration(self):
        with tempfile.TemporaryDirectory(prefix="task-cgroup-unit-") as directory:
            root = Path(directory)
            broker = object.__new__(module.Broker)
            broker.state = root
            broker.root = root
            broker.boot = "synthetic"
            broker.init = {"pid": 1, "start": "1", "group": "/synthetic", "namespace": "pid:[1]"}
            broker.binding = {"context": {"synthetic": True}}
            broker.worker_file = root / "worker.json"
            worker = {"pid": 10, "start": "10", "parent": 1, "group": "/synthetic", "namespace": "pid:[1]"}
            peer = {"pid": 20, "start": "20", "parent": 10, "group": "/synthetic", "namespace": "pid:[1]"}
            key = "a" * 64
            group = root / ("bb-task-" + key)
            group.mkdir()
            (group / "cgroup.procs").write_text("")
            (group / "cgroup.events").write_text("populated 0\n")
            identity = f"synthetic:{group.stat().st_dev}:{group.stat().st_ino}"
            module.save(broker.worker_file, {"boot": "synthetic", "context": broker.binding["context"], "process": worker})
            module.save(root / (key + ".json"), {"boot": "synthetic", "context": broker.binding["context"],
                        "worker": worker, "identity": identity, "sealed": False})
            command = b"/usr/bin/python3\0-I\0/opt/bondbuddy/task-runner.py\0" + key.encode() + b"\0" + identity.encode() + b"\0--\0python3\0"
            moved = dict(peer, start="21", group="/synthetic/bb-task-" + key)
            connection = Mock()
            connection.sendmsg.return_value = len(b'{"status":"move-self"}\n')
            connection.recv.return_value = b'{"moved":true}\n'
            with patch.object(module, "process", side_effect=[peer, worker, moved]), \
                    patch.object(Path, "read_bytes", return_value=command), \
                    patch.object(module.Broker, "trusted_executable"), \
                    patch.object(module.Broker, "trusted_path"):
                with self.assertRaises(RuntimeError):
                    broker.handle({"action": "attach", "key": key, "identity": identity}, 20, 1000, connection)
            connection.sendmsg.assert_called_once()
            self.assertEqual((group / "cgroup.procs").read_text(), "", "broker never writes a supplied numeric PID")
            with patch.object(module.Broker, "pending_launchers", return_value=0):
                self.assertEqual(broker.result(key, {"identity": identity, "sealed": True}, group)["nativeProcesses"], 0)

    def test_unreadable_scope_and_missing_journal_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix="task-cgroup-unit-") as directory:
            broker = object.__new__(module.Broker)
            broker.state = broker.root = Path(directory)
            broker.boot = "synthetic"
            broker.binding = {"context": {}}
            with self.assertRaises(FileNotFoundError):
                broker.task({"key": "a" * 64, "identity": "synthetic:1:1"})
            with self.assertRaises(FileNotFoundError):
                broker.result("a" * 64, {"identity": "synthetic:1:1", "sealed": True}, Path(directory))


@unittest.skipUnless(os.environ.get("BB_TASK_CGROUP_TEST_IMAGE"), "requires explicit existing local Docker worker image")
class NativeCgroupFixture(unittest.TestCase):
    def setUp(self):
        self.assertEqual(os.geteuid(), 0, "local host broker test needs root, not a privileged container")
        self.directory = Path(tempfile.mkdtemp(prefix="task-cgroup-linux-"))
        self.socket_directory = self.directory / "socket"
        self.socket_directory.mkdir(mode=0o750)
        os.chown(self.socket_directory, 0, 1000)
        self.state = self.directory / "state"
        self.state.mkdir(mode=0o700)
        self.name = "bb-task-cgroup-test-" + uuid.uuid4().hex[:12]
        self.context = {"identity": {"account_id": "synthetic", "region": "synthetic", "instance_id": "synthetic-one",
                                    "epoch": str(uuid.uuid4())}, "session_id": str(uuid.uuid4())}
        self.receipts = []
        self.broker = None
        self.unit = None
        runner = self.directory / "task-runner.py"
        shutil.copyfile(HERE / "task-runner.py", runner)
        runner.chmod(0o644)
        database = getattr(self, "database", False)
        extra = []
        if database:
            repository = HERE.parent.parent
            worker_dist = self.directory / "worker-dist"
            shutil.copytree(repository / "apps/worker/dist", worker_dist)
            shutil.copyfile(worker_dist / "runtime.js", worker_dist / "runtime-impl.js")
            shutil.copyfile(HERE / "task-cgroup-database-fixture.mjs", worker_dist / "runtime.js")
            extra += ["-v", f"{worker_dist}:/app/apps/worker/dist:ro"]
            for path in ["apps/api/dist", "packages/contracts/dist", "packages/domain/dist", "packages/rule-applicability-context/dist", "packages/rule-pack-registry/dist",
                         "apps/worker/src/fixtures", "deploy/m1/security/managed-model-activity-grants.sql"]:
                self.assertTrue((repository / path).exists(), f"build/missing fixture prerequisite: {path}")
                extra += ["-v", f"{repository / path}:/app/{path}:ro"]
            extra += ["-e", f"BB_SYNTHETIC_TASK_CGROUP_CONTEXT={json.dumps(self.context)}",
                      "-e", f"BB_TEST_DATABASE_URL=postgresql://postgres@{self.postgres}/bondbuddy_fixture"]
        fixture = "task-cgroup-database-fixture.mjs" if database else "task-cgroup-fixture.mjs"
        self.container = subprocess.Popen([
            "docker", "run", "--name", self.name, "--pull", "never", "-i", "--init", "--read-only",
            "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--network", getattr(self, "network", "none"), "--pids-limit", "128",
            "-v", f"{self.socket_directory}:/run/bondbuddy/task-cgroups:ro",
            "-v", f"{runner}:/opt/bondbuddy/task-runner.py:ro",
            *extra, *([] if database else ["-v", f"{HERE / fixture}:/app/apps/worker/dist/runtime.js:ro"]),
            "--entrypoint", "node", os.environ["BB_TASK_CGROUP_TEST_IMAGE"], "apps/worker/dist/runtime.js",
        ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.addCleanup(self.cleanup)
        self.assertEqual(json.loads(self.container.stdout.readline()), {"boot": True})
        status = json.loads(subprocess.check_output(["docker", "inspect", "--format", "{{json .State}}", self.name]))
        init = module.process(status["Pid"])
        self.group = Path("/sys/fs/cgroup" + init["group"])
        module.save(self.state / "binding.json", {"pid": init["pid"], "start": init["start"],
                    "group": init["group"], "context": self.context})
        self.start_broker()
        if not database:
            self.assertEqual(self.call({"action": "register", "context": self.context})["status"], "ok")

    def start_broker(self):
        command = ["/usr/bin/python3", "-I", str(HERE / "task-cgroup-broker.py"),
                   str(self.state / "binding.json"), str(self.state), str(self.socket_directory / "broker.sock")]
        if os.environ.get("BB_TASK_CGROUP_TEST_SYSTEMD") == "1":
            self.unit = self.name + "-broker"
            properties = ["NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes",
                          "ProtectKernelTunables=yes", "ProtectKernelModules=yes", "ProtectKernelLogs=yes",
                          "InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -/run/containerd -/etc/bondbuddy",
                          "RestrictNamespaces=yes", "RestrictSUIDSGID=yes",
                          "ReadOnlyPaths=/sys/fs/cgroup",
                          f"ReadWritePaths={self.group} {self.state} {self.socket_directory}",
                          f"BindPaths={self.directory}", "UMask=0077",
                          "CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_FOWNER CAP_SYS_PTRACE",
                          "RestrictAddressFamilies=AF_UNIX", "LockPersonality=yes"]
            # Test-only bind exposes the disposable /tmp fixture through PrivateTmp.
            # No AppArmor property here: this measures the systemd sandbox, not LSM enforcement.
            command = ["systemd-run", "--quiet", "--wait", "--pipe", "--collect", "--unit", self.unit,
                       *[f"--property={item}" for item in properties], "--", *command]
        self.broker = subprocess.Popen(command)
        for _ in range(500):
            if self.broker.poll() is not None:
                self.fail("trusted broker exited")
            if (self.socket_directory / "broker.sock").exists():
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                    try:
                        probe.connect(str(self.socket_directory / "broker.sock"))
                    except (ConnectionRefusedError, FileNotFoundError):
                        pass
                    else:
                        return
            time.sleep(0.01)
        self.fail("trusted broker unavailable")

    def stop_broker(self):
        if self.broker is not None:
            if self.unit is not None:
                stopped = subprocess.run(["systemctl", "stop", self.unit], capture_output=True, text=True)
                if stopped.returncode != 0:
                    self.assertEqual(stopped.returncode, 5, stopped.stderr)
                    # --collect can unload a broker that positively exited with its init.
                    self.assertEqual(self.broker.wait(timeout=5), 0, "missing unit is not proof of a clean broker exit")
            else:
                self.broker.terminate()
            self.broker.wait(timeout=5)
            self.broker = None

    def cleanup(self):
        self.stop_broker()
        if self.container.poll() is None:
            subprocess.run(["docker", "kill", self.name], stdout=subprocess.DEVNULL, check=True)
        self.container.wait(timeout=10)
        keys = {receipt["key"] for receipt in self.receipts}
        keys.update(path.name[:-5] for path in self.state.iterdir() if re.fullmatch(r"[a-f0-9]{64}\.json", path.name))
        paths = []
        for key in keys:
            row = module.private_json(self.state / (key + ".json"))
            path = self.group / ("bb-task-" + key)
            if row.get("parent_key"):
                self.assertRegex(row["parent_key"], r"^[a-f0-9]{64}$")
                path = self.group / ("bb-task-" + row["parent_key"]) / ("bb-call-" + key)
            self.assertTrue(path.is_relative_to(self.group))
            paths.append(path)
        for path in sorted(paths, key=lambda path: len(path.parts), reverse=True):
            if path.exists():
                path.rmdir()
        subprocess.run(["docker", "rm", self.name], stdout=subprocess.DEVNULL, check=True)
        if not self.container.stdin.closed:
            self.container.stdin.close()
        if not self.container.stdout.closed:
            self.container.stdout.close()
        shutil.rmtree(self.directory)

    def call(self, request):
        self.container.stdin.write(json.dumps(request) + "\n")
        self.container.stdin.flush()
        response = json.loads(self.container.stdout.readline())
        self.assertNotIn("fixtureError", response)
        return response

    def scope(self, name, token="attempt-1", kind="job"):
        result = self.call({"action": "open", "scope": {"kind": kind, "id": name, "token": token}})
        self.assertEqual(result["status"], "ok")
        self.receipts.append(result)
        return result

    def proof(self, receipt, action="inspect"):
        return self.call({"action": action, "key": receipt["key"], "identity": receipt["identity"]})

    def launch(self, receipt, script):
        return self.call({"action": "spawn", "receipt": receipt, "command": ["/usr/bin/python3", "-c", script]})

@unittest.skipUnless(os.environ.get("BB_TASK_CGROUP_TEST_IMAGE"), "requires explicit existing local Docker worker image")
class NativeCgroupTests(NativeCgroupFixture):
    def test_chapter_orphan_close_keeps_parent_open_and_late_runner_is_refused(self):
        parent = self.scope("chapter-job")
        call_request = {"action": "open_call", "key": parent["key"], "identity": parent["identity"], "logicalCallId": "chapter-1", "generation": 1}
        first = self.call(call_request)
        self.assertEqual(first["status"], "ok")
        orphan = self.launch(first, "import os,time\npid=os.fork()\nif pid==0:\n os.setsid();os.close(1);os.close(2);time.sleep(120)\nelse: print(pid,flush=True)\n")
        self.assertEqual(orphan["code"], 0)
        self.assertEqual(self.proof(parent, "inspect_live")["nativeProcesses"], 1)
        for _ in range(100):
            closed = self.proof(first, "close_call")
            if closed["nativeProcesses"] == 0: break
            time.sleep(0.02)
        self.assertEqual(closed["nativeProcesses"], 0)
        self.assertTrue(closed["sealed"])
        self.assertFalse(self.proof(parent, "inspect_live")["sealed"])
        self.assertEqual(self.launch(first, "print('late-business-code')")["code"], 78)
        self.assertEqual(self.proof(first, "retire")["nativeProcesses"], 0)
        second = self.call(dict(call_request, logicalCallId="chapter-2"))
        self.assertEqual(second["status"], "ok")
        self.assertEqual(self.launch(second, "print('next-chapter')")["stdout"].strip(), "next-chapter")
        self.assertEqual(self.proof(second, "close_call")["nativeProcesses"], 0)
        self.assertEqual(self.proof(second, "retire")["nativeProcesses"], 0)
        self.assertEqual(self.proof(parent, "seal")["nativeProcesses"], 0)
        self.assertEqual(self.proof(parent, "retire")["nativeProcesses"], 0)

    def test_orphan_setsid_multiple_calls_independent_tasks_and_restart(self):
        a = self.scope("A")
        orphan_script = ("import os,time\npid=os.fork()\nif pid==0:\n os.setsid();os.close(1);os.close(2);time.sleep(120)\n"
                         "else: print(pid,flush=True)\n")
        first, second = self.launch(a, orphan_script), self.launch(a, orphan_script)
        self.assertEqual(first["code"], 0)
        self.assertEqual(second["code"], 0)
        pids = [int(first["stdout"]), int(second["stdout"])]
        self.assertEqual(self.proof(a, "seal")["nativeProcesses"], 1)
        b = self.scope("B")
        descriptor_check = ("import os\nfor name in os.listdir('/proc/self/fd'):\n"
                            " try: target=os.readlink('/proc/self/fd/'+name)\n"
                            " except FileNotFoundError: continue\n"
                            " assert 'cgroup.procs' not in target, 'admission capability leaked into exec'\n"
                            "print('B executed')\n")
        self.assertEqual(self.launch(b, descriptor_check)["stdout"].strip(), "B executed")
        self.assertEqual(self.proof(b, "seal")["nativeProcesses"], 0)
        self.assertEqual(self.proof(a)["nativeProcesses"], 1, "Codex/Python parent exit is not orphan exit")
        attempt = self.scope("A", "attempt-2")
        self.assertEqual(self.launch(attempt, "print('separate exact attempt')")["code"], 0)
        self.assertEqual(self.proof(attempt, "seal")["nativeProcesses"], 0)
        self.assertEqual(self.call({"action": "child", "request": {"action": "register", "context": self.context}})["status"], "blocked")
        wrong = dict(self.context, session_id=str(uuid.uuid4()))
        self.assertEqual(self.call({"action": "register", "context": wrong})["status"], "blocked")
        late = self.launch(b, "print('UNSAFE')")
        self.assertEqual(late["code"], 78)
        self.assertNotIn("UNSAFE", late["stdout"])
        self.assertEqual(self.proof(b)["nativeProcesses"], 0)
        self.stop_broker()
        self.start_broker()
        self.assertEqual(self.proof(a)["nativeProcesses"], 1, "broker restart retains the sealed native receipt")
        for pid in pids:
            program = f"const f=require('fs');const s=f.readFileSync('/proc/{pid}/stat','utf8');if(+s.slice(s.lastIndexOf(')')+2).split(' ')[1]!==1)throw Error('not init orphan');process.kill({pid},'SIGTERM');"
            subprocess.run(["docker", "exec", self.name, "node", "-e", program], check=True)
        for _ in range(100):
            if self.proof(a)["nativeProcesses"] == 0:
                break
            time.sleep(0.01)
        self.assertEqual(self.proof(a)["nativeProcesses"], 0)
        # Deleting/recreating the exact path is not an empty completion receipt.
        path = self.group / ("bb-task-" + a["key"])
        path.rmdir()
        self.assertEqual(self.proof(a)["status"], "blocked")
        path.mkdir()
        self.assertEqual(self.proof(a)["status"], "blocked")
        self.assertEqual(self.proof(b)["nativeProcesses"], 0, "bad A inventory does not block clean B")
        self.assertEqual(self.proof(b, "retire")["status"], "ok")
        self.assertEqual(self.proof(b, "retire")["status"], "ok", "lost retirement reply is idempotent")
        self.assertEqual(self.proof(b)["status"], "blocked")


@unittest.skipUnless(os.environ.get("BB_TASK_CGROUP_TEST_IMAGE") and os.environ.get("BB_TASK_CGROUP_TEST_DATABASE") == "1",
                     "requires explicit disposable PostgreSQL fixture opt-in")
class NativeDatabaseTests(NativeCgroupFixture):
    database = True

    def setUp(self):
        self.network = "bb-task-sql-" + uuid.uuid4().hex[:12]
        self.postgres = self.network + "-pg"
        subprocess.run(["docker", "network", "create", "--internal", self.network], check=True, stdout=subprocess.DEVNULL)
        self.addCleanup(self.cleanup_database)
        subprocess.run(["docker", "run", "-d", "--pull", "never", "--name", self.postgres, "--network", self.network,
                        "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=bondbuddy_fixture", "postgres:16"],
                       check=True, stdout=subprocess.DEVNULL)
        for _ in range(100):
            ready = subprocess.run(["docker", "exec", self.postgres, "pg_isready", "-U", "postgres"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if ready.returncode == 0:
                break
            time.sleep(0.1)
        self.assertEqual(ready.returncode, 0)
        repository = HERE.parent.parent
        self.migrations = Path(tempfile.mkdtemp(prefix="task-cgroup-migrations-"))
        self.migrations.chmod(0o755)
        self.addCleanup(shutil.rmtree, self.migrations)
        # Windows checkouts may use CRLF. PostgreSQL function-text migrations
        # require the repository's Linux LF bytes in this disposable template.
        for source in (repository / "db/migrations").iterdir():
            if source.suffix == ".sql":
                (self.migrations / source.name).write_text(source.read_text())
        migrated = subprocess.run(["docker", "run", "--rm", "--pull", "never", "--network", self.network,
                                   "-e", f"DATABASE_URL=postgresql://postgres@{self.postgres}/bondbuddy_fixture",
                                   "-v", f"{self.migrations}:/app/db/migrations:ro",
                                   "-v", f"{repository / 'db/migrate.mjs'}:/app/db/migrate.mjs:ro",
                                   "--entrypoint", "node", os.environ["BB_TASK_CGROUP_TEST_IMAGE"], "db/migrate.mjs"],
                                  text=True, capture_output=True, timeout=120)
        self.assertEqual(migrated.returncode, 0, migrated.stderr)
        super().setUp()

    def cleanup_database(self):
        subprocess.run(["docker", "rm", "-f", "-v", self.postgres], stdout=subprocess.DEVNULL, check=True)
        subprocess.run(["docker", "network", "rm", self.network], stdout=subprocess.DEVNULL, check=True)

    def test_actual_pipeline_and_two_slot_runtime_with_native_peer(self):
        stdout, _ = self.container.communicate(timeout=120)
        self.assertEqual(self.container.returncode, 0, stdout[-15000:])
        self.assertIn("# fail 0", stdout)
        self.assertIn("# skipped 0", stdout)
        self.assertIn("actual two-slot runtime retries a clean A while B stays running", stdout)


if __name__ == "__main__":
    unittest.main()
