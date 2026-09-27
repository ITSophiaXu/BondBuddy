import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { SSE_PRIVATE_APPLICABILITY_DICTIONARY } from '@bondbuddy/domain/sse-private-applicability';
import {
  loadSsePrivateCandidateBundle,
  SSE_PRIVATE_CANDIDATE_ASSET_PIN,
  SsePrivateCandidateAssetError,
  verifySsePrivateCandidateAssetBytes,
} from './sse-private-candidate-assets.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const assetDirectory = join(repositoryRoot, 'knowledge/exchange-bonds/drafts/sse-private');

async function readCandidateBytes() {
  const [rulePackBytes, chapterTemplateBytes, coverageBytes] = await Promise.all([
    readFile(join(assetDirectory, 'rule-pack.json')),
    readFile(join(assetDirectory, 'chapter-template.json')),
    readFile(join(assetDirectory, 'coverage.json')),
  ]);
  return { rulePackBytes, chapterTemplateBytes, coverageBytes };
}

test('loads the exact draft.6 assets as a candidate-only descriptor with deterministic coverage gaps', async () => {
  const bundle = await loadSsePrivateCandidateBundle(repositoryRoot);
  assert.equal(bundle.status, 'candidate_only');
  assert.equal(SSE_PRIVATE_APPLICABILITY_DICTIONARY.version, SSE_PRIVATE_CANDIDATE_ASSET_PIN.taxonomy.version);
  assert.equal(SSE_PRIVATE_APPLICABILITY_DICTIONARY.contentSha256, SSE_PRIVATE_CANDIDATE_ASSET_PIN.taxonomy.contentSha256);
  assert.deepEqual(bundle.taxonomy, SSE_PRIVATE_CANDIDATE_ASSET_PIN.taxonomy);
  assert.equal(bundle.rulePack.id, 'sse-private');
  assert.equal(bundle.rulePack.version, '2026.09.27-draft.6');
  assert.equal(bundle.rulePack.contentSha256, SSE_PRIVATE_CANDIDATE_ASSET_PIN.rulePack.contentSha256);
  assert.equal(bundle.coverage.items.length, 32);
  assert.equal(bundle.coverage.openBlockers.length, 4);
  assert.deepEqual(bundle.coverage.items.map((item) => item.itemId), [...bundle.coverage.items.map((item) => item.itemId)].sort());
  assert.deepEqual(bundle.coverage.openBlockers.map((item) => item.blockerId), [...bundle.coverage.openBlockers.map((item) => item.blockerId)].sort());

  const uncovered = bundle.coverage.items.filter((item) => item.disposition === 'uncovered');
  assert.equal(uncovered.length, 31);
  assert.ok(uncovered.every((item) => item.itemId && item.rationale && item.ruleIds.length === 0));
  assert.ok(uncovered.every((item) => item.candidateAssetSha256 === bundle.coverage.rawSha256));

  const otherMarkets = bundle.coverage.items.find((item) => item.itemId === 'other-markets');
  assert.ok(otherMarkets);
  assert.equal(otherMarkets.disposition, 'not_applicable');
  assert.deepEqual(otherMarkets.ruleIds, []);
  assert.deepEqual(otherMarkets.sourceRefIds, []);
  assert.equal(otherMarkets.candidateAssetSha256, bundle.coverage.rawSha256);
});

test('fails closed on changed asset bytes and missing runtime assets', async () => {
  const bytes = await readCandidateBytes();
  const changedPack = Buffer.concat([bytes.rulePackBytes, Buffer.from(' ')]);
  assert.throws(
    () => verifySsePrivateCandidateAssetBytes({ ...bytes, rulePackBytes: changedPack }),
    (error: unknown) => error instanceof SsePrivateCandidateAssetError && error.code === 'RULE_PACK_BYTES_MISMATCH',
  );

  await assert.rejects(
    loadSsePrivateCandidateBundle(join(repositoryRoot, '.missing-candidate-root')),
    (error: unknown) => error instanceof SsePrivateCandidateAssetError && error.code === 'CANDIDATE_ASSET_MISSING',
  );
});
