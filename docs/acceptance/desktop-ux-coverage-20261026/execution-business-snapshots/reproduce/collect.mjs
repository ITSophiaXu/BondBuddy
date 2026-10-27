import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

// No commands, services, tests or databases are started here. Root explicitly
// selects completed invocations and source freezes in collect-config.json.
// Usage: node .local/execution-business-snapshots/collect.mjs --check [config-name]
//        node .local/execution-business-snapshots/collect.mjs --collect [config-name]
const root = process.cwd(), local = resolve(root, '.local/execution-business-snapshots');
const target = resolve(root, 'docs/acceptance/desktop-ux-coverage-20261026/execution-business-snapshots');
const mode = process.argv[2], configName = process.argv[3] ?? 'collect-config.json';
assert(['--check', '--collect'].includes(mode), 'Choose --check or --collect explicitly');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clean = value => value.replace(/\x1b\[[0-9;]*m/g, '');
const within = (base, file) => {
  const part = relative(base, resolve(file));
  assert(part && !part.startsWith('..') && !isAbsolute(part), 'Path outside ' + base + ': ' + file);
};
within(root, local); within(root, target);
const regular = file => {
  const stat = lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Only regular files are allowed: ' + file);
  return stat;
};
const localPath = name => {
  assert(typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && basename(name) === name,
    'Expected an explicit top-level evidence filename: ' + String(name));
  const file = join(local, name); within(local, file); regular(file); return file;
};
const read = name => readFileSync(localPath(name));
const json = name => JSON.parse(read(name).toString('utf8'));
const record = name => { const bytes = read(name); return { path: name, bytes: bytes.length, sha256: sha(bytes) }; };
const config = json(configName);
assert.equal(config.schemaVersion, 1);
assert.equal(config.baseline_commit, '25c39048');
assert(config.goal_complete === false && config.g03_complete === false, 'This evidence cannot close G03/the full goal');
assert(typeof config.notes === 'string' && config.notes.trim(), 'Root must state the final evidence boundaries');
assert(config.broad && config.final, 'Both broad and final source bindings are required');
assert(Array.isArray(config.selected) && config.selected.length > 0, 'Explicit completed command selections are required');

const validateSnapshot = name => {
  const entries = json(name); assert(Array.isArray(entries) && entries.length > 0, 'Missing source entries: ' + name);
  const seen = new Set();
  for (const entry of entries) {
    assert(typeof entry.path === 'string' && !isAbsolute(entry.path) && entry.path === entry.path.replaceAll('\\', '/'));
    within(root, resolve(root, entry.path));
    assert(/^[a-f0-9]{64}$/.test(entry.sha256), 'Bad source hash in ' + name);
    assert(!seen.has(entry.path), 'Duplicate source path in ' + name); seen.add(entry.path);
  }
  return entries;
};
const binding = definition => {
  const before = validateSnapshot(definition.before), freeze = json(definition.freeze);
  assert.equal(freeze.name + '.json', definition.before, 'Freeze points at another source snapshot');
  assert.equal(freeze.sha256, record(definition.before).sha256, 'Freeze does not bind source bytes');
  assert.equal(freeze.files, before.length, 'Freeze file count differs');
  const time = Date.parse(freeze.created_at); assert(Number.isFinite(time), 'Freeze has no creation time');
  return { before, freeze, time, records: [record(definition.before), record(definition.freeze)] };
};
const broad = binding(config.broad), final = binding(config.final);
assert(config.final.after, 'Root must select the completed final source-after snapshot');
const after = validateSnapshot(config.final.after);
assert.deepEqual(after, final.before, 'Final before/after source and compiled bytes differ');
const finalAfterTime = regular(localPath(config.final.after)).mtimeMs;
const checkCurrentSources = () => {
  for (const entry of after) {
    const file = resolve(root, entry.path); within(root, file); regular(file);
    assert.equal(sha(readFileSync(file)), entry.sha256, 'Current source/build changed: ' + entry.path);
  }
};
checkCurrentSources();
const old = new Map(broad.before.map(entry => [entry.path, entry.sha256]));
const now = new Map(final.before.map(entry => [entry.path, entry.sha256]));
const sourceChanges = [
  ...broad.before.filter(entry => !now.has(entry.path)).map(entry => ({ path: entry.path, before: entry.sha256, after: null })),
  ...final.before.filter(entry => old.get(entry.path) !== entry.sha256)
    .map(entry => ({ path: entry.path, before: old.get(entry.path) ?? null, after: entry.sha256 })),
].sort((left, right) => left.path.localeCompare(right.path));
const testFile = /^apps\/(?:api|worker)\/(?:src|dist)\/.+\.test\.(?:ts|js|d\.ts|js\.map)$/;
assert(sourceChanges.every(change => testFile.test(change.path)),
  'Broad-to-final changes include production code/migration/contracts: ' + sourceChanges.filter(change => !testFile.test(change.path)).map(change => change.path).join(', '));
if (Array.isArray(config.allowed_test_changes)) {
  assert.deepEqual(sourceChanges.map(change => change.path), [...config.allowed_test_changes].sort(),
    'Changed test source/build paths differ from the explicit root selection');
}

const parseCounts = (name, required) => {
  const text = clean(read(name).toString('utf8'));
  const count = field => {
    const matches = [...text.matchAll(new RegExp('^(?:ℹ|#)\\s+' + field + '\\s+(\\d+)\\s*$', 'gm'))];
    if (!required && matches.length !== 1) return null;
    assert.equal(matches.length, 1, 'Missing/repeated ' + field + ' summary in ' + name);
    return Number(matches[0][1]);
  };
  const tests = count('tests'); if (tests === null) return null;
  const result = { tests, passed: count('pass'), failed: count('fail'), cancelled: count('cancelled'), skipped: count('skipped'), todo: count('todo') };
  if (Object.values(result).some(value => value === null)) {
    assert(!required, 'Incomplete counters in ' + name); return null;
  }
  assert.equal(result.tests, result.passed + result.failed + result.cancelled + result.skipped + result.todo,
    'Inconsistent Node test counters in ' + name);
  return result;
};
const completedCommand = name => {
  const receipt = json(name), log = name.replace(/\.json$/, '.log');
  assert(name.endsWith('.json') && log !== name);
  assert(Array.isArray(receipt.args), 'Not a command receipt: ' + name);
  assert(Number.isInteger(receipt.status), 'Running or aborted commands cannot be selected: ' + name);
  assert.equal(receipt.phase === 'running', false, 'Running command cannot be selected: ' + name);
  assert(!receipt.error && !receipt.signal, 'Errored/interrupted command cannot be selected: ' + name);
  const started = Date.parse(receipt.started), finished = Date.parse(receipt.finished);
  assert(Number.isFinite(started) && Number.isFinite(finished) && finished >= started, 'Command has no final completion time: ' + name);
  localPath(log);
  return { receipt: name, log, ...receipt, started_ms: started, finished_ms: finished };
};
const selectedNames = new Set();
const selected = config.selected.map(selection => {
  assert(typeof selection.label === 'string' && selection.label.trim());
  assert(['broad', 'final'].includes(selection.phase), 'Select broad/final source phase explicitly');
  assert(['node_test', 'command'].includes(selection.kind));
  assert(typeof selection.acceptance === 'boolean');
  assert(!selectedNames.has(selection.receipt), 'Same command selected twice: ' + selection.receipt);
  selectedNames.add(selection.receipt);
  const command = completedCommand(selection.receipt);
  assert.equal(command.status, selection.expected_status, 'Unexpected selected command status');
  const source = selection.phase === 'broad' ? broad : final;
  assert(command.started_ms >= source.time, 'Command predates its selected freeze: ' + selection.receipt);
  if (selection.phase === 'final') {
    assert(command.finished_ms <= finalAfterTime, 'Final source-after predates command completion');
    assert(Object.hasOwn(command.environment ?? {}, 'BB_RUN_RUNTIME_ENABLED'), 'Final receipt must capture the runtime flag');
    assert.equal(command.environment.BB_RUN_RUNTIME_ENABLED, selection.expected_runtime_enabled ?? null,
      'Final runtime environment differs from the explicit selection/default');
    const database = new URL(command.environment.BB_TEST_DATABASE_URL);
    assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.port, '15526');
    assert.equal(database.pathname, '/bb_execution_snapshots_template_20261026');
    assert.equal(database.password, '', 'Never archive database credentials');
  }
  if (selection.acceptance) assert.equal(command.status, 0, 'Failed exploratory commands cannot become acceptance');
  const counts = selection.kind === 'node_test' ? parseCounts(command.log, true) : null;
  if (selection.acceptance && counts) {
    assert.equal(counts.failed, 0); assert.equal(counts.cancelled, 0); assert.equal(counts.todo, 0);
    assert(counts.tests > 0, 'Empty Node test invocation');
  }
  if (selection.expected_counts) assert.deepEqual(counts, selection.expected_counts, 'Selected counters differ from root configuration');
  const test_files = command.args.filter(arg => typeof arg === 'string' && /\.test\.js$/.test(arg));
  return { label: selection.label, phase: selection.phase, kind: selection.kind, acceptance: selection.acceptance,
    note: selection.note ?? null, receipt: command.receipt, log: command.log, status: command.status,
    started: command.started, finished: command.finished, environment: command.environment ?? null,
    args: command.args, counts, test_files, aggregate: null };
});
assert(selected.some(selection => selection.phase === 'final' && selection.acceptance && selection.kind === 'node_test'),
  'At least one completed final corrective/acceptance test group is required');
