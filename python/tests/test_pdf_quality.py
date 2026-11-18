import io
import tempfile
import time
import unittest
from pathlib import Path
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from bondbuddy_pdf_quality import inspect, union_area

class PdfQualityTests(unittest.TestCase):
    def make(self, draw):
        data = io.BytesIO()
        c = canvas.Canvas(data, pagesize=(600, 800))
        draw(c)
        c.save()
        return data.getvalue()

    def image(self, width, height):
        return ImageReader(Image.new('RGB', (width, height), 'white'))

    def probe(self, data, seconds=10):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td)/'sample.pdf'; path.write_bytes(data)
            events = []
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
        result = self.probe(self.make(draw))
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

if __name__ == '__main__': unittest.main()
