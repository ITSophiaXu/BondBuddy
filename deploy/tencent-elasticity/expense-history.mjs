import {lstat, realpath} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {readPrivateJson} from './private-files.mjs';
import {canonical, sha256, requireThat} from './policy.mjs';

const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const pending = o => ['intent', 'submitted', 'unknown'].includes(o.state);

/** One operator-pinned archive of real source ledger rows, never fabricated
 * operations or a second ledger. The existing producer prices these rows. */
export async function readExpenseHistory(config) {
  const pin = config.external_expense_history;
  if (pin === undefined) return undefined;
  requireThat(pin?.file?.startsWith('/') && resolve(pin.file) === pin.file &&
    digest(pin.sha256) && digest(pin.source_evidence_sha256) && digest(pin.source_ledger_sha256) &&
    /^\d{1,20}$/.test(pin.source_system_identifier), 'EXPENSE_HISTORY_PIN_REQUIRED');
  requireThat(await realpath(pin.file) === pin.file, 'EXPENSE_HISTORY_PATH');
  for (let path = dirname(pin.file);; path = dirname(path)) {
    const stat = await lstat(path);
    requireThat(stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o022) &&
      [0, process.getuid()].includes(stat.uid), 'EXPENSE_HISTORY_DIRECTORY');
    if (path === '/') break;
  }
  const history = await readPrivateJson(pin.file);
  requireThat(sha256(canonical(history)) === pin.sha256, 'EXPENSE_HISTORY_HASH');
  return history;
}

