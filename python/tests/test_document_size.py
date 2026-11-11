"""Synthetic size-policy tests; rendered counts are mocked in this unit suite."""
import copy
import unittest
from unittest.mock import patch

from bondbuddy_file_authoring.document_size import PageCountError, compare_size

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
APP = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties'


def parts(text, count=1, cached_pages=1):
    body = ''.join(f'<w:p><w:r><w:t>{text}</w:t></w:r></w:p>' for _ in range(count))
    return {'word/document.xml': f'<w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>'.encode(),
            'docProps/app.xml': f'<Properties xmlns="{APP}"><Pages>{cached_pages}</Pages></Properties>'.encode()}


class DocumentSizeTests(unittest.TestCase):
    def setUp(self):
        self.source = parts('原主体原市场披露文字' * 200, count=100)
        self.renderer = patch('bondbuddy_file_authoring.document_size.render_pages', side_effect=[{'pages': 310}, {'pages': 110}]).start()
        patch('bondbuddy_file_authoring.document_size.shutil.which', return_value='/synthetic/libreoffice').start()
        patch.dict('os.environ', {'BONDBUDDY_WORD_LIBREOFFICE': ''}).start()
        self.addCleanup(patch.stopall)

    def test_actual_page_collapse_rejected_despite_identical_text_and_paragraph_counts(self):
        result = compare_size(self.source, self.source)
        self.assertEqual(result['character_ratio'], 1)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['issues'][0], {'code': 'WORD_DOCUMENT_SIZE_REDUCED', 'metric': 'rendered_pages',
                                               'before': 310, 'after': 110, 'minimum_ratio': .7})
        self.assertEqual(self.renderer.call_count, 2)

    def test_global_body_collapse_rejected_with_every_paragraph_still_present(self):
        result = compare_size(self.source, parts('目标主体新披露' * 20, count=100))
        self.assertEqual(result['baseline']['nonempty_paragraphs'], result['clean']['nonempty_paragraphs'])
        self.assertEqual(result['issues'][0]['metric'], 'body_characters')
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['page_check']['status'], 'not_run')
        self.renderer.assert_not_called()

    def test_low_similarity_with_reasonable_whole_document_size_passes(self):
        self.renderer.side_effect = [{'pages': 310}, {'pages': 290}]
        result = compare_size(self.source, parts('目标公司银行间票据业务' * 200, count=100))
        self.assertEqual(result['status'], 'passed', result)
        self.assertEqual(result['visual_acceptance'], 'not_performed')

    def test_boundary_and_small_page_count_variation_do_not_reject(self):
        for before, after in [(300, 210), (50, 34), (49, 20)]:
            with self.subTest(before=before, after=after):
                self.renderer.side_effect = [{'pages': before}, {'pages': after}]
                self.assertEqual(compare_size(self.source, self.source)['status'], 'passed')

    def test_short_local_rewrite_remains_flexible(self):
        result = compare_size(parts('旧市场相关披露。' * 100), parts('本期票据在银行间交易流通。'))
        self.assertEqual(result['status'], 'not_applicable')
        self.renderer.assert_not_called()

    def test_header_padding_and_word_cached_pages_cannot_hide_collapse(self):
        clean = parts('新主体披露。', count=100, cached_pages=999)
        clean['word/header1.xml'] = f'<w:hdr xmlns:w="{W}"><w:p><w:r><w:t>{"填充" * 100000}</w:t></w:r></w:p></w:hdr>'.encode()
        self.assertEqual(compare_size(self.source, clean)['issues'][0]['metric'], 'body_characters')
        self.renderer.side_effect = [{'pages': 310}, {'pages': 110}]
        clean = copy.deepcopy(self.source)
        clean['docProps/app.xml'] = parts('', cached_pages=999)['docProps/app.xml']
        result = compare_size(self.source, clean)
        self.assertEqual(result['page_check']['clean']['pages'], 110)
        self.assertEqual(result['status'], 'failed')

    def test_missing_renderer_timeout_and_bad_pdf_fail_closed(self):
        for reason in ('render_timeout', 'render_output_invalid', 'render_pdf_unreadable'):
            with self.subTest(reason=reason):
                self.renderer.side_effect = PageCountError(reason)
                result = compare_size(self.source, self.source)
                self.assertEqual(result['issues'], [{'code': 'WORD_PAGE_COUNT_UNAVAILABLE', 'reason': reason}])
        with patch('bondbuddy_file_authoring.document_size.shutil.which', return_value=None):
            result = compare_size(self.source, self.source)
            self.assertEqual(result['issues'], [{'code': 'WORD_PAGE_COUNT_UNAVAILABLE', 'reason': 'renderer_missing'}])

    def test_short_text_with_long_source_metadata_still_requires_real_page_check(self):
        source = parts('图示及财务披露', cached_pages=310)
        result = compare_size(source, source)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['issues'][0]['metric'], 'rendered_pages')

    def test_stale_large_cached_page_count_cannot_make_a_short_document_fail(self):
        self.renderer.side_effect = [{'pages': 1}, {'pages': 1}]
        result = compare_size(parts('源文本' * 100, cached_pages=310), parts('本期票据交易安排。'))
        self.assertEqual(result['status'], 'passed', result)
        self.assertLess(result['character_ratio'], .7)

    def test_existing_rejection_never_claims_page_pass(self):
        result = compare_size(self.source, self.source, already_rejected=True)
        self.assertEqual(result['status'], 'not_run')
        self.assertEqual(result['page_check']['status'], 'not_run')
        self.renderer.assert_not_called()


if __name__ == '__main__':
    unittest.main()
