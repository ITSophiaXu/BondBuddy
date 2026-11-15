import {createHash} from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export function requireThat(condition, code) { if (!condition) throw new Error(code); }
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const id = (x, prefix) => typeof x === 'string' && new RegExp(`^${prefix}-[a-z0-9]+$`).test(x);

/** Provider configuration, not a second capacity policy. PG remains authoritative. */
export function validateConfig(c, {apply = false} = {}) {
  requireThat(c?.version === 'tencent-execution-pool-v1', 'CONFIG_VERSION');
  requireThat(c.region === 'ap-beijing' && c.zone === 'ap-beijing-7' && c.instance_type === 'SA9.LARGE16', 'RESOURCE_SCOPE');
  requireThat(/^\d{1,20}$/.test(c.account_id) && /^[a-z0-9-]{1,40}$/.test(c.pool_tag), 'OWNERSHIP_SCOPE');
  requireThat(c.min_running === 1 && c.max_owned === 2, 'POOL_BOUND');
  requireThat(['single_node_validation', 'two_node_validation', 'automatic'].includes(c.phase), 'PHASE_REQUIRED');
  requireThat([4, 8].includes(c.global_model_limit) && c.node_model_limit === 4, 'CAPACITY_BOUND');
  requireThat(c.compute_cny_per_hour === 0.8 && c.compute_cap_cny_per_hour === 1.6, 'COMPUTE_QUOTE');
  requireThat(Number.isSafeInteger(c.scale_up_wait_seconds) && c.scale_up_wait_seconds >= 30 &&
    Number.isSafeInteger(c.idle_seconds) && c.idle_seconds >= 60 &&
    Number.isSafeInteger(c.failure_cooldown_seconds) && c.failure_cooldown_seconds >= 60, 'COOLDOWN_BOUND');
  if (apply) {
    requireThat(c.enabled === true, 'APPLY_DISABLED');
    requireThat(id(c.image_id, 'img') && id(c.vpc_id, 'vpc') && id(c.subnet_id, 'subnet') && id(c.security_group_id, 'sg'), 'MATERIAL_IDS_REQUIRED');
    requireThat(hash(c.source_sha256) && hash(c.image_sha256) && hash(c.network_review_sha256) && hash(c.quote_sha256), 'MANIFEST_REQUIRED');
    requireThat(c.role_names?.length === 2 && new Set(c.role_names).size === 2 && c.role_names.every(x => /^[A-Za-z0-9_-]{1,60}$/.test(x)), 'PER_NODE_ROLE_REQUIRED');
    requireThat(Number.isFinite(c.noncompute_cap_cny_per_hour) && c.noncompute_cap_cny_per_hour >= 0 &&
      Number.isFinite(c.total_cap_cny_per_hour) && Math.round(c.total_cap_cny_per_hour * 1000) >= 1600 + Math.round(c.noncompute_cap_cny_per_hour * 1000), 'NONCOMPUTE_QUOTE_REQUIRED');
    if (c.phase === 'automatic') requireThat(c.stop_charging_verified === true && hash(c.stop_charging_evidence_sha256), 'STOP_CHARGING_UNVERIFIED');
    requireThat(c.private_pg_verified === true && c.service_credentials_verified === true, 'BOOTSTRAP_UNVERIFIED');
    if (c.global_model_limit === 8) requireThat(hash(c.provider_budget_review_sha256), 'PROVIDER_BUDGET_UNVERIFIED');
  }
  return c;
}

export function planCapacity(snapshot, inventory, config, now = Date.now()) {
  validateConfig(config);
  const hold = reason => ({kind: 'hold', reason});
  if (!config.enabled || !snapshot.policy.managed_nodes) return hold('disabled');
  if (!snapshot.policy.budget_available) return hold('budget');
  if (snapshot.policy.node_model_limit !== 4 || ![4, 8].includes(snapshot.policy.global_model_limit) ||
      snapshot.policy.global_model_limit !== config.global_model_limit || snapshot.policy.max_nodes !== 2) return hold('policy_mismatch');
  if (snapshot.pending_cloud_reservations) return hold('pending_cloud_operation');
  if (inventory.length > 2) return hold('inventory_drift');
  if (inventory.some(x => x.cooldown_until && now < Date.parse(x.cooldown_until))) return hold('inventory_cooldown');
  const live = inventory.filter(x => x.instance_state !== 'STOPPED'); // unknown/starting still reserve costs
  const ready = snapshot.nodes.filter(x => x.state === 'ready');
  const demand = snapshot.groups.filter(g => g.effective_queued_work > 0 &&
    g.oldest_wait_seconds >= config.scale_up_wait_seconds &&
    g.available_run_slots === 0);
  const unsupplied = demand.filter(g => !ready.some(n => n.capabilities.includes(g.capability) && n.ready_slots > 0));
  const hasBudgetSlots = snapshot.active_model_calls < snapshot.policy.global_model_limit;
  if (live.length < 1 || (config.phase !== 'single_node_validation' && unsupplied.length && hasBudgetSlots)) {
    const spare = inventory.find(x => x.instance_state === 'STOPPED');
    if (live.length >= 2 || (!spare && inventory.length >= 2)) return hold('max_owned');
    if ((live.length + 1) * config.compute_cny_per_hour > config.compute_cap_cny_per_hour) return hold('compute_cap');
    return {kind: spare ? 'start' : 'run', instance_id: spare?.instance_id ?? null,
      capabilities: live.length < 1 ? ['authoring', 'review', 'assistant', 'probe'] : unsupplied.map(g => g.capability)};
  }
  // Idle age is an optimization gate only; fresh PG drain proof is still mandatory.
  if (config.phase === 'automatic' && ready.length > 1 && live.length > 1 && snapshot.effective_queued_work === 0) {
    const spare = ready.find(n => n.identity.instance_id !== config.resident_instance_id &&
      ready.some(other => other.identity.instance_id === config.resident_instance_id && other.ready_slots > 0 &&
        n.capabilities.every(cap => other.capabilities.includes(cap))) &&
      n.active_leases === 0 && n.active_model_calls === 0 &&
      Number.isFinite(Date.parse(n.idle_since)) && now - Date.parse(n.idle_since) >= config.idle_seconds * 1000);
    if (spare) return {kind: 'drain', identity: spare.identity, revision: spare.revision};
  }
  return hold('capacity_or_demand');
}
