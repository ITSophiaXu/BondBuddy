import { Value } from '@sinclair/typebox/value';
import { ProjectFileLinkSchema, ReviewRevisionHandlingSchema } from '@bondbuddy/contracts';

/** Internal storage provenance, never a browser-supplied authority or a public DTO. */
export type RunFileReferenceScope = {
  owner: string; projectId: string; runId: string; inputHash: string;
} & (
  | { source: 'provider'; attemptId: string; reviewCorrection?: boolean }
  | { source: 'local_correction' | 'local_project_file'; attemptId?: never; reviewCorrection?: never }
);
export type RunFileReference = { name: string; key: string; sha256: string; byteSize: number; mediaType: string };
export class RunFileReferenceError extends Error {
  constructor() { super('Run file reference does not match its exact storage scope'); this.name = 'RunFileReferenceError'; }
}

const WORD_MAX = 100 * 1024 * 1024, REVIEW_TEXT_MAX = 4 * 1024 * 1024;
const REVISION_JSON_MAX = 32 * 1024 * 1024, DELIVERY_MAX = 256 * 1024;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const schemas = ['codex-file-word-v1', 'codex-m4-document-v1', 'codex-review-file-v1', 'review-revision-cli-v1', 'project-file-output-v1'] as const;
type FileSchema = typeof schemas[number];
type RecordValue = Record<string, unknown>;
const authoringNames = ['tracked.docx', 'clean.docx', 'baseline.docx', 'delivery.md'];
const m4Names = ['document.docx', 'preparation-note.docx'];
const reviewNames = ['report.docx', 'model-report.docx', 'report.md', 'final-response.md', 'comments.docx', 'comments.pdf', 'annotations.json'];
const correctionNames = ['revision.docx', 'clean.docx', 'baseline.docx', 'report.docx', 'report.md', 'editor.json'];
const revisionNames = ['tracked.docx', 'clean.docx', 'baseline.docx', 'handling.json', 'summary.json', 'proposal.json'];
const projectNames = ['report.docx', 'revision.docx', 'clean.docx', 'baseline.docx'];
const invalid = (): never => { throw new RunFileReferenceError(); };
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function record(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is RecordValue {
  if (!record(value) || required.some(key => !Object.hasOwn(value, key))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))) invalid();
}
function segment(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value) && !value.includes('..');
}
function checkScope(scope: RunFileReferenceScope, resultSchemaVersion: string): FileSchema {
  exact(scope, ['owner', 'projectId', 'runId', 'inputHash', 'source'], ['attemptId', 'reviewCorrection']);
  if (![scope.owner, scope.projectId, scope.runId].every(segment) || !hash(scope.inputHash)
    || !schemas.includes(resultSchemaVersion as FileSchema)) invalid();
  if (scope.source === 'provider') {
    if (!segment(scope.attemptId) || resultSchemaVersion === 'project-file-output-v1'
      || resultSchemaVersion === 'codex-review-file-v1' && scope.attemptId === 'correction'
      || scope.reviewCorrection !== undefined && (typeof scope.reviewCorrection !== 'boolean' || resultSchemaVersion !== 'codex-review-file-v1')) invalid();
  } else {
    if (Object.hasOwn(scope, 'attemptId') || Object.hasOwn(scope, 'reviewCorrection')
      || scope.source === 'local_correction' && resultSchemaVersion !== 'codex-review-file-v1'
      || scope.source === 'local_project_file' && resultSchemaVersion !== 'project-file-output-v1'
      || !['local_correction', 'local_project_file'].includes(scope.source)) invalid();
  }
  return resultSchemaVersion as FileSchema;
}
function paths(scope: RunFileReferenceScope, schema: FileSchema, name: string, sha256: string): string[] {
  const base = `owners/${scope.owner}/projects/${scope.projectId}/runs/${scope.runId}/`;
  if (schema === 'project-file-output-v1') return projectNames.includes(name) ? [`${base}project-files/${sha256}/${name}`] : [];
  if (scope.source === 'local_correction') return correctionNames.includes(name) ? [`${base}review-files/correction/${sha256}/${name}`] : [];
  const attempt = scope.source === 'provider' ? scope.attemptId : invalid();
  if (schema === 'codex-file-word-v1') return authoringNames.includes(name) ? [`${base}file-authoring/${attempt}/${sha256}/${name}`] : [];
  if (schema === 'codex-m4-document-v1') return m4Names.includes(name) ? [`${base}m4-documents/${attempt}/${sha256}/${name}`] : [];
  if (schema === 'review-revision-cli-v1') return revisionNames.includes(name) ? [`${base}review-revision-cli/${attempt}/${sha256}/${name}`] : [];
  const keys = reviewNames.includes(name) ? [`${base}review-files/${attempt}/${sha256}/${name}`] : [];
  if (scope.source === 'provider' && scope.reviewCorrection === true && correctionNames.includes(name))
    keys.push(`${base}review-files/correction/${sha256}/${name}`);
  return keys;
}
function limit(scope: RunFileReferenceScope, schema: FileSchema, name: string, key: string, sha256: string): number {
  if (/\.(docx|pdf)$/.test(name)) return WORD_MAX;
  // The deterministic correction collector retains all six outputs up to
  // 100 MiB. Its report/editor bound belongs only to the exact correction key;
  // an explicitly enabled provider can still retain ordinary 4 MiB companions.
  if (schema === 'codex-review-file-v1' && ['report.md', 'editor.json'].includes(name)
    && (scope.source === 'local_correction' || scope.source === 'provider' && scope.reviewCorrection === true)
    && key === `owners/${scope.owner}/projects/${scope.projectId}/runs/${scope.runId}/review-files/correction/${sha256}/${name}`) return WORD_MAX;
  return schema === 'codex-file-word-v1' ? DELIVERY_MAX : schema === 'review-revision-cli-v1' ? REVISION_JSON_MAX : REVIEW_TEXT_MAX;
}
function mediaType(name: string): string {
  return name.endsWith('.docx') ? DOCX : name.endsWith('.pdf') ? 'application/pdf' : name.endsWith('.json') ? 'application/json' : 'text/markdown';
}

