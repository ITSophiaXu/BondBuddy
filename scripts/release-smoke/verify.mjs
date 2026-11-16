#!/usr/bin/env node
/** Validate existing private release-test evidence; never run or fabricate it. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './support.mjs';
import { REQUIRED_RELEASE_CASES, verifyFiveFlowEvidence } from './evidence-schema.mjs';
import {candidateImageContract,verifyImageContract} from './image-contract.mjs';
import {verifyConfirmationEvidence} from './upload-confirmation-evidence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const gitHash = /^[a-f0-9]{40}$/;
const digestHash = /^[a-f0-9]{64}$/;
const imageId = /^sha256:[a-f0-9]{64}$/;
export const MAX_REPORT_AGE_MS = 24 * 60 * 60 * 1000;

export function verifyReport(report, expected, now = Date.now(), allowExpired = false) {
  if (report?.status !== 'passed' || report.modelProbe !== 'passed')
    throw new Error('Release smoke report and model probe must both have passed');
  if (!gitHash.test(expected?.commit ?? '') || !gitHash.test(expected?.tree ?? '') ||
      !gitHash.test(report.sha ?? '') || !gitHash.test(report.tree ?? '') ||
      report.sha !== expected.commit || report.tree !== expected.tree)
    throw new Error('Release smoke evidence belongs to another commit or source tree');
  if (!Array.isArray(report.cases) || report.cases.length !== REQUIRED_RELEASE_CASES.length ||
      REQUIRED_RELEASE_CASES.some(id => report.cases.filter(entry => entry?.id === id).length !== 1) ||
      report.cases.some(entry => entry?.status !== 'passed'))
    throw new Error('Required release smoke cases are missing, duplicated, unexpected or not passed');
  for (const target of ['api', 'worker', 'web']) {
    if (!imageId.test(report.images?.[target]?.id ?? ''))
      throw new Error(`Release smoke image identity is missing or invalid: ${target}`);
  }
  verifyImageContract(report,expected);
  verifyConfirmationEvidence(report,expected);
  verifyFiveFlowEvidence(report, expected);
  const started = typeof report.startedAt === 'string' ? Date.parse(report.startedAt) : NaN;
  const finished = typeof report.finishedAt === 'string' ? Date.parse(report.finishedAt) : NaN;
  const completedAt = typeof report.completedAt === 'string' ? Date.parse(report.completedAt) : NaN;
  const caseTimes = report.cases.map(entry => typeof entry.finishedAt === 'string' ? Date.parse(entry.finishedAt) : NaN);
  if (caseTimes.some(time => !Number.isFinite(time))) throw new Error('Release smoke case completion timestamps are missing or invalid');
  const completed = Math.max(...caseTimes);
  if (!Number.isFinite(now) || !Number.isFinite(started) || !Number.isFinite(finished) || !Number.isFinite(completedAt) ||
      started > completedAt || completedAt > finished || finished > now + 60_000 ||
      report.cases.some(entry => Date.parse(entry.finishedAt) < started) || completed > completedAt ||
      (!allowExpired && now - completed > MAX_REPORT_AGE_MS))
    throw new Error('Release smoke evidence is expired or has invalid timestamps');
  return report;
}

/**
 * Read the existing tab-delimited deployment log, not an arbitrary matching hash.
 * Role evidence cannot authorize a different role or a failed deployment. A
 * completed first-release recovery is the initial successful deployment; an
 * ordinary rollback cannot manufacture an original deployment record.
 * This helper is also used by the independent quality-receipt rollback check.
 */
export function hasSuccessfulDeployment(releasesLog, expected, digest, field, role) {
  if (!['quality_sha256', 'smoke_sha256'].includes(field)) throw new Error('Unknown release evidence field');
  if (role !== undefined && !['main', 'execution'].includes(role)) throw new Error('Unknown deployment role');
  if (typeof releasesLog !== 'string' || !gitHash.test(expected?.commit ?? '') || !digestHash.test(digest ?? '')) return false;
  const operation = role === undefined ? 'deploy' : `deploy-${role}`;
  return releasesLog.split(/\r?\n/).some(line => {
    const columns = line.split('\t');
    if (columns.length !== 3 || !/^\S+$/.test(columns[0]) ||
        !Number.isFinite(Date.parse(columns[0])) || columns[1] !== operation) return false;
    const tokens = columns[2].split(/ +/);
    const values = key => tokens.filter(token => token.startsWith(`${key}=`)).map(token => token.slice(key.length + 1));
    const matches = (key, value) => {
      const found = values(key);
      return found.length === 1 && found[0] === value;
    };
    if (!matches(field, digest)) return false;
    if (role !== undefined) {
      if (['resume_first', 'resume_candidate'].some(key => values(key).length > 1 ||
          values(key).some(value => !['0', '1'].includes(value)))) return false;
      return matches('app', expected.commit) &&
        (matches('rollback', '0') || (matches('rollback', '1') && (matches('resume_first', '1') || matches('resume_candidate', '1'))));
    }
    return tokens[0] === expected.commit.slice(0, 12) && matches('commit', expected.commit);
  });
}

export function verifyRollbackReport(rawReport, expected, releasesLog, now = Date.now(), role) {
  const report = verifyReport(JSON.parse(rawReport), expected, now, true);
  if (!hasSuccessfulDeployment(releasesLog, expected, sha256(rawReport), 'smoke_sha256', role))
    throw new Error('Rollback requires the original passing smoke report of a successfully deployed commit and role');
  return report;
}

function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (!((mode === 'verify' && args.length === 2) ||
        (mode === 'verify-rollback' && (args.length === 3 || args.length === 4))))
    throw new Error('Usage: node scripts/release-smoke/verify.mjs verify <commit> <report.json> | verify-rollback <commit> <report.json> <releases.log> [main|execution]');
  const [ref, filename, logFile, role] = args;
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]);
  const expected = { commit, tree: git(['rev-parse', `${commit}^{tree}`]),imageContract:candidateImageContract(commit,args=>execFileSync('git',args,{cwd:root,windowsHide:true})),
    inspectorSha256: sha256(execFileSync('git', ['show', `${commit}:scripts/release-smoke/artifact-inspect-cli.mjs`], { cwd: root, windowsHide: true })) };
  if(expected.imageContract.confirmation)expected.confirmationInspectorSha256=sha256(execFileSync('git',['cat-file','blob',`${commit}:scripts/release-smoke/upload-confirmation-preflight.mjs`],{cwd:root,windowsHide:true}));
  const raw = readFileSync(filename, 'utf8');
  if (mode === 'verify-rollback') verifyRollbackReport(raw, expected, readFileSync(logFile, 'utf8'), Date.now(), role);
  else verifyReport(JSON.parse(raw), expected);
  process.stdout.write(`Verified release smoke evidence for ${commit}; smoke_sha256=${sha256(raw)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(`Release smoke gate: ${error.message}`); process.exitCode = 1; }
}