const broadSelection = selected.find(selection => selection.receipt === config.broad.command);
assert(broadSelection && broadSelection.phase === 'broad' && broadSelection.kind === 'node_test' && broadSelection.acceptance === false,
  'Broad full collection must be explicitly selected as failed/exploratory, without acceptance');
assert.notEqual(broadSelection.status, 0, 'This round does not claim a clean full-suite run');

const windowsTitles = [
  '#79 NDJSON sink cannot be split by log injection',
  '#79 file sink repeat and concurrent processes retain one durable line per key',
  '#79 replay of a complete pre-existing line still acknowledges only after file sync',
  '#79 size cap fails closed for new keys but permits replay of a full segment',
  '#79 replay also detects a key in a legacy rotated segment',
];
const skipArg = broadSelection.args.find(arg => typeof arg === 'string' && arg.startsWith('--test-skip-pattern='));
assert(skipArg, 'Broad Windows exclusion expression is missing');
const skipExpression = new RegExp(skipArg.slice('--test-skip-pattern='.length));
assert(windowsTitles.every(title => skipExpression.test(title)), 'Broad exclusion does not match all five exact Windows titles');
assert.equal(windowsTitles.filter(title => skipExpression.test(title + ' extra')).length, 0, 'Broad exclusion must remain exact');
const runtimeHistory = json(config.runtime_environment_record);
assert(runtimeHistory.acceptance && /exploratory|failed/i.test(runtimeHistory.acceptance),
  'Runtime history must retain the broad exploratory limitation');
