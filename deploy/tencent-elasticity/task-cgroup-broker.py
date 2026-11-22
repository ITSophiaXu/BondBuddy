#!/usr/bin/python3
"""Root-owned containment; only an owned, durably sealed call subtree may be killed."""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import sys


def require(condition):
    if not condition:
        raise RuntimeError("TASK_CGROUP_REFUSED")


def private_json(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o077 == 0)
    with path.open("r") as stream:
        return json.load(stream)


def save(path, value):
    temporary = path.with_name(path.name + ".new")
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        # A failed write is not a completion receipt. Keep a displaced .new for recovery.
        raise


def process(pid):
    raw = Path(f"/proc/{pid}/stat").read_text()
    fields = raw[raw.rfind(")") + 2:].split()
    require(len(fields) >= 20 and fields[19].isdigit())
    cgroups = Path(f"/proc/{pid}/cgroup").read_text().splitlines()
    require(len(cgroups) == 1 and cgroups[0].startswith("0::/"))
    return {"pid": pid, "start": fields[19], "parent": int(fields[1]),
            "namespace": os.readlink(f"/proc/{pid}/ns/pid"),
            "group": cgroups[0][3:]}

def frame(connection):
    data = b""
    while not data.endswith(b"\n"):
        chunk = connection.recv(4096)
        require(chunk and len(data) + len(chunk) <= 4096)
        data += chunk
    return data


