import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { digest } from '@bondbuddy/api/data';
import type { writeRunWorkingFile } from '@bondbuddy/api/run-working-files';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { projectRunExecution } from '@bondbuddy/api/run-execution';
import { emptyUpdateDetails, type ReviewFinding, type ReviewRevisionPin } from '@bondbuddy/contracts';
import type { UnifiedInput } from './unified-input.js';
import type { StageContext } from './run-pipeline.js';

const python = process.env.BONDBUDDY_WORD_PYTHON ?? process.env.BONDBUDDY_TEST_PYTHON ?? 'python3';
const execute = promisify(execFile);

/** Synthetic documents and fake model control; the actual Python tool and collector run. */
export async function revisionCliFixture() {
  const root = await mkdtemp(join(tmpdir(), 'bb-revision-cli-test-'));
  const sourcePath = join(root, 'source.docx');
  await execute(python, ['-B', '-c', 'from docx import Document; import sys; d=Document(); d.add_paragraph("Net assets 100."); d.add_paragraph("Unselected paragraph."); d.save(sys.argv[1])', sourcePath]);
  const sourceBytes = await readFile(sourcePath), auditBytes = Buffer.from('Net assets 120.');
  const material = (id: string, bytes: Buffer, role: string, texts: string[]) => ({
    pin: { material_id: id, material_version: 1, sha256: digest(bytes), role }, filename: `${id}.docx`,
    objectKey: `private/${id}`, mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    records: texts.map((literal_quote, i) => ({ record_id: `r${i}`, material_id: id, material_version: 1, content_hash: digest(bytes),
      locator_type: 'docx_block' as const, locator: { path: [{ paragraph: i + 1 }], stable_ref: `docx:p${String(i + 1).padStart(4, '0')}` },
      literal_quote, context: 'synthetic', extraction_method: 'native_text' as const, extractor_version: 'synthetic', confidence: 1, uncertainty: [], formatting: {} })),
  });
  const source = material('source', sourceBytes, 'historical', ['Net assets 100.', 'Unselected paragraph.']);
  const audit = { ...material('audit', auditBytes, 'audit', ['Net assets 120.']), mediaType: 'text/plain', filename: 'audit.txt' };
  const evidence = (m: typeof source) => ({ material_id: m.pin.material_id, material_version: 1, material_sha256: m.pin.sha256,
    parse_snapshot_id: `parse-${m.pin.material_id}`, parse_response_sha256: 'c'.repeat(64), record_id: 'r0', record_sha256: inputManifestHash(m.records[0]),
    locator_type: 'docx_block' as const, locator: m.records[0]!.locator, quote: m.records[0]!.literal_quote, extraction_method: 'native_text' as const, uncertainty: [] });
  const finding: ReviewFinding = { finding_id: 'F-1', report_id: 'report', dimension: 'financial', conclusion: 'error', severity: 'P1',
    title: 'Synthetic assets mismatch', description: 'Use the accepted audit evidence.', target_refs: [evidence(source)], evidence_refs: [evidence(audit)],
    suggested_change: 'Correct net assets to 120.', limitations: [], repairability: { can_revise: true, reason: 'Accepted precise evidence.', allowed_record_ids: ['r0'] },
    origin_report_id: 'report', check_status: 'rechecked' };
  const pin: ReviewRevisionPin = { version: 'review-revision-v1', owner_user_id: 'owner', project_id: 'project',
    source_material: { material_id: 'source', material_version: 1, sha256: source.pin.sha256 },
    source_report: { report_id: 'report', run_id: 'review-run', version: 1, input_revision: 1, sha256: 'd'.repeat(64) },
    accepted_plan: { plan_id: 'accepted-plan', version: 1, sha256: 'e'.repeat(64), accepted_at: '2026-10-03T00:00:00.000Z' },
    selected_findings: [finding], excluded_findings: [{ finding_id: 'F-excluded', reason: 'Explicitly excluded.' }], requirements: [], limitations: [] };
  const input: UnifiedInput = { manifest: { issuer_name: 'Synthetic issuer', market: 'sse', offering: 'private', update_details: emptyUpdateDetails(),
    materials: [source.pin, audit.pin], authoring: { version: 'unified_v1', source_prospectuses: [], requirements: [], knowledge: [],
      knowledge_status: 'authoring_reference_not_compliance_approval', review_revision: pin } }, materials: [source, audit], requirements: [] };
  const blobs = new Map<string, Buffer>([['private/source', sourceBytes], ['private/audit', auditBytes]]);
  const rawRun = { id: 'run', owner_user_id: 'owner', project_id: 'project', input_revision: 1,
    input_hash: inputManifestHash(input.manifest), task_kind: 'update' };
  const ctx = { run: projectRunExecution(rawRun, { executionVersion: 1, inputRevision: 1, inputHash: rawRun.input_hash }),
    lease: { checkpoint: {} }, checkpoint: {}, signal: new AbortController().signal, values: new Map(),
    pool: { query: async () => ({ rows: [{ created_at: '2026-10-03T00:00:00.000Z' }] }) },
    blobs: { getIfExistsBounded: async (key: string) => blobs.get(key) ?? null, put: async (key: string, bytes: Buffer) => { blobs.set(key, bytes); } },
  } as unknown as StageContext;
  const proposal = { version: 'review-revision-cli-v1', input_hash: ctx.run.input_hash, reviewed: ['r0'],
    edits: [{ record_id: 'r0', after: 'Net assets 120.', evidence: ['audit/r0'], finding_ids: ['F-1'] }], additions: [],
    handling: [{ finding_id: 'F-1', status: 'modified', reason: 'Corrected from the accepted evidence.', evidence: ['audit/r0'] }], summary: ['Synthetic revision.'] };
  const writes:Parameters<typeof writeRunWorkingFile>[0][]=[];
  const writer:typeof writeRunWorkingFile=async value=>{writes.push({...value,bytes:Buffer.from(value.bytes)});await value.blobs.put(value.key,value.bytes,value.mediaType);};
  return { root, input, pin, ctx, blobs, proposal, writes, writer };
}