assert(typeof runtimeHistory.limitation === 'string' && /not|未|不/i.test(runtimeHistory.limitation),
  'Do not present retained session runtime history as captured process environment');

const overlappingFiles = [];
for (let i = 0; i < selected.length; i++) for (let j = i + 1; j < selected.length; j++) {
  const shared = selected[i].test_files.filter(file => selected[j].test_files.includes(file));
  if (shared.length) overlappingFiles.push({ left: selected[i].receipt, right: selected[j].receipt, shared_test_files: shared, aggregate: null });
}

const migration = completedCommand(config.migration_replay.receipt);
assert.equal(migration.status, 0);
const applied = [...clean(read(migration.log).toString('utf8')).matchAll(/^Applied ([^\r\n]+\.sql)\s*$/gm)].map(match => match[1]);
assert(applied.length >= config.migration_replay.minimum_applied, 'Selected migration log is not the configured empty-database replay');
assert(applied.includes('0124_run_execution_business_snapshots.sql'), '0124 was not actually applied');
for (const name of config.migration_replay.required_migrations ?? []) assert(applied.includes(name), 'Missing replayed migration: ' + name);
const audit = json(config.cleanup.audit), stopAudit = json(config.cleanup.stop_audit);
for (const value of [audit, stopAudit]) {
  for (const key of ['runs', 'executions', 'reviews', 'm4']) assert.equal(value[key], 0, 'Nonempty dedicated template: ' + key);
  assert.deepEqual(value.clones, []); assert.deepEqual(value.other_clients, []);
  assert(value.schema.some(row => row.filename === '0124_run_execution_business_snapshots.sql'), 'Cleanup audit missing final migration');
  assert(Number.isSafeInteger(value.postmaster_pid) && value.postmaster_pid > 0);
}
assert.equal(audit.postmaster_pid, stopAudit.postmaster_pid, 'Cleanup audit stopped a different server');
const stop = json(config.cleanup.stop_command), stopped = json(config.cleanup.stopped_status);
assert.equal(stop.status, 0); assert.equal(stopped.status, 3);
const start = json(config.cleanup.start_record);
assert.equal(start.postmaster_pid, stopAudit.postmaster_pid); assert.equal(start.pid, stopAudit.postmaster_pid);

