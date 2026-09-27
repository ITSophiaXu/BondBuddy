#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'tests/samples/2026-09-25/manifest.json');
const generatedPath = resolve(root, 'apps/worker/src/authorized-sample-membership.generated.ts');
const bytes = readFileSync(manifestPath);
const manifest = JSON.parse(bytes.toString('utf8'));
const manifestGitBlobSha = execFileSync('git', ['hash-object', manifestPath], { cwd: root, encoding: 'utf8' }).trim();
const committedManifestGitBlobSha = execFileSync('git', ['rev-parse', 'HEAD:tests/samples/2026-09-25/manifest.json'], { cwd: root, encoding: 'utf8' }).trim();
if (manifestGitBlobSha !== committedManifestGitBlobSha) throw new Error('working manifest bytes differ from the tracked Git blob');
const manifestSha256 = createHash('sha256').update(bytes).digest('hex');
const files = manifest.cases.flatMap(({ case_id: caseId, files: caseFiles }) => caseFiles.map(file => ({
  caseId,
  fileId: file.file_id,
  uploadRole: file.upload_role,
  sha256: file.sha256,
})));

if (files.length !== manifest.file_count) throw new Error(`manifest file count mismatch: ${files.length} != ${manifest.file_count}`);
if (new Set(files.map(file => file.fileId)).size !== files.length) throw new Error('manifest contains duplicate file_id values');
if (files.some(file => Object.keys(file).sort().join(',') !== 'caseId,fileId,sha256,uploadRole')) {
  throw new Error('allowlist projection includes fields outside case/file/role/hash');
}

const rows = files.map(file => `  { caseId: '${file.caseId}', fileId: '${file.fileId}', uploadRole: '${file.uploadRole}', sha256: '${file.sha256}' },`).join('\n');
const expected = [
  '/**',
  ' * Generated from the exact tracked Git blob at',
  ' * tests/samples/2026-09-25/manifest.json. Deliberately contains only membership',
  ' * metadata: no original filenames, paths, excerpts, periods, or customer data.',
  ' * Run `node scripts/check-authorized-sample-membership.mjs` after changing it.',
  ' */',
  `export const AUTHORIZED_SAMPLE_MANIFEST_GIT_BLOB_SHA = '${manifestGitBlobSha}' as const;`,
  `export const AUTHORIZED_SAMPLE_MANIFEST_SHA256 = '${manifestSha256}' as const;`,
  '',
  'export const AUTHORIZED_SAMPLE_CASE_FILES = [',
  rows,
  '] as const;',
  '',
].join('\n');
const generated = readFileSync(generatedPath, 'utf8');
if (generated !== expected) throw new Error('runtime allowlist or manifest SHA is stale; regenerate the metadata-only module from the source manifest');
process.stdout.write(`authorized sample membership matches ${files.length} manifest entries (${manifestSha256})\n`);
