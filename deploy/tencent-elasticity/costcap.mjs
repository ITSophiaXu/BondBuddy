import {requireThat} from './policy.mjs';

/** Input is a fresh, controlled expense snapshot from the existing ops billing
 * reconciliation, including conservative bounds while cloud bills are delayed.
 * An empty monthly bill is never proof of zero cost. No per-user daily quota. */
export function costAdmission(input, inventory, config, now = Date.now()) {
  const fail = reason => ({allowed: false, reason});
  if (!input || input.currency !== 'CNY' || input.version !== 'execution-cloud-expense-v1') return fail('expense_snapshot_missing');
  const observed = Date.parse(input.observed_at), start = Date.parse(input.period_start), end = Date.parse(input.period_end);
  if (!Number.isFinite(observed) || observed > now + 30000 || now - observed > 300000 ||
      !Number.isFinite(start) || !Number.isFinite(end) || start > now || end <= now || end - start > 86400000) return fail('expense_snapshot_stale');
  if (input.account_id !== config.account_id || input.region !== config.region || input.quote_sha256 !== config.quote_sha256 ||
      input.policy_revision !== config.expense_policy_revision || input.period_cap_cny !== 48 ||
      input.total_hourly_cap_cny !== 2.4) return fail('expense_policy_mismatch');
  if (!input.resource_ids || inventory.some(i => !input.resource_ids.includes(i.instance_id)) ||
      input.unknown_operations_fully_reserved !== true || input.bill_delay_conservatively_bounded !== true) return fail('expense_inventory_incomplete');
  const numbers = ['spent_upper_bound_cny', 'reserved_upper_bound_cny', 'unknown_liability_cny', 'drain_reserve_cny'];
  if (numbers.some(k => !Number.isFinite(input[k]) || input[k] < 0) || input.drain_reserve_cny < 2.4) return fail('expense_bound_missing');
  if (config.total_cap_cny_per_hour > 2.4) return fail('hourly_cap');
  // Reserve at least one hour plus a full hour for safe drain. Unknown cloud
  // operations and residual disk/network costs are already included in input.
  const used = numbers.reduce((n, k) => n + input[k], 0);
  return used + config.total_cap_cny_per_hour <= 48 ? {allowed: true, headroom_cny: 48 - used} : fail('period_cap');
}

export function requireCostAdmission(input, inventory, config) {
  const result = costAdmission(input, inventory, config);
  requireThat(result.allowed, 'CLOUD_COSTCAP_REJECTED');
  return result;
}
