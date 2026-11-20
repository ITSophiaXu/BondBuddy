"""Shared, dependency-free primitives for the privileged diagnostic broker."""
import base64
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import tempfile
import time

CONFIG = pathlib.Path('/etc/bondbuddy-diagnostics/config.json')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/var/empty'}
IDENT = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')
SECRET_NAME = re.compile(r'password|passwd|secret|(?:^|[_-])(?:(?:access|refresh|id)[_-]?)?token$|api.?key|private.?key|client.?key|connection.?string|cookie|authorization|credential', re.I)


def identifier(value):
    if not isinstance(value, str) or not IDENT.fullmatch(value):
        raise ValueError('Invalid identifier')
    return value


def trusted_file(path, directory=False):
    path = pathlib.Path(path)
    if not path.is_absolute():
        raise ValueError('An absolute administrator-owned path is required')
    for parent in [*reversed(path.parents), path]:
        info = parent.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Unsafe diagnostic path ownership or permissions')
    info = path.stat()
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ValueError('Unexpected diagnostic path type')
    return path


def load_config(path=CONFIG):
    config = json.loads(trusted_file(path).read_text())
    if config.get('version') != 3:
        raise ValueError('Unsupported diagnostic configuration')
    identifier(config['node'])
    if not 30 <= config.get('retention_days',180) <= 3650:
        raise ValueError('Retention must be 30..3650 days')
    for project in config.get('compose_projects', []):
        identifier(project)
    for unit in config.get('journal_units', []):
        identifier(unit)
    if not isinstance(config.get('node_config_snapshot', False), bool):
        raise ValueError('Invalid node config snapshot setting')
    if not config.get('compose_projects') and not config.get('explicit_containers'):
        raise ValueError('An explicit BondBuddy container scope is required')
    for name in config.get('explicit_containers', []):
        identifier(name)
    trusted_file(config['state_directory'], directory=True)
    for actor, role in config.get('actors', {}).items():
        identifier(actor)
        if role not in ('reader', 'ingest'):
            raise ValueError('Unknown diagnostic role')
    for actor, source in config.get('ingest_sources', {}).items():
        identifier(actor)
        identifier(source)
        if config['actors'].get(actor) != 'ingest':
            raise ValueError('Ingestion requires its own machine identity')
    return config


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else canonical(value).encode()).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def scrub(value, secrets=()):
    if isinstance(value, dict):
        return {k: '[redacted]' if SECRET_NAME.search(k) else scrub(v, secrets) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v, secrets) for v in value]
    if not isinstance(value, str):
        return value
    text = ''.join(c for c in value if c in '\n\r\t' or ord(c) >= 32 and ord(c) != 127)
    for secret in sorted(set(secrets), key=len, reverse=True):
        if len(secret) >= 8:
            text = text.replace(secret, '[redacted]')
    text = re.sub(r'-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----', '[private key redacted]', text, flags=re.S)
    text = re.sub(r'(?i)\b(Bearer|Basic)\s+[A-Za-z0-9_+/=.-]+', r'\1 [redacted]', text)
    text = re.sub(r'(?i)\b([a-z][a-z0-9+.-]{0,31}://)[^\s/@:]+:[^\s/@]+@', r'\1[redacted]@', text)
    text = re.sub(r'''(?ix)(["']?(?:password|passwd|secret|access[_-]?token|refresh[_-]?token|api[_-]?key|accountkey|sig|authorization|cookie|set-cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)''', r'\1[redacted]', text)
    text = re.sub(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b', '[jwt redacted]', text)
    return text


def cursor_encode(data):
    return base64.urlsafe_b64encode(canonical(data).encode()).decode().rstrip('=')


def cursor_decode(value, scope):
    if not isinstance(value, str) or len(value) > 2048 or not re.fullmatch(r'[A-Za-z0-9_-]+', value):
        raise ValueError('Invalid cursor')
    try:
        decoded = json.loads(base64.urlsafe_b64decode(value + '=' * (-len(value) % 4)))
    except (ValueError, UnicodeError) as error:
        raise ValueError('Invalid cursor') from error
    if not isinstance(decoded, dict) or decoded.get('scope') != digest(scope):
        raise ValueError('Cursor belongs to another query')
    return decoded


class DiagnosticFailure(RuntimeError):
    """Only fixed categories and numeric exit status may cross the broker boundary."""
    def __init__(self, stage, code, exit_status=None):
        super().__init__('Diagnostic operation failed')
        self.details = {'stage': stage, 'code': code}
        if isinstance(exit_status, int): self.details['exit_status'] = exit_status


def failure_details(error):
    return error.details if isinstance(error, DiagnosticFailure) else {'code': 'UNCLASSIFIED_FAILURE'}


def command(args, timeout=30, input_bytes=None, max_bytes=8 * 1024 * 1024):
    stage = {'ssh': 'archive_upload', 'docker': 'container_read', 'journalctl': 'journal_read'}.get(pathlib.Path(args[0]).name, 'local_command')
    # Call sites construct argv from fixed programs and validated fields; never shell=True.
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors, tempfile.TemporaryFile() as supplied:
        if input_bytes: supplied.write(input_bytes)
        supplied.seek(0)
        proc = subprocess.Popen(args, stdin=supplied, stdout=output, stderr=errors, env=ENV)
        deadline = time.monotonic() + timeout
        try:
            while proc.poll() is None:
                if os.fstat(output.fileno()).st_size > max_bytes or os.fstat(errors.fileno()).st_size > 65536:
                    raise DiagnosticFailure(stage, 'OUTPUT_LIMIT')
                if time.monotonic() >= deadline: raise DiagnosticFailure(stage, 'COMMAND_TIMEOUT')
                time.sleep(.05)
            if proc.returncode:
                errors.seek(0); diagnostic = errors.read(65536).lower()
                code = 'COMMAND_EXIT'
                if stage == 'archive_upload' and proc.returncode == 255:
                    for phrase, category in [(b'permission denied (', 'SSH_AUTH_DENIED'), (b'host key verification failed', 'SSH_HOST_KEY'),
                                             (b'connection refused', 'SSH_REFUSED'), (b'connection timed out', 'SSH_TIMEOUT'),
                                             (b'no route to host', 'SSH_ROUTE'), (b'could not resolve hostname', 'SSH_DNS')]:
                        if phrase in diagnostic: code = category; break
                raise DiagnosticFailure(stage, code, proc.returncode)
            if os.fstat(output.fileno()).st_size > max_bytes: raise DiagnosticFailure(stage, 'OUTPUT_LIMIT')
            output.seek(0); return output.read(max_bytes)
        finally:
            if proc.poll() is None:
                proc.terminate()
                try: proc.wait(timeout=3)
                except subprocess.TimeoutExpired: proc.kill(); proc.wait()


def audit(config, actor, args, outcome='requested'):
    directory = trusted_file(config['state_directory'], directory=True)
    path = directory / 'access-audit.jsonl'
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags, 0o600)
    try:
        info = os.fstat(fd)
        if info.st_uid != 0 or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise ValueError('Unsafe audit file')
        record = canonical({'at': time.time(), 'actor': actor, 'query': args,
                            'outcome': outcome, 'node': config['node']}) + '\n'
        encoded = record.encode()
        if os.write(fd, encoded) != len(encoded):
            raise OSError('Incomplete audit write')
        os.fsync(fd)
    finally:
        os.close(fd)
