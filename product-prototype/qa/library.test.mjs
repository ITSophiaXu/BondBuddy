import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProspectusLibrary, normaliseEntry, officialUrl } from '../lib/prospectus-library.mjs';
import { matchProspectus, blueprintEligibility } from '../public/library-schema.js';
import { ROOT, PYTHON, processRun } from '../lib/platform.mjs';

const dir=join(ROOT,'qa','artifacts','library-'+randomUUID());await mkdir(dir,{recursive:true});
await processRun(PYTHON,[join(ROOT,'qa','make_library_fixtures.py'),dir]);
const library=new ProspectusLibrary(join(dir,'library'));
const metadata={title:'测试募集书',issuer:'测试参考企业',market:'sse',instrument:'公司债券',offering:'public',projectStatus:'审核通过',sourceUrl:'https://bond.sse.com.cn/project/fixture',documentUrl:'https://static.sse.com.cn/fixture.pdf',publishedAt:'2026-06-30',version:'申报稿',industry:'制造业',region:'江苏省',ownership:'地方国有企业',assetBand:'100—500亿元'};
const pdf={filename:'blueprint.pdf',content:await readFile(join(dir,'blueprint.pdf'))};
const own={owner:'one',file:pdf,confirmed:true};

test('official URLs reject lookalike hosts, credential URLs, unsupported ports and foreign markets',()=>{
  for(const url of ['https://bond.sse.com.cn.evil.test/a','https://bond.sse.com.cn@evil.test/a','https://bond.sse.com.cn:444/a','file:///etc/passwd','http://localhost/a','javascript:alert(1)','https://bond.szse.cn/a'])assert.throws(()=>officialUrl(url,'sse',true));
  assert.equal(officialUrl('http://bond.sse.com.cn/bridge/information/#','sse',true),'http://bond.sse.com.cn/bridge/information/#');
  assert.throws(()=>normaliseEntry({...metadata,publishedAt:'2026-02-30'}));
  assert.throws(()=>normaliseEntry({...metadata,projectStatus:'已通过并永久有效'}));
});
test('PDF ingestion builds a searchable text index, deduplicates and keeps personal documents private',async()=>{
  const item=await library.add(metadata,own);assert.equal(item.textReady,true);assert.equal(item.file.sha256.length,64);assert(!('owner'in item));assert(!('diskName'in item.file));
  assert.equal((await library.add(metadata,own)).duplicate,true);
  assert.equal((await library.search('one',{q:'LIBRARY_BODY_SEARCH_TOKEN'})).items[0].hit.locator,'PDF-P001');
  assert.equal((await library.search('other')).total,0);
  await assert.rejects(library.detail(item.id,'other'),e=>e.status===404);
  await assert.rejects(library.document(item.id,'other'),e=>e.status===404);
  await assert.rejects(library.blueprint(item.id,'other',{exchange:'sse',offering:'public'}),e=>e.status===404);
  const selected=await library.blueprint(item.id,'one',{exchange:'sse',offering:'public'});assert.deepEqual(selected.file.content,pdf.content);assert.equal(selected.snapshot.issuer,metadata.issuer);
  await assert.rejects(library.blueprint(item.id,'one',{exchange:'szse',offering:'public'}),/交易所不同/);
  await assert.rejects(library.add(metadata,{...own,visibility:'public'}),e=>e.status===403);
});
test('index-only, unreadable, unconfirmed, withdrawn and interbank entries stay browseable but cannot be blueprints',async()=>{
  const inputs=[
    [metadata,{owner:'index',confirmed:true}],
    [metadata,{owner:'scan',file:{filename:'scan.pdf',content:await readFile(join(dir,'scan.pdf'))},confirmed:true}],
    [metadata,{owner:'pending',file:pdf}],
    [{...metadata,projectStatus:'终止 / 撤回'},{...own,owner:'withdrawn'}],
    [{...metadata,market:'nafmii',instrument:'中期票据（MTN）',sourceUrl:'http://zhuce.nafmii.org.cn/project/fixture',documentUrl:'http://www.nafmii.org.cn/fixture.pdf'},{...own,owner:'interbank'}]
  ];
  for(const [entry,options] of inputs){const item=await library.add(entry,options);assert.equal((await library.search(options.owner)).total,1);assert.equal((await library.search(options.owner,{sort:'recommended',target_exchange:'sse',target_offering:'public'})).total,0);assert.equal(blueprintEligibility(item).eligible,false);await assert.rejects(library.blueprint(item.id,options.owner,{}));}
});
test('matching explains actual known dimensions without inventing absent characteristics',()=>{
  const ready={...metadata,confirmedAt:'2026-07-01',textReady:true,file:{name:'a.pdf'}};
  const matched=matchProspectus(ready,{exchange:'sse',offering:'public',industry:'制造业',ownership:'地方国有企业'});
  const unknown=matchProspectus({...ready,industry:'',ownership:''},{exchange:'sse',offering:'public',industry:'制造业',ownership:'地方国有企业'});
  const different=matchProspectus({...ready,industry:'房地产'},{exchange:'sse',offering:'public',industry:'制造业'});
  assert(matched.score>unknown.score);assert(unknown.unknown.includes('行业信息缺失'));assert(!unknown.reasons.includes('行业相同'));assert(different.differences.includes('行业不同'));
});
test('new versions retire older recommendations while preserving files and source snapshots',async()=>{
  const old=await library.add(metadata,{...own,owner:'version'});
  const next=await library.add({...metadata,version:'注册稿',projectStatus:'注册生效',supersedes:old.id},{...own,owner:'version'});
  assert.equal((await library.detail(old.id,'version')).supersededBy,next.id);
  await assert.rejects(library.blueprint(old.id,'version',{}),/更新的收录版本/);
  const search=await library.search('version',{sort:'recommended'});assert.equal(search.total,1);assert.equal(search.items[0].id,next.id);
  assert.deepEqual(await readFile(await library.document(old.id,'version')),pdf.content);
  const publicItem=await library.add(metadata,{...own,owner:'operator',operator:true,visibility:'public'});
  await assert.rejects(library.add({...metadata,supersedes:publicItem.id},{...own,owner:'customer'}),/相同收录范围/);
  const visible=await library.search('visitor');assert.equal(visible.stats.public,1);assert.equal(visible.items[0].visibility,'public');
});
test('operator batch ingestion publishes reviewed official entries and reports rejected rows',async()=>{
  const manifest=join(dir,'batch.json'),runtime=join(dir,'cli-runtime');
  await writeFile(manifest,JSON.stringify([{...metadata,reviewed:true,filePath:'blueprint.pdf'}]));
  // The CLI inherits a dedicated runtime; no business catalog is changed.
  const old=process.env.BOND_BUDDY_RUNTIME;process.env.BOND_BUDDY_RUNTIME=runtime;
  try{const output=await processRun(process.execPath,[join(ROOT,'scripts','import-library.mjs'),manifest,'--publish']);assert.equal(JSON.parse(output)[0].status,'已收录正文');assert.equal((await new ProspectusLibrary(join(runtime,'library')).search('visitor')).stats.public,1);}finally{if(old===undefined)delete process.env.BOND_BUDDY_RUNTIME;else process.env.BOND_BUDDY_RUNTIME=old;}
});
test('a changed library file is rejected instead of silently snapshotting different bytes',async()=>{
  const item=await library.add(metadata,{...own,owner:'tamper'});await writeFile(await library.document(item.id,'tamper'),'corrupted');await assert.rejects(library.blueprint(item.id,'tamper',{}),/校验失败/);
});
