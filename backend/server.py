from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import io
import json
import mimetypes
import os
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote, quote

from .store import Store, uid, now
from .engine import (add_file, commit_file, prepare_file, publication_changes, fetch_public_url,
                     project_view, review_change, working_file)
from .documents import targets, word_export
from .runner import Runner, cli_status, cli_path
from .demo import seed

ROOT = Path(__file__).resolve().parent.parent
MAX_UPLOAD = 25 * 1024 * 1024


class App:
    def __init__(self, root=None, demo=True):
        self.store = Store(root or os.environ.get('BOND_DATA_DIR', ROOT / '.local/data'))
        self.runner = Runner(self.store, ROOT)
        self.instance_id = uid('server')
        self.started_at = now()
        self.csrf = secrets.token_urlsafe(32)
        self.preview_cache = {}
        self.auth_username = os.environ.get('BOND_AUTH_USERNAME', '').strip()
        self.auth_password = os.environ.get('BOND_AUTH_PASSWORD', '')
        if bool(self.auth_username) != bool(self.auth_password):
            raise ValueError('BOND_AUTH_USERNAME 和 BOND_AUTH_PASSWORD 必须同时配置。')
        self.allowed_hosts = {
            value.strip().lower()
            for value in os.environ.get('BOND_ALLOWED_HOSTS', '').split(',')
            if value.strip()
        }
        self.trust_proxy = os.environ.get('BOND_TRUST_PROXY', '').strip().lower() in {'1', 'true', 'yes', 'on'}
        self.shared_workspace = os.environ.get('BOND_SHARED_WORKSPACE', '').strip().lower() in {'1', 'true', 'yes', 'on'}
        self.workspace_label = os.environ.get('BOND_WORKSPACE_LABEL', '').strip() or ('Azure 共享工作区' if self.shared_workspace else '本机工作区')
        self.project_storage_limit = int(os.environ.get('BOND_PROJECT_STORAGE_LIMIT_MB', '500')) * 1024 * 1024
        self.min_free_storage = int(os.environ.get('BOND_MIN_FREE_STORAGE_MB', '1024')) * 1024 * 1024
        self.runtime = {'installed': bool(cli_path()), 'ready': None, 'message': '正在检测本机 Agent 状态'}
        if demo:
            seed(self.store)
        threading.Thread(target=self.check_runtime, daemon=True).start()

    def check_runtime(self):
        self.runtime = cli_status()
        return self.runtime_view()

    def runtime_view(self):
        runtime = dict(self.runtime)
        runtime['execution_verified'] = self.runner.execution_verified
        if runtime.get('ready') and self.runner.runtime_failure:
            runtime.update(ready=False, authenticated=True, code='execution_permission_denied', message=self.runner.runtime_failure)
        elif runtime.get('ready') and self.runner.execution_verified:
            runtime['message'] = 'Agent 已完成真实任务调用，可以继续更新。'
        return runtime

    def storage_view(self):
        result = self.store.storage_view()
        result.update(
            shared=self.shared_workspace,
            label=self.workspace_label,
            project_limit_bytes=self.project_storage_limit,
            min_free_bytes=self.min_free_storage,
            persistence='azure_vm_volume' if self.shared_workspace else 'local_disk',
        )
        return result

    def check_upload_capacity(self, p, size):
        current = sum(f.get('size', 0) for f in p.get('files', []))
        if self.project_storage_limit and current + size > self.project_storage_limit:
            raise ValueError('当前项目材料超过存储上限，请删除无关材料或新建项目。')
        storage = self.store.storage_view()
        if storage['disk_free_bytes'] - size * 2 < self.min_free_storage:
            raise ValueError('服务器磁盘余量不足，为避免项目损坏已停止上传。请清理空间或迁移到 Azure Blob Storage。')


