import base64
import hashlib
import io
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfWriter
from bondbuddy_ocr.engine import Failure, _cell_crop, _tables, extract_page, numeric_value, process

FONT = os.environ.get('BB_OCR_TEST_FONT')
if not FONT:
    FONT = next((p for p in ['/System/Library/Fonts/STHeiti Medium.ttc','/System/Library/Fonts/PingFang.ttc','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf','C:/Windows/Fonts/arial.ttf'] if Path(p).exists()),None)


def sample_image():
    image=Image.new('RGB',(1200,850),'white');draw=ImageDraw.Draw(image)
    font=ImageFont.truetype(FONT,36)
    xs=[60,460,800,1140];ys=[80,180,300,420,540,660]
    for y in ys:draw.line((xs[0],y,xs[-1],y),fill='black',width=4)
    for x in [xs[0],xs[-1]]:draw.line((x,ys[0],x,ys[-1]),fill='black',width=4)
    for x in xs[1:-1]:draw.line((x,ys[1],x,ys[-1]),fill='black',width=4)
    draw.text((100,105),'财务报表  金额（万元）',fill='black',font=font)
    values=[['项目','2025','2024'],['营业收入','(1,234.50)','2,345.60'],['净利润','0','—'],['资产','','1.25']]
    for r,values_row in enumerate(values):
        for c,value in enumerate(values_row):draw.text((xs[c]+25,ys[r+1]+35),value,fill='black',font=font)
    return image


