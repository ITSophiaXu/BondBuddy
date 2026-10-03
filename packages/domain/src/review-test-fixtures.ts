/** Entirely synthetic fixtures; no customer documents or genuine release attestations. */
import { readFile } from 'node:fs/promises';
import type { ReviewRuleRef } from '../../contracts/dist/review-results.js';
import { publishRulePack, rulePackContentHash, type RulePack, type RuleContext, type ReviewAttestation } from './index.js';
import { referenceFor, reviewContentHash, type TrustedReviewRecord, type ReviewEvidenceContext } from './review-evidence.js';
import type { ReviewFinancialObservation } from './review-financial-checks.js';

export function reviewFixture() {
  const records: TrustedReviewRecord[] = [];
  const source_material = { material_id:'synthetic-disclosure',material_version:1,sha256:'a'.repeat(64) };
  const ctx: ReviewEvidenceContext = { owner_user_id:'synthetic-user', project_id:'synthetic-project',report_id:'synthetic-report-1',source_material,records,rules:[] };
  const addRecord = (id: string, quote: string, disclosure = true, extra: Partial<TrustedReviewRecord> = {}): TrustedReviewRecord => {
    const record: TrustedReviewRecord = { owner_user_id:ctx.owner_user_id,project_id:ctx.project_id,
      material_id:disclosure ? source_material.material_id : `synthetic-source-${id}`,material_version:1,
      material_sha256:disclosure ? source_material.sha256 : reviewContentHash(id),
      parse_snapshot_id:`synthetic-parse-${id}`,parse_response_sha256:reviewContentHash(`parse:${id}`),
      record_id:id,record_sha256:reviewContentHash(quote),locator_type:'docx_block',
      locator:{stable_ref:`p:${id}`,path:[{paragraph:records.length+1}]},literal_quote:quote,
      extraction_method:'native_text',uncertainty:[],...extra };
    records.push(record); return record;
  };
  const observation = (id: string, value: string, options: Partial<ReviewFinancialObservation> = {}): ReviewFinancialObservation => {
    const source_kind = options.source_kind ?? 'disclosure';
    const ref = referenceFor(addRecord(id,`合成甲公司 合并 原始报表 2025-01-01至2025-12-31 CNY ${options.unit ?? '万元'} 营业收入 ${options.value_literal ?? value}`,source_kind === 'disclosure'));
    return { observation_id:id,source_kind,entity_id:'synthetic-issuer',metric:'revenue',accounting_scope:'consolidated',basis:'original',context_verification:'trusted_structured',
      period:{start:'2025-01-01',end:'2025-12-31',as_of:null},currency:'CNY',unit:'万元',value,value_literal:value,
      value_refs:[ref],context_refs:{entity:[ref],period:[ref],accounting_scope:[ref],currency:[ref],unit:[ref],basis:[ref]},...options };
  };
  return {ctx,records,addRecord,observation};
}

export const syntheticRuleContext: RuleContext = {market:'sse',offering:'public_all',document_stage:'registration',issuer_scope:'synthetic_issuer',as_of:'2026-09-24'};
export async function syntheticReviewPack(): Promise<{pack:RulePack; ref:ReviewRuleRef}> {
  const draft: RulePack = JSON.parse(await readFile(new URL('../examples/synthetic-rule-pack.json',import.meta.url),'utf8'));
  draft.sources[0] = {...draft.sources[0]!,source_id:'synthetic-formal-source',kind:'formal_rule',official_url:'https://example.invalid/synthetic-rule',document_hash:'b'.repeat(64),published_on:'2025-12-01',effective_from:'2026-01-01',legal_effective_date_basis:'explicit_text',effective_date_derivation_evidence:[{kind:'synthetic_clause',value:'clause 1'}],verified_by:'synthetic-industry-reviewer',verified_at:'2026-09-24T00:30:00Z'};
  draft.rules[0] = {...draft.rules[0]!,enabled:true,enforcement:'hard_block',source_ref_ids:['synthetic-formal-source'],outputs:{when_met:'pass',when_not_met:'issue',severity:'blocking'}};
  // Simulated metadata exercises the release gate, not a claim of genuine authorization.
  draft.sample_suite.data_classification = 'authorized_real';
  const reviews: ReviewAttestation[] = ['industry_reviewer','technical_reviewer'].map((role,i) => ({reviewer_id:`synthetic-reviewer-${i}`,reviewer_role:role as ReviewAttestation['reviewer_role'],reviewed_at:'2026-09-24T01:00:00Z',source_verified:true,scope_verified:true,samples_verified:true,notes:'Synthetic test attestation only.'}));
  const pack = publishRulePack(draft,{channel:'production',reviews,released_by:'synthetic-release-operator',released_at:'2026-09-24T01:30:00Z',reason:'Synthetic test fixture only; not professional evidence.'});
  const source = pack.sources[0]!, rule = pack.rules[0]!;
  return {pack,ref:{rule_id:rule.rule_id,rule_version:rule.version,pack_id:pack.pack_id,pack_version:pack.version,pack_sha256:rulePackContentHash(pack),source_id:source.source_id,source_version:source.source_version,source_sha256:source.document_hash!,quote:source.exact_quote,locator:source.clause_locator,effective_from:source.effective_from,effective_to:source.effective_to,applicability:'applicable',authority:'regulatory',url:source.official_url!}};
}
