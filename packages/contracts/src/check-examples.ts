import { Ajv } from 'ajv';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMarketOffering, M1_MATERIAL_PARTITIONS, M1_UPLOAD_MATERIAL_ROLES, M1_UPLOAD_MIME_TYPES, openApiDocument, platformProcessingCostSchemas, referenceLibrarySchemas, schemas, type SchemaName } from './index.js';

type Example = { name: string; schema: SchemaName; valid: boolean; http_status?: number; value: Record<string, unknown> };
const file = fileURLToPath(new URL('../examples/synthetic.json', import.meta.url));
const data = JSON.parse(readFileSync(file, 'utf8')) as { synthetic: boolean; cases: Example[] };
const updateExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/update-project.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Example[] };
assert.equal(updateExamples.synthetic, true);
data.cases.push(...updateExamples.cases);
const adminExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/admin-logs.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Example[] };
assert.equal(adminExamples.synthetic, true);
data.cases.push(...adminExamples.cases);
// #17 worker runtime stream examples.
const runtimeExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/worker-runtime.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Example[] };
assert.equal(runtimeExamples.synthetic, true);
data.cases.push(...runtimeExamples.cases);
// #35 trial guard examples.
const trialExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/trial-guard.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Example[] };
assert.equal(trialExamples.synthetic, true);
data.cases.push(...trialExamples.cases);
// #7 registration agreement examples.
const agreementExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/agreement.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Example[] };
assert.equal(agreementExamples.synthetic, true);
data.cases.push(...agreementExamples.cases);
assert.equal(data.synthetic, true);
// #78 internal library query v1: validated here, and proven absent from the public OpenAPI document.
const libraryExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/reference-library.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Array<{ name: string; schema: keyof typeof referenceLibrarySchemas; valid: boolean; value: unknown }> };
assert.equal(libraryExamples.synthetic, true);
{
  const libraryAjv = new Ajv({ allErrors: true, strict: true });
  for (const example of libraryExamples.cases) {
    const validate = libraryAjv.compile(referenceLibrarySchemas[example.schema]);
    assert.equal(validate(example.value), example.valid, `${example.name}: ${libraryAjv.errorsText(validate.errors)}`);
  }
  const publicDocument = JSON.stringify(openApiDocument());
  for (const name of Object.keys(referenceLibrarySchemas)) assert.ok(!publicDocument.includes(name), `internal ${name} leaked into public OpenAPI`);
  assert.ok(!publicDocument.includes('/admin/library'), 'admin library routes are not public contract');
  assert.ok(!Object.keys(schemas).some(name => name.startsWith('Library')), 'library schemas are not public schemas');
}
const ajv = new Ajv({ allErrors: true, strict: true });
// Internal #76 platform-paid OCR/parse processing contract is validated separately and
// stays out of the public OpenAPI/schema namespace.
const processingCostExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/platform-processing-cost.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Example[] };
assert.equal(processingCostExamples.synthetic, true);
for (const example of processingCostExamples.cases) {
  const validate = ajv.compile(platformProcessingCostSchemas[example.schema as keyof typeof platformProcessingCostSchemas]);
  assert.equal(validate(example.value), example.valid, `${example.name}: ${ajv.errorsText(validate.errors)}`);
}
assert.ok(!JSON.stringify(openApiDocument()).includes('PlatformProcessingCost'), 'internal processing cost schemas are not public OpenAPI');
const byName = new Map<string, Example>();
for (const example of data.cases) {
  assert.ok(!byName.has(example.name), `duplicate example ${example.name}`);
  byName.set(example.name, example);
  assert.ok(Object.hasOwn(schemas, example.schema), `unknown schema ${example.schema}`);
  const validate = ajv.compile(schemas[example.schema]);
  const result = validate(example.value);
  assert.equal(result, example.valid, `${example.name}: ${ajv.errorsText(validate.errors)}`);
}
const value = (name: string) => {
  const example = byName.get(name);
  assert.ok(example, name);
  return example.value;
};
const before = value('run-before-tab-close');
const after = value('run-after-relogin');
assert.equal(before.run_id, after.run_id, 'new session must find same run');
assert.equal(before.execution_request_id, after.execution_request_id, 'relogin must not create another execution');
assert.equal(before.input_hash, after.input_hash, 'immutable snapshot survives browser close');
assert.equal(after.state, 'running', 'browser close does not cancel server work');
const events = value('run-recovery-events');
assert.deepEqual((events.items as Array<Record<string, unknown>>).map(event => event.seq), [2, 3]);
assert.equal(events.next_cursor, after.event_cursor);
assert.equal(byName.get('owner-safe-404')?.http_status, 404);
assert.equal(byName.get('revision-conflict-409')?.http_status, 409);
assert.equal(byName.get('idempotency-conflict-409')?.http_status, 409);
const unknown = value('model-attempt-unknown-usage');
assert.equal(unknown.usage_status, 'pending');
assert.equal(unknown.input_tokens, null);
assert.equal(unknown.output_tokens, null);
assert.equal(unknown.prompt_snapshot_ref, before.prompt_snapshot_ref);
const upload = value('upload-session');
const complete = value('upload-complete-request');
const material = value('material-persisted');
assert.equal(upload.upload_id, material.upload_id);
assert.equal(material.sha256, complete.sha256);
assert.equal(material.byte_size, complete.byte_size);
assert.equal(upload.state, 'uploading');
assert.equal(material.state, 'persisted');
const projectEvent = value('project-upload-progress-event');
assert.equal(projectEvent.project_id, value('project-revision-7').project_id);
assert.equal((projectEvent.payload as Record<string, unknown>).uploaded_bytes, complete.byte_size);
assert.equal(Object.hasOwn(projectEvent, 'run_id'), false, 'upload precedes run creation');
const lockRequest = value('lock-input-revision-request');
const locked = value('locked-input-revision');
assert.deepEqual(lockRequest.material_versions, locked.material_versions);
assert.equal(locked.input_hash, before.input_hash);
assert.equal(lockRequest.draft_revision, locked.input_revision);
const recognition = value('recognition-needs-confirmation');
assert.equal(recognition.material_id, material.material_id);
const sourceMarket = recognition.source_market as Record<string, unknown>;
assert.equal(sourceMarket.value, null);
assert.ok((sourceMarket.uncertainty as string[]).length > 0);
assert.deepEqual((sourceMarket.provenance as Record<string, unknown>).evidence_refs, ['page-1-region-2']);
const periods = recognition.reporting_periods as Array<Record<string, unknown>>;
assert.equal(periods[0]?.end, '2024-12-31');
assert.equal(periods[0]?.scope, 'consolidated');
assert.equal(periods[1]?.end, null, 'ambiguous OCR date must stay unknown');
assert.equal((recognition.latest_reporting_cutoff as Record<string, unknown>).value, null);
const private404 = value('owner-safe-404');
assert.equal(private404.code, 'NOT_FOUND');
assert.equal(JSON.stringify(private404).includes('victim'), false);
assert.equal(value('artifact-ready-after-quality-check').run_id, before.run_id);
assert.equal(isMarketOffering('nafmii', 'dfi'), true);
assert.equal(isMarketOffering('sse', 'dfi'), false);
assert.equal(value('upload-spreadsheet-request').media_type, M1_UPLOAD_MIME_TYPES[2]);
assert.equal(value('upload-image-request').media_type, 'image/jpeg');
assert.equal(value('upload-create').role, material.role);
for (const name of ['unsupported-legacy-or-macro-format-415', 'encrypted-material-422', 'content-mismatch-422']) {
  assert.ok(byName.get(name)?.http_status === 415 || byName.get(name)?.http_status === 422);
}
const internalEvent = value('internal-model-attempt-event-unknown-usage');
assert.equal(internalEvent.run_id, before.run_id);
assert.equal(internalEvent.call_id, unknown.call_id);
assert.equal(internalEvent.prompt_snapshot_ref, unknown.prompt_snapshot_ref);
assert.equal((internalEvent.usage as Record<string, unknown>).input_tokens, null);
assert.equal((value('internal-error-event').error as Record<string, unknown>).category, 'model_provider');
const prototype = await import(new URL('../../../product-prototype/public/project-fields.js', import.meta.url).href) as { MATERIAL_GROUPS: Array<{ label: string; items: Array<[string, string]> }>; SUPPORT_ROLES: string[] };
const expectedRoles = ['historical', 'reference', ...prototype.SUPPORT_ROLES];
assert.deepEqual([...M1_UPLOAD_MATERIAL_ROLES].sort(), expectedRoles.sort(), 'M1 upload roles must follow current prototype partitions');
for (const partition of M1_MATERIAL_PARTITIONS) {
  const source = prototype.MATERIAL_GROUPS.find(group => group.label === partition.label);
  assert.ok(source, `missing prototype partition ${partition.label}`);
  for (const role of partition.roles) assert.equal(source.items.find(item => item[0] === role.code)?.[1], role.label);
}
console.log(`validated ${data.cases.length} synthetic examples + ${libraryExamples.cases.length} internal library examples and recovery/conflict/usage invariants`);
// #79: retries and final success are both kept; cached/reasoning are subsets of the totals.
const timeline = value('admin-job-timeline-retry-then-success') as { attempts: Array<{ status: string; usage: Record<string, number> }>; consumption: Record<string, Record<string, number>> };
const sumOf = (rows: typeof timeline.attempts, field: string) => rows.reduce((n, row) => n + row.usage[field], 0);
assert.equal(timeline.consumption.all_attempts.input_tokens, sumOf(timeline.attempts, 'input_tokens'));
assert.equal(timeline.consumption.completed_attempts.input_tokens, sumOf(timeline.attempts.filter(a => a.status === 'completed'), 'input_tokens'));
assert.ok(timeline.consumption.all_attempts.cached_input_tokens <= timeline.consumption.all_attempts.input_tokens);
