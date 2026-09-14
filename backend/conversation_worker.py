"""Internal Codex worker for standalone conversations.

The worker container mounts Codex credentials and its own run directory, but
never the issuer project volume or web authentication secrets.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .conversations import MAX_CONVERSATION_BYTES, ConversationRunner, conversation_messages
from .server import ROOT
from .store import Store


MAX_BODY = MAX_CONVERSATION_BYTES + 100_000


class WorkerApp:
    def __init__(self, root):
        codex_home = Path(os.environ.get('CODEX_HOME', '/data/worker-codex')).resolve()
        codex_home.mkdir(parents=True, exist_ok=True)
        (codex_home / 'config.toml').write_text(
            'cli_auth_credentials_store = "file"\n'
            'web_search = "disabled"\n\n'
            '[features]\n'
            'shell_tool = false\n'
            'view_image = false\n',
            encoding='utf-8',
        )
        self.store = Store(root)
        self.runner = ConversationRunner(self.store, ROOT)


class WorkerHandler(BaseHTTPRequestHandler):
    server_version = 'BondDraftConversationWorker/1.0'

    @property
    def app(self):
        return self.server.app

    def log_message(self, fmt, *args):
        return

    def send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def body(self):
        raw_length = self.headers.get('Content-Length', '')
        length = int(raw_length) if raw_length.isdigit() else -1
        if length < 0 or length > MAX_BODY:
            raise ValueError('Worker 请求内容过大。')
        if not self.headers.get('Content-Type', '').startswith('application/json'):
            raise ValueError('Worker 请求格式无效。')
        data = json.loads(self.rfile.read(length) or b'{}')
        if not isinstance(data, dict):
            raise ValueError('Worker 请求格式无效。')
        return data

    @staticmethod
    def job_id(value):
        if not isinstance(value, str) or not re.fullmatch(r'run_[a-f0-9]{12}', value):
            raise ValueError('Worker 任务标识无效。')
        return value

    def request_deadline(self):
        raw = self.headers.get('X-Bond-Deadline', '')
        try:
            deadline = float(raw)
        except ValueError as exc:
            raise ValueError('Worker 请求期限无效。') from exc
        remaining = deadline - time.time()
        maximum = int(os.environ.get('BOND_CLI_TIMEOUT', '900')) + 60
        if not math.isfinite(deadline) or remaining <= 0 or remaining > maximum:
            raise ValueError('Worker 请求期限无效。')
        return deadline

    def do_GET(self):
        if self.path == '/health':
            self.send_json(200, {'ok': True})
        else:
            self.send_json(404, {'error': 'Worker 接口不存在。'})

    def do_POST(self):
        try:
            data = self.body()
            jid = self.job_id(data.get('job_id'))
            if self.path == '/cancel':
                self.app.runner.cancelled.add(jid)
                process = self.app.runner.processes.get(jid)
                if process and process.poll() is None:
                    self.app.runner._stop_process(process)
                self.send_json(200, {'ok': True})
                return
            if self.path != '/invoke':
                self.send_json(404, {'error': 'Worker 接口不存在。'})
                return
            deadline = self.request_deadline()
            conversation = data.get('conversation', [])
            messages = conversation_messages(conversation)
            if not messages or messages[-1]['role'] != 'user' or not messages[-1]['text'].strip():
                raise ValueError('Worker 当前消息无效。')
            message = messages[-1]['text']
            conversation_id = str(data.get('conversation_id', ''))
            if not re.fullmatch(r'conversation_[a-f0-9]{12}', conversation_id):
                raise ValueError('Worker 对话标识无效。')
            snapshot = {'id': conversation_id, 'messages': messages}
            run_dir = self.app.store.root / 'runs' / conversation_id / jid
            acquired = False
            try:
                while jid not in self.app.runner.cancelled:
                    if time.time() >= deadline:
                        raise TimeoutError('独立对话排队超时，任务已停止，请稍后重试。')
                    if self.app.runner.job_slots.acquire(timeout=.5):
                        acquired = True
                        break
                if not acquired:
                    raise InterruptedError('Worker 任务已停止。')
                self.app.runner.execution_deadlines[jid] = (
                    time.monotonic() + max(0, deadline - time.time())
                )
                result = self.app.runner._invoke(snapshot, jid, run_dir, [], message, None, 1)
            finally:
                self.app.runner.execution_deadlines.pop(jid, None)
                if acquired:
                    self.app.runner.job_slots.release()
                self.app.runner._prune_runs(conversation_id)
            self.send_json(200, result)
        except InterruptedError as exc:
            self.send_json(409, {'error': str(exc)})
        except (ValueError, RuntimeError, OSError) as exc:
            self.send_json(400, {'error': str(exc)[:1800]})
        except Exception:
            import traceback
            traceback.print_exc()
            self.send_json(500, {'error': 'Worker 执行失败。'})


def create_worker(port=8090, root=None, host='0.0.0.0'):
    server = ThreadingHTTPServer((host, port), WorkerHandler)
    server.daemon_threads = True
    server.app = WorkerApp(root or os.environ.get('BOND_CONVERSATION_WORK_DIR', '/data/conversations'))
    return server


def main():
    parser = argparse.ArgumentParser(description='Standalone conversation Codex worker')
    parser.add_argument('--host', default=os.environ.get('BOND_WORKER_HOST', '0.0.0.0'))
    parser.add_argument('--port', type=int, default=int(os.environ.get('BOND_WORKER_PORT', '8090')))
    args = parser.parse_args()
    server = create_worker(args.port, host=args.host)
    try:
        server.serve_forever()
    finally:
        for process in list(server.app.runner.processes.values()):
            if process.poll() is None:
                server.app.runner._stop_process(process)
        server.server_close()


if __name__ == '__main__':
    main()
