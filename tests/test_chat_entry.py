"""Project conversations: no CLI/model calls or real project writes."""
import unittest
from unittest.mock import patch

from backend.runner import Runner, answer_only_request, request_scope_for
from backend.documents import targets
from backend.engine import stage_candidates, working_file
from backend.store import Store
from tests.test_cowork import ProjectFixture, ROOT


class ChatEntryTests(ProjectFixture, unittest.TestCase):
    def run_reply(self, project, message, result, request_scope='chat'):
        runner = Runner(self.store, ROOT)
        with patch('backend.runner.cli_path', return_value='fixture-cli'), patch('backend.runner.threading.Thread'):
            jid = runner.start(project, message, request_id='fixture-request', request_scope=request_scope)
        with patch.object(runner, '_invoke', return_value=result), patch.object(runner, '_capture_web_refs') as web:
            runner._work(project['id'], jid, message, None, request_scope)
        return runner, web

    def test_questions_without_prospectus_save_conversation_only(self):
        project = self.store.create('尚无募集书的项目')
        self.run_reply(project, '什么是合并口径？', {'intent': 'answer', 'summary': '合并报表以企业集团为会计主体。', 'changes': [], 'assessments': []})
        self.assertEqual(['user', 'assistant'], [m['role'] for m in project['messages']])
        self.assertEqual('answer', project['job']['result_intent'])
        self.assertEqual('chat', project['job']['kind'])
        self.assertEqual([], project['changes'])
        self.assertEqual(0, project['revision'])
        with patch('backend.runner.cli_path', return_value='fixture-cli'):
            with self.assertRaisesRegex(ValueError, '底稿'):
                Runner(self.store, ROOT).start(project)

    def test_answer_does_not_apply_changes_or_coverage_even_if_model_includes_them(self):
        stage_candidates(self.p)
        before = self.store.snapshot({'changes': self.p['changes'], 'coverage': self.p['coverage'], 'revision': self.p['revision']})
        result = self.result()
        result.update(intent='answer', summary='当前材料中的资产总额为120万元。')
        _, web = self.run_reply(self.p, '这一版资产总额是多少？', result)
        self.assertEqual(before, {key: self.p[key] for key in before})
        self.assertEqual('answer', self.p['job']['result_intent'])
        web.assert_not_called()

    def test_explicit_answer_only_request_rejects_model_update_before_applying(self):
        before = self.store.snapshot({'changes': self.p['changes'], 'coverage': self.p['coverage'], 'revision': self.p['revision']})
        _, web = self.run_reply(self.p, '解释资产变化，只回答，不修改文档。', self.result())
        self.assertEqual('failed', self.p['job']['status'])
        self.assertIn('未采用', self.p['job']['error'])
        self.assertEqual(before, {key: self.p[key] for key in before})
        web.assert_not_called()
        self.assertFalse(answer_only_request(self.p, '更新财务数字，不修改其他章节。'))

    def test_explicit_update_still_produces_real_sourced_revision(self):
        self.run_reply(self.p, '请更新资产总额', self.result())
        self.assertEqual('completed', self.p['job']['status'])
        self.assertEqual('update', self.p['job']['result_intent'])
        change = next(c for c in self.p['changes'] if c['target_id'] == self.target['id'])
        self.assertTrue(change['sources'][0]['verified'])
        self.assertEqual('pending', change['status'])

    def test_full_update_is_not_truncated_to_chat_context(self):
        stage_candidates(self.p)
        self.p['coverage'] = {
            target['id']: {'decision': 'keep', 'reason': '上次运行'}
            for target in targets(working_file(self.p))
        }
        self.run_reply(self.p, '根据新一期财报更新募集书', self.result(), request_scope='full_update')
        self.assertEqual('update', self.p['job']['kind'])
        self.assertEqual('completed', self.p['job']['status'])
        self.assertIn('仍有', self.p['job']['step'])

    def test_full_update_rejects_answer_only_model_result(self):
        result = {'intent': 'answer', 'summary': '只给出说明', 'changes': [], 'assessments': []}
        self.run_reply(self.p, '根据新一期财报更新募集书', result, request_scope='full_update')
        self.assertEqual('failed', self.p['job']['status'])
        self.assertIn('只返回了答复', self.p['job']['error'])

    def test_full_update_scope_recognizes_mixed_instructions(self):
        self.assertEqual(
            'full_update',
            request_scope_for('请帮我更新整份募集说明书，并解释修改依据', requested_scope='chat'),
        )
        self.assertEqual(
            'full_update',
            request_scope_for('请更新募集说明书中的所有财务数据，不要修改其他章节', requested_scope='chat'),
        )
        self.assertEqual(
            'full_update',
            request_scope_for('请更新募集说明书中的财务数据，其他章节不要修改。', requested_scope='chat'),
        )
        self.assertEqual('chat', request_scope_for('为什么要更新募集书？', requested_scope='chat'))
        self.assertEqual('chat', request_scope_for('解释如何更新募集书', requested_scope='chat'))
        self.assertEqual('chat', request_scope_for('更新募集说明书是什么意思？', requested_scope='chat'))
        self.assertEqual('chat', request_scope_for('募集说明书更新需要哪些材料？', requested_scope='chat'))
        self.assertEqual('chat', request_scope_for('更新募集说明书有什么风险？', requested_scope='chat'))
        self.assertEqual('chat', request_scope_for('更新募集说明书会影响哪些章节？', requested_scope='chat'))
        self.assertEqual(
            'chat',
            request_scope_for('请修改募集说明书第三章，其他章节不要修改。', requested_scope='chat'),
        )
        self.assertEqual('chat', request_scope_for('为什么要更新募集书？', requested_scope='full_update'))
        self.assertEqual(
            'chat',
            request_scope_for('请修改募集说明书第三章，其他章节不要修改。', requested_scope='full_update'),
        )
        self.assertEqual(
            'full_update',
            request_scope_for('请更新整份募集说明书，附录不要修改。', requested_scope='chat'),
        )
        self.assertEqual(
            'full_update',
            request_scope_for('请更新募集说明书，风险提示章节不要修改。', requested_scope='full_update'),
        )
        self.assertFalse(answer_only_request(self.p, '请检查全部位置，风险提示章节不要修改。'))
        self.assertFalse(answer_only_request(self.p, '请更新募集说明书，风险提示章节不要修改。'))

    def test_network_retry_returns_existing_run_even_after_reload(self):
        runner = Runner(self.store, ROOT)
        with patch('backend.runner.cli_path', return_value='fixture-cli'), patch('backend.runner.threading.Thread') as thread:
            jid = runner.start(self.p, '请解释资产口径', request_id='home-request-1')
            self.assertEqual(jid, runner.start(self.p, '请解释资产口径', request_id='home-request-1'))
            self.assertEqual(1, thread.call_count)
        self.assertEqual(1, len(self.p['messages']))
        reloaded = Store(self.temp.name)
        self.assertEqual(jid, Runner(reloaded, ROOT).start(reloaded.get(self.p['id']), '请解释资产口径', request_id='home-request-1'))
        with self.assertRaisesRegex(ValueError, '不同内容'):
            runner.start(self.p, '请修改文档', request_id='home-request-1')
        with self.assertRaisesRegex(ValueError, '仍在运行'):
            runner.start(self.p, '另一个请求', request_id='home-request-2')
        self.assertEqual(1, len(self.p['messages']))


if __name__ == '__main__':
    unittest.main()
