import io
import tempfile
import time
import unittest
from pathlib import Path
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
import pypdfium2 as pdfium
from bondbuddy_pdf_quality import inspect, union_area, page_resolution, sample_pages

class PdfQualityTests(unittest.TestCase):
    def make(self, draw):
        data = io.BytesIO()
        c = canvas.Canvas(data, pagesize=(600, 800))
        draw(c)
        c.save()
        return data.getvalue()

    def image(self, width, height):
        image = Image.new('RGB', (width, height), 'white')
        # ReportLab hashes pixel bytes without dimensions: distinguish transposed fixtures.
        image.putpixel((0,0), (width % 256, height % 256, 0))
        return ImageReader(image)

    def probe(self, data, seconds=10, all_pages=False):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td)/'sample.pdf'; path.write_bytes(data)
            events = []
            if all_pages:
                # Test image geometry independently from the production sampling policy.
                with pdfium.PdfDocument(path) as doc:
                    events.append({'page_count': len(doc)})
                    for i in range(len(doc)):
                        page = doc[i]
                        try: events.append({'page': i+1, 'dpi': page_resolution(page, time.monotonic()+seconds)})
                        finally: page.close()
                    events.append({'complete': True})
            else:
                inspect(path, events.append, seconds=seconds)
            return events

    def test_scans_and_vector_and_logo_and_tiled_pages(self):
        def draw(c):
            c.drawImage(self.image(1200,1600),0,0,width=600,height=800); c.showPage()
            c.drawImage(self.image(2500,3334),0,0,width=600,height=800); c.showPage()
            c.drawString(40,700,'Native vector text'); c.showPage()
            for _ in range(50):
                c.drawImage(self.image(20,20),20,20,width=100,height=100)
            c.showPage()
            for row in range(8):
                c.drawImage(self.image(1200,200),0,row*100,width=600,height=100)
            c.showPage()
        result = self.probe(self.make(draw), all_pages=True)
        self.assertEqual(result[0], {'page_count':5})
        self.assertEqual(result[1:6], [{'page':1,'dpi':144},{'page':2,'dpi':None},{'page':3,'dpi':None},{'page':4,'dpi':None},{'page':5,'dpi':144}])
        self.assertEqual(result[-1], {'complete':True})

    def test_form_scale_is_included_in_effective_dpi(self):
        def draw(c):
            c.beginForm('scan',0,0,300,400)
            c.drawImage(self.image(1200,1600),0,0,width=300,height=400)
            c.endForm(); c.scale(2,2); c.doForm('scan'); c.showPage()
        self.assertEqual(self.probe(self.make(draw))[1], {'page':1,'dpi':144})

    def test_quarter_turn_and_high_dpi_do_not_depend_on_filename(self):
        def draw(c):
            c.translate(600,0); c.rotate(90)
            c.drawImage(self.image(1600,1200),0,0,width=800,height=600); c.showPage()
        self.assertEqual(self.probe(self.make(draw))[1], {'page':1,'dpi':144})

    def test_nominal_200_dpi_float32_placements_do_not_warn(self):
        def draw(c):
            for px, py in [(2340,1654),(1654,2338)]:
                c.drawImage(self.image(px,py),0,0,width=px*72/200,height=py*72/200)
                c.showPage()
            c.saveState()
            c.beginForm('boundary',0,0,300,400)
            c.drawImage(self.image(1667,2223),0,0,width=1667*72/200/2,height=2223*72/200/2)
            c.endForm()
            c.scale(2,2); c.doForm('boundary'); c.restoreState(); c.showPage()
            c.translate(600,0); c.rotate(90)
            c.drawImage(self.image(2223,1667),0,0,width=2223*72/200,height=1667*72/200)
            c.showPage()
        result=self.probe(self.make(draw), all_pages=True)
        self.assertEqual([r['dpi'] for r in result if 'page' in r],[None]*4)
        self.assertEqual(result[-1],{'complete':True})

    def test_genuinely_below_threshold_remains_low(self):
        def draw(c):
            for dpi in [96,110,144,150,199.9,199.9995]:
                c.drawImage(self.image(1200,1600),0,0,width=1200*72/dpi,height=1600*72/dpi)
                c.showPage()
        result=self.probe(self.make(draw), all_pages=True)
        self.assertEqual([r['dpi'] for r in result if 'page' in r],[96,110,144,150,199,199])

    def test_budget_exhaustion_is_not_complete(self):
        events = self.probe(self.make(lambda c: (c.drawString(40,40,'Synthetic'),c.showPage())),seconds=-1)
        self.assertEqual(events,[{'page_count':1}])

    def test_union_is_clipped_and_not_double_counted(self):
        self.assertEqual(union_area([(0,0,10,10),(0,0,10,10),(5,5,15,15)]),175)

    def test_corrupt_and_encrypted_never_report_quality_pass(self):
        from pypdf import PdfReader, PdfWriter
        with self.assertRaises(Exception): self.probe(b'not a PDF')
        writer=PdfWriter();writer.add_page(PdfReader(io.BytesIO(self.make(lambda c:(c.drawString(1,1,'X'),c.showPage())))).pages[0]);writer.encrypt('secret')
        out=io.BytesIO();writer.write(out)
        with self.assertRaises(Exception): self.probe(out.getvalue())

    def report(self, count, low_pages=()):
        image = self.image(1200,1600)
        def draw(c):
            for page in range(1, count+1):
                c.drawString(40,700,'Synthetic page '+str(page))
                if page in low_pages:
                    c.drawImage(image,0,0,width=600,height=800)
                c.showPage()
        return self.make(draw)

    def test_long_report_checks_only_eight_representative_pages(self):
        for count in (9,12,100,1501):
            with self.subTest(count=count):
                events=self.probe(self.report(count))
                pages=[e['page'] for e in events if 'page' in e]
                self.assertEqual(pages,sample_pages(count))
                self.assertLessEqual(len(pages),8)
                self.assertLess(len(pages),count)
                self.assertIn(1,pages)
                self.assertIn(count,pages)
                self.assertEqual(events[-1],{'complete':True})
        self.assertEqual(sample_pages(100),[5,8,12,1,25,50,75,100])

    def test_low_in_front_middle_tail_stops_immediately(self):
        for low_page in (5,8,12,1,25,50,75,100):
            with self.subTest(low_page=low_page):
                events=self.probe(self.report(100,{low_page}))
                measured=[e for e in events if 'page' in e]
                self.assertEqual(measured[-1],{'page':low_page,'dpi':144})
                self.assertEqual(len(measured),sample_pages(100).index(low_page)+1)
                self.assertEqual(events[-1],{'complete':True})
        events=self.probe(self.report(100,set(range(1,101))))
        self.assertEqual([e for e in events if 'page' in e],[{'page':5,'dpi':144}])

    def test_unselected_isolated_low_page_is_outside_sampling_coverage(self):
        events=self.probe(self.report(100,{2}))
        self.assertNotIn(2,[e['page'] for e in events if 'page' in e])
        self.assertTrue(all(e['dpi'] is None for e in events if 'page' in e))
        self.assertEqual(events[-1],{'complete':True})

    def test_deadline_keeps_only_actual_sample_prefix(self):
        from unittest.mock import patch
        data=self.report(100)
        with patch('bondbuddy_pdf_quality.time.monotonic',side_effect=[0,0,1]):
            events=self.probe(data,seconds=0.05)
        self.assertEqual(events,[{'page_count':100},{'page':5,'dpi':None}])

if __name__ == '__main__': unittest.main()
