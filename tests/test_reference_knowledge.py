import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from backend.store import Store

from backend import cli_word, knowledge
from backend.runner import Runner
from backend.conversations import ConversationRunner


class ReferenceKnowledgeTests(unittest.TestCase):
    def test_word_task_has_traceable_reference_separate_from_materials(self):
        with TemporaryDirectory() as root:
            task = Path(root) / 'task'
            project = {'id': 'test', 'title': '测试项目', 'period': '2026-06-30',
                       'files': [], 'original_id': None, 'job': {'use_reference_knowledge': True}}
            cli_word.prepare(project, task, '更新至本项目目标期')
            payload = json.loads((task / 'input.json').read_text())
            ref = payload['reference_knowledge']
            self.assertEqual(payload['target_period'], '2026-06-30')
            self.assertEqual(payload['materials'], [])
            self.assertEqual(ref['version'], '1.0.0')
            self.assertEqual(ref['sha256'], hashlib.sha256((task / ref['path']).read_bytes()).hexdigest())
            self.assertEqual(ref['source_sha256'], hashlib.sha256(knowledge.SOURCE.read_bytes()).hexdigest())
            self.assertIn(knowledge.SOURCE.read_text(), (task / ref['path']).read_text())
            self.assertIn('knowledge.md', (task / '任务说明.md').read_text())

    def test_retry_replaces_stale_reference_and_retains_work(self):
        with TemporaryDirectory() as root:
            previous = Path(root) / 'previous'
            previous.mkdir()
            (previous / 'knowledge.md').write_text('stale reference')
            (previous / 'scratch').mkdir()
            (previous / 'scratch' / 'progress.md').write_text('saved work')
            task = Path(root) / 'next'
            cli_word.prepare({'id': 'test', 'title': '测试', 'period': '2026',
                              'files': [], 'original_id': None, 'job': {'use_reference_knowledge': True}}, task, '继续', previous)
            self.assertEqual((task / 'knowledge.md').read_text(), knowledge.reference_text())
            self.assertEqual((task / 'scratch' / 'progress.md').read_text(), 'saved work')

    def test_unchecked_task_omits_reference(self):
        with TemporaryDirectory() as root:
            task = Path(root) / 'task'
            with patch('backend.cli_word.snapshot', side_effect=AssertionError('must not load knowledge')):
                payload = cli_word.prepare({'id': 'test', 'title': '测试', 'period': '2026',
                                            'files': [], 'original_id': None}, task, '更新')
            self.assertIsNone(payload['reference_knowledge'])
            self.assertFalse((task / 'knowledge.md').exists())

    def test_option_is_recorded_per_run_and_changes_cannot_reuse_request_id(self):
        with TemporaryDirectory() as root:
            store = Store(root)
            project = store.create('测试')
            runner = Runner(store, Path(root))
            with patch.object(runner, '_cli_path', return_value='codex'), patch('backend.runner.threading.Thread'):
                first = runner.start(project, '解释财务更新', request_id='first', use_reference_knowledge=True)
                self.assertTrue(project['job']['use_reference_knowledge'])
                self.assertTrue(project['messages'][-1]['use_reference_knowledge'])
                self.assertEqual(first, runner.start(project, '解释财务更新', request_id='first', use_reference_knowledge=True))
                with self.assertRaisesRegex(ValueError, '同一消息标识'):
                    runner.start(project, '解释财务更新', request_id='first', use_reference_knowledge=False)
                project['job']['status'] = 'completed'
                runner.start(project, '解释财务更新', request_id='second')
                self.assertFalse(project['job']['use_reference_knowledge'])
                with self.assertRaisesRegex(ValueError, '布尔值'):
                    runner.start(project, '解释财务更新', use_reference_knowledge='false')

    def test_project_paths_share_reference_without_changing_standalone_chat(self):
        runner = Runner(None, Path('/unused'))
        self.assertEqual(runner._knowledge_text(), knowledge.reference_text())
        self.assertIn('knowledge.md', runner._prompt({}))
        conversation = ConversationRunner(None, Path('/unused'))
        self.assertEqual(conversation._knowledge_text(), conversation.rules)


if __name__ == '__main__':
    unittest.main()

from tests import test_cowork as http_fixtures


class KnowledgeApiTests(unittest.TestCase):
    setUpClass = classmethod(http_fixtures.HttpTests.setUpClass.__func__)
    tearDownClass = classmethod(http_fixtures.HttpTests.tearDownClass.__func__)
    request = http_fixtures.HttpTests.request

    def test_all_project_run_routes_forward_boolean_option(self):
        status, project = self.request('/api/projects', {'title': '知识开关验证'})
        self.assertEqual(status, 201)
        for route in ('direct-word', 'chat', 'run'):
            for choice in (True, False, None):
                data = {'message': '请更新募集书'}
                if choice is not None:
                    data['use_reference_knowledge'] = choice
                with patch.object(self.server.app.runner, 'start', return_value='test-run') as start:
                    status, _ = self.request('/api/projects/' + project['id'] + '/' + route, data)
                self.assertEqual(status, 202)
                self.assertIs(start.call_args.kwargs['use_reference_knowledge'], choice is True)
