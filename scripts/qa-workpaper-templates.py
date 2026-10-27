"""Synthetic layout probes for each template family; never publish as business evidence."""
import json
import sys
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from lxml import etree as E

root=Path(__file__).resolve().parents[1]/'knowledge/workpaper-templates/2026-10-27'
out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
catalogue=json.loads((root/'catalog.json').read_text(encoding='utf8'))
families=list(dict.fromkeys(t['family'] for t in catalogue))
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
for index,family in enumerate(families):
    template=next(t for t in catalogue if t['family']==family)
    with ZipFile(root/template['filename']) as z:parts={n:z.read(n) for n in z.namelist()}
    title=False
    for name in parts:
        if not name.startswith('word/') or not name.endswith('.xml'):continue
        xml=E.fromstring(parts[name])
        for paragraph in xml.iter(W+'p'):
            texts=list(paragraph.iter(W+'t'))
            if not texts or not any('[[内容' in (t.text or '') for t in texts):continue
            for t in texts:t.text=''
            if name!='word/document.xml':text='合成格式测试'
            elif not title:text='合成发行人'+family;title=True
            elif any(a.tag==W+'tc' for a in paragraph.iterancestors()):text='2025年末 100.00 万元'
            else:text='本文件用于合成格式测试。合成发行人2025年末资产总额100万元，负债50万元。未取得原始证照或实际履职记录，不能确认相应程序已经执行。'
            texts[0].text=text
        parts[name]=E.tostring(xml,encoding='UTF-8',xml_declaration=True,standalone=True)
    with ZipFile(out/f'{index+1:02d}-{template["id"]}.docx','w',ZIP_DEFLATED) as z:
        for name,bytes in parts.items():z.writestr(name,bytes)
    print(template['id'],family,flush=True)
