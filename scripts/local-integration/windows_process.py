"""Windows-only local service launcher and process identity/console diagnostics.

Use a real hidden console, not DETACHED_PROCESS/CREATE_NO_WINDOW: PostgreSQL's
plain CreateProcess backend calls must inherit that console instead of allocating
one per connection. No shell, services, scheduled tasks or machine settings.
"""
import ctypes as c
from ctypes import wintypes as w
import json
import msvcrt
import _winapi
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import time

kernel = c.WinDLL('kernel32', use_last_error=True)
user = c.WinDLL('user32', use_last_error=True)
kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
kernel.OpenProcess.restype = w.HANDLE
kernel.CloseHandle.argtypes = [w.HANDLE]
kernel.QueryFullProcessImageNameW.argtypes = [w.HANDLE, w.DWORD, w.LPWSTR, c.POINTER(w.DWORD)]
kernel.GetProcessTimes.argtypes = [w.HANDLE, c.POINTER(w.FILETIME), c.POINTER(w.FILETIME), c.POINTER(w.FILETIME), c.POINTER(w.FILETIME)]
kernel.TerminateProcess.argtypes = [w.HANDLE, w.UINT]
kernel.GetExitCodeProcess.argtypes = [w.HANDLE, c.POINTER(w.DWORD)]
kernel.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
kernel.GetConsoleWindow.restype = w.HWND
user.IsWindowVisible.argtypes = [w.HWND]


def identity(pid, handle=None):
    own = handle is None
    handle = handle or kernel.OpenProcess(0x1000, False, int(pid))
    if not handle:
        error = c.get_last_error()
        if error == 87:  # PID no longer exists
            return None
        raise OSError(error, f'Cannot inspect PID {pid}')
    try:
        code = w.DWORD()
        if not kernel.GetExitCodeProcess(handle, c.byref(code)):
            raise c.WinError(c.get_last_error())
        if code.value != 259:
            return None
        created, exited, kern, usr = (w.FILETIME() for _ in range(4))
        if not kernel.GetProcessTimes(handle, c.byref(created), c.byref(exited), c.byref(kern), c.byref(usr)):
            raise c.WinError(c.get_last_error())
        size = w.DWORD(32768)
        path = c.create_unicode_buffer(size.value)
        if not kernel.QueryFullProcessImageNameW(handle, 0, path, c.byref(size)):
            raise c.WinError(c.get_last_error())
        return {'pid': int(pid), 'createdTicks': str((created.dwHighDateTime << 32) | created.dwLowDateTime),
                'exe': os.path.normcase(os.path.abspath(path.value))}
    finally:
        if own:
            kernel.CloseHandle(handle)


def matches(actual, expected):
    return actual is not None and actual['pid'] == expected['pid'] and actual['createdTicks'] == expected['createdTicks'] and actual['exe'] == os.path.normcase(os.path.abspath(expected['exe']))


