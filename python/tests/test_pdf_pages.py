import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from bondbuddy_file_authoring import pdf_pages as pages


def native_pdf(path, texts):
    writer = PdfWriter()
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'),
                             NameObject('/Subtype'): NameObject('/Type1'),
                             NameObject('/BaseFont'): NameObject('/Helvetica')})
    for text in texts:
        page = writer.add_blank_page(width=612, height=792)
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
        content = DecodedStreamObject()
        escaped = text.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
        content.set_data(f'BT /F1 14 Tf 50 750 Td ({escaped}) Tj ET'.encode('ascii'))
        page[NameObject('/Contents')] = writer._add_object(content)
    with path.open('wb') as output:
        writer.write(output)


def scanned_pdf(path, text='Revenue 123,456.78'):
    image = Image.new('RGB', (1400, 600), 'white')
    font_path = Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
    font = ImageFont.truetype(str(font_path), 60) if font_path.exists() else ImageFont.load_default(size=60)
    ImageDraw.Draw(image).text((70, 120), text, fill='black', font=font)
    image.save(path, 'PDF', resolution=150)
    image.close()


def record(text, number=1, index=1):
    return {'record_id': f'p{number}-r{index}', 'page': number, 'text': text, 'bbox': [10, 10, 500, 60],
            'confidence': .94, 'numeric': {'kind': 'number', 'decimal': '123456.78', 'unit': None},
            'cell': None, 'uncertainty': ['ocr_requires_review', 'critical_value_requires_confirmation'],
            'eligible_for_manuscript': False}


def ocr_result(source, number, language):
    return ({'page': number, 'width': 2333, 'height': 1000, 'rotation_clockwise': 0,
             'coordinate_system': 'rendered_pixels_top_left', 'image_sha256': 'a' * 64,
             'warnings': ['layout_requires_review']}, [record('Revenue 123,456.78', number)])


RUNTIME = {'processor': 'synthetic-engine-v1', 'tesseract': 'synthetic', 'language': 'eng',
           'languages': {'eng': 'b' * 64}, 'pdfium': 'synthetic', 'pillow': 'synthetic',
           'dpi': 250, 'max_pixels': 20_000_000}


class PdfPagesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / 'source.pdf'
        self.cache = self.root / 'cache'
        native_pdf(self.source, ['Revenue 123,456.78', 'Assets 987,654.32', 'Revenue 234,567.89'])

    def tearDown(self):
        self.temporary.cleanup()

    def open(self, **kwargs):
        return pages.PdfPages(self.source, self.cache, language='eng', **kwargs)

    def test_native_reads_are_local_bounded_evidence_and_cache_hits(self):
        with patch.object(pages, 'ocr_runtime_identity', side_effect=AssertionError('native page must not start OCR')):
            with self.open() as pdf:
                result = pdf.read(1)
                self.assertEqual(result['mode'], 'native')
                self.assertEqual(result['records'][0]['text'], 'Revenue 123,456.78')
                self.assertEqual(result['coordinate_system'], 'pdf_points_top_left')
                self.assertEqual(result['records'][0]['page'], 1)
                self.assertEqual(len(result['records'][0]['bbox']), 4)
                with patch.object(pdf.document.pages[0], 'extract_words', side_effect=AssertionError('cache was ignored')):
                    self.assertEqual(pdf.read(1), result)
                self.assertLessEqual(len(pages.encoded(result)), pages.MAX_REPLY_BYTES)

    def test_outline_is_metadata_only_and_paginated(self):
        with self.open() as pdf, patch.object(pdf, '_native', side_effect=AssertionError('outline must not parse contents')):
            first = pdf.outline(limit=2)
            self.assertEqual(first['pages'], [{'page': 1, 'native_cached': False}, {'page': 2, 'native_cached': False}])
            self.assertEqual(first['next_offset'], 2)
            self.assertIsNone(pdf.outline(offset=2)['next_offset'])

    def test_large_outline_has_a_bounded_complete_cursor(self):
        native_pdf(self.source, ['Synthetic page'] * 350)
        with self.open() as pdf:
            seen, offset = [], 0
            while True:
                result = pdf.outline(offset=offset, limit=200)
                self.assertLessEqual(len(pages.encoded(result)), 6 * 1024)
                seen.extend(item['page'] for item in result['pages'])
                if result['next_offset'] is None:
                    break
                self.assertGreater(result['next_offset'], offset)
                offset = result['next_offset']
            self.assertEqual(seen, list(range(1, 351)))

    def test_read_fragments_keep_every_character_and_respect_byte_limit(self):
        text = '财务数据1234567890' * 300
        data = {'page': 1, 'mode': 'ocr', 'warnings': [], 'records': [record(text, index=i) for i in range(1, 21)]}
        with self.open() as pdf, patch.object(pdf, '_page', return_value=data):
            offset, seen = 0, []
            while True:
                result = pdf.read(1, offset=offset, limit=200)
                self.assertLessEqual(len(pages.encoded(result)), pages.MAX_REPLY_BYTES)
                self.assertTrue(result['records'])
                seen.extend(result['records'])
                if result['next_offset'] is None:
                    break
                self.assertGreater(result['next_offset'], offset)
                offset = result['next_offset']
            for index in range(1, 21):
                self.assertEqual(''.join(item['text'] for item in seen if item['record_id'] == f'p1-r{index}'), text)
            self.assertEqual(len(seen), result['total_records'])

    def test_oversized_header_cannot_return_unbounded_empty_evidence(self):
        data = {'page': 1, 'mode': 'native', 'warnings': ['x' * 7000], 'records': []}
        with self.open() as pdf, patch.object(pdf, '_page', return_value=data):
            with self.assertRaisesRegex(pages.PdfPageError, 'PDF_PAGE_HEADER_LIMIT'):
                pdf.read(1)

    def test_search_paginates_without_skipping_results(self):
        with self.open() as pdf, patch.object(pages, 'render_ocr_page', side_effect=AssertionError('search cannot OCR')):
            first = pdf.search('Revenue', limit=1, max_pages=2)
            self.assertEqual([r['page'] for r in first['matches']], [1])
            second = pdf.search('Revenue', **first['next_cursor'], limit=1, max_pages=2)
            self.assertEqual(second['matches'], [])
            self.assertEqual(second['next_cursor'], {'page': 3, 'offset': 0})
            third = pdf.search('Revenue', **second['next_cursor'])
            self.assertEqual([r['page'] for r in third['matches']], [3])
            self.assertIsNone(third['next_cursor'])

    def test_search_finds_match_across_fragment_boundary(self):
        text = 'x' * 997 + 'FinancialStatement' + 'y' * 1100
        data = {'page': 1, 'mode': 'native', 'image_count': 0, 'warnings': [], 'records': [record(text)]}
        with self.open() as pdf, patch.object(pdf, '_page', return_value=data):
            result = pdf.search('FinancialStatement', max_pages=1)
            self.assertEqual(len(result['matches']), 1)
            self.assertIn('FinancialStatement', result['matches'][0]['text'])
            self.assertEqual(result['matches'][0]['text_offset'], 0)

    def test_dense_multilingual_search_is_bounded_without_losing_matches(self):
        text = '营业收入 Revenue 123,456.78。' * 70
        data = {'page': 1, 'mode': 'native', 'image_count': 0, 'warnings': [],
                'records': [record(text, index=index) for index in range(1, 21)]}
        expected = pages.fragments(data['records'])
        with self.open() as pdf, patch.object(pdf, '_page', return_value=data):
            seen, offset = [], 0
            while True:
                result = pdf.search('营业收入', page=1, offset=offset, max_pages=1, limit=100)
                self.assertLessEqual(len(pages.encoded(result)), 6 * 1024)
                seen.extend((item['record_id'], item['fragment_index']) for item in result['matches'])
                cursor = result['next_cursor']
                if cursor is None or cursor['page'] != 1:
                    break
                self.assertGreater(cursor['offset'], offset)
                offset = cursor['offset']
            self.assertEqual(seen, [(item['record_id'], item['fragment_index']) for item in expected])

    def test_scan_search_never_triggers_ocr_and_reports_unread_pages(self):
        scanned_pdf(self.source)
        with patch.object(pages, 'ocr_runtime_identity', return_value=RUNTIME), patch.object(pages, 'render_ocr_page', side_effect=AssertionError('search cannot OCR')):
            with self.open() as pdf:
                result = pdf.search('Revenue')
                self.assertEqual(result['matches'], [])
                self.assertEqual(result['pages_without_ocr'], [1])
                self.assertEqual(result['searched_pages'], [])

    def test_ocr_preserves_evidence_but_never_caches_pixels(self):
        scanned_pdf(self.source)
        with patch.object(pages, 'ocr_runtime_identity', return_value=RUNTIME), patch.object(pages, 'render_ocr_page', side_effect=ocr_result) as render:
            with self.open() as pdf:
                result = pdf.read(1)
                self.assertEqual(result['mode'], 'ocr')
                self.assertEqual(result['records'][0]['numeric']['decimal'], '123456.78')
                self.assertFalse(result['records'][0]['eligible_for_manuscript'])
                self.assertIn('critical_value_requires_confirmation', result['records'][0]['uncertainty'])
                self.assertEqual(result['rendering']['source_sha256'], hashlib.sha256(self.source.read_bytes()).hexdigest())
                self.assertEqual(result['rendering']['engine'], RUNTIME)
                self.assertEqual(pdf.search('123,456.78')['matches'][0]['confidence'], .94)
                self.assertEqual(pdf.read(1), result)
                self.assertEqual(render.call_count, 1)
            self.assertFalse(list(self.cache.rglob('*.png')))
            for path in self.cache.rglob('*.json'):
                self.assertNotIn('image_base64', path.read_text())
                self.assertNotIn('rendered_image', path.read_text())

    def test_forced_ocr_on_partial_native_page_is_reused_by_auto_and_search(self):
        native_pdf(self.source, ['Financial statement header'])
        with patch.object(pages, 'ocr_runtime_identity', return_value=RUNTIME), patch.object(pages, 'render_ocr_page', side_effect=ocr_result) as render:
            with self.open() as pdf:
                native = pdf.read(1, ocr='never')
                self.assertEqual(native['image_count'], 0)
                self.assertEqual(native['records'][0]['text'], 'Financial statement header')
                forced = pdf.read(1, ocr='force')
                self.assertEqual(forced['records'][0]['text'], 'Revenue 123,456.78')
                self.assertEqual(pdf.read(1), forced)
                self.assertEqual(pdf.search('123,456.78')['matches'], forced['records'])
                with patch.object(pdf, '_existing_ocr', side_effect=AssertionError('never must stay native')):
                    self.assertEqual(pdf.read(1, ocr='never'), native)
            # A fresh context has no in-memory OCR identity; discover and verify
            # the saved evidence without rendering the same page again.
            with self.open() as pdf, patch.object(pages, 'render_ocr_page', side_effect=AssertionError('cached OCR was ignored')):
                self.assertEqual(pdf.read(1), forced)
                result = pdf.search('123,456.78')
                self.assertEqual(result['matches'], forced['records'])
                self.assertEqual(result['pages_without_ocr'], [])
                self.assertIsNone(result['next_cursor'])
                self.assertEqual(pdf.read(1, ocr='never'), native)
            self.assertEqual(render.call_count, 1)

    def test_partial_native_page_cannot_hide_a_corrupt_forced_ocr_cache(self):
        native_pdf(self.source, ['Financial statement header'])
        with patch.object(pages, 'ocr_runtime_identity', return_value=RUNTIME), patch.object(pages, 'render_ocr_page', side_effect=ocr_result):
            with self.open() as pdf:
                pdf.read(1, ocr='force')
                path, _ = pdf._cache_path(1, 'ocr')
                value = json.loads(path.read_bytes())
                value['data']['records'][0]['text'] = 'Changed financial number'
                path.write_bytes(pages.encoded(value))
            with self.open() as pdf:
                for action in (lambda: pdf.read(1), lambda: pdf.search('Revenue')):
                    with self.assertRaisesRegex(pages.PdfPageError, 'PDF_CACHE_INVALID'):
                        action()
                self.assertEqual(pdf.read(1, ocr='never')['mode'], 'native')

    def test_snapshot_relocation_reuses_ocr_without_absolute_cache_paths(self):
        scanned_pdf(self.source)
        with patch.object(pages, 'ocr_runtime_identity', return_value=RUNTIME), patch.object(pages, 'render_ocr_page', side_effect=ocr_result) as render:
            with self.open() as pdf:
                expected = pdf.read(1)
            next_attempt = self.root / 'next-attempt'
            next_attempt.mkdir()
            relocated_source = next_attempt / 'source.pdf'
            shutil.copyfile(self.source, relocated_source)
            shutil.copytree(self.cache, next_attempt / 'cache')
            with pages.PdfPages(relocated_source, next_attempt / 'cache', language='eng') as pdf:
                self.assertEqual(pdf.read(1), expected)
            self.assertEqual(render.call_count, 1)

    def test_ocr_runtime_and_source_hash_changes_invalidate_cache(self):
        scanned_pdf(self.source)
        with patch.object(pages, 'ocr_runtime_identity', return_value=RUNTIME) as runtime, patch.object(pages, 'render_ocr_page', side_effect=ocr_result) as render:
            with self.open() as pdf:
                first = pdf.read(1)
            runtime.return_value = {**RUNTIME, 'processor': 'synthetic-engine-v2'}
            with self.open() as pdf:
                second = pdf.read(1)
            with self.source.open('ab') as source:
                source.write(b'\n% changed source identity\n')
            with self.open() as pdf:
                third = pdf.read(1)
            self.assertEqual(render.call_count, 3)
            self.assertNotEqual(first['rendering']['engine'], second['rendering']['engine'])
            self.assertNotEqual(second['source_sha256'], third['source_sha256'])

    def test_corrupt_cache_fails_instead_of_trusting_changed_text(self):
        with self.open() as pdf:
            pdf.read(1)
            path, _ = pdf._cache_path(1, 'native')
            value = json.loads(path.read_bytes())
            value['data']['records'][0]['text'] = 'Changed financial number'
            path.write_bytes(pages.encoded(value))
            with self.assertRaisesRegex(pages.PdfPageError, 'PDF_CACHE_INVALID'):
                pdf.read(1)

    def test_nested_pixels_are_rejected_even_with_recomputed_checksum(self):
        scanned_pdf(self.source)
        with patch.object(pages, 'ocr_runtime_identity', return_value=RUNTIME), patch.object(pages, 'render_ocr_page', side_effect=ocr_result):
            with self.open() as pdf:
                pdf.read(1)
                path, _ = pdf._cache_path(1, 'ocr')
                value = json.loads(path.read_bytes())
                value['data']['records'][0]['numeric']['image_base64'] = 'forbidden'
                value['sha256'] = hashlib.sha256(pages.encoded(value['data'])).hexdigest()
                path.write_bytes(pages.encoded(value))
                with self.assertRaisesRegex(pages.PdfPageError, 'PDF_CACHE_INVALID'):
                    pdf.read(1)

    def test_ocr_failure_does_not_save_a_successful_page(self):
        scanned_pdf(self.source)
        with patch.object(pages, 'ocr_runtime_identity', return_value=RUNTIME), patch.object(pages, 'render_ocr_page', side_effect=RuntimeError('OCR_ENGINE_FAILED')):
            with self.open() as pdf:
                with self.assertRaisesRegex(RuntimeError, 'OCR_ENGINE_FAILED'):
                    pdf.read(1)
                path, _ = pdf._cache_path(1, 'ocr')
                self.assertFalse(path.exists())
                self.assertEqual(pdf.search('Revenue')['pages_without_ocr'], [1])

    def test_source_mutation_during_session_is_rejected(self):
        with self.open() as pdf:
            with self.source.open('ab') as source:
                source.write(b'\n% mutate\n')
            for action in (lambda: pdf.read(1), lambda: pdf.outline(), lambda: pdf.search('Revenue')):
                with self.assertRaisesRegex(pages.PdfPageError, 'PDF_SOURCE_CHANGED'):
                    action()

    def test_invalid_page_and_range_are_explicit_errors(self):
        with self.open() as pdf:
            for action in (lambda: pdf.read(0), lambda: pdf.read(4), lambda: pdf.read(1, offset=-1),
                           lambda: pdf.read(1, limit=201), lambda: pdf.search(''), lambda: pdf.search('x', max_pages=21)):
                with self.assertRaises(pages.PdfPageError):
                    action()

    @unittest.skipIf(os.name == 'nt', 'symlink permissions vary on Windows')
    def test_symlink_cache_ancestor_is_rejected(self):
        actual = self.root / 'actual'
        actual.mkdir()
        self.cache.symlink_to(actual, target_is_directory=True)
        with self.assertRaisesRegex(pages.PdfPageError, 'PDF_CACHE_PATH_UNSAFE'):
            self.open()

    @unittest.skipUnless(shutil.which('tesseract'), 'requires the production local OCR runtime')
    def test_real_scanned_financial_value_uses_local_ocr_and_reuses_cache(self):
        scanned_pdf(self.source)
        with self.open() as pdf:
            result = pdf.read(1)
            self.assertEqual(result['mode'], 'ocr')
            matching = [r for r in result['records'] if '123,456.78' in r['text']]
            self.assertTrue(matching, result['records'])
            self.assertIn('critical_value_requires_confirmation', matching[0]['uncertainty'])
            self.assertFalse(matching[0]['eligible_for_manuscript'])
            self.assertEqual(result['rendering']['engine']['dpi'], 250)
            with patch.object(pages, 'render_ocr_page', side_effect=AssertionError('OCR cache was ignored')):
                self.assertEqual(pdf.read(1), result)
        self.assertNotIn('image_base64', pages.encoded(result).decode())
        self.assertFalse(list(self.cache.rglob('*.png')))


if __name__ == '__main__':
    unittest.main()
