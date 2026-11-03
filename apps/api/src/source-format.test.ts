import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { Value } from '@sinclair/typebox/value';
import { emptyUpdateDetails, SourceFormatPolicySchema, type UnifiedAuthoringInput } from '@bondbuddy/contracts';
import { assertOwnedFormatTemplate, lockSourceFormatPolicy, lockUnifiedAuthoring, inheritPreviousOutputFormat } from './unified-authoring.js';

const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const a = { material_id: 'a-source', material_version: 1, sha256: 'a'.repeat(64), role: 'historical', media_type: docx };
const b = { ...a, material_id: 'b-template', sha256: 'b'.repeat(64), role: 'reference' };
const explicit = { material_id: b.material_id, material_version: b.material_version, sha256: b.sha256 };

test('explicit template overrides recommendation but cannot refer to unselected or stale bytes', () => {
  const details = { ...emptyUpdateDetails(), format_template: explicit };
  assert.deepEqual(lockSourceFormatPolicy(details, [a, b]), { version: 'source-format-v1', mode: 'preserve_docx',
    template: { kind: 'material', ...explicit }, selection: 'explicit' });
  for (const materials of [[a], [a, { ...b, sha256: 'c'.repeat(64) }], [a, { ...b, material_version: 2 }],
    [a, { ...b, role: 'financial' }], [a, { ...b, media_type: 'text/plain' }]])
    assert.throws(() => lockSourceFormatPolicy(details, materials), /格式模板/);
  assert.equal(lockSourceFormatPolicy({ ...details, format_template: null }, [a, b]).selection, 'automatic');
});

test('an adopted update original wins DOCX preference and equal-rank reference order', () => {
  const adopted = { material_id: a.material_id, material_version: a.material_version, sha256: a.sha256 };
  assert.deepEqual(lockSourceFormatPolicy(emptyUpdateDetails(), [b, a], adopted), {
    version: 'source-format-v1', mode: 'preserve_docx', template: { kind: 'material', ...adopted }, selection: 'automatic' });
  assert.deepEqual(lockSourceFormatPolicy(emptyUpdateDetails(), [b, { ...a, media_type: 'application/pdf' }], adopted), {
    version: 'source-format-v1', mode: 'reconstruct_pdf', template: { kind: 'material', ...adopted }, selection: 'automatic' });
  assert.equal(lockSourceFormatPolicy({ ...emptyUpdateDetails(), format_template: adopted }, [b, a], adopted).selection, 'explicit');
});

test('adopted source pins fail closed on absent/stale input or a different explicit format', () => {
  const adopted = { material_id: a.material_id, material_version: a.material_version, sha256: a.sha256 };
  for (const materials of [[b], [b, { ...a, material_version: 2 }], [b, { ...a, sha256: 'c'.repeat(64) }],
    [b, { ...a, role: 'financial' }], [b, { ...a, media_type: 'text/plain' }]])
    assert.throws(() => lockSourceFormatPolicy(emptyUpdateDetails(), materials, adopted), /已采用原稿/);
  assert.throws(() => lockSourceFormatPolicy({ ...emptyUpdateDetails(), format_template: explicit }, [a, b], adopted),
    (error: any) => error.status === 409 && error.code === 'INPUT_REVISION_CONFLICT' && /清除旧格式选择/.test(error.message));
});

test('new update authoring locks an immutable adopted format while unbound authoring retains explicit selection', async () => {
  const adopted = { material_id: a.material_id, material_version: a.material_version, sha256: a.sha256 };
  const project = { market: null, offering: null, update_details: emptyUpdateDetails() };
  const messages = { version: 0, content_sha256: '0'.repeat(64), members: [], message_ids: [] };
  const before = structuredClone(project);
  const locked = await lockUnifiedAuthoring(project, [b, a], messages, adopted);
  assert.deepEqual(locked.format_policy.template, { kind: 'material', ...adopted });
  assert.deepEqual(project, before);
  adopted.sha256 = 'c'.repeat(64);
  assert.equal(locked.format_policy.template?.sha256, a.sha256);
  const unbound = await lockUnifiedAuthoring({ ...project, update_details: { ...project.update_details, format_template: explicit } }, [a, b], messages);
  assert.deepEqual(unbound.format_policy.template, { kind: 'material', ...explicit });
});

test('empty, PDF-only and exact DOCX inputs lock distinct modes and do not mutate inputs', async () => {
  const project = { market: null, offering: null, update_details: { ...emptyUpdateDetails(), format_template: explicit } };
  const messages = { version: 0, content_sha256: '0'.repeat(64), members: [], message_ids: [] };
  const locked = await lockUnifiedAuthoring(project, [a, b], messages);
  assert.ok(Value.Check(SourceFormatPolicySchema, locked.format_policy));
  project.update_details.format_template.sha256 = 'c'.repeat(64);
  assert.equal(locked.format_policy.template?.sha256, 'b'.repeat(64));
  assert.equal(lockSourceFormatPolicy(emptyUpdateDetails(), []).mode, 'new_document');
  assert.equal(lockSourceFormatPolicy(emptyUpdateDetails(), [{ ...a, media_type: 'application/pdf' }]).mode, 'reconstruct_pdf');
});

test('continuation inherits the selected clean artifact without changing its revision baseline', () => {
  const authoring: UnifiedAuthoringInput = { version: 'unified_v1', source_prospectuses: [], requirements: [], knowledge: [],
    knowledge_status: 'authoring_reference_not_compliance_approval', format_policy: lockSourceFormatPolicy(emptyUpdateDetails(), [b]),
    previous_output: { artifact_id: 'selected-clean', version: 4, sha256: 'c'.repeat(64), run_id: 'prior-run', input_revision: 2 } };
  const before = structuredClone(authoring.previous_output);
  inheritPreviousOutputFormat(authoring);
  assert.deepEqual(authoring.previous_output, before);
  assert.deepEqual(authoring.format_policy, { version: 'source-format-v1', mode: 'preserve_docx',
    template: { kind: 'artifact', ...before }, selection: 'previous_output' });
  assert.ok(Value.Check(SourceFormatPolicySchema, authoring.format_policy));
});

test('draft selection validates owner, project, exact version and hash without disclosing foreign materials', async () => {
  const calls: unknown[][] = [];
  let rows: Record<string, unknown>[] = [{ role: b.role, media_type: b.media_type, sha256: b.sha256 }];
  const client = { query: async (sql: string, values: unknown[]) => {
    assert.match(sql, /owner_user_id=\$1 AND project_id=\$2 AND id=\$3 AND version=\$4/);
    assert.match(sql, /deleted_at IS NULL FOR SHARE/); calls.push(values); return { rows };
  } } as unknown as Pick<PoolClient, 'query'>;
  const template = { material_id: b.material_id, material_version: 1, sha256: b.sha256 };
  await assertOwnedFormatTemplate(client, 'owner', 'project', template);
  assert.deepEqual(calls[0], ['owner', 'project', b.material_id, 1]);
  rows = [];
  await assert.rejects(() => assertOwnedFormatTemplate(client, 'other-owner', 'other-project', template),
    (error: any) => error.status === 404 || error.statusCode === 404);
  rows = [{ role: 'historical', media_type: docx, sha256: 'c'.repeat(64) }];
  await assert.rejects(() => assertOwnedFormatTemplate(client, 'owner', 'project', template), /原稿版本/);
  await assertOwnedFormatTemplate(client, 'owner', 'project', null);
});
