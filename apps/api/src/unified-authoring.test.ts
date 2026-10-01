import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { MARKET_OFFERINGS, emptyUpdateDetails, UpdateDetailsSchema, updateDetailsErrors, type Market, type Offering, type ProjectMessageSetPin, type SourceProspectus } from '@bondbuddy/contracts';
import { lockUnifiedAuthoring } from './unified-authoring.js';
import { digest } from './data.js';
const messages={version:0,content_sha256:'0'.repeat(64),members:[],message_ids:[]} as ProjectMessageSetPin;
const source: SourceProspectus = { material_id:'source-a',material_version:1,sha256:'a'.repeat(64),issuer_name:'合成母公司',relation:'parent',market:'sse',offering:'private',reporting_periods:[],status:'user_asserted' };

test('existing knowledge snapshots are selected by target type, including all eleven scopes',async()=>{
  for(const [market,offerings] of Object.entries(MARKET_OFFERINGS)) for(const offering of offerings){
    const pin=await lockUnifiedAuthoring({market:market as Market,offering:offering as Offering,update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1'}},[],messages);
    assert.ok(pin.knowledge.length);assert.equal(pin.knowledge_status,'authoring_reference_not_compliance_approval');
    assert.ok(pin.knowledge.some(k=>k.path.includes(`${market}-${offering}`)||k.path.includes(`/${offering}/`)));
    for(const k of pin.knowledge)assert.equal(digest(k.markdown),k.sha256);
    assert.deepEqual(pin.source_prospectuses,[]);
  }
});

test('source declarations never select target knowledge and stale material replacements fail',async()=>{
  const project={market:'szse' as const,offering:'public_all' as const,update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1' as const,source_prospectuses:[source]}};
  const pin=await lockUnifiedAuthoring(project,[{material_id:'source-a',material_version:1,sha256:source.sha256,role:'historical'}],messages);
  assert.equal(pin.source_prospectuses[0].relation,'parent');assert.match(pin.knowledge[0].path,/szse-public_all/);
  await assert.rejects(()=>lockUnifiedAuthoring(project,[{material_id:'source-a',material_version:2,sha256:'b'.repeat(64),role:'historical'}],messages),/Source declaration/);
  assert.deepEqual((await lockUnifiedAuthoring(project,[],messages)).source_prospectuses,[]);
});

test('source metadata uses public enums and validates dates without converting user declarations into evidence',()=>{
  const details={...emptyUpdateDetails(),authoring_mode:'unified_v1' as const,source_prospectuses:[source]};
  assert.ok(Value.Check(UpdateDetailsSchema,details));
  assert.equal(Value.Check(UpdateDetailsSchema,{...details,source_prospectuses:[{...source,status:'verified'}]}),false);
  assert.equal(updateDetailsErrors({...details,source_prospectuses:[{...source,market:'nafmii'}]})[0].code,'invalid_source_scope');
  assert.equal(updateDetailsErrors({...details,source_prospectuses:[source,source]})[0].code,'duplicate_source');
});
