#!/usr/bin/python3
"""Exec only after trusted host admission. Exec preserves the permit's PID."""
import json
import array
import os
import socket
import struct
import sys


def main():
    key, identity, separator, command, *args = sys.argv[1:]
    if separator != "--":
        raise RuntimeError("TASK_RUNNER_ARGUMENTS")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(5)
        client.connect("/run/bondbuddy/task-cgroups/broker.sock")
        client.sendall((json.dumps({"action": "attach", "key": key, "identity": identity}) + "\n").encode())
        admission, ancillary, flags, _ = client.recvmsg(4096, socket.CMSG_SPACE(struct.calcsize("i")), socket.MSG_CMSG_CLOEXEC)
        descriptors = []
        valid_ancillary = True
        for level, kind, value in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                integers = array.array("i")
                integers.frombytes(value[:len(value) - len(value) % integers.itemsize])
                descriptors.extend(integers)
                valid_ancillary = valid_ancillary and len(value) % integers.itemsize == 0
            else:
                valid_ancillary = False
        try:
            while not admission.endswith(b"\n"):
                chunk = client.recv(4096)
                if not chunk or len(admission) + len(chunk) > 4096:
                    raise RuntimeError("TASK_RUNNER_ADMISSION_UNAVAILABLE")
                admission += chunk
            if flags & (socket.MSG_CTRUNC | socket.MSG_TRUNC) or not valid_ancillary or len(descriptors) != 1 or admission != b'{"status":"move-self"}\n':
                raise RuntimeError("TASK_RUNNER_ADMISSION_REFUSED")
            # Kernel PID 0 denotes this caller, never a recyclable supplied PID.
            # Close the capability before business exec; it is never inherited.
            os.write(descriptors[0], b"0")
        finally:
            for descriptor in descriptors:
                os.close(descriptor)
        client.sendall(b'{"moved":true}\n')
        data = b""
        while not data.endswith(b"\n"):
            chunk = client.recv(4096)
            if not chunk or len(data) + len(chunk) > 4096:
                raise RuntimeError("TASK_RUNNER_ADMISSION_UNAVAILABLE")
            data += chunk
        result = json.loads(data)
        if result.get("status") != "ok" or result.get("key") != key or result.get("identity") != identity or result.get("sealed"):
            raise RuntimeError("TASK_RUNNER_ADMISSION_REFUSED")
    os.execvpe(command, [command, *args], os.environ)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Task native admission failed closed.", file=sys.stderr)
        sys.exit(78)
