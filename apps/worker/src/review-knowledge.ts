import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Fixed reference-data pin. The Markdown never grants tool or execution authority. */
export const REVIEW_AUDIT_KNOWLEDGE_PIN = Object.freeze({
  id: 'audit-reconciliation',
  version: 'audit-reconciliation-2026-10-02-cli-v2',
  sourceSHA: '0dd2a03aaca23e48b01144594b50451f17806059460ef9567aedd782f1124ecb',
  contentSHA: '1f3522ec0f9c3ba39fa993eb79face48c6631bcdff876316e5ad842fc6b8bd5e',
});

const relativePath = 'knowledge/audit-reconciliation/METHODS.md';
/** Same depth for apps/worker/src, apps/worker/dist, and the Docker /app layout. */
export const REVIEW_AUDIT_KNOWLEDGE_PATH = fileURLToPath(
  new URL(`../../../${relativePath}`, import.meta.url),
);

export interface ReviewKnowledgeDocument {
  readonly id: string;
  readonly version: string;
  readonly sourceSHA: string;
  readonly contentSHA: string;
  readonly markdown: string;
}

/** Deployments/tests may select an absolute repository root; the file and hash stay fixed. */
export async function loadReviewAuditKnowledge(
  options: { repositoryRoot?: string } = {},
): Promise<ReviewKnowledgeDocument> {
  if (options.repositoryRoot !== undefined && !isAbsolute(options.repositoryRoot)) {
    throw new Error('REVIEW_AUDIT_KNOWLEDGE_ROOT_MUST_BE_ABSOLUTE');
  }
  const path =
    options.repositoryRoot === undefined
      ? REVIEW_AUDIT_KNOWLEDGE_PATH
      : join(options.repositoryRoot, relativePath);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    throw new Error(`REVIEW_AUDIT_KNOWLEDGE_UNAVAILABLE: ${relativePath}`, { cause });
  }
  const contentSHA = createHash('sha256').update(bytes).digest('hex');
  if (contentSHA !== REVIEW_AUDIT_KNOWLEDGE_PIN.contentSHA) {
    throw new Error('REVIEW_AUDIT_KNOWLEDGE_CONTENT_SHA_MISMATCH');
  }
  // Hash the real bytes before decoding; do not normalize line endings or accept a caller-supplied pin.
  return Object.freeze({
    ...REVIEW_AUDIT_KNOWLEDGE_PIN,
    contentSHA,
    markdown: bytes.toString('utf8'),
  });
}
