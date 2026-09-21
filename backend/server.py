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
from .request_token import persistent_token
from .engine import (add_file, commit_file, prepare_file, publication_changes, fetch_public_url,
                     project_view, review_change, working_file)
from .documents import targets, word_export
from .runner import Runner, cli_status, cli_path
from .conversations import ConversationStore, ConversationRunner, conversation_view
from .demo import seed
from .usage_meter import report as usage_report

ROOT = Path(__file__).resolve().parent.parent
MAX_UPLOAD = 25 * 1024 * 1024


class App:
    def __init__(self, root=None, demo=True):
        self.store = Store(root or os.environ.get('BOND_DATA_DIR', ROOT / '.local/data'))
        self.runner = Runner(self.store, ROOT)
        self.runner.original_files = True
        self.conversations = ConversationStore(self.store.root)
        self.conversation_runner = ConversationRunner(self.conversations, ROOT)
        self.conversation_runner.job_slots = self.runner.job_slots
        self.instance_id = uid('server')
        self.started_at = now()
        self.csrf = persistent_token(self.store.root)
        self.preview_cache = {}
        self.export_lock = threading.Lock()
        self.active_exports = set()
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
        standalone_requested = os.environ.get('BOND_STANDALONE_CONVERSATIONS', '1').strip().lower() not in {'0', 'false', 'no', 'off'}
        self.standalone_conversations = standalone_requested and (
            not self.shared_workspace or bool(self.conversation_runner.worker_url)
        )
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
        runtime['execution_verified'] = self.runner.execution_verified or self.conversation_runner.execution_verified
        failure = self.runner.runtime_failure or self.conversation_runner.runtime_failure
        if runtime.get('ready') and failure:
            runtime.update(ready=False, authenticated=True, code='execution_permission_denied', message=failure)
        elif runtime.get('ready') and runtime['execution_verified']:
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

    def begin_export(self, project_id):
        with self.export_lock:
            if project_id in self.active_exports:
                return False
            self.active_exports.add(project_id)
            return True

    def finish_export(self, project_id):
        with self.export_lock:
            self.active_exports.discard(project_id)


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
            # A trusted CDN may use the origin hostname for its upstream Host.
            and parsed.netloc.lower() in hosts
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
            if method == 'POST' and not secrets.compare_digest(self.headers.get('X-Bond-Token', ''), self.app.csrf):
                self.send(403, {'error': '访问校验失败，请刷新页面后重试。', 'code': 'request_token_invalid'})
                return
            url = urlparse(self.path)
            parts = [unquote(x) for x in url.path.strip('/').split('/')]
            query = parse_qs(url.query)
            if parts == ['api', 'health']:
                self.send(200, {'ok': True, 'app': 'bond-draft-cowork', 'csrf': self.app.csrf,
                                'runtime': self.app.runtime_view(), 'storage': self.app.storage_view(), 'version': '1.3.0',
                                'instance_id': self.app.instance_id, 'started_at': self.app.started_at,
                                'features': {'project_chat_without_document': True, 'chat_request_deduplication': True,
                                             'standalone_conversations': self.app.standalone_conversations, 'direct_tracked_word': True,
                                             'cli_word_artifact': True}})
                return
            if parts == ['api', 'runtime', 'check'] and method == 'POST':
                self.body()
                self.send(200, self.app.check_runtime())
                return
            if parts == ['api', 'knowledge'] and method == 'GET':
                knowledge_path = ROOT / 'backend' / 'data' / 'financial_rules.json'
                expert_path = ROOT / 'outputs' / '上交所私募公司债财务数据更新规则_专家审阅版.md'
                data = json.loads(knowledge_path.read_text(encoding='utf-8'))
                self.send(200, {
                    'title': data['title'], 'version': data['version'],
                    'source_names': data['source_names'],
                    'conflict_count': data['conflict_count'],
                    'expert_text': expert_path.read_text(encoding='utf-8'),
                    'rules': [{key: rule.get(key, '') for key in ('id', 'title', 'chapter', 'body_markdown')}
                              for rule in data.get('rules', [])],
                })
                return
            if parts[:2] == ['api', 'conversations']:
                if not self.app.standalone_conversations:
                    raise KeyError('独立对话未配置隔离 Worker。')
                with self.app.conversations.lock:
                    if len(parts) == 2:
                        if method == 'GET':
                            conversations = sorted(self.app.conversations.conversations.values(), key=lambda c: c['updated_at'], reverse=True)
                            self.send(200, [conversation_view(c, summary=True) for c in conversations])
                        else:
                            data = self.body()
                            message = str(data.get('message', '')).strip()
                            c = self.app.conversations.create(message, data.get('request_id'))
                            jid = self.app.conversation_runner.start(c, message, data.get('request_id'))
                            self.send(202, {'conversation': conversation_view(c), 'run_id': jid})
                        return
                    c = self.app.conversations.get(parts[2])
                    if len(parts) == 3 and method == 'GET':
                        self.send(200, conversation_view(c))
                        return
                    if len(parts) == 4 and method == 'POST':
                        data = self.body()
                        if parts[3] == 'chat':
                            jid = self.app.conversation_runner.start(c, str(data.get('message', '')).strip(), data.get('request_id'))
                            self.send(202, {'conversation': conversation_view(c), 'run_id': jid})
                            return
                        if parts[3] == 'cancel':
                            self.app.conversation_runner.cancel(c)
                            self.send(200, conversation_view(c))
                            return
                    raise KeyError('对话操作不存在')
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
            if len(parts) == 4 and parts[:2] == ['api', 'projects'] and parts[3] == 'export' and method == 'GET':
                view = query.get('view', ['final'])[0]
                if view not in {'final', 'revision'}:
                    raise ValueError('导出模式无效。')
                format = query.get('format', ['docx'])[0]
                if format not in {'docx', 'json'}:
                    raise ValueError('导出格式无效。')
                with self.app.store.lock:
                    p = self.app.store.snapshot(self.app.store.get(parts[2]))
                f = working_file(p)
                if not f:
                    raise ValueError('请先上传募集书。')
                if format == 'json':
                    out = json.dumps(project_view(p, full_history=True), ensure_ascii=False, indent=2).encode()
                    self.send(200, out, 'application/json', p['title'] + '_审核记录.json')
                    return
                if not self.app.begin_export(p['id']):
                    self.send(409, {'error': '当前项目的导出文件正在生成，请等待本次下载开始。'})
                    return
                try:
                    if p.get('direct_word'):
                        from .direct_word import read_delivery
                        out = read_delivery(self.app.store, p)
                        view = 'revision'
                    else:
                        out = word_export(f, publication_changes(p['changes']), view)
                    suffix = '修订版' if view == 'revision' else '最终视图'
                    self.send(200, out, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', p['title'] + '_' + suffix + '.docx')
                finally:
                    self.app.finish_export(p['id'])
                return
            if len(parts) >= 3 and parts[:2] == ['api', 'projects']:
                with self.app.store.lock:
                    p = self.app.store.get(parts[2])
                    if len(parts) == 3:
                        self.send(200, project_view(p))
                        return
                    action = parts[3]
                    if method == 'POST' and p['job']['status'] in {'queued', 'running'} and action not in {'cancel', 'chat'}:
                        self.send(409, {'error': 'Agent 正在运行。请等待完成或先停止，再修改文档或添加材料。'})
                        return
                    if action == 'events':
                        pass  # Stream outside the lock.
                    elif action == 'usage' and method == 'GET':
                        self.send(200, usage_report(self.app.store.root, p))
                        return
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
                            if page < 1 or (f['page_count'] is not None and page > f['page_count']):
                                raise ValueError('页码超出范围。')
                            import pypdfium2 as pdfium
                            from .docx_fidelity import source_bytes
                            pdf = pdfium.PdfDocument(source_bytes(f))
                            try:
                                if page > len(pdf):
                                    raise ValueError('页码超出范围。')
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
                    elif action == 'direct-word' and method == 'POST':
                        data = self.body()
                        jid = self.app.runner.start(p, str(data.get('message') or '请根据上传原材料完成全文更新，直接生成带修订的 Word。'), request_id=data.get('request_id'), request_scope='direct_word', use_reference_knowledge=data.get('use_reference_knowledge', False))
                        self.send(202, {'run_id': jid})
                        return
                    elif action in {'run', 'chat'} and method == 'POST':
                        data = self.body()
                        message = str(data.get('message', '')).strip()
                        if action == 'chat' and not message:
                            raise ValueError('请先输入消息。')
                        if action == 'chat':
                            target_id = data.get('target_id')
                            scope = data.get('scope') or ('selection' if target_id else 'chat')
                            try:
                                jid = self.app.runner.start(
                                    p,
                                    message,
                                    target_id,
                                    request_id=data.get('request_id'),
                                    request_scope=scope,
                                    use_reference_knowledge=data.get('use_reference_knowledge', False),
                                )
                            except ValueError as exc:
                                if '当前任务仍在运行' in str(exc):
                                    self.send(409, {'error': 'Agent 正在运行。请等待完成或先停止，再发送新的请求。'})
                                    return
                                raise
                        else:
                            jid = self.app.runner.start(p, message, data.get('target_id'), use_reference_knowledge=data.get('use_reference_knowledge', False))
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
        for conversation in list(server.app.conversations.conversations.values()):
            if conversation['job']['status'] in {'running', 'queued'}:
                server.app.conversation_runner.cancel(conversation)
        server.server_close()


if __name__ == '__main__':
    main()
