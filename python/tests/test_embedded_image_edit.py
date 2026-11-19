"""Source-bound raster image removal; synthetic fixtures, no business facts."""
import base64,copy,io,tempfile,unittest
from pathlib import Path
from docx import Document
from bondbuddy_file_authoring.check import package,resolve_revisions
from bondbuddy_file_authoring.fixed_edit import Editor,empty_log,finalize,write_json
from bondbuddy_file_authoring.template_manifest import build_manifest,sha
from bondbuddy_file_authoring.format_diff import audit,canonical
from bondbuddy_file_authoring.word_patch import q,xml,serialized,paragraph_text
from bondbuddy_file_authoring.embedded_images import single_image

PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCT8AAAAASUVORK5CYII=')

class ImageEditTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.source=self.root/'source.docx'
  d=Document();d.add_heading('第一章 发行人',1);d.add_paragraph('已提供资料中的发行人事实。');d.add_picture(io.BytesIO(PNG));d.add_paragraph('原图之后的事实不变。');d.save(self.source)
  self.data={'input_hash':'a'*64,'baseline_sha256':sha(self.source.read_bytes()),'baseline_path':'source.docx','revision_author':'BondBuddy-test','revision_date':'2026-11-20T01:00:00Z'}
  self.input=self.root/'input.json';write_json(self.input,self.data);self.node=next(n for n in build_manifest(self.source)['nodes'] if n.get('image_edit',{}).get('supported'))
 def tearDown(self):self.temp.cleanup()
 def operation(self,after=''):
  image=self.node['image_edit'];return{'id':'remove-old-image','kind':'remove_image','node_id':self.node['node_id'],'before':'','image_sha256':image['sha256'],'relationship_id':image['relationship_id'],'after':after,'reason':'Target issuer differs; preserve only the supplied facts.'}
 def generate(self,ops):
  log=empty_log(self.data,self.source.read_bytes());log['operations']=ops;path=self.root/'operations.json';write_json(path,log);out=self.root/'out';finalize(self.input,path,out);return out,path
 def test_manifest_binds_actual_part_and_raster_hash(self):
  self.assertIn('remove_image',build_manifest(self.source)['supported_operations']);self.assertEqual(self.node['image_edit']['sha256'],sha(PNG));self.assertEqual(self.node['image_edit']['media_type'],'image/png')
 def test_removal_is_tracked_rejectable_and_exactly_replayed(self):
  before=self.source.read_bytes();out,path=self.generate([self.operation()]);tracked=xml(package(out/'tracked.docx')['word/document.xml']);clean=xml(package(out/'clean.docx')['word/document.xml'])
  self.assertEqual(len(list(tracked.iter(q('drawing')))),1);self.assertEqual(len(list(clean.iter(q('drawing')))),0);self.assertEqual(list(tracked.iter(q('drawing')))[0].getparent().getparent().tag,q('del'))
  resolve_revisions(tracked,False,only_new=self.data['revision_author']);self.assertEqual(canonical(tracked),canonical(xml(package(self.source)['word/document.xml'])));self.assertEqual(audit(self.source,out/'tracked.docx',self.data['revision_author'],self.input,path)['status'],'passed');self.assertEqual(self.source.read_bytes(),before)
 def test_replacement_is_business_text_and_later_text_edits_replay(self):
  op=self.operation('发行人组织设置待核。');editor=Editor(self.data,self.source).replay([op]);editor.apply({'id':'clarify','kind':'replace_text','node_id':self.node['node_id'],'before':op['after'],'after':'发行人组织设置以有效制度文件为准。'})
  parts=editor.tracked_parts();accepted=copy.deepcopy(xml(parts['word/document.xml']));resolve_revisions(accepted,True);self.assertIn('发行人组织设置以有效制度文件为准。',''.join(paragraph_text(p) for p in accepted.iter(q('p'))));self.assertFalse(list(accepted.iter(q('drawing'))))
 def test_hash_relationship_reason_and_duplicate_edit_fail_closed(self):
  for patch,code in[({'image_sha256':'b'*64},'IMAGE_ANCHOR_MISMATCH'),({'relationship_id':'foreign'},'IMAGE_ANCHOR_MISMATCH'),({'reason':''},'IMAGE_REASON_REQUIRED'),({'unknown':'xml'},'OPERATION_INVALID')]:
   with self.subTest(patch=patch):
    with self.assertRaisesRegex(ValueError,code):Editor(self.data,self.source).replay([{**self.operation(),**patch}])
  editor=Editor(self.data,self.source).replay([self.operation()])
  with self.assertRaisesRegex(ValueError,'IMAGE_UNSUPPORTED'):editor.apply({**self.operation(),'id':'second'})
 def test_mixed_text_fields_multiple_drawings_and_external_relationship_are_rejected(self):
  base=Editor(self.data,self.source);part,p=base.nodes[self.node['node_id']]
  for mutation in['text','field','second','external','wrong_relationship_namespace']:
   with self.subTest(mutation=mutation):
    editor=Editor(self.data,self.source);part,p=editor.nodes[self.node['node_id']]
    if mutation=='text':
     from bondbuddy_file_authoring.word_patch import run_with_text
     p.append(run_with_text(p.find(q('r')),'不能被图片编辑丢弃的正文'))
    elif mutation=='field':
     from lxml import etree as ET
     ET.SubElement(p.find(q('r')),q('fldChar'),{q('fldCharType'):'begin'})
    elif mutation=='second':p.append(copy.deepcopy(p.find(q('r'))))
    else:
     relpath='word/_rels/document.xml.rels';rels=xml(editor.parts[relpath]);r=next(x for x in rels if x.get('Id')==self.node['image_edit']['relationship_id'])
     if mutation=='external':r.set('TargetMode','External')
     else:rels.tag='WrongNamespace'
     editor.parts[relpath]=serialized(rels)
    with self.assertRaisesRegex(ValueError,'IMAGE_UNSUPPORTED'):single_image(editor.parts,part,p)
 def test_manual_resource_or_drawing_drift_does_not_pass_format_audit(self):
  out,path=self.generate([self.operation('发行人组织情况待核。')]);parts=package(out/'tracked.docx');root=xml(parts['word/document.xml']);drawing=next(root.iter(q('drawing')));drawing.set('unexpected','mutated');parts['word/document.xml']=serialized(root)
  from bondbuddy_file_authoring.fixed_edit import write_package
  write_package(out/'tracked.docx',parts);self.assertEqual(audit(self.source,out/'tracked.docx',self.data['revision_author'],self.input,path)['status'],'failed')

if __name__=='__main__':unittest.main()
