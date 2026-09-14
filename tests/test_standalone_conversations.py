import json
import os
import sys
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from backend.conversations import (
    MAX_CONVERSATION_BYTES,
    ConversationStore,
    ConversationRunner,
    WorkerRequestTimeout,
    conversation_messages,
)
from backend.conversation_worker import WorkerApp
from backend.server import create_server
from backend.store import Store
from tests import test_cowork as fixtures

ROOT = fixtures.ROOT


class StandaloneRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.projects = Store(self.temp.name)
        self.project = self.projects.create('不应读取的项目')
        self.project['messages'] = [{'role': 'user', 'text': '项目中的私密内容'}]
        self.projects.save(self.project)
        self.before = (Path(self.temp.name) / (self.project['id'] + '.json')).read_bytes()
        self.store = ConversationStore(Path(self.temp.name))
        self.runner = ConversationRunner(self.store, ROOT)

    def test_conversation_persists_without_creating_a_project_and_retries_once(self):
        with self.store.lock, patch('backend.conversations.cli_path', return_value='fixture'), patch('backend.conversations.threading.Thread') as thread:
            c = self.store.create('什么是债券久期？', 'first-message')
            jid = self.runner.start(c, '什么是债券久期？', 'first-message')
            self.assertEqual(c['id'], self.store.create('什么是债券久期？', 'first-message')['id'])
            self.assertEqual(jid, self.runner.start(c, '什么是债券久期？', 'first-message'))
            self.assertEqual(1, thread.call_count)
        payload = self.runner._input_payload(c, Path(self.temp.name), [], '什么是债券久期？', None)
        self.assertIsNone(payload['project'])
        self.assertFalse(payload['allow_web'])
        self.assertNotIn('project_context', payload)
        self.assertNotIn('source_library', payload)
        self.assertNotIn('私密', json.dumps(payload, ensure_ascii=False))
        reply = {'intent': 'answer', 'summary': '久期用于衡量债券价格对利率变化的敏感程度。', 'changes': [], 'assessments': []}
        with patch.object(self.runner, '_invoke', return_value=reply):
            self.runner._work(c['id'], jid, '什么是债券久期？', None)
        self.assertEqual('completed', c['job']['status'])
        reloaded = ConversationStore(Path(self.temp.name))
        self.assertEqual(2, len(reloaded.get(c['id'])['messages']))
        with patch('backend.conversations.cli_path', return_value='fixture'), patch('backend.conversations.threading.Thread'):
            self.runner.start(c, '给我一个例子', 'follow-up')
        followup = self.runner._input_payload(c, Path(self.temp.name), [], '给我一个例子', None)
        self.assertEqual(3, len(followup['conversation']))
        self.assertEqual(1, len(Store(self.temp.name).projects))
        self.assertEqual(self.before, (Path(self.temp.name) / (self.project['id'] + '.json')).read_bytes())

    def test_standalone_rejects_document_actions(self):
        c = self.store.create('更新当前募集书', 'first-message')
        with patch('backend.conversations.cli_path', return_value='fixture'), patch('backend.conversations.threading.Thread'):
            jid = self.runner.start(c, '更新当前募集书', 'first-message')
        with patch.object(self.runner, '_invoke', return_value={'intent': 'update', 'summary': '声称更新', 'changes': [{'target_id': 'private'}], 'assessments': []}):
            self.runner._work(c['id'], jid, '更新当前募集书', None)
        self.assertEqual('failed', c['job']['status'])
        self.assertEqual(1, len(c['messages']))
        self.assertEqual(self.before, (Path(self.temp.name) / (self.project['id'] + '.json')).read_bytes())

    def test_cancelled_reply_does_not_append_a_late_result(self):
        c = self.store.create('一个问题', 'one')
        with patch('backend.conversations.cli_path', return_value='fixture'), patch('backend.conversations.threading.Thread'):
            jid = self.runner.start(c, '一个问题', 'one')
        def late(*_args):
            self.runner.cancel(c)
            return {'intent': 'answer', 'summary': '晚到的回答', 'changes': [], 'assessments': []}
        with patch.object(self.runner, '_invoke', side_effect=late):
            self.runner._work(c['id'], jid, '一个问题', None)
        self.assertEqual('cancelled', c['job']['status'])
        self.assertEqual(1, len(c['messages']))

    def test_cli_transport_receives_only_this_conversation(self):
        c = self.store.create('解释票面利率', 'one')
        self.store.add_message(c, 'user', '解释票面利率')
        run_dir = self.store.root / 'runs' / c['id'] / 'fixture'
        def command(_path, _directory, _schema, output, _web):
            return [sys.executable, str(ROOT / 'tests/fixture_cli.py'), 'success', str(output)]
        with patch('backend.runner.command_for', command):
            result = self.runner._invoke(c, 'fixture', run_dir, [], '解释票面利率', None, 1)
        self.assertEqual('SUBPROCESS FIXTURE', result['summary'])
        task_input = (run_dir / 'batch-1/input.json').read_text(encoding='utf-8')
        self.assertNotIn('私密', task_input)
        self.assertNotIn('source_library', task_input)
        self.assertFalse((run_dir / 'sources').exists())

    def test_standalone_cli_has_no_shell_or_image_tools(self):
        args = self.runner._command_for(
            Path(self.temp.name),
            Path(self.temp.name) / 'schema.json',
            Path(self.temp.name) / 'result.json',
            False,
        )
        self.assertIn(['--disable', 'shell_tool'], [args[i:i + 2] for i in range(len(args) - 1)])
        self.assertIn(['--disable', 'view_image'], [args[i:i + 2] for i in range(len(args) - 1)])
        self.assertLess(args.index('shell_tool'), args.index('exec'))
        prompt = self.runner._prompt({'conversation': [{'role': 'user', 'text': '仅回答当前问题'}]})
        self.assertIn('仅回答当前问题', prompt)
        self.assertIn('不要读取任何文件或调用工具', prompt)

    def test_app_and_standalone_runs_share_one_concurrency_slot(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        with patch('backend.server.cli_status', return_value={'ready': False}):
            server = create_server(0, temp.name, demo=False)
        try:
            self.assertIs(server.app.runner.job_slots, server.app.conversation_runner.job_slots)
        finally:
            server.server_close()

    def test_worker_history_stays_below_request_limit_and_keeps_latest_message(self):
        history = [
            {'role': 'assistant' if index % 2 else 'user', 'text': '债' * 30_000}
            for index in range(20)
        ]
        history[-1] = {'role': 'user', 'text': '最新问题'}
        selected = conversation_messages(history)
        encoded = json.dumps(selected, ensure_ascii=False, separators=(',', ':')).encode()
        self.assertLessEqual(len(encoded), MAX_CONVERSATION_BYTES)
        self.assertEqual('最新问题', selected[-1]['text'])
        self.assertLess(len(selected), len(history))

    def test_worker_writes_a_minimal_tool_free_codex_config(self):
        root = Path(self.temp.name) / 'worker-runs'
        codex_home = Path(self.temp.name) / 'worker-codex'
        with patch.dict(os.environ, {'CODEX_HOME': str(codex_home)}):
            WorkerApp(root)
        config = (codex_home / 'config.toml').read_text(encoding='utf-8')
        self.assertIn('shell_tool = false', config)
        self.assertIn('view_image = false', config)
        self.assertNotIn('mcp_servers', config)

    def test_remote_worker_receives_only_allowlisted_conversation_fields(self):
        c = self.store.create('解释票面利率', 'one')
        self.store.add_message(c, 'user', '解释票面利率')
        self.runner.worker_url = 'http://conversation-worker:8090'
        captured = {}

        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return False
            def read(self):
                return json.dumps({
                    'intent': 'answer',
                    'summary': '票面利率是债券约定的利率。',
                    'changes': [],
                    'assessments': [],
                }).encode()

        def urlopen(request, timeout):
            captured['url'] = request.full_url
            captured['timeout'] = timeout
            captured['body'] = json.loads(request.data.decode())
            captured['deadline'] = request.get_header('X-bond-deadline')
            return Response()

        with patch('backend.conversations.urllib.request.urlopen', side_effect=urlopen):
            result = self.runner._invoke(c, 'fixture', Path(self.temp.name), [], '解释票面利率', None, 1)
        self.assertEqual('票面利率是债券约定的利率。', result['summary'])
        self.assertEqual('http://conversation-worker:8090/invoke', captured['url'])
        self.assertEqual({'conversation_id', 'job_id', 'conversation'}, set(captured['body']))
        self.assertEqual([{'role': 'user', 'text': '解释票面利率'}], captured['body']['conversation'])
        self.assertGreater(float(captured['deadline']), time.time())
        self.assertNotIn('私密', json.dumps(captured['body'], ensure_ascii=False))

    def test_remote_timeout_cancels_worker_job(self):
        c = self.store.create('解释票面利率', 'one')
        self.store.add_message(c, 'user', '解释票面利率')
        self.runner.worker_url = 'http://conversation-worker:8090'
        calls = []

        def request(path, data, timeout=None, deadline=None):
            calls.append((path, data, timeout, deadline))
            if path == '/invoke':
                raise WorkerRequestTimeout('timeout')
            return {'ok': True}

        with patch.object(self.runner, '_worker_request', side_effect=request):
            with self.assertRaises(WorkerRequestTimeout):
                self.runner._invoke(c, 'run_123456789abc', Path(self.temp.name), [], '解释票面利率', None, 1)
        self.assertEqual(['/invoke', '/cancel'], [call[0] for call in calls])
        self.assertGreater(calls[0][3], time.time())


class StandaloneHttpTests(unittest.TestCase):
    request = fixtures.HttpTests.request

    def setUp(self):
        self.temp = TemporaryDirectory()
        with patch('backend.server.cli_status', return_value={'ready': False}):
            self.server = create_server(0, self.temp.name, demo=False)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.token = self.server.app.csrf
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def test_api_is_separate_from_projects_and_keeps_access_checks(self):
        status, _ = self.request('/api/conversations', {'message': '问答', 'request_id': 'first'}, {'X-Bond-Token': 'wrong'})
        self.assertEqual(403, status)
        with patch('backend.conversations.cli_path', return_value='fixture'), patch.object(self.server.app.conversation_runner, '_work'):
            status, result = self.request('/api/conversations', {'message': '一般问答', 'request_id': 'first'})
            self.assertEqual(202, status)
            status, retry = self.request('/api/conversations', {'message': '一般问答', 'request_id': 'first'})
        self.assertEqual(result['run_id'], retry['run_id'])
        cid = result['conversation']['id']
        self.assertIsNone(result['conversation']['project_id'])
        self.assertEqual([], self.request('/api/projects')[1])
        self.assertEqual(404, self.request('/api/projects/' + cid)[0])
        self.assertEqual(1, len(self.request('/api/conversations')[1]))
        self.assertEqual(1, len(self.request('/api/conversations/' + cid)[1]['messages']))
        self.assertEqual(400, self.request('/api/conversations', {'message': '不同请求', 'request_id': 'first'})[0])
        self.assertEqual(200, self.request('/api/conversations/' + cid + '/cancel', {})[0])
        self.assertEqual('cancelled', self.request('/api/conversations/' + cid)[1]['job']['status'])

    def test_shared_workspace_disables_conversations_without_isolated_worker(self):
        temp = TemporaryDirectory()
        with patch.dict(os.environ, {
            'BOND_SHARED_WORKSPACE': '1',
            'BOND_CONVERSATION_WORKER_URL': '',
            'BOND_STANDALONE_CONVERSATIONS': '1',
        }), patch('backend.server.cli_status', return_value={'ready': False}):
            server = create_server(0, temp.name, demo=False)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        original = self.server, self.url, self.token
        self.server = server
        self.url = f'http://127.0.0.1:{server.server_port}'
        self.token = server.app.csrf
        try:
            status, health = self.request('/api/health')
            self.assertEqual(200, status)
            self.assertFalse(health['features']['standalone_conversations'])
            self.assertEqual(404, self.request('/api/conversations')[0])
        finally:
            server.shutdown()
            server.server_close()
            temp.cleanup()
            self.server, self.url, self.token = original


if __name__ == '__main__':
    unittest.main()