class OcrTests(unittest.TestCase):
    def test_cell_crop_keeps_narrow_axes_positive_and_pads_larger_cells(self):
        image = Image.new('RGB', (80, 80))
        for y in range(image.height):
            for x in range(image.width):
                image.putpixel((x, y), (x, y, 0))
        for width in range(1, 13):
            for height in range(1, 13):
                with self.subTest(width=width, height=height):
                    crop = _cell_crop(image, [10, 20, 10 + width, 20 + height])
                    x_inset = min(6, (width - 1) // 2)
                    y_inset = min(6, (height - 1) // 2)
                    self.assertEqual(crop.size, (width - 2 * x_inset, height - 2 * y_inset))
                    self.assertGreaterEqual(crop.width, 1)
                    self.assertGreaterEqual(crop.height, 1)
                    self.assertEqual(crop.getpixel((0, 0)), (10 + x_inset, 20 + y_inset, 0))
        crop = _cell_crop(image, [10, 20, 50, 50])
        self.assertEqual(crop.size, (28, 18))
        self.assertEqual(crop.getpixel((0, 0)), (16, 26, 0))

    def test_cell_crop_rejects_invalid_original_geometry(self):
        image = Image.new('RGB', (80, 80), 'white')
        for bbox in ([10, 20, 10, 40], [10, 20, 40, 20], [40, 20, 10, 40],
                     [10, 40, 40, 20], [-1, 20, 40, 40], [10, 20, 81, 40],
                     [10, 20, 40, 81], [10.5, 20, 40, 40], [10, 20, 40]):
            with self.subTest(bbox=bbox), self.assertRaisesRegex(Failure, '^OCR_INVALID_GEOMETRY$'):
                _cell_crop(image, bbox)

    def test_narrow_ruled_cells_keep_original_page_and_pending_decisions(self):
        image = Image.new('RGB', (140, 680), 'white')
        cells = []
        sizes = [(width, 20) for width in range(1, 13)] + [(20, height) for height in range(1, 13)]
        for index, (width, height) in enumerate(sizes):
            y = 10 + index * 26
            cells.append({'bbox': [10, y, 10 + width, y + height],
                          'row': index + 1, 'column': 1, 'row_span': 1, 'column_span': 1,
                          'table_id': 'table-1'})
        image.putpixel((10, 20), (0, 0, 0))
        dash_cell = {'bbox': [50, 10, 100, 40], 'row': 25, 'column': 1,
                     'row_span': 1, 'column_span': 1, 'table_id': 'table-1'}
        number_cell = {**dash_cell, 'bbox': [50, 50, 100, 80], 'row': 26}
        ImageDraw.Draw(image).line((57, 25, 88, 25), fill='black')
        ImageDraw.Draw(image).rectangle((65, 60, 68, 63), fill='black')

        def tsv(_image, _language, _directory, index, *args, **kwargs):
            if index == '9-cell-25':
                return [{'text': '0', 'bbox': [16, 16, 19, 19], 'confidence': .95}]
            return []

        with tempfile.TemporaryDirectory() as temp, \
                patch('bondbuddy_ocr.engine._orientation', return_value=(image, 0, [])), \
                patch('bondbuddy_ocr.engine._tables', return_value=[[*cells, dash_cell, number_cell]]), \
                patch('bondbuddy_ocr.engine._tsv', side_effect=tsv):
            page, records = extract_page(image, 'eng', temp, 9)

        self.assertEqual(len(records), 26)
        self.assertEqual(records[0]['bbox'], [10, 10, 11, 30])
        self.assertEqual(records[0]['numeric']['kind'], 'unparsed')
        self.assertIn('unreadable_cell', records[0]['uncertainty'])
        self.assertTrue(all(record['bbox'] == cell['bbox']
                            for record, cell in zip(records, [*cells, dash_cell, number_cell])))
        self.assertTrue(all(not record['eligible_for_manuscript'] and record['uncertainty']
                            for record in records))
        self.assertTrue(all(record['numeric']['kind'] == 'blank' for record in records[1:24]))
        self.assertEqual(records[24]['numeric']['kind'], 'dash')
        self.assertIn('dash_shape_inferred', records[24]['uncertainty'])
        self.assertEqual(records[25]['numeric'], {'kind': 'number', 'decimal': '0', 'unit': None})
        self.assertIn('critical_value_requires_confirmation', records[25]['uncertainty'])
        buffer = io.BytesIO()
        image.save(buffer, format='PNG')
        self.assertEqual(base64.b64decode(page['image_base64']), buffer.getvalue())
        self.assertEqual(page['image_sha256'], hashlib.sha256(buffer.getvalue()).hexdigest())

    def test_numeric_semantics(self):
        cases={'0':('number','0'),'':('blank',None),'—':('dash',None),'-':('dash',None),'(1,234.50)':('number','-1234.50'),'（0.25）万元':('number','-0.25'),'1.25%':('number','1.25'),'12,34':('unparsed',None),'(1.2':('unparsed',None),'1e3':('unparsed',None)}
        for raw,(kind,decimal) in cases.items():
            with self.subTest(raw=raw):
                result=numeric_value(raw);self.assertEqual((result['kind'],result['decimal']),(kind,decimal))
        self.assertEqual(numeric_value('（0.25）万元')['unit'],'万元')

    @unittest.skipUnless(FONT,'A test font is required')
    def test_ruled_table_preserves_blank_and_merged_geometry(self):
        tables=_tables(sample_image());self.assertEqual(len(tables),1)
        cells=tables[0];self.assertTrue(any(c['column_span']==3 for c in cells))
        self.assertEqual(len(cells),13)

    @unittest.skipUnless(FONT and shutil.which('tesseract'),'Real OCR engine and a font are required')
    def test_actual_image_and_budgeted_pdf(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'source.png';sample_image().save(path)
            sha=hashlib.sha256(path.read_bytes()).hexdigest()
            def request(p=path,media='image/png',**options):
                return {'schema_version':'ocr-request-v1','request_id':'synthetic-ocr','material':{'material_id':'synthetic-material','material_version':1,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'media_type':media,'authorized_local_path':str(p)},'options':{'purpose':'source_preflight','language':'eng','max_pages':1,**options}}
            result=process(request());self.assertEqual(result['status'],'needs_confirmation',result['error'])
            self.assertEqual(result['coverage'],'complete');self.assertEqual(result['page_count'],1)
            self.assertGreater(len(result['records']),5)
            self.assertTrue(all(r['eligible_for_manuscript'] is False for r in result['records']))
            self.assertTrue(any(r['cell'] and r['numeric']['kind']=='blank' for r in result['records']))
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(),sha)
            # A mixed PDF contains native text and a scan; OCR retains source page order.
            from reportlab.pdfgen import canvas
            pdf=Path(temp)/'mixed.pdf';c=canvas.Canvas(str(pdf),pagesize=(600,425))
            c.drawString(60,380,'SYNTHETIC NATIVE HEADER');c.showPage()
            c.drawImage(str(path),0,0,width=600,height=425);c.showPage();c.save()
            partial=process(request(pdf,'application/pdf'))
            self.assertEqual(partial['coverage'],'partial');self.assertEqual(partial['page_count'],2)
            self.assertEqual([p['page'] for p in partial['pages']],[1])
            denied=process(request(pdf,'application/pdf',purpose='full_ocr'))
            self.assertEqual(denied['error'],'OCR_EXECUTION_REQUIRED')
            overflow=process(request(pdf,'application/pdf',purpose='full_ocr',execution_authorized=True))
            self.assertEqual(overflow['error'],'OCR_FULL_DOCUMENT_BUDGET_EXCEEDED');self.assertEqual(overflow['records'],[])
            full=process(request(pdf,'application/pdf',purpose='full_ocr',execution_authorized=True,max_pages=2))
            self.assertEqual(full['coverage'],'complete');self.assertEqual([p['page'] for p in full['pages']],[1,2])
            bad=request();bad['material']['sha256']='0'*64
            self.assertEqual(process(bad)['error'],'OCR_SOURCE_HASH_MISMATCH')
            encrypted=Path(temp)/'encrypted.pdf';writer=PdfWriter();writer.add_blank_page(100,100);writer.encrypt('synthetic');writer.write(encrypted)
            self.assertEqual(process(request(encrypted,'application/pdf'))['error'],'MATERIAL_ENCRYPTED')

    @unittest.skipUnless(FONT and os.environ.get('BB_OCR_CHINESE_TEST')=='1','Set BB_OCR_CHINESE_TEST=1 with chi_sim traineddata')
    def test_actual_chinese_numeric_sample(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'scan.png';sample_image().save(p)
            result=process({'schema_version':'ocr-request-v1','request_id':'chinese-sample','material':{'material_id':'chinese-material','material_version':1,'media_type':'image/png','sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'authorized_local_path':str(p)},'options':{'purpose':'source_preflight','language':'chi_sim+eng','max_pages':1}})
            self.assertEqual(result['status'],'needs_confirmation',result['error'])
            combined=''.join(r['text'].replace(' ','') for r in result['records'])
            self.assertIn('2025',combined);self.assertIn('2024',combined);self.assertIn('收入',combined)
            self.assertTrue(any(r['numeric']['decimal']=='-1234.50' for r in result['records']),combined)
            self.assertTrue(any(r['numeric']['decimal']=='0' for r in result['records']),combined)
            self.assertTrue(any(r['numeric']['kind']=='dash' for r in result['records']),combined)
            self.assertEqual(next(r['cell']['column'] for r in result['records'] if r['text']=='2025'),2)
            self.assertEqual(next(r['cell']['column'] for r in result['records'] if r['text']=='2024'),3)
            self.assertTrue(all(r['uncertainty'] for r in result['records']))

if __name__=='__main__':unittest.main()
