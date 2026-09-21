from pathlib import Path
import sys
from docx import Document
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
doc = Document()
doc.add_heading('第一章 发行人基本情况', 1)
doc.add_paragraph('仅用于测试的参考企业，参考资产999亿元。LIBRARY_BODY_SEARCH_TOKEN')
doc.save(out / 'blueprint.docx')
writer = PdfWriter()
page = writer.add_blank_page(width=595, height=842)
font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
stream = DecodedStreamObject()
stream.set_data(b'BT /F1 12 Tf 60 720 Td (LIBRARY_BODY_SEARCH_TOKEN. Peer issuer data 999. Chapter One Prospectus.) Tj ET')
page[NameObject('/Contents')] = writer._add_object(stream)
writer.write(out / 'blueprint.pdf')
blank = PdfWriter()
blank.add_blank_page(width=595, height=842)
blank.write(out / 'scan.pdf')
