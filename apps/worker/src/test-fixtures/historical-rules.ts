import { readFileSync } from 'node:fs';
import { publishRulePackBundle, type RulePack, type ReviewAttestation, type ChapterTemplate, type CoverageManifest } from '@bondbuddy/domain';
import { updateContentHash } from '@bondbuddy/domain/historical-update';
import type { ProductionRulePackSelection } from '@bondbuddy/rule-pack-registry';

/** Synthetic in-memory adapter fixture only. Never persisted as a production release or acceptance. */
export function syntheticHistoricalRules(mutate?: (draft: RulePack) => void): Extract<ProductionRulePackSelection, { status: 'selected' }> {
  const draft = JSON.parse(readFileSync(new URL('../../../../packages/domain/examples/synthetic-rule-pack.json', import.meta.url), 'utf8')) as RulePack;
  draft.pack_id = 'synthetic-rules'; draft.version = '1';
  draft.scope = { market: 'sse', offering: 'private', instruments: ['ordinary-company-bond'], document_stages: ['issuance'], issuer_scopes: ['domestic-company'] };
  draft.sources[0] = { ...draft.sources[0]!, kind: 'formal_rule', official_url: 'https://example.invalid/synthetic',
    document_hash: 'a'.repeat(64), published_on: '2026-01-01', effective_from: '2026-01-01',
    verified_by: 'synthetic-industry', verified_at: '2026-09-24T00:30:00Z' };
  draft.rules[0] = { ...draft.rules[0]!, enabled: true, enforcement: 'soft_check',
    applicability: { ...draft.rules[0]!.applicability, document_stages: ['issuance'] },
    boundaries: ['合成规则：金额和材料不一致时保留待人工确认。'], exceptions: ['合成例外不得省略。'] };
  // The publisher's schema requires this tag. These names/evidence remain synthetic and are never acceptance evidence.
  draft.sample_suite.data_classification = 'authorized_real';
  mutate?.(draft);
  const reviews: ReviewAttestation[] = ['industry_reviewer', 'technical_reviewer'].map(role => ({
    reviewer_id: `synthetic-${role}`, reviewer_role: role as ReviewAttestation['reviewer_role'], reviewed_at: '2026-09-24T01:00:00Z',
    source_verified: true, scope_verified: true, samples_verified: true, notes: 'Synthetic isolated test, not an actual signature.' }));
  const template: ChapterTemplate = { schema_version: 'chapter-template-v1', template_id: 'synthetic-template', version: '1',
    rule_pack_id: draft.pack_id, market: 'sse', offering: 'private', document_stages: ['issuance'], chapters: [
      { chapter_id: 'synthetic-chapter', title: '合成章节', form_refs: ['synthetic-form'], source_ref_ids: ['synthetic-lead'],
        required_fields: [], applicability: 'Synthetic test only' } ] };
  const coverage: CoverageManifest = { schema_version: 'capability-coverage-v1', manifest_id: 'synthetic-coverage', version: '1',
    rule_pack_id: draft.pack_id, assessed_at: '2026-09-24T01:00:00Z', open_blockers: [], items: [
      { item_id: 'synthetic-item', area: 'Synthetic area', disposition: 'covered', document_stages: ['issuance'],
        source_ref_ids: ['synthetic-lead'], rationale: 'Synthetic isolated test, not actual acceptance.' } ] };
  const pack = publishRulePackBundle(draft, template, coverage, { channel: 'production', reviews, released_by: 'synthetic-operator',
    released_at: '2026-09-24T02:00:00Z', reason: 'Synthetic isolated test; never write to production.' });
  return { status: 'selected', pack, template, coverage,
    pin: { releaseEventId: 'synthetic-release', packId: pack.pack_id, version: '1', contentHash: pack.release!.content_hash,
      templateId: 'synthetic-template', templateVersion: '1', templateHash: updateContentHash(template), coverageId: 'synthetic-coverage',
      coverageVersion: '1', coverageHash: updateContentHash(coverage), sourceCheckIds: ['synthetic-source-check'], sampleEvidenceIds: ['synthetic-sample'],
      market: 'sse', offering: 'private', instrument: 'ordinary-company-bond', documentStage: 'issuance', asOf: '2026-09-26',
      applicabilityContext: { issuerScope: 'domestic-company', investorScope: 'professional', industry: null, specialFeatures: [] } } };
}
