import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { inputManifestHash, loadExactReviewedContext } from '@bondbuddy/api/production-rule-pin';
import { rulePackContentHash } from '@bondbuddy/domain';
import type { ProductionRulePackSelection } from '@bondbuddy/rule-pack-registry';
import { loadReviewRuleContext, type ReviewRuleManifest } from './review-rule-context.js';
import { syntheticHistoricalRules } from './test-fixtures/historical-rules.js';
import type { StageContext } from './run-pipeline.js';

function fixture(){
  const selected=syntheticHistoricalRules();
  const manifest:ReviewRuleManifest={market:selected.pin.market,offering:selected.pin.offering,issuer_name:'Synthetic issuer',draft_revision:1,materials:[],review:{input:{as_of:selected.pin.asOf}}};
  const row=()=>({id:selected.pin.releaseEventId,pack_id:selected.pack.pack_id,pack_version:selected.pack.version,content_hash:rulePackContentHash(selected.pack),
    action:'production_release',market:selected.pin.market,offering:selected.pin.offering,pack_snapshot:structuredClone(selected.pack)});
  const calls:{sql:string;params:unknown[]}[]=[];let contexts:unknown[]=[];let releases:unknown[]=[row()];let saves=0;
  const ctx={run:{id:'synthetic-run',owner_user_id:'synthetic-owner',project_id:'synthetic-project',input_revision:2,input_hash:inputManifestHash(manifest)},checkpoint:{},
    pool:{query:async(sql:string,params:unknown[]=[])=>{calls.push({sql,params});return {rows:sql.includes('bb_rule_applicability_context_drafts')?contexts:releases};}} as unknown as Pool} as unknown as StageContext;
  const save=async()=>{saves++;};
  return {manifest,ctx,selected,calls,row,save,getSaves:()=>saves,setContexts:(value:unknown[])=>{contexts=value;},setReleases:(value:unknown[])=>{releases=value;}};
}
test('missing market, offering or date remains uncovered and never supplies fabricated defaults',async()=>{
  for(const change of [{market:null},{market:'unsupported'},{offering:null},{offering:'unsupported'},{review:{input:{as_of:null}}},{review:{input:{as_of:'2026-02-30'}}}]){
    const f=fixture();Object.assign(f.manifest,change);f.ctx.run.input_hash=inputManifestHash(f.manifest);const result=await loadReviewRuleContext(f.ctx,f.manifest,[],{save:f.save});
    assert.equal(result.rule_context,null);assert.equal(result.rules.length,0);assert.equal(f.calls.length,0);
  }
});
test('actual published ledger sources are pinned as unknown applicability when context is unreviewed',async()=>{
  const f=fixture();const result=await loadReviewRuleContext(f.ctx,f.manifest,[],{save:f.save});
  assert.equal(result.rule_context,null);assert.equal(result.rule_packs[0]?.pack_id,f.selected.pack.pack_id);assert.equal(result.rules[0]?.applicability,'unknown');
  assert.equal(result.rules[0]?.source_sha256,f.selected.pack.sources[0]?.document_hash);assert.equal(f.getSaves(),1);
  assert(f.calls.filter(c=>c.sql.includes('bb_rule_pack_production_release_events')).every(c=>c.params.includes('sse')&&c.params.includes('private')));
  assert(result.limitations.some(s=>s.includes('仅作为引用阅读')));assert.equal(result.formatting_requirements.length,0);
});
test('replay rechecks the exact pinned release and never silently selects a newer replacement',async()=>{
  const f=fixture();await loadReviewRuleContext(f.ctx,f.manifest,[],{save:f.save});f.setReleases([{...f.row(),has_later_event:true}]);
  const result=await loadReviewRuleContext(f.ctx,f.manifest,[],{save:f.save});assert.equal(result.rules.length,0);assert(result.limitations.some(s=>s.includes('替换')));assert.equal(f.getSaves(),1);
  const last=f.calls.at(-1)!;assert.match(last.sql,/e.id=ANY/);assert.deepEqual(last.params[0],['synthetic-release']);
});
test('withdrawn, expired, unpublished, tampered and cross-market sources never enter the prompt',async()=>{
  for(const kind of ['withdrawn','expired','draft','tampered','cross-market']){
    const f=fixture(),row=f.row();if(kind==='withdrawn')row.action='production_withdrawal';
    if(kind==='expired'){row.pack_snapshot.validity.effective_to='2026-01-10';row.content_hash=rulePackContentHash(row.pack_snapshot);row.pack_snapshot.release!.content_hash=row.content_hash;}
    if(kind==='draft')row.pack_snapshot.status='draft';
    if(kind==='tampered')row.pack_snapshot.sources[0]!.exact_quote='Changed source';
    if(kind==='cross-market')row.offering='public_all';f.setReleases([row]);
    const result=await loadReviewRuleContext(f.ctx,f.manifest,[],{save:f.save});assert.equal(result.rules.length,0,kind);
  }
});
function reviewed(f:ReturnType<typeof fixture>){
  const identity={status:'verified',record_id:'synthetic-identity',version:1,content_hash:'a'.repeat(64),entity_id:'synthetic-issuer',issuer_display_name:f.manifest.issuer_name!,material_id:'synthetic-material',material_version:1,source_snapshot_id:'synthetic-parse',source_record_id:'r1',source_record_sha256:'b'.repeat(64),source_content_sha256:'c'.repeat(64),reviewed_by:'synthetic-reviewer',reviewed_at:'2026-09-24T00:00:00Z'};
  f.setContexts([{id:'synthetic-context',version:1,content_hash:'d'.repeat(64),source_input_revision:1,source_input_hash:'e'.repeat(64),source_manifest:{issuer_identity:identity}}]);
  const pin=f.selected.pin;return {status:'approved' as const,reasons:[],request:{market:pin.market,offering:pin.offering,instrument:pin.instrument,documentStage:pin.documentStage,asOf:pin.asOf,
    issuerScope:pin.applicabilityContext.issuerScope,investorScope:pin.applicabilityContext.investorScope??'',industry:pin.applicabilityContext.industry??'',specialFeatures:[...(pin.applicabilityContext.specialFeatures??[])]},contextPin:{} as never};
}
test('reviewed-context selection and exact production revalidation supply eligible rules (synthetic)',async()=>{
  const f=fixture();f.selected={...f.selected,pin:{...f.selected.pin,applicabilityContext:{...f.selected.pin.applicabilityContext,industry:''}}};const approved=reviewed(f);const modes:string[]=[];let selections=0,rechecks=0;
  const options={save:f.save,loadExact:async(...args:Parameters<typeof loadExactReviewedContext>)=>{modes.push(args[7]??'selection');return approved;},
    select:async()=>{selections++;return f.selected as ProductionRulePackSelection;},revalidate:async()=>{rechecks++;return f.selected as ProductionRulePackSelection;}};
  const result=await loadReviewRuleContext(f.ctx,f.manifest,[],options);assert.equal(result.rule_context?.document_stage,'issuance');assert(result.rules.every(r=>r.applicability==='applicable'));assert.equal(selections,1);assert.equal(rechecks,1);assert.deepEqual(modes,['selection','replay']);
  await loadReviewRuleContext(f.ctx,f.manifest,[],options);assert.equal(selections,1);assert.equal(rechecks,2);assert.equal(modes.at(-1),'replay');
});
test('withdrawn approved pin does not fall back to a reference or another rule release',async()=>{
  const f=fixture();f.selected={...f.selected,pin:{...f.selected.pin,applicabilityContext:{...f.selected.pin.applicabilityContext,industry:''}}};const approved=reviewed(f);let rechecks=0;
  const options={save:f.save,loadExact:async()=>approved,select:async()=>f.selected as ProductionRulePackSelection,
    revalidate:async():Promise<ProductionRulePackSelection>=>++rechecks===1?f.selected:{status:'blocked',reasons:['production_rule_pack_withdrawn']}};
  await loadReviewRuleContext(f.ctx,f.manifest,[],options);const result=await loadReviewRuleContext(f.ctx,f.manifest,[],options);assert.equal(result.rules.length,0);assert(result.limitations.some(s=>s.includes('withdrawn')));
});
test('public-all and DFI lookups retain exact offering without substituting private/public',async()=>{
  for(const [market,offering] of [['sse','public_all'],['nafmii','dfi']]){
    const f=fixture();f.manifest.market=market!;f.manifest.offering=offering!;f.ctx.run.input_hash=inputManifestHash(f.manifest);f.setReleases([]);
    const result=await loadReviewRuleContext(f.ctx,f.manifest,[],{save:f.save});assert.equal(result.rules.length,0);
    const query=f.calls.find(c=>c.sql.includes('WITH latest'))!;assert.deepEqual(query.params,[market,offering]);
  }
});
test('hash/owner/material mismatches fail before rule queries',async()=>{
  const f=fixture();f.ctx.run.input_hash='a'.repeat(64);await assert.rejects(()=>loadReviewRuleContext(f.ctx,f.manifest,[],{save:f.save}),/INPUT_HASH_MISMATCH/);assert.equal(f.calls.length,0);
});
