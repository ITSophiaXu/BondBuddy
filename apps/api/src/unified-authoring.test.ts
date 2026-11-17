import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { MARKET_OFFERINGS, emptyUpdateDetails, UpdateDetailsSchema, updateDetailsErrors, type Market, type Offering, type ProjectMessageSetPin, type SourceProspectus } from '@bondbuddy/contracts';
import { assertAuthoringSourceInformation, assertAuthoringSourceRequired, assertAuthoringAuditRequired, lockUnifiedAuthoring } from './unified-authoring.js';
import { digest, publicProblem, Problem } from './data.js';
import { SOURCE_PROSPECTUS_REQUIRED_FIELD_ERROR, AUDIT_REPORT_REQUIRED_FIELD_ERROR } from '@bondbuddy/contracts';
import { lockReviewFileDelivery } from './review-file-knowledge.js';
const messages={version:0,content_sha256:'0'.repeat(64),members:[],message_ids:[]} as ProjectMessageSetPin;
test('new authoring requires a source, while verified previous results remain usable', () => {
  const financial = { material_id: 'financial', material_version: 1, sha256: 'a'.repeat(64), role: 'financial' };
  for (const materials of [[], [financial]]) assert.throws(() => assertAuthoringSourceRequired(materials), error => {
    assert.ok(error instanceof Problem);
    assert.equal(error.status, 422);
    assert.deepEqual(publicProblem(error, 'synthetic-source-required').field_errors, [SOURCE_PROSPECTUS_REQUIRED_FIELD_ERROR]);
    return true;
  });
  for (const role of ['historical', 'reference']) assert.doesNotThrow(() => assertAuthoringSourceRequired([{...financial, role}]));
  assert.doesNotThrow(() => assertAuthoringSourceRequired([financial], {
    artifact_id: 'verified-result', version: 1, sha256: 'b'.repeat(64), run_id: 'previous-run', input_revision: 1,
  }));
});
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

test('PPN locks the complete 20261013 writing framework without leaking it to other target products', async () => {
  const path = 'knowledge/nafmii/drafts/ppn/writing-20261013/writing-framework.md';
  const project = {market: 'nafmii' as const, offering: 'ppn' as const,
    update_details: {...emptyUpdateDetails(), authoring_mode: 'unified_v1' as const, source_prospectuses: [source]}};
  const materials = [{material_id: source.material_id, material_version: 1, sha256: source.sha256, role: 'reference'}];
  const pin = await lockUnifiedAuthoring(project, materials, messages);
  const guide = pin.knowledge.find(k => k.path === path)!;
  assert.ok(guide);
  assert.equal(guide.sha256, digest(guide.markdown));
  assert.match(guide.markdown, /ppn-writing-2026\.10\.13-v1/);
  assert.equal([...guide.markdown.matchAll(/^### C\d+ /gm)].length, 108);
  assert.equal([...guide.markdown.matchAll(/^### T\d{3} /gm)].length, 90);
  assert.match(guide.markdown, /第九章 定向信息披露安排/);
  assert.match(guide.markdown, /第十三章 主动债务管理/);
  assert.match(guide.markdown, /可用授信／总负债 <30%/);
  assert.match(guide.markdown, /可用授信／有息负债 ≤30%/);
  assert.match(guide.markdown, /P05610/);
  assert.equal(pin.knowledge_status, 'authoring_reference_not_compliance_approval');
  assert.equal(pin.source_prospectuses[0].relation, 'parent');
  // Even a PPN reference cannot choose the PPN framework for another target.
  const ppnSource = {...source, market: 'nafmii' as const, offering: 'ppn' as const};
  for (const [market, offerings] of Object.entries(MARKET_OFFERINGS)) for (const offering of offerings) {
    if (market === 'nafmii' && offering === 'ppn') continue;
    const other = await lockUnifiedAuthoring({market: market as Market, offering: offering as Offering,
      update_details: {...project.update_details, source_prospectuses: [ppnSource]}}, materials, messages);
    assert.equal(other.knowledge.some(k => k.path === path || k.markdown.includes('ppn-writing-2026.10.13-v1')), false);
  }
});

test('PPN review retains its prior rule sources without treating the update template as review policy', async () => {
  const pin = await lockReviewFileDelivery({market: 'nafmii', offering: 'ppn'});
  assert.deepEqual(pin.knowledge.map(k => k.path), ['knowledge/nafmii/APPLICABILITY.md',
    'knowledge/nafmii/drafts/ppn/README.md', 'knowledge/audit-reconciliation/METHODS.md']);
  assert.equal(pin.knowledge.some(k => k.markdown.includes('ppn-writing-2026.10.13-v1')), false);
  for (const k of pin.knowledge) assert.equal(k.sha256, digest(k.markdown));
});

test('source metadata uses public enums and validates dates without converting user declarations into evidence',()=>{
  const details={...emptyUpdateDetails(),authoring_mode:'unified_v1' as const,source_prospectuses:[source]};
  assert.ok(Value.Check(UpdateDetailsSchema,details));
  assert.equal(Value.Check(UpdateDetailsSchema,{...details,source_prospectuses:[{...source,status:'verified'}]}),false);
  assert.equal(updateDetailsErrors({...details,source_prospectuses:[{...source,market:'nafmii'}]})[0].code,'invalid_source_scope');
  assert.equal(updateDetailsErrors({...details,source_prospectuses:[source,source]})[0].code,'duplicate_source');
});

test('source-name-free declarations pass the same API gate used by input locking, quote and execute', () => {
  const material = { material_id: source.material_id, material_version: 1, sha256: source.sha256, role: 'historical' };
  const declared = { ...source, issuer_name: null, reporting_periods: [{start:'2024-01-01',end:'2024-12-31',period_kind:'annual' as const,scope:null,status:'user_asserted' as const,evidence_refs:[]}] };
  assert.doesNotThrow(() => assertAuthoringSourceInformation([material], [declared]));
  assert.throws(() => assertAuthoringSourceInformation([material], [{...declared,relation:null}]), /企业关系/);
  assert.throws(() => assertAuthoringSourceInformation([{...material,material_version:2}], [declared]), /INPUT_REQUIRED|补齐/);
});


test('only an audit report satisfies authoring audit requirement', () => {
  const pin = {material_id:'synthetic-audit', material_version:1, sha256:'a'.repeat(64), role:'audit'};
  for (const roles of [[], ['historical'], ['reference','financial','interimFinancial','notes']]) {
    assert.throws(() => assertAuthoringAuditRequired(roles.map(role => ({...pin,role}))), error => {
      assert.ok(error instanceof Problem);
      assert.equal(error.status,422);
      assert.deepEqual(publicProblem(error,'synthetic-audit-required').field_errors,[AUDIT_REPORT_REQUIRED_FIELD_ERROR]);
      return true;
    });
  }
  assert.doesNotThrow(() => assertAuthoringAuditRequired([pin]));
});
