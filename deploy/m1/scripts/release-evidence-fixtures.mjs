// Explicit synthetic gates for pre-existing topology/lifecycle tests. These
// fixtures test deployment state transitions, not evidence validity; the real
// validators and all entry-point failures are exercised in release-evidence.test.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function syntheticEvidenceEnvironment(directory) {
  mkdirSync(directory, { recursive: true });
  const quality = join(directory, 'synthetic-quality.json');
  const smoke = join(directory, 'synthetic-smoke.json');
  writeFileSync(quality, '{"synthetic":"quality command fixture"}\n');
  writeFileSync(smoke, '{"synthetic":"smoke command fixture"}\n');
  return { BB_RELEASE_QUALITY_RECEIPT: quality, BB_RELEASE_SMOKE_REPORT: smoke };
}

export function installSyntheticEvidenceGates(repository) {
  mkdirSync(join(repository, 'scripts/release-smoke'), { recursive: true });
  const gate = `// Synthetic command fixture; never a production verifier.\nimport {existsSync} from 'node:fs';\nif (!['verify','verify-rollback'].includes(process.argv[2]) || !existsSync(process.argv[4] ?? '')) process.exit(91);\n`;
  writeFileSync(join(repository, 'scripts/prospectus-quality-gate.mjs'), gate);
  writeFileSync(join(repository, 'scripts/release-smoke/verify.mjs'), gate);
  writeFileSync(join(repository, 'scripts/release-smoke/support.mjs'), '// Synthetic validator dependency fixture.\n');
  writeFileSync(join(repository, 'scripts/release-smoke/evidence-schema.mjs'), '// Synthetic schema dependency fixture.\n');
  writeFileSync(join(repository, 'scripts/release-smoke/model-quality-evidence.mjs'), '// Synthetic model-evidence dependency fixture.\n');
  writeFileSync(join(repository, 'scripts/release-smoke/image-contract.mjs'), '// Synthetic image-contract dependency fixture.\n');
  writeFileSync(join(repository, 'scripts/release-smoke/upload-confirmation-evidence.mjs'), '// Synthetic upload-evidence dependency fixture.\n');
  writeFileSync(join(repository, 'scripts/release-smoke/verify-images.mjs'), `// Synthetic topology-only image gate.\nif (!['reuse','verify','verify-rollback'].includes(process.argv[2])) process.exit(91);\n`);
  writeFileSync(join(repository, 'scripts/release-smoke/rollback-readiness.mjs'), '// Synthetic topology-only rollback preflight.\n');
}