class Handler(BaseHTTPRequestHandler):
    server_version = 'BondDraft/1.0'
    protocol_version = 'HTTP/1.1'

    @property
    def app(self):
        return self.server.app

    def log_message(self, fmt, *args):
        if args and ('/events' in str(args[0]) or '/api/health' in str(args[0])):
            return
        super().log_message(fmt, *args)

    def send(self, status, data, content_type='application/json; charset=utf-8', download=None, headers=None):
        if not isinstance(data, bytes):
            data = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'SAMEORIGIN')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'")
        self.send_header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
        if self.request_scheme() == 'https':
            self.send_header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
        if download:
            self.send_header('Content-Disposition', 'attachment; filename="download"; filename*=UTF-8\'\'' + quote(download))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def body(self, raw=False):
        if self.headers.get('Transfer-Encoding'):
            raise ValueError('不支持分块请求体。')
        length = int(self.headers.get('Content-Length', '0'))
        if length < 0 or length > (MAX_UPLOAD if raw else 100_000):
            raise ValueError('文件超过 25 MB 或请求内容过大。')
        data = self.rfile.read(length)
        if raw:
            return data
        if not self.headers.get('Content-Type', '').startswith('application/json'):
            raise ValueError('请求格式应为 JSON。')
        result = json.loads(data or b'{}')
        if not isinstance(result, dict):
            raise ValueError('请求格式无效。')
        return result

    def request_scheme(self):
        if self.app.trust_proxy:
            forwarded = self.headers.get('X-Forwarded-Proto', '').split(',', 1)[0].strip().lower()
            if forwarded in {'http', 'https'}:
                return forwarded
        return 'http'

    def authorized(self):
        if not self.app.auth_username:
            return True
        value = self.headers.get('Authorization', '')
        if not value.startswith('Basic '):
            return False
        try:
            decoded = base64.b64decode(value[6:].strip(), validate=True).decode('utf-8')
            username, password = decoded.split(':', 1)
        except (binascii.Error, UnicodeDecodeError, ValueError):
            return False
        return (
            secrets.compare_digest(username, self.app.auth_username)
            and secrets.compare_digest(password, self.app.auth_password)
        )

    def valid_origin(self):
        port = self.server.server_port
        hosts = self.app.allowed_hosts or {f'127.0.0.1:{port}', f'localhost:{port}'}
        host = self.headers.get('Host', '').strip().lower()
        if not host or any(char in host for char in '\r\n,') or host not in hosts:
            return False
        origin = self.headers.get('Origin')
        if not origin:
            return True
        parsed = urlparse(origin)
        return (
            parsed.scheme == self.request_scheme()
            and parsed.netloc.lower() == host
            and not parsed.username
            and not parsed.password
            and not parsed.path
            and not parsed.params
            and not parsed.query
            and not parsed.fragment
        )

    def do_GET(self):
        self.route('GET')

    def do_POST(self):
        self.route('POST')

    def route(self, method):
        try:
            if not self.authorized():
                self.send(
                    401,
                    {'error': '需要登录后访问。'},
                    headers={'WWW-Authenticate': 'Basic realm="BondDraftAI", charset="UTF-8"'},
                )
                return
            if not self.valid_origin():
                self.send(403, {'error': '访问来源不在允许范围内。'})
                return
            if method == 'POST' and not secrets.compare_digest(self.headers.get('X-Bond-Token', ''), self.app.csrf):
                self.send(403, {'error': '访问校验失败，请刷新页面后重试。'})
                return
            url = urlparse(self.path)
            parts = [unquote(x) for x in url.path.strip('/').split('/')]
            query = parse_qs(url.query)
            if parts == ['api', 'health']:
                self.send(200, {'ok': True, 'app': 'bond-draft-cowork', 'csrf': self.app.csrf,
                                'runtime': self.app.runtime_view(), 'storage': self.app.storage_view(), 'version': '1.2.0',
                                'instance_id': self.app.instance_id, 'started_at': self.app.started_at})
                return
            if parts == ['api', 'runtime', 'check'] and method == 'POST':
                self.body()
                self.send(200, self.app.check_runtime())
                return
            if parts == ['api', 'projects']:
                with self.app.store.lock:
                    if method == 'POST':
                        data = self.body()
                        p = self.app.store.create(data.get('title', ''), data.get('mode', 'financial'), data.get('period', '2026-06-30'))
                        p['web_enabled'] = bool(data.get('web_enabled')) and p['mode'] == 'full'
                        self.app.store.save(p)
                        self.send(201, project_view(p))
                    else:
                        projects = sorted(self.app.store.projects.values(), key=lambda p: p['updated_at'], reverse=True)
                        self.send(200, [{'id': p['id'], 'title': p['title'], 'demo': p['demo'], 'mode': p['mode'], 'period': p['period'], 'updated_at': p['updated_at']} for p in projects if not p.get('archived')])
                return
            if len(parts) == 4 and parts[:2] == ['api', 'projects'] and parts[3] == 'url' and method == 'POST':
                data = self.body()
                with self.app.store.lock:
                    p = self.app.store.get(parts[2])
                    if p['mode'] != 'full' or not p['web_enabled']:
                        raise ValueError('请在全文更新项目中启用公开网页查询。')
                    if p['job']['status'] in {'queued', 'running'}:
                        raise ValueError('请先等待或停止当前任务，再添加材料。')
                    revision = p['revision']
                content, final_url = fetch_public_url(str(data.get('url', '')))
                with self.app.store.lock:
                    p = self.app.store.get(parts[2])
                    if p['revision'] != revision or p['job']['status'] in {'queued', 'running'}:
                        raise ValueError('项目状态已变化，请重新添加该网页。')
                    self.app.check_upload_capacity(p, len(content.encode()))
                    f = add_file(self.app.store, p, content.encode(), '网页材料_' + uid('source') + '.txt', 'source', 'web', final_url)
                    self.app.store.save(p)
                    self.send(201, {'id': f['id'], 'warnings': []})
                return
            if len(parts) == 4 and parts[:2] == ['api', 'projects'] and parts[3] == 'files' and method == 'POST':
                with self.app.store.lock:
                    p = self.app.store.get(parts[2])
                    if p['job']['status'] in {'queued', 'running'}:
                        raise ValueError('Agent 正在运行。请等待完成或先停止，再添加材料。')
                raw = self.body(raw=True)
                with self.app.store.lock:
                    p = self.app.store.get(parts[2])
                    self.app.check_upload_capacity(p, len(raw))
                prepared = prepare_file(
                    raw,
                    query.get('name', [''])[0],
                    query.get('role', ['source'])[0],
                    query.get('category', ['other'])[0],
                )
                with self.app.store.lock:
                    p = self.app.store.get(parts[2])
                    if p['job']['status'] in {'queued', 'running'}:
                        raise ValueError('项目状态已变化，请重新上传该材料。')
                    self.app.check_upload_capacity(p, len(raw))
                    f = commit_file(self.app.store, p, raw, prepared)
                    self.app.store.save(p)
                    self.send(201, {'id': f['id'], 'warnings': f['warnings']})
                return
            if len(parts) >= 3 and parts[:2] == ['api', 'projects']:
                with self.app.store.lock:
                    p = self.app.store.get(parts[2])
                    if len(parts) == 3:
                        self.send(200, project_view(p))
                        return
                    action = parts[3]
                    if method == 'POST' and p['job']['status'] in {'queued', 'running'} and action != 'cancel':
                        self.send(409, {'error': 'Agent 正在运行。请等待完成或先停止，再修改文档或添加材料。'})
                        return
                    if action == 'events':
                        pass  # Stream outside the lock.
                    elif action == 'files':
                        if len(parts) < 5:
                            raise ValueError('缺少文件标识。')
                        f = self.app.store.file(p, parts[4])
                        if not f:
                            raise KeyError('材料不存在')
                        if len(parts) == 5:
                            data = {k: v for k, v in f.items() if k not in {'stored_path','original_source_path'}}
                            self.send(200, data)
                        elif parts[5] == 'raw':
                            from .docx_fidelity import source_bytes
                            raw = source_bytes(f)
                            self.send(200, raw, mimetypes.guess_type(f['name'])[0] or 'application/octet-stream', f['name'])
                        elif parts[5] == 'word-preview':
                            if f.get('extension') != '.docx':
                                raise ValueError('原格式预览需要 DOCX 文件。')
                            from .word_preview import word_preview
                            self.send(200, word_preview(f, [], 'final'))
                        elif parts[5] == 'page' and len(parts) == 7:
                            if f['extension'] != '.pdf':
                                raise ValueError('该文件没有 PDF 页码。')
                            page = int(parts[6])
                            if page < 1 or page > (f['page_count'] or 0):
                                raise ValueError('页码超出范围。')
                            import pypdfium2 as pdfium
                            from .docx_fidelity import source_bytes
                            pdf = pdfium.PdfDocument(source_bytes(f))
                            try:
                                page_obj = pdf[page - 1]
                                bitmap = page_obj.render(scale=1.5)
                                try:
                                    img = bitmap.to_pil()
                                    out = io.BytesIO()
                                    img.save(out, format='PNG')
                                    self.send(200, out.getvalue(), 'image/png')
                                finally:
                                    bitmap.close()
                                    page_obj.close()
                            finally:
                                pdf.close()
                        else:
                            raise KeyError('文件操作不存在')
                        return
                    elif action in {'run', 'chat'} and method == 'POST':
                        data = self.body()
                        message = str(data.get('message', '')).strip()
                        if action == 'chat' and not message:
                            raise ValueError('请先输入消息。')
                        jid = self.app.runner.start(p, message, data.get('target_id'))
                        self.send(202, {'run_id': jid})
                        return
                    elif action == 'cancel' and method == 'POST':
                        self.body()
                        self.app.runner.cancel(p)
                        self.send(200, {'ok': True})
                        return
                    elif action == 'review' and method == 'POST':
                        data = self.body()
                        c = review_change(p, data['change_id'], data['action'], data.get('text'), data.get('version'))
                        self.app.store.save(p)
                        self.send(200, c)
                        return
                    elif action == 'edit' and method == 'POST':
                        data = self.body()
                        if data.get('revision') != p['revision']:
                            raise ValueError('文档已有新的修改，请刷新后再保存。')
                        tid = data.get('target_id')
                        t = next((x for x in targets(working_file(p)) if x['id'] == tid), None)
                        if not t:
                            raise KeyError('文档位置不存在')
                        c = next((c for c in p['changes'] if c['target_id'] == tid), None)
                        if not c:
                            c = {'id': uid('chg'), 'target_id': tid, 'before': t['text'], 'after': t['text'], 'reason': '', 'needs_review': False,
                                 'sources': [], 'status': 'pending', 'origin': 'human', 'chapter': t['chapter'], 'created_at': now(), 'version': 0, 'issue': ''}
                            p['changes'].append(c)
                        review_change(p, c['id'], 'edit', data.get('text'))
                        self.app.store.save(p)
                        self.send(200, {'ok': True})
                        return
                    elif action == 'export':
                        view = query.get('view', ['final'])[0]
                        if view not in {'final', 'revision'}:
                            raise ValueError('导出模式无效。')
                        f = working_file(p)
                        if not f:
                            raise ValueError('请先上传募集书。')
                        format = query.get('format', ['docx'])[0]
                        if format == 'json':
                            out = json.dumps(project_view(p, full_history=True), ensure_ascii=False, indent=2).encode()
                            self.send(200, out, 'application/json', p['title'] + '_审核记录.json')
                        elif format == 'docx':
                            out = word_export(f, publication_changes(p['changes']), view)
                            suffix = '修订版' if view == 'revision' else '最终视图'
                            self.send(200, out, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', p['title'] + '_' + suffix + '.docx')
                        else:
                            raise ValueError('导出格式无效。')
                        return
                    elif action == 'word-preview':
                        from .word_preview import word_preview
                        view = query.get('view', ['final'])[0]
                        if view not in {'final', 'revision'}:
                            raise ValueError('预览模式无效。')
                        f = working_file(p)
                        if not f or f.get('extension') != '.docx':
                            raise ValueError('原格式预览需要历史募集书 DOCX 文件。')
                        safe_changes = publication_changes(p['changes'])
                        digest = hashlib.sha256(json.dumps(safe_changes, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
                        key = (p['id'], f.get('sha256'), p['period'], digest, view)
                        if key not in self.app.preview_cache:
                            result = word_preview(f, safe_changes, view)
                            if len(self.app.preview_cache) >= 4:
                                self.app.preview_cache.pop(next(iter(self.app.preview_cache)))
                            self.app.preview_cache[key] = result
                        self.send(200, self.app.preview_cache[key])
                        return
                    else:
                        raise KeyError('操作不存在')
                if action == 'events':
                    self.stream(p['id'])
                    return
            if method != 'GET':
                raise KeyError('接口不存在')
            asset = 'index.html' if url.path == '/' else unquote(url.path).lstrip('/')
            path = (ROOT / 'web' / asset).resolve()
            if not path.is_relative_to((ROOT / 'web').resolve()) or not path.is_file():
                raise KeyError('页面不存在')
            self.send(200, path.read_bytes(), mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
        except KeyError as exc:
            self.send(404, {'error': str(exc).strip("'")})
        except (ValueError, TypeError) as exc:
            self.send(400, {'error': str(exc)})
        except PermissionError:
            self.send(500, {'error': '当前服务没有权限重新打开已保存的源文件。请在本机 PowerShell 中启动工作台后重试，并确认来源文件在本机可用。已提取的文字和审核记录仍保留。'})
        except (OSError, RuntimeError) as exc:
            self.send(500, {'error': '操作未完成：' + str(exc)[:500]})
        except Exception:
            import traceback
            traceback.print_exc()
            self.send(500, {'error': '操作未完成，请检查文件是否可读取后重试。'})

    def stream(self, pid):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'close')
        self.end_headers()
        last = None
        try:
            for _ in range(600):
                with self.app.store.lock:
                    p = self.app.store.get(pid)
                    updated = p['updated_at']
                if updated != last:
                    payload = json.dumps({'updated_at': updated}, ensure_ascii=False)
                    self.wfile.write(('data: ' + payload + '\n\n').encode())
                    self.wfile.flush()
                    last = updated
                time.sleep(1)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        self.close_connection = True


def create_server(port=8765, data_dir=None, demo=True, host='127.0.0.1'):
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    server.app = App(data_dir, demo)
    return server


def main():
    parser = argparse.ArgumentParser(description='募集书 Cowork 本地工作台')
    parser.add_argument('--host', default=os.environ.get('BOND_HOST', '127.0.0.1'))
    parser.add_argument('--port', type=int, default=int(os.environ.get('PORT', os.environ.get('BOND_PORT', '8765'))))
    parser.add_argument('--no-demo', action='store_true')
    args = parser.parse_args()
    demo = not args.no_demo and os.environ.get('BOND_DEMO', '1').strip().lower() not in {'0', 'false', 'no', 'off'}
    server = create_server(args.port, demo=demo, host=args.host)
    print(f'募集书 Cowork 已启动：http://{args.host}:{server.server_port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for p in list(server.app.store.projects.values()):
            if p['job']['status'] in {'running', 'queued'}:
                server.app.runner.cancel(p)
        server.server_close()


if __name__ == '__main__':
    main()
