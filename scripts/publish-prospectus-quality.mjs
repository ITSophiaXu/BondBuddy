#!/usr/bin/env node
/** Run only on the controlled release host. This CLI publishes statuses, never private evidence. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RELEASE_STATUS = 'prospectus-release-acceptance';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = code => { throw new Error(`PROSPECTUS_PUBLISH_${code}`); };

function execute(command, args, { cwd, env, input } = {}) {
  const result = spawnSync(command, args, { cwd, env, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    timeout: command === 'gh' ? 60_000 : 35 * 60 * 1000 });
  // The runner preserves its own logs. Do not copy raw gh errors or private paths
  // into public GitHub status descriptions or publisher console output.
  if (result.error || result.status !== 0) fail(command === 'gh' ? 'STATUS_UPDATE_FAILED' : 'COMMAND_FAILED');
  return result.stdout ?? '';
}
export function repositoryFromRemote(remote) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(remote);
  if (!match) fail('CANONICAL_GITHUB_ORIGIN_REQUIRED');
  return match[1];
}
export function gateEnvironment(env) {
  const child = { ...env };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_CONFIG_DIR']) delete child[key];
  return child;
}
/** Injectable command/file adapters exercise orchestration without real statuses
 * or any real/synthetic acceptance record. Production CLI never overrides them. */
export function publishProspectusQuality({ commit, cwd = root, env = process.env, platform = process.platform,
  run = execute, read = readFileSync, node = process.execPath } = {}) {
  if (platform !== 'linux') fail('LINUX_REQUIRED');
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) fail('EXACT_FULL_COMMIT_REQUIRED');
  const childEnv = gateEnvironment(env);
  const git = args => run('git', args, { cwd, env: childEnv }).trim();
  const head = git(['rev-parse', 'HEAD']), tree = git(['rev-parse', 'HEAD^{tree}']);
  if (head !== commit || git(['status', '--porcelain', '--untracked-files=normal'])) fail('CLEAN_CANDIDATE_REQUIRED');
  const repository = repositoryFromRemote(git(['remote', 'get-url', 'origin']));
  const receipt = resolve(cwd, '.local/prospectus-quality.json');
  const update = (state, description) => run('gh', ['api', '--hostname', 'github.com', '--method', 'POST',
    `repos/${repository}/statuses/${commit}`, '--input', '-'], {
    cwd, env, input: JSON.stringify({ state, context: RELEASE_STATUS, description }),
  });
  update('pending', 'Complete quality checks and real-model acceptance are running.');
  try {
    run(node, ['scripts/prospectus-quality-gate.mjs', 'run', '.local/prospectus-quality.json'], { cwd, env: childEnv });
    run(node, ['scripts/prospectus-quality-gate.mjs', 'verify', commit, receipt], { cwd, env: childEnv });
    if (git(['rev-parse', 'HEAD']) !== commit || git(['rev-parse', 'HEAD^{tree}']) !== tree || git(['status', '--porcelain', '--untracked-files=normal']))
      fail('CANDIDATE_CHANGED');
    const receiptSha256 = createHash('sha256').update(read(receipt)).digest('hex');
    update('success', `Full quality and real-model acceptance passed; receipt ${receiptSha256}`);
    return { status: 'passed', commit, tree, context: RELEASE_STATUS, receipt_sha256: receiptSha256 };
  } catch (error) {
    try { update('failure', 'Full quality or real-model acceptance failed; release is not authorized.'); }
    catch { fail('FAILURE_STATUS_UNAVAILABLE'); }
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) fail('USAGE_EXPECTED_FULL_COMMIT');
    console.log(JSON.stringify(publishProspectusQuality({ commit: process.argv[2] })));
  } catch (error) {
    console.error(/^PROSPECTUS_PUBLISH_[A-Z_]+$/.test(error.message) ? error.message : 'PROSPECTUS_PUBLISH_FAILED');
    process.exitCode = 1;
  }
}