/** Validate one declared output before storing it; no partial result wrapper is needed. */
export function validateRunFileReference(input: {
  scope: RunFileReferenceScope; resultSchemaVersion: string; name: string; value: unknown;
}): RunFileReference {
  const schema = checkScope(input.scope, input.resultSchemaVersion);
  exact(input.value, ['key', 'sha256', 'byte_size']);
  const file = input.value;
  if (typeof input.name !== 'string' || !hash(file.sha256) || typeof file.key !== 'string'
    || !Number.isSafeInteger(file.byte_size) || (file.byte_size as number) < 1
    || (file.byte_size as number) > limit(input.scope, schema, input.name, file.key, file.sha256)
    || !paths(input.scope, schema, input.name, file.sha256).includes(file.key)) invalid();
  return { name: input.name, key: file.key as string, sha256: file.sha256 as string, byteSize: file.byte_size as number, mediaType: mediaType(input.name) };
}

function generationLinks(value: unknown): boolean {
  if (value === undefined) return true;
  exact(value, ['links', 'source_sha256', 'target_sha256', 'warnings']);
  return hash(value.source_sha256) && hash(value.target_sha256) && Array.isArray(value.links) && value.links.length <= 10000
    && value.links.every(link => Value.Check(ProjectFileLinkSchema, link)) && Array.isArray(value.warnings)
    && value.warnings.length <= 4001 && value.warnings.every(warning => typeof warning === 'string' && warning.length <= 12000);
}

/** Exact collector envelopes only. Unknown schemas never silently become an empty inventory. */
export function extractRunFileReferences(input: {
  scope: RunFileReferenceScope; resultSchemaVersion: string; value: unknown;
}): RunFileReference[] {
  const schema = checkScope(input.scope, input.resultSchemaVersion), value = input.value;
  const required = ['version', 'input_hash', 'files'];
  if (schema === 'codex-file-word-v1') exact(value, [...required, 'summary'], ['error']);
  else if (schema === 'codex-m4-document-v1') exact(value, [...required, 'skill_sha256', 'method_hash'], ['error', 'project_file_links']);
  else if (schema === 'review-revision-cli-v1') exact(value, [...required, 'revision_pin_sha256', 'skill_sha256', 'summary'], ['error', 'handling']);
  else exact(value, required, schema === 'codex-review-file-v1' ? ['error'] : []);
  if (value.version !== schema || value.input_hash !== input.scope.inputHash || !record(value.files)) invalid();
  if ((schema === 'codex-file-word-v1' || schema === 'review-revision-cli-v1') && !record(value.summary)) invalid();
  if (schema === 'codex-m4-document-v1' && (!hash(value.skill_sha256) || !hash(value.method_hash) || !generationLinks(value.project_file_links))) invalid();
  if (schema === 'review-revision-cli-v1' && (!hash(value.revision_pin_sha256) || !hash(value.skill_sha256))) invalid();
  const error = value.error;
  if (error !== undefined && error !== (schema === 'codex-file-word-v1' || schema === 'review-revision-cli-v1' ? 'WORD_QUALITY_REJECTED' : 'WORD_DELIVERY_UNAVAILABLE')) invalid();
  // Walk every ref, including optional/error outputs, before deciding whether a result is complete.
  const refs = value.files as RecordValue;
  const files = Reflect.ownKeys(refs).map(name => {
    if (typeof name !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(refs, name) ?? {}, 'value')) return invalid();
    return validateRunFileReference({ ...input, name, value: refs[name] });
  });
  const has = (names: readonly string[]) => names.every(name => files.some(file => file.name === name));
  if (schema === 'review-revision-cli-v1') {
    if (error !== undefined) {
      if ((value.summary as RecordValue).validation_error !== 'WORD_REVISION_SCOPE_OR_ARTIFACT_INVALID' || files.length !== 0 || value.handling !== undefined) invalid();
    } else if (!Value.Check(ReviewRevisionHandlingSchema, value.handling)
      || !has((value.summary as RecordValue).no_changes === true ? revisionNames.filter(name => !name.endsWith('.docx')) : revisionNames)
      || (value.summary as RecordValue).no_changes === true && files.some(file => file.name.endsWith('.docx'))) invalid();
  } else if (error === undefined) {
    if (schema === 'codex-file-word-v1' && !has(['tracked.docx', 'clean.docx'])) invalid();
    if (schema === 'codex-m4-document-v1' && (!has(m4Names) || files[0]?.sha256 === files[1]?.sha256)) invalid();
    if (schema === 'codex-review-file-v1' && (!has(['report.docx'])
      || (input.scope.source === 'local_correction' || input.scope.source === 'provider' && input.scope.reviewCorrection === true) && !has(correctionNames))) invalid();
    if (schema === 'project-file-output-v1' && !(files.length === 1 && has(['report.docx'])
      || files.length === 3 && has(['revision.docx', 'clean.docx', 'baseline.docx']))) invalid();
  }
  return files;
}
