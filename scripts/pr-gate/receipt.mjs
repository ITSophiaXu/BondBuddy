import { createHash } from 'node:crypto';
import { parseExclusions, SUMMARY_SCHEMA } from './run.mjs';
import { verifyCapabilityRuns } from './capabilities.mjs';
import { verifyOfflineCache } from './offline-cache.mjs';
import { verifyHostRuns } from './host-dispatch.mjs';
import { verifyCoreSource } from './core-source.mjs';
import { verifyBrowserRuns } from './browser-receipt.mjs';

export const RECEIPT_SCHEMA = 'pr-gate-local-v1';
export const PREPARATION_IDS = Object.freeze(['image', 'capabilities', 'services', 'dependencies', 'build', 'contracts', 'browser', 'host']);
const EXCLUSION_LISTS = ['notInCi', 'knownFailing', 'allowSkip'];
const COUNT_KEYS = ['selected', 'passed', 'blocking', 'tolerated', 'notInCi'];
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function requireEvidence(condition, message) {
  if (!condition) throw new Error(`Invalid PR gate receipt: ${message}`);
}
const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
const emptyArray = value => Array.isArray(value) && value.length === 0;
const sameArray = (actual, expected) => Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);

/** Hash the exact committed bytes that were used by the runner, not reserialized JSON. */
export function exclusionsEvidence(raw) {
  const parsed = parseExclusions(JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw));
  const counts = Object.fromEntries(EXCLUSION_LISTS.map(name => [name, parsed[name].length]));
  return {
    sha256: createHash('sha256').update(raw).digest('hex'),
    counts,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
  };
}

function verifyExclusions(actual, expected) {
  for (const [label, value] of [['recorded', actual], ['expected', expected]]) {
    requireEvidence(SHA256.test(value?.sha256 ?? ''), `${label} exclusions hash is missing`);
    requireEvidence(EXCLUSION_LISTS.every(name => nonnegativeInteger(value.counts?.[name])), `${label} exclusions counts are invalid`);
    requireEvidence(nonnegativeInteger(value.total) && value.total === EXCLUSION_LISTS.reduce((sum, name) => sum + value.counts[name], 0), `${label} exclusions total is inconsistent`);
  }
  requireEvidence(actual.sha256 === expected.sha256 && actual.total === expected.total && EXCLUSION_LISTS.every(name => actual.counts[name] === expected.counts[name]), 'exclusions do not match the requested commit');
}

