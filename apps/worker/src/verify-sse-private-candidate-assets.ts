import {
  loadSsePrivateCandidateBundle,
  SSE_PRIVATE_CANDIDATE_RUNTIME_ROOT,
} from './sse-private-candidate-assets.js';

// Build/deployment probe: only public asset metadata, no grant, DB, model or customer data.
const root = process.argv[2] ?? SSE_PRIVATE_CANDIDATE_RUNTIME_ROOT;
const bundle = await loadSsePrivateCandidateBundle(root);
process.stdout.write(
  JSON.stringify({
    status: bundle.status,
    rule_pack: bundle.rulePack,
    taxonomy: bundle.taxonomy,
    template: bundle.chapterTemplate,
    coverage: {
      id: bundle.coverage.manifestId,
      version: bundle.coverage.version,
      sha256: bundle.coverage.rawSha256,
      items: bundle.coverage.items.length,
      uncovered: bundle.coverage.items.filter((item) => item.disposition === 'uncovered').length,
      not_applicable: bundle.coverage.items.filter((item) => item.disposition === 'not_applicable')
        .length,
      open_blockers: bundle.coverage.openBlockers.length,
    },
  }) + '\n',
);
