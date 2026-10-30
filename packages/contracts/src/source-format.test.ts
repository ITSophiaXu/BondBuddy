import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { emptyUpdateDetails, FormatTemplatePinSchema, SourceFormatPolicySchema, UpdateDetailsSchema,
  recommendFormatTemplate, sameFormatTemplate, type SourceProspectus, type UnifiedAuthoringInput } from './update-project.js';

const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const first = { material_id: 'z-first-upload', material_version: 2, sha256: 'a'.repeat(64), role: 'historical', media_type: docx };
const pin = { material_id: first.material_id, material_version: first.material_version, sha256: first.sha256 };
const declaration = (material = first, relation: SourceProspectus['relation'] = 'same_issuer'): SourceProspectus => ({ ...material,
  issuer_name: null, relation, market: null, offering: null, reporting_periods: [], status: 'user_asserted' });

test('format choice is optional, nullable and bound to exact material bytes', () => {
  for (const edit of [{}, { format_template: null }, { format_template: pin }])
    assert.ok(Value.Check(UpdateDetailsSchema, { ...emptyUpdateDetails(), ...edit }));
  for (const invalid of [{ ...pin, material_version: 0 }, { ...pin, sha256: 'bad' }, { ...pin, path: '/private' }])
    assert.equal(Value.Check(FormatTemplatePinSchema, invalid), false);
  assert.ok(sameFormatTemplate(pin, first));
  assert.equal(sameFormatTemplate(pin, { ...pin, material_version: 3 }), false);
  assert.equal(sameFormatTemplate(pin, { ...pin, sha256: 'b'.repeat(64) }), false);
  assert.equal(sameFormatTemplate(null, null), false);
});

test('recommendation favors editable DOCX and same issuer, preserving upload order for ties', () => {
  const later = { ...first, material_id: 'a-later-upload' };
  const pdf = { ...first, material_id: 'pdf', media_type: 'application/pdf' };
  assert.equal(recommendFormatTemplate([pdf, first, later], [declaration(pdf)]), first);
  assert.equal(recommendFormatTemplate([first, later], [declaration(later)]), later);
  assert.equal(recommendFormatTemplate([first, later]), first);
  assert.equal(recommendFormatTemplate([{ ...first, role: 'financial' }, { ...first, media_type: 'text/plain' }]), null);
  assert.equal(recommendFormatTemplate([], []), null);
});

test('policy schema distinguishes editable, reconstructed, first-draft and exact previous-output inputs', () => {
  const material = { version: 'source-format-v1', mode: 'preserve_docx', template: { kind: 'material', ...pin }, selection: 'explicit' };
  const artifact = { version: 'source-format-v1', mode: 'preserve_docx', template: { kind: 'artifact', artifact_id: 'clean', version: 1,
    sha256: pin.sha256, run_id: 'prior-run', input_revision: 3 }, selection: 'previous_output' };
  for (const policy of [material, { ...material, mode: 'reconstruct_pdf' }, artifact,
    { version: 'source-format-v1', mode: 'new_document', template: null, selection: 'automatic' }])
    assert.ok(Value.Check(SourceFormatPolicySchema, policy));
  for (const policy of [{ ...artifact, mode: 'reconstruct_pdf' }, { ...material, template: null },
    { ...artifact, selection: 'explicit' }, { ...material, version: 'future-version' }])
    assert.equal(Value.Check(SourceFormatPolicySchema, policy), false);
  const legacy: UnifiedAuthoringInput = { version: 'unified_v1', source_prospectuses: [], requirements: [], knowledge: [],
    knowledge_status: 'authoring_reference_not_compliance_approval' };
  assert.equal(Object.hasOwn(legacy, 'format_policy'), false, 'old input snapshots retain their original path');
});