class Broker:
    def __init__(self, binding, state):
        self.binding = binding
        self.state = state
        self.boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        require(re.fullmatch(r"[a-f0-9-]+", self.boot) is not None)
        self.init = process(binding["pid"])
        require(self.init["start"] == binding["start"] and self.init["group"] == binding["group"])
        group = binding["group"]
        require(group.startswith("/") and group != "/" and ".." not in group.split("/"))
        self.root = Path("/sys/fs/cgroup" + group)
        require(self.root.resolve() == self.root and (self.root / "cgroup.events").is_file())
        require(self.root.stat().st_uid == 0 and self.root.stat().st_mode & 0o022 == 0)
        self.worker_file = state / "worker.json"

    def worker(self, peer):
        saved = private_json(self.worker_file)
        require(saved["boot"] == self.boot and saved["context"] == self.binding["context"])
        identity = saved["process"]
        live = process(identity["pid"])
        require(live["start"] == identity["start"] and live["namespace"] == self.init["namespace"] and live["group"] == self.init["group"])
        require(peer["pid"] == live["pid"] and peer["start"] == live["start"])
        return saved

    def task(self, request, allow_retired=False):
        key = request.get("key")
        require(isinstance(key, str) and re.fullmatch(r"[a-f0-9]{64}", key) is not None)
        row = private_json(self.state / (key + ".json"))
        require(row["boot"] == self.boot and row["context"] == self.binding["context"])
        require(row["identity"] == request.get("identity"))
        if row.get("parent_key"):
            parent_key, parent, parent_group = self.task({"key": row["parent_key"], "identity": row["parent_identity"]})
            require(parent_key != key and parent["worker"] == row["worker"] and not parent.get("parent_key"))
            group = parent_group / ("bb-call-" + key)
        else:
            group = self.root / ("bb-task-" + key)
        if allow_retired and row.get("empty_proven") is True and not group.exists():
            require(row["sealed"])
            return key, row, group
        if row.get("retired"):
            require(allow_retired and row["sealed"] and row.get("empty_proven") is True and not group.exists())
            return key, row, group
        info = group.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o022 == 0)
        require(row["identity"] == f"{self.boot}:{info.st_dev}:{info.st_ino}")
        return key, row, group

    def result(self, key, row, group):
        # populated covers descendants and sub-cgroups, including init orphans
        # and setsid. It excludes zombies that can no longer execute.
        events = dict(line.split() for line in (group / "cgroup.events").read_text().splitlines())
        require(events.get("populated") in ("0", "1"))
        result = {"status": "ok", "key": key, "identity": row["identity"],
                  "sealed": row["sealed"], "nativeProcesses": int(events["populated"]) or self.pending_launchers(key)}
        if row.get("parent_key"):
            result["callBinding"] = row["scope"]
        return result

    def pending_launchers(self, key):
        saved = private_json(self.worker_file)
        count = 0
        keys = {key}
        parent_path = self.state / (key + ".json")
        if parent_path.exists():
            parent = private_json(parent_path)
            for path in self.state.glob("*.json"):
                if re.fullmatch(r"[a-f0-9]{64}\.json", path.name):
                    row = private_json(path)
                    if row.get("parent_key") == key:
                        require(row["boot"] == self.boot and row["context"] == self.binding["context"] and
                                row["parent_identity"] == parent["identity"])
                        keys.add(path.stem)
        # Before admission the immutable runner cannot fork or exec business
        # code. It is a direct worker child, or an init-adopted orphan. Account
        # for that pre-move window as well as the populated task subtree.
        for parent in {saved["process"]["pid"], self.init["pid"]}:
            children = Path(f"/proc/{parent}/task/{parent}/children").read_text().split()
            require(all(child.isdigit() for child in children))
            for child in children:
                pid = int(child)
                if pid == saved["process"]["pid"]:
                    continue
                try:
                    before = process(pid)
                    if before["namespace"] != self.init["namespace"] or before["group"] != self.init["group"]:
                        continue
                    raw = Path(f"/proc/{pid}/stat").read_text()
                    fields = raw[raw.rfind(")") + 2:].split()
                    require(fields[19] == before["start"])
                    if fields[0] in ("Z", "X"):
                        continue
                    environment = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
                    tags = [entry[19:] for entry in environment if entry.startswith(b"BB_TASK_CGROUP_KEY=")]
                    require(len(tags) == 1 and re.fullmatch(b"[a-f0-9]{64}", tags[0]) is not None)
                    require(process(pid) == before)
                    count += int(tags[0].decode() in keys)
                except FileNotFoundError:
                    # The inspected pre-admission process has exited; any
                    # admitted descendants are already in the task subtree.
                    continue
        return count

    def handle(self, request, pid, uid, connection=None):
        require(uid == 1000 and isinstance(request, dict))
        peer = process(pid)
        require(peer["namespace"] == self.init["namespace"])
        action = request.get("action")
        if action == "register":
            require(request.get("context") == self.binding["context"])
            require(peer["group"] == self.init["group"] and (pid == self.init["pid"] or peer["parent"] == self.init["pid"]))
            command = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
            require(command in ([b"node", b"apps/worker/dist/runtime.js", b""],
                                [b"/usr/local/bin/node", b"apps/worker/dist/runtime.js", b""]))
            self.trusted_executable(pid, "/usr/local/bin/node")
            row = {"boot": self.boot, "context": self.binding["context"], "process": peer}
            if self.worker_file.exists():
                require(private_json(self.worker_file) == row)
            else:
                save(self.worker_file, row)
            return {"status": "ok", "key": "0" * 64, "identity": f"{self.boot}:0:0", "sealed": False, "nativeProcesses": 0}
        if action == "open":
            worker = self.worker(peer)
            scope = request.get("scope")
            require(isinstance(scope, dict) and set(scope) == {"kind", "id", "token"})
            require(scope["kind"] in ("job", "assistant", "background") and
                    all(isinstance(scope[field], str) and re.fullmatch(r"[A-Za-z0-9_-]{1,180}", scope[field]) for field in ("id", "token")))
            key = hashlib.sha256(json.dumps(scope, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()
            group = self.root / ("bb-task-" + key)
            # Never adopt an unknown/recreated group or reuse a sealed execution.
            require(not group.exists() and not (self.state / (key + ".json")).exists())
            group.mkdir(mode=0o755)
            info = group.stat()
            row = {"boot": self.boot, "context": self.binding["context"], "worker": worker["process"],
                   "identity": f"{self.boot}:{info.st_dev}:{info.st_ino}", "sealed": False, "scope": scope}
            save(self.state / (key + ".json"), row)
            return self.result(key, row, group)
        if action == "open_call":
            worker = self.worker(peer)
            parent_key, parent, parent_group = self.task(request)
            require(parent["worker"] == worker["process"] and not parent["sealed"] and not parent.get("parent_key") and
                    parent.get("scope", {}).get("kind") in ("job", "assistant"))
            logical = request.get("logicalCallId")
            generation = request.get("generation")
            require(isinstance(logical, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", logical) and
                    type(generation) is int and 1 <= generation <= 2147483647)
            scope = {"kind": "call", "parentKey": parent_key, "parentIdentity": parent["identity"],
                     "logicalCallId": logical, "generation": generation}
            key = hashlib.sha256(json.dumps(scope, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()
            group = parent_group / ("bb-call-" + key)
            require(not group.exists() and not (self.state / (key + ".json")).exists())
            group.mkdir(mode=0o755)
            info = group.stat()
            row = {"boot": self.boot, "context": self.binding["context"], "worker": worker["process"], "scope": scope,
                   "parent_key": parent_key, "parent_identity": parent["identity"],
                   "identity": f"{self.boot}:{info.st_dev}:{info.st_ino}", "sealed": False}
            save(self.state / (key + ".json"), row)
            return self.result(key, row, group)
        key, row, group = self.task(request, allow_retired=action == "retire")
        if action == "attach":
            saved = private_json(self.worker_file)
            worker = process(saved["process"]["pid"])
            require(saved["boot"] == self.boot and saved["context"] == self.binding["context"])
            require(worker == row["worker"] and worker["group"] == self.init["group"])
            require(peer["parent"] == worker["pid"] and peer["group"] == self.init["group"] and not row["sealed"])
            if row.get("parent_key"):
                _, parent, _ = self.task({"key": row["parent_key"], "identity": row["parent_identity"]})
                require(not parent["sealed"])
            command = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
            require(command[:3] == [b"/usr/bin/python3", b"-I", b"/opt/bondbuddy/task-runner.py"] and
                    command[3:6] == [key.encode(), row["identity"].encode(), b"--"])
            self.trusted_executable(pid, "/usr/bin/python3")
            self.trusted_path(pid, "/opt/bondbuddy/task-runner.py")
            require(connection is not None)
            # The immutable runner writes PID 0 with this *one destination*
            # capability, then closes it before exec. A dying/recycled peer can
            # never cause the broker to move another numeric PID.
            descriptor = os.open(group / "cgroup.procs", os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
            try:
                message = b'{"status":"move-self"}\n'
                sent = connection.sendmsg([message], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, struct.pack("i", descriptor))])
                require(isinstance(sent, int) and 0 < sent <= len(message))
                if sent < len(message):
                    connection.sendall(message[sent:])
                require(frame(connection) == b'{"moved":true}\n')
                moved = process(pid)
                require(moved["start"] == peer["start"] and
                        moved["namespace"] == peer["namespace"] and moved["group"] == str(group).removeprefix("/sys/fs/cgroup"))
            finally:
                os.close(descriptor)
            return self.result(key, row, group)

        self.worker(peer)
        require(row["worker"] == peer)
        if action == "retire":
            require(row["sealed"])
            if row.get("empty_proven") is True and not group.exists():
                if not row.get("retired"):
                    row["retired"] = True
                    save(self.state / (key + ".json"), row)
                return {"status": "ok", "key": key, "identity": row["identity"], "sealed": True, "nativeProcesses": 0}
            result = self.result(key, row, group)
            require(result["nativeProcesses"] == 0)
            # Persist a positive proof before removal. A lost reply is only
            # idempotent for this exact durable tombstone and absent group.
            row["empty_proven"] = True
            save(self.state / (key + ".json"), row)
            group.rmdir()
            row["retired"] = True
            save(self.state / (key + ".json"), row)
            return result
        if action in ("seal", "close_call"):
            if action == "close_call":
                require(row.get("parent_key") is not None)
            if not row["sealed"]:
                row["sealed"] = True
                save(self.state / (key + ".json"), row)
            if action == "close_call":
                # No caller PID/path can select the target. task() bound the exact
                # original parent, call inode, boot, epoch, session and worker.
                descriptor = os.open(group / "cgroup.kill", os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
                try:
                    os.write(descriptor, b"1")
                finally:
                    os.close(descriptor)
        else:
            require(action == "inspect_live" or action == "inspect" and row["sealed"])
        return self.result(key, row, group)


    def trusted_path(self, pid, path):
        current = Path(f"/proc/{pid}/root")
        for part in path.strip("/").split("/"):
            current = current / part
            info = current.stat()
            require(info.st_uid == 0 and info.st_mode & 0o022 == 0)
        return current.stat()

    def trusted_executable(self, pid, executable):
        expected = self.trusted_path(pid, executable)
        actual = Path(f"/proc/{pid}/exe").stat()
        require(actual.st_dev == expected.st_dev and actual.st_ino == expected.st_ino)


def main():
    require(os.geteuid() == 0 and len(sys.argv) == 4)
    binding_path, state_path, socket_path = map(Path, sys.argv[1:])
    binding = private_json(binding_path)
    for directory in (state_path, socket_path.parent):
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o022 == 0)
    broker = Broker(binding, state_path)
    # Only a controlled service restart removes its stale socket. Never replace
    # a connectable socket belonging to another running broker.
    if socket_path.exists():
        require(stat.S_ISSOCK(socket_path.lstat().st_mode) and socket_path.lstat().st_uid == 0)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            try:
                probe.connect(str(socket_path))
            except ConnectionRefusedError:
                socket_path.unlink()
            else:
                raise RuntimeError("TASK_CGROUP_BROKER_ALREADY_ACTIVE")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        server.bind(str(socket_path))
        os.chown(socket_path, 0, 1000)
        os.chmod(socket_path, 0o660)
        server.listen(32)
        server.settimeout(1)
        while True:
            try:
                connection, _ = server.accept()
            except socket.timeout:
                # Retain journals, but do not bind a future epoch to a broker
                # whose actual container init has exited or changed identity.
                try:
                    live = process(broker.init["pid"])
                except FileNotFoundError:
                    return
                if any(live[field] != broker.init[field] for field in ("start", "namespace", "group")):
                    return
                continue
            with connection:
                try:
                    connection.settimeout(2)
                    pid, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    result = broker.handle(json.loads(frame(connection)), pid, uid, connection)
                except Exception as error:
                    print(f"Task cgroup request refused ({type(error).__name__}, errno={getattr(error, 'errno', None)}); retained containment.", file=sys.stderr)
                    result = {"status": "blocked"}
                try:
                    connection.sendall((json.dumps(result) + "\n").encode())
                except (BrokenPipeError, ConnectionResetError, socket.timeout):
                    print("Task cgroup response unavailable; retained containment.", file=sys.stderr)


if __name__ == "__main__":
    main()
