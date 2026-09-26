"""Engineering checks only: these do not execute/approve financial or legal rules."""
import unittest
from build_sse_private_knowledge import NoticeParser, evidence_inventory
from build_exchange_knowledge import extract


class OfficialNoticeTests(unittest.TestCase):
    def test_archived_scripts_and_navigation_do_not_become_rule_evidence(self):
        parser = NoticeParser()
        parser.feed('<p>menu</p><div class="allZoom"><p>法定正文</p><div>附件说明</div>'
                    '<script>pretend_approved()</script><style>hidden</style></div><p>footer</p>')
        self.assertEqual(parser.parts, ['法定正文', '附件说明'])

    def test_all_official_notices_link_to_the_hashed_original_and_required_metadata(self):
        documents = evidence_inventory(extract)
        self.assertEqual(len(documents), 10)
        for key in ['sse-application-2023', 'sse-focus-2025', 'sse-private-listing-2023',
                    'sse-disclosure-2023', 'sse-mature-2026', 'sse-officer-2025']:
            doc = documents[key]
            notice = doc['records']['NOTICE']['text']
            self.assertIn('现行有效', notice)
            self.assertIn('发布日期', notice)
            self.assertIn('生效日期', notice)
            year, month, day = doc['effective_from'].split('-')
            self.assertTrue(any(date in notice for date in (
                f'{year}年{month}月{day}日', f'{year}年{int(month)}月{int(day)}日')))
        self.assertIn('自2026年5月1日起施行', documents['sse-officer-2025']['records']['NOTICE']['text'])
        self.assertIn('可以参照', documents['sse-protection-2021']['records']['NOTICE']['text'])
        self.assertIn('上证发〔2023〕172号', documents['sse-mature-2026']['records']['NOTICE']['text'])


if __name__ == '__main__':
    unittest.main()