// Preserve every original failed/aborted receipt and log. Selected invocations
// alone supply adopted counters; history never contributes an aggregate.
const records = readdirSync(local).filter(name => /\.(?:json|log|txt)$/.test(name)
  && ![configName, 'summary.json', 'collect-config.example.json'].includes(name)).sort();
const disposed = new Map((config.aborted_running_receipts ?? []).map(value => [value.receipt, value.disposition]));
const history = [];
for (const name of records.filter(name => name.endsWith('.json'))) {
  const value = json(name);
  if (!Array.isArray(value?.args)) continue;
  const running = value.phase === 'running' || value.status === null;
  if (running) {
    assert(disposed.has(name), 'Evidence still contains an undisposed running command: ' + name);
    const disposition = json(disposed.get(name));
    assert(disposition.stopped || disposition.finished || disposition.aborted_at, 'Aborted command needs a terminal disposition');
  }
  const log = name.replace(/\.json$/, '.log');
  history.push({ receipt: name, log: existsSync(join(local, log)) ? log : null,
    classification: selectedNames.has(name) ? 'selected' : running ? 'historical_aborted' :
      Number.isInteger(value.status) && value.finished ? value.status === 0 ? 'historical_completed_passed' : 'historical_completed_failed' : 'historical_incomplete',
    status: value.status ?? null, signal: value.signal ?? null, acceptance: selectedNames.has(name) ? selected.find(item => item.receipt === name).acceptance : false,
    counts: existsSync(join(local, log)) && !running ? parseCounts(log, false) : null, aggregate: null });
}
for (const item of history.filter(item => /^(?:api|worker|contracts)-build(?:-\d+)?\.json$/.test(item.receipt))) {
  const build = json(item.receipt); if (!build.started || !build.finished) continue;
  for (const selection of selected.filter(item => item.phase === 'broad')) {
    assert(!(Date.parse(build.started) <= Date.parse(selection.finished) && Date.parse(build.finished) >= Date.parse(selection.started)),
      'Known build overlaps a broad test invocation: ' + item.receipt + ' / ' + selection.receipt);
  }
}
const scripts = readdirSync(local).filter(name => name.endsWith('.mjs')).sort();
assert(scripts.includes('verify.mjs') && scripts.includes('collect.mjs'), 'Reproduction drivers are missing');
const recordFiles = records.map(record), scriptFiles = scripts.map(record);
const summary = {
  schemaVersion: 1, synthetic: true, recorded_at: new Date().toISOString(), baseline_commit: config.baseline_commit,
  goal_complete: false, g03_complete: false, status: 'failed_exploratory_full_run_with_selected_final_corrections',
  notes: config.notes, aggregate: null, current_round_browser_claim: false,
  includes_private_byte_store: false, includes_generated_word: false,
  count_policy: 'Each invocation reports its own counters. Full, corrective, repeated and overlapping groups are never added.',
  selected_results: selected, overlapping_test_file_groups: overlappingFiles, historical_commands: history,
  broad_runtime_environment: { record: config.runtime_environment_record, captured_process_environment: broadSelection.environment,
    session_history: runtimeHistory, independently_verified_original_environment: false },
  windows_exclusions: { titles: windowsTitles, expression: skipArg, acceptance: false, included_in_reported_skip_count: false,
    scope: 'Five exact Windows NDJSON titles were excluded by name. Neither exclusion nor retained historical sink tests establish current sink acceptance.' },
  source_binding: {
    broad: { ...config.broad, records: broad.records }, final: { ...config.final, records: [...final.records, record(config.final.after)] },
    final_before_after_identical: true, current_files_match: true, broad_to_final_changes: sourceChanges,
    production_sources_contracts_and_migrations_unchanged_between_broad_and_final: true,
    final_files: after.length,
  },
  migration_replay: { receipt: migration.receipt, log: migration.log, status: migration.status, applied },
  infrastructure_cleanup: { ...config.cleanup, audit, stop_audit: stopAudit, stop_command: stop, stopped_status: stopped,
    exact_postmaster_pid: stopAudit.postmaster_pid },
  record_files: recordFiles, reproduce_files: [...scriptFiles, record(configName)],
};
writeFileSync(join(local, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
if (mode === '--check') {
  console.log('Validated explicit result selections, source bindings and cleanup; wrote local summary.json. Nothing archived.');
} else {
  assert(existsSync(join(target, 'README.md')), 'Root must finish this round README before archival');
  assert(readdirSync(target).every(name => name === 'README.md'), 'Never overwrite already collected evidence');
  const inputRecords = [...recordFiles, ...scriptFiles, record(configName)];
  const copy = (sourceName, destinationName) => {
    const source = localPath(sourceName), destination = resolve(target, destinationName);
    within(target, destination); const bytes = readFileSync(source);
    mkdirSync(resolve(destination, '..'), { recursive: true });
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    assert.equal(sha(readFileSync(destination)), sha(bytes), 'Archive byte mismatch: ' + destinationName);
  };
  for (const item of recordFiles) copy(item.path, join('records', item.path));
  for (const item of scriptFiles) copy(item.path, join('reproduce', item.path));
  copy(configName, join('reproduce', configName)); copy('summary.json', 'summary.json');
  writeFileSync(join(target, '.gitattributes'), '# Preserve exact recorded bytes and manifest hashes.\n* -text\nrecords/** -diff\n', { flag: 'wx' });
  for (const item of inputRecords) assert.deepEqual(record(item.path), item, 'Evidence changed while collecting: ' + item.path);
  checkCurrentSources();
  const files = [];
  const walk = directory => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      assert(!item.isSymbolicLink(), 'Symlink in acceptance archive');
      const file = join(directory, item.name);
      if (item.isDirectory()) walk(file);
      else if (item.isFile()) {
        assert(!/\.(?:docx|pdf|zip|sqlite|db|pem|key)$/i.test(file), 'Private/document/database/key file cannot be archived');
        const bytes = readFileSync(file); files.push({ path: relative(target, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: sha(bytes) });
      }
    }
  };
  walk(target); files.sort((left, right) => left.path.localeCompare(right.path));
  writeFileSync(join(target, 'manifest.json'), JSON.stringify({ synthetic: true, baseline_commit: config.baseline_commit,
    goal_complete: false, g03_complete: false, aggregate: null, includes_private_byte_store: false, includes_generated_word: false,
    files }, null, 2) + '\n', { flag: 'wx' });
  console.log('Archived ' + files.length + ' independently hashed files; aggregate remains null.');
}