export function mergeExpenseHistory(ledger, history, config, period, periodFor) {
  const pin = config.external_expense_history;
  if (pin === undefined) {
    requireThat(history === undefined, 'EXPENSE_HISTORY_UNPINNED');
    return ledger;
  }
  const now = Date.parse(ledger?.captured_at), captured = Date.parse(history?.ledger?.captured_at);
  requireThat(history?.version === 'execution-cloud-history-v1' &&
    history.account_id === config.account_id && history.region === config.region &&
    history.expense_policy_sha256 === config.expense_policy_sha256 &&
    history.expense_policy_revision === config.expense_policy_revision && history.currency === 'CNY' &&
    history.time_zone === config.time_zone &&
    history.ledger_sha256 === pin.source_ledger_sha256 && digest(pin.source_ledger_sha256) &&
    history.ledger_sha256 === sha256(canonical(history.ledger)) &&
    history.source_system_identifier === pin.source_system_identifier &&
    history.source_evidence_sha256 === pin.source_evidence_sha256 && digest(pin.source_evidence_sha256) &&
    digest(pin.sha256) && sha256(canonical(history)) === pin.sha256,
    'EXPENSE_HISTORY_SOURCE');
  requireThat(Number.isFinite(now) && Number.isFinite(captured) && captured <= now &&
    Date.parse(history.valid_from) <= now && now < Date.parse(history.valid_until), 'EXPENSE_HISTORY_TIME');
  const rollover = history.rollover_policy;
  requireThat(rollover === undefined || rollover?.mode === 'closed_archive_conservative_carry_v1' &&
    digest(rollover.review_sha256), 'EXPENSE_HISTORY_ROLLOVER_POLICY');
  const sourcePeriod = rollover ? periodFor(history.ledger.captured_at, config.time_zone) : period;
  requireThat(Object.entries(sourcePeriod).every(([key, value]) => history[key] === value) &&
    (rollover || Date.parse(history.valid_until) <= Date.parse(period.period_end)), 'EXPENSE_HISTORY_TIME');
  // Reserve the entire new day from its first instant. DST can only round this
  // duration upward; no immutable debt or continuing resource is zeroed at midnight.
  const carryDays = rollover ? Math.max(0, Math.ceil((Date.parse(period.period_end) -
    Date.parse(sourcePeriod.period_end)) / 86400000)) : 0;
  requireThat(Array.isArray(history.ledger.nodes) && Array.isArray(history.ledger.operations) &&
    Array.isArray(ledger.nodes) && Array.isArray(ledger.operations), 'EXPENSE_HISTORY_ROWS');
  // An immutable closed archive remains usable. Live resources and unresolved
  // operations must be refreshed, and still need the producer's live inventory.
  const closed = history.ledger.nodes.every(n => Number.isFinite(Date.parse(n.destroyed_at)) && Date.parse(n.destroyed_at) <= captured) &&
    !history.ledger.operations.some(pending);
  requireThat(!rollover || closed, 'EXPENSE_HISTORY_ARCHIVE_NOT_CLOSED');
  requireThat(closed || now - captured <= 300000, 'EXPENSE_HISTORY_STALE');
  const union = (old, current, key) => {
    const rows = new Map();
    for (const row of [...old, ...current]) {
      const id = key(row);
      requireThat(typeof id === 'string' && id.length > 0, 'EXPENSE_HISTORY_ROW_ID');
      requireThat(!rows.has(id) || canonical(rows.get(id)) === canonical(row), 'EXPENSE_HISTORY_CONFLICT');
      rows.set(id, row);
    }
    return [...rows.values()];
  };
  const nodes = union(history.ledger.nodes, ledger.nodes, n => n.identity?.instance_id);
  const operations = union(history.ledger.operations, ledger.operations, o => o.operation_id);
  // Foreign or omitted bound operations cannot disappear into an unpriced tail.
  for (const o of operations) requireThat(o.identity === null ||
    o.identity?.account_id === config.account_id && o.identity.region === config.region &&
    nodes.some(n => n.identity.instance_id === o.identity.instance_id), 'EXPENSE_HISTORY_COVERAGE');
  requireThat(Array.isArray(history.external_liabilities) && history.external_liabilities.length > 0 &&
    digest(history.fixed_obligation_dedup_receipt_sha256), 'EXPENSE_HISTORY_EXTERNAL_REQUIRED');
  const ids = new Set();
  let external = 0;
  for (const row of history.external_liabilities) {
    requireThat(typeof row.liability_id === 'string' && row.liability_id.length > 0 && !ids.has(row.liability_id) &&
      ['manual_compute', 'management_calls', 'surviving_disk', 'independent_other'].includes(row.kind) &&
      row.scope === 'outside_source_ledger_and_current_quote' &&
      typeof row.source_ref === 'string' && row.source_ref.length > 0 && digest(row.source_sha256) &&
      (rollover ? Date.parse(row.coverage_end) >= Date.parse(history.valid_until) : row.coverage_end === period.period_end) && Array.isArray(row.resource_ids) &&
      new Set(row.resource_ids).size === row.resource_ids.length &&
      row.resource_ids.every(id => typeof id === 'string' && id.length > 0 && !nodes.some(n => n.identity.instance_id === id)),
      'EXPENSE_HISTORY_EXTERNAL_OVERLAP');
    ids.add(row.liability_id);
    for (const key of ['spent_upper_bound_cny', 'unknown_carry_upper_bound_cny', 'remaining_period_upper_bound_cny']) {
      requireThat(Number.isFinite(row[key]) && row[key] >= 0, 'EXPENSE_HISTORY_EXTERNAL_BOUND');
      external += Math.ceil(row[key] * 1000000);
    }
    if (rollover) {
      requireThat(row.carry_policy === 'retain_and_accrue_daily_upper_bound' &&
        Number.isFinite(row.daily_upper_bound_cny) && row.daily_upper_bound_cny >= 0,
        'EXPENSE_HISTORY_CARRY_BOUND');
      // Keep the full original bound, including unknowns, and accumulate each
      // subsequent day's reviewed upper bound. Never infer billing settlement.
      external += carryDays * Math.ceil(row.daily_upper_bound_cny * 1000000);
    }
  }
  requireThat(Number.isSafeInteger(external), 'EXPENSE_HISTORY_EXTERNAL_BOUND');
  return {...ledger, nodes, operations, external_liability_upper_bound_cny: external / 1000000};
}