/** Verify completeness without changing run.mjs's treatment of approved exceptions. */
export function verifyReceipt(receipt, expected, now = Date.now()) {
  requireEvidence(receipt?.schema_version === RECEIPT_SCHEMA && receipt.status === 'passed', 'no complete passing receipt');
  requireEvidence(receipt.clean_tree === true && receipt.platform === 'linux' && typeof receipt.host_platform === 'string' && receipt.host_platform.length > 0, 'clean source tree and execution platform are required');
  for (const key of ['commit', 'tree', 'develop_commit']) {
    requireEvidence(SHA.test(receipt[key] ?? '') && SHA.test(expected?.[key] ?? '') && receipt[key] === expected[key], `${key} does not match the requested commit`);
  }
  const started = Date.parse(receipt.started_at), finished = Date.parse(receipt.finished_at);
  requireEvidence(Number.isFinite(now) && typeof receipt.started_at === 'string' && typeof receipt.finished_at === 'string' && Number.isFinite(started) && Number.isFinite(finished) && started <= finished && finished <= now + 60_000, 'invalid run timestamps');
  verifyExclusions(receipt.exclusions, expected.exclusions);
  requireEvidence(emptyArray(receipt.errors), 'run has errors or an incomplete error record');
  requireEvidence(receipt.cleanup?.status === 'passed', 'test service cleanup did not pass');

  requireEvidence(Array.isArray(receipt.preparation) && receipt.preparation.length === PREPARATION_IDS.length && new Set(receipt.preparation.map(step => step?.id)).size === PREPARATION_IDS.length && PREPARATION_IDS.every(id => receipt.preparation.some(step => step?.id === id && step.status === 'passed')), 'required preparation did not complete');

  const matrix = expected.matrix;
  requireEvidence(Array.isArray(matrix) && matrix.length > 0 && new Set(matrix.map(row => row?.name)).size === matrix.length, 'expected matrix is missing or duplicated');
  requireEvidence(Array.isArray(receipt.shards) && receipt.shards.length === matrix.length && new Set(receipt.shards.map(row => row?.name)).size === matrix.length, 'shards are missing or duplicated');
  for (const row of matrix) {
    requireEvidence(typeof row.name === 'string' && row.name.length > 0 && typeof row.groups === 'string' && row.groups.length > 0 && /^\d+\/\d+$/.test(row.shard ?? ''), 'invalid expected matrix row');
    const groups = row.groups.split(',').map(group => group.trim()).filter(Boolean);
    const shard = receipt.shards.find(item => item.name === row.name);
    requireEvidence(shard && shard.groups === row.groups && shard.shard === row.shard && shard.exit_code === 0, `${row.name} did not complete the expected shard`);
    const summary = shard.summary;
    requireEvidence(summary?.schema === SUMMARY_SCHEMA && summary.job === row.name && sameArray(summary.groups, groups) && summary.shard === row.shard && summary.expectedJobs === matrix.length && summary.report === false && summary.commit === expected.commit && summary.status === 'passed', `${row.name} summary is incomplete or belongs to another run`);
    const summaryFinished = Date.parse(summary.finishedAt);
    requireEvidence(typeof summary.finishedAt === 'string' && Number.isFinite(summaryFinished) && summaryFinished >= started && summaryFinished <= finished, `${row.name} summary timestamp is outside the run`);
    const counts = summary.counts;
    requireEvidence(COUNT_KEYS.every(key => nonnegativeInteger(counts?.[key])) && counts.selected > 0 && counts.selected === counts.passed + counts.blocking + counts.tolerated, `${row.name} counts are empty or inconsistent`);
    requireEvidence(counts.blocking === 0 && emptyArray(summary.problems) && emptyArray(summary.blocking), `${row.name} has blocking results`);
    requireEvidence(Array.isArray(summary.tolerated) && summary.tolerated.length === counts.tolerated && Array.isArray(summary.recovered) && summary.recovered.length <= counts.passed && Array.isArray(summary.skipsAllowed) && summary.skipsAllowed.length <= counts.passed, `${row.name} exception results are inconsistent`);
    requireEvidence(emptyArray(summary.suggestion?.knownFailing) && emptyArray(summary.suggestion?.allowSkip), `${row.name} still suggests unapproved exceptions`);
  }

  const merged = receipt.merge?.result;
  requireEvidence(receipt.merge?.exit_code === 0 && merged?.schema === 'pr-gate-result-v1' && merged.status === 'passed' && merged.report === false && merged.expected === matrix.length && merged.received === matrix.length && emptyArray(merged.problems) && emptyArray(merged.failed) && emptyArray(merged.suggestion?.knownFailing) && emptyArray(merged.suggestion?.allowSkip), 'merge did not confirm every shard passed');
  if (receipt.dependency_mode === 'offline-cache') {
    requireEvidence(receipt.dependency_sources?.downloads === false, 'offline cache declared a download');
    requireEvidence(receipt.cache_image?.image_id === receipt.offline_cache?.image_id, 'cache image identity differs');
    requireEvidence(receipt.cache_runtime?.network === 'none' && receipt.cache_runtime?.image_id === receipt.cache_image.image_id && receipt.cache_runtime?.published_ports === 0 && receipt.cache_runtime?.privileged === false, 'offline runner isolation missing');
    for (const service of ['postgres', 'azurite']) requireEvidence(/^sha256:[a-f0-9]{64}$/.test(receipt.cache_service_images?.[service] ?? ''), 'cached service identity missing');
    verifyOfflineCache(receipt.offline_cache, expected);
  } else requireEvidence(receipt.dependency_mode === 'download', 'dependency mode is missing or unknown');
  verifyCapabilityRuns(receipt, expected, now);
  verifyHostRuns(receipt, expected);
  for (const key of ['commit', 'tree']) requireEvidence(receipt.host_source?.[key] === expected[key], 'host source belongs to another candidate');
  requireEvidence(receipt.host_source.clean_tree === true && JSON.stringify(receipt.host_source.raw_source) === JSON.stringify(receipt.host_dispatch.runtime.source.raw_source), 'host and core raw source proofs differ');
  verifyCoreSource(receipt.core_source_final, { candidate: expected, runId: receipt.run_id, verifierSha256: expected.source_verifier_sha256,
    rawSource: receipt.host_dispatch.runtime.source.raw_source, shards: receipt.shards, startedAt: receipt.started_at, finishedAt: receipt.finished_at });
  verifyBrowserRuns(receipt, expected);
  return receipt;
}
