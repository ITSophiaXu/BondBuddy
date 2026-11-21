import json
import tempfile
import unittest
from pathlib import Path
from docx import Document
from bondbuddy_file_authoring.workflow_nodes import inspect_nodes
from bondbuddy_file_authoring.fixed_edit import apply_batch
from bondbuddy_file_authoring.template_manifest import build_manifest, sha
from bondbuddy_file_authoring.chapter_inventory import inventory

class WorkflowNodeTests(unittest.TestCase):
    def test_large_table_uses_row_groups_without_losing_any_child_text(self):
        with tempfile.TemporaryDirectory() as root:
            source=Path(root)/'source.docx';d=Document();table=d.add_table(rows=80,cols=2)
            for row in table.rows:
                for cell in row.cells:cell.text='业务事实'*80
            d.save(source);value=inventory(source)
            aggregate=next(n for n in value['nodes'] if n['kind']=='table')
            self.assertTrue(aggregate['scope_only']);self.assertEqual(aggregate['text'],'')
            self.assertGreater(aggregate['text_chars'],18000)
            self.assertEqual(sum(group['row_count'] for group in aggregate['row_groups']),80)
            paragraphs=[n for n in value['nodes'] if n['kind']=='paragraph']
            self.assertEqual(len(paragraphs),160)
            self.assertTrue(all(n['text']=='业务事实'*80 for n in paragraphs))
            self.assertEqual(len(value['nodes']),len([i for c in value['chapters'] for i in c['source_node_ids']]))
    def test_current_projection_replaces_stale_source_before(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root); source=root/'source.docx'; d=Document(); d.add_paragraph('before'); d.save(source)
            node=next(n for n in build_manifest(source)['nodes'] if n['kind']=='paragraph')
            input_path=root/'input.json'; log=root/'operations.json'
            input_path.write_text(json.dumps({'input_hash':'a'*64,'revision_author':'BondBuddy','baseline_path':'source.docx','baseline_sha256':sha(source.read_bytes())}))
            apply_batch(input_path,log,[{'id':'one','kind':'replace_text','node_id':node['node_id'],'before':'before','after':'after'}])
            value=inspect_nodes(input_path,log,[node['node_id']])
            self.assertEqual(value['nodes'][0]['text'],'after')
            with self.assertRaisesRegex(ValueError,'SCOPE'):
                inspect_nodes(input_path,log,['missing'])
