import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMarketOffering, type Market, type Offering, type ReviewFileDeliveryPin } from '@bondbuddy/contracts';
import { digest } from './data.js';
import { loadAuthoringKnowledge } from './unified-authoring.js';

const root = resolve(fileURLToPath(import.meta.url), '../../../..');
/** Snapshot reference bytes at submission, so deployment cannot change an accepted task. */
export async function lockReviewFileDelivery(project: { market: Market | null; offering: Offering | null }): Promise<ReviewFileDeliveryPin> {
  const knowledge = await loadAuthoringKnowledge(project);
  const paths = ['knowledge/audit-reconciliation/METHODS.md'];
  if (project.market && project.offering && project.market !== 'nafmii' && isMarketOffering(project.market, project.offering))
    paths.push(`product-prototype/knowledge/${project.market}-${project.offering}-review.md`);
  for (const path of paths) {
    const markdown = await readFile(resolve(root, path), 'utf8');
    knowledge.push({ path, markdown, sha256: digest(markdown) });
  }
  return { version: 'review-file-v1', knowledge };
}