def atomic_json(path, value):
    path = Path(path)
    temp = path.with_name(path.name + f'.{os.getpid()}.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=True), encoding='utf-8')
    os.replace(temp, path)


def launch(data):
    si = subprocess.STARTUPINFO()
    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW | subprocess.STARTF_USESTDHANDLES
    si.wShowWindow = subprocess.SW_HIDE
    with open(os.devnull, 'rb') as inp, open(data['stdout'], 'ab', buffering=0) as out, open(data['stderr'], 'ab', buffering=0) as err:
        handles = [msvcrt.get_osfhandle(f.fileno()) for f in [inp, out, err]]
        for handle in handles:
            os.set_handle_inheritable(handle, True)
        si.hStdInput, si.hStdOutput, si.hStdError = handles
        si.lpAttributeList = {'handle_list': handles}
        hp = ht = None
        try:
            hp, ht, pid, _ = _winapi.CreateProcess(data['exe'], subprocess.list2cmdline([data['exe'], *data['args']]),
                None, None, True, subprocess.CREATE_NEW_CONSOLE | 4,
                {**os.environ, 'BB_LOCAL_LAUNCH_ID': data['launchId']}, data['cwd'], si)  # CREATE_SUSPENDED
            ref = identity(pid)
            ref.update({'args': data['args'], 'cwd': data['cwd'], 'launchId': data['launchId'], 'consoleMode': 'inherited-hidden-console'})
            atomic_json(data['receipt'], ref)  # persist ownership before any service code runs
            kernel.ResumeThread.argtypes = [w.HANDLE]
            kernel.ResumeThread.restype = w.DWORD
            if kernel.ResumeThread(ht) == 0xffffffff:
                raise c.WinError(c.get_last_error())
            return ref
        except Exception:
            if hp is not None:
                _winapi.TerminateProcess(hp, 1)
                _winapi.WaitForSingleObject(hp, 10000)
            raise
        finally:
            if ht is not None: _winapi.CloseHandle(ht)
            if hp is not None: _winapi.CloseHandle(hp)
            for handle in handles:
                os.set_handle_inheritable(handle, False)


class ProcessEntry(c.Structure):
    _fields_ = [('dwSize', w.DWORD), ('cntUsage', w.DWORD), ('th32ProcessID', w.DWORD),
                ('th32DefaultHeapID', c.c_size_t), ('th32ModuleID', w.DWORD), ('cntThreads', w.DWORD),
                ('th32ParentProcessID', w.DWORD), ('pcPriClassBase', w.LONG), ('dwFlags', w.DWORD),
                ('szExeFile', w.WCHAR * 260)]


def process_tree(root):
    kernel.CreateToolhelp32Snapshot.argtypes = [w.DWORD, w.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = w.HANDLE
    kernel.Process32FirstW.argtypes = [w.HANDLE, c.POINTER(ProcessEntry)]
    kernel.Process32NextW.argtypes = [w.HANDLE, c.POINTER(ProcessEntry)]
    handle = kernel.CreateToolhelp32Snapshot(2, 0)
    if handle == c.c_void_p(-1).value:
        raise c.WinError(c.get_last_error())
    entries = []
    try:
        entry = ProcessEntry(); entry.dwSize = c.sizeof(entry)
        found = kernel.Process32FirstW(handle, c.byref(entry))
        while found:
            entries.append({'pid': entry.th32ProcessID, 'parentPid': entry.th32ParentProcessID, 'name': entry.szExeFile})
            found = kernel.Process32NextW(handle, c.byref(entry))
    finally:
        kernel.CloseHandle(handle)
    descendants = {root['pid']}
    while True:
        new = {p['pid'] for p in entries if p['parentPid'] in descendants}
        if new <= descendants:
            break
        descendants |= new
    tree = []
    for entry in entries:
        if entry['pid'] not in descendants:
            continue
        current = identity(entry['pid'])
        if current and int(current['createdTicks']) >= int(root['createdTicks']):
            tree.append({**entry, **current})
    return tree


def windows(pids):
    found = []
    callback_type = c.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
    user.GetWindowThreadProcessId.argtypes = [w.HWND, c.POINTER(w.DWORD)]
    user.GetClassNameW.argtypes = [w.HWND, w.LPWSTR, c.c_int]
    @callback_type
    def callback(hwnd, _):
        pid = w.DWORD(); user.GetWindowThreadProcessId(hwnd, c.byref(pid))
        if pid.value in pids:
            kind = c.create_unicode_buffer(256)
            user.GetClassNameW(hwnd, kind, 256)
            found.append({'pid': pid.value, 'handle': str(hwnd), 'class': kind.value, 'visible': bool(user.IsWindowVisible(hwnd))})
        return True
    user.EnumWindows.argtypes = [callback_type, w.LPARAM]
    if not user.EnumWindows(callback, 0):
        raise c.WinError(c.get_last_error())
    return found


def listeners():
    ip = c.WinDLL('iphlpapi')
    size = w.DWORD()
    ip.GetExtendedTcpTable(None, c.byref(size), False, 2, 3, 0)  # AF_INET, OWNER_PID_LISTENER
    buffer = c.create_string_buffer(size.value)
    code = ip.GetExtendedTcpTable(buffer, c.byref(size), False, 2, 3, 0)
    if code:
        raise OSError(code, 'Cannot inspect TCP listeners')
    count, = struct.unpack_from('<I', buffer)
    result = []
    for index in range(count):
        state, address, port, _, _, pid = struct.unpack_from('<6I', buffer, 4 + index * 24)
        result.append({'pid': pid, 'port': socket.ntohs(port & 0xffff), 'address': socket.inet_ntoa(struct.pack('<I', address))})
    return result


def main(data):
    action = data['action']
    if action == 'launch':
        return launch(data)
    if action == 'identity':
        return identity(data['pid'])
    if action == 'inspect':
        return {'identities': {str(pid): identity(pid) for pid in data.get('pids', [])}, 'listeners': listeners()}
    if action == 'console':
        ref = data['ref']
        if not matches(identity(ref['pid']), ref):
            raise RuntimeError('Console root identity changed')
        tree = process_tree(ref)
        return {'processes': tree, 'windows': windows({p['pid'] for p in tree})}
    if action == 'terminate':
        ref = data['ref']
        handle = kernel.OpenProcess(0x1000 | 0x1 | 0x100000, False, ref['pid'])
        if not handle:
            if identity(ref['pid']) is None:
                return {'alreadyExited': True}
            raise c.WinError(c.get_last_error())
        try:
            if not matches(identity(ref['pid'], handle), ref):
                raise RuntimeError('Refusing to stop a different process generation')
            if not kernel.TerminateProcess(handle, 0):
                raise c.WinError(c.get_last_error())
            if kernel.WaitForSingleObject(handle, 10000) != 0:
                raise RuntimeError('Process did not exit')
            return {'stopped': True}
        finally:
            kernel.CloseHandle(handle)
    raise ValueError('Unknown local process action')


def hold_lock(name):
    kernel.CreateMutexW.argtypes = [c.c_void_p, w.BOOL, w.LPCWSTR]
    kernel.CreateMutexW.restype = w.HANDLE
    kernel.ReleaseMutex.argtypes = [w.HANDLE]
    handle = kernel.CreateMutexW(None, False, name)
    if not handle: raise c.WinError(c.get_last_error())
    acquired = False
    try:
        acquired = kernel.WaitForSingleObject(handle, 0) in [0, 0x80]
        if not acquired: raise RuntimeError('Another local lifecycle operation is in progress')
        print(json.dumps({'ok': True}), flush=True)
        sys.stdin.read()  # parent exit closes the pipe; the kernel also releases abandoned mutexes
    finally:
        if acquired: kernel.ReleaseMutex(handle)
        kernel.CloseHandle(handle)


try:
    if len(sys.argv) == 3 and sys.argv[1] == 'lock':
        hold_lock(sys.argv[2])
    else:
        print(json.dumps({'ok': True, 'result': main(json.load(sys.stdin))}, ensure_ascii=True))
except Exception as error:
    print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=True))
    sys.exit(1)
