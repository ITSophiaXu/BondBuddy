"""Synthetic full-node chapter inventory; headings are derived without model choice."""
import tempfile
import unittest
from pathlib import Path
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from bondbuddy_file_authoring.template_manifest import build_manifest, sha


class ChapterInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.source = Path(self.temp.name) / 'source.docx'

    def tearDown(self):
        self.temp.cleanup()

    def inventory(self):
        from bondbuddy_file_authoring.chapter_inventory import inventory
        return inventory(self.source)

    def test_preface_headings_table_descendants_and_aux_cover_every_stable_node_once(self):
        doc = Document(); doc.add_paragraph('前言')
        doc.add_heading('第一章 发行人', level=1); doc.add_heading('一、基本信息', level=2)
        table = doc.add_table(rows=2, cols=2); table.cell(0, 0).text = '第一章 这是表格内容'
        table.cell(1, 1).text = '100'
        doc.add_heading('第二章 财务', level=1); doc.add_paragraph('正文')
        doc.sections[0].header.paragraphs[0].text = '页眉'; doc.save(self.source)
        raw = self.source.read_bytes(); result = self.inventory()
        self.assertEqual(result['source_sha256'], sha(raw))
        self.assertEqual(self.source.read_bytes(), raw)
        self.assertEqual([chapter['title'] for chapter in result['chapters']],
                         ['preface', '第一章 发行人', '第二章 财务', 'aux'])
        ids = [node for chapter in result['chapters'] for node in chapter['source_node_ids']]
        expected = [node['node_id'] for node in build_manifest(self.source)['nodes']]
        self.assertCountEqual(ids, expected); self.assertEqual(len(ids), len(set(ids)))
        table_nodes = [node['node_id'] for node in result['nodes'] if node['kind'] in {'table', 'row', 'cell'}]
        self.assertTrue(set(table_nodes).issubset(result['chapters'][1]['source_node_ids']))

    def test_direct_outline_level_inherits_heading_boundary_and_body_only_becomes_preface(self):
        doc = Document(); doc.add_paragraph('普通正文')
        p = doc.add_paragraph('显式章界'); props = p._p.get_or_add_pPr()
        level = OxmlElement('w:outlineLvl'); level.set(qn('w:val'), '0'); props.append(level)
        doc.add_paragraph('第二段'); doc.save(self.source)
        result = self.inventory()
        self.assertEqual([chapter['title'] for chapter in result['chapters']], ['preface', '显式章界'])
        doc = Document(); doc.add_paragraph('只有正文'); doc.save(self.source)
        self.assertEqual([chapter['title'] for chapter in self.inventory()['chapters']], ['preface'])
