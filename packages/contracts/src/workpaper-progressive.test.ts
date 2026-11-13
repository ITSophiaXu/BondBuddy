import test from 'node:test';
import assert from 'node:assert/strict';
import {Value} from '@sinclair/typebox/value';
import {workpaperChapters,workpaperProgressiveSelection,WorkpaperActionSchema,WorkpaperStartSchema,WorkpaperTaskSchema,type WorkpaperEntry} from './workpapers.js';
import {FileGenerationPreparationSchema,emptyFileGenerationPreparation,FileGenerationSubmitSchema} from './file-generation.js';

const file=(id:string,folder='',code='',sheet='目录'):WorkpaperEntry=>({id,folder,code,sheet,title:`文件${id}`,instructions:'',row:1,kind:'file',path:`${id}.docx`});

test('real first branching level groups nested folders without hardcoded chapter names',()=>{
  const entries=[file('a','1 尽职调查/发行人/基本信息'),file('b','1 尽职调查/发行人/关联企业'),file('c','1 尽职调查/财务/资产')];
  const chapters=workpaperChapters(entries);
  assert.deepEqual(chapters.map(c=>[c.title,c.item_ids]),[['发行人',['a','b']],['财务',['c']]]);
  const selected=workpaperProgressiveSelection(entries,['b','c'],chapters.map(c=>c.id).reverse());
  assert.deepEqual(selected.chapters.map(c=>c.title),['财务','发行人']);
  assert.deepEqual(selected.trial_item_ids,['c','b']);
  assert.deepEqual(chapters.map(c=>c.item_ids),[['a','b'],['c']],'selection never mutates the catalogue');
});

test('trial samples one per first eight ordered selected chapters; remainder keeps actual chapter order',()=>{
  const entries=Array.from({length:11},(_,chapter)=>[file(`${chapter}a`,`root/chapter ${chapter}`),file(`${chapter}b`,`root/chapter ${chapter}/sub`)]).flat();
  const chapters=workpaperChapters(entries),order=chapters.slice(1).reverse().map(c=>c.id);
  const selected=workpaperProgressiveSelection(entries,entries.filter(e=>!e.id.startsWith('0')).map(e=>e.id),order);
  assert.deepEqual(selected.trial_item_ids,['10a','9a','8a','7a','6a','5a','4a','3a']);
  assert.deepEqual(selected.ordered_item_ids.slice(8),['10b','9b','8b','7b','6b','5b','4b','3b','2a','2b','1a','1b']);
  assert.equal(new Set(selected.ordered_item_ids).size,20);
});

test('flat numbered catalogue uses real headings and preserves unnumbered files and separate sheets',()=>{
  const entries=[{...file('a','','1-0'),title:'发行人基本情况'},file('b','','1-2'),{...file('c','','2-0'),title:'业务经营'},file('d','','2-1')];
  assert.deepEqual(workpaperChapters(entries).map(c=>[c.title,c.item_ids]),[['1-0 发行人基本情况',['a','b']],['2-0 业务经营',['c','d']]]);
  assert.equal(workpaperChapters([file('a'),file('b')]).length,1);
  assert.equal(workpaperChapters([file('a','同名','','甲'),file('b','同名','','乙')]).length,2);
  assert.deepEqual(workpaperChapters([{...file('folder'),kind:'folder'},file('a')])[0]!.item_ids,['a']);
  assert.deepEqual(workpaperChapters([]),[]);
});

test('invalid file selections and non-exact chapter permutations fail closed',()=>{
  const entries=[file('a','甲'),file('b','乙')],order=workpaperChapters(entries).map(c=>c.id);
  for(const [ids,chapters] of [[[],order],[['a','a'],order],[['foreign'],order],[['a','b'],[]],[['a','b'],[order[0],order[0]]],[['a'],order]] as [string[],string[]][])
    assert.throws(()=>workpaperProgressiveSelection(entries,ids,chapters),/WORKPAPER_PROGRESSIVE/);
});

test('opt-in progressive schemas preserve old requests and require revision plus idempotency key for confirmation',()=>{
  const progressive={chapter_order:['chapter-1']};
  const start={request_id:'r',catalogue_id:'c',catalogue_sha256:'a'.repeat(64),item_ids:['a'],source_version_id:'s',source_selection_revision:1,requirements:'',price_version:'p',expected_points:1,start_mode:'direct'};
  const submit={request_id:'r',expected_revision:1,source_version_id:'s',source_selection_revision:1,expected_points:1,price_version:'p'};
  for(const [schema,value] of [[WorkpaperStartSchema,start],[FileGenerationSubmitSchema,submit],[FileGenerationPreparationSchema,emptyFileGenerationPreparation()]] as const){
    assert.equal(Value.Check(schema,value),true);
    assert.equal(Value.Check(schema,{...value,progressive}),true);
    assert.equal(Value.Check(schema,{...value,progressive:{chapter_order:['chapter-1','chapter-1']}}),false);
  }
  assert.equal(Value.Check(WorkpaperActionSchema,{action:'continue_remaining',expected_revision:1,request_id:'confirm'}),true);
  assert.equal(Value.Check(WorkpaperActionSchema,{action:'continue_remaining',expected_revision:1}),false);
  assert.equal(Value.Check(WorkpaperTaskSchema,{batch_id:'b',catalogue_id:'c',entry:file('a'),mode:'direct',execution:'progressive_item_v1'}),true);
});
