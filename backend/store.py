import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path


def uid(prefix):
    return prefix + '_' + uuid.uuid4().hex[:12]


def now():
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.projects = {}
        for path in self.root.glob('project_*.json'):
            try:
                data = json.loads(path.read_text(encoding='utf-8'))
                if data.get('job', {}).get('status') in {'running', 'queued'}:
                    data['job']['status'] = 'interrupted'
                    data['job']['error'] = '服务重新启动，任务已中断。已保存的修改可继续审核，或重新运行。'
                self.projects[data['id']] = data
            except (ValueError, OSError):
                continue

    def save(self, project):
        with self.lock:
            project['updated_at'] = now()
            path = self.root / (project['id'] + '.json')
            temp = path.with_suffix('.tmp')
            temp.write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding='utf-8')
            os.replace(temp, path)
            self.projects[project['id']] = project

    def get(self, id):
        if id not in self.projects:
            raise KeyError('项目不存在')
        return self.projects[id]

    def create(self, title, mode='financial', period='2026-06-30', demo=False):
        if mode not in {'financial', 'full'}:
            raise ValueError('请选择更新范围。')
        try:
            datetime.strptime(period, '%Y-%m-%d')
        except ValueError as exc:
            raise ValueError('报告期末应为有效日期。') from exc
        if not str(title).strip():
            raise ValueError('请填写项目名称。')
        p = {'id': uid('project'), 'title': str(title).strip()[:120], 'mode': mode, 'period': period,
             'demo': demo, 'web_enabled': False, 'created_at': now(), 'updated_at': now(), 'revision': 0,
             'files': [], 'original_id': None, 'changes': [], 'messages': [], 'history': [],
             'job': {'status': 'idle'}, 'coverage': {}, 'warnings': []}
        self.save(p)
        return p

    def file(self, p, file_id):
        return next((f for f in p['files'] if f['id'] == file_id), None)

    def original(self, p):
        return self.file(p, p['original_id'])

    def add_message(self, p, role, text, **extra):
        p['messages'].append({'id': uid('msg'), 'role': role, 'text': text, 'created_at': now(), **extra})

    def log(self, p, action, **details):
        p['history'].append({'id': uid('event'), 'action': action, 'at': now(), **details})

    def snapshot(self, p):
        return json.loads(json.dumps(p))
