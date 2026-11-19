import {createHash} from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export function requireThat(condition, code) { if (!condition) throw new Error(code); }
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const id = (x, prefix) => typeof x === 'string' && new RegExp(`^${prefix}-[a-z0-9]+$`).test(x);
const modelCapacity = x => Number.isInteger(x) && x > 0 && x <= 2147483647;

/** Operator-owned pins name existing instances, never an image allowlist. */
export function retainedNodePin(c, instanceId) {
  const pins=c.retained_nodes===undefined?[]:c.retained_nodes;
  requireThat(Array.isArray(pins)&&pins.length<=2,'RETAINED_NODE_PINS');
  const keys=['instance_id','image_id','image_sha256','source_sha256','role_name','create_operation_id','launch_manifest_sha256','launch_binding_sha256'];
  requireThat(pins.every(p=>p&&Object.keys(p).length===keys.length&&Object.keys(p).every(k=>keys.includes(k))&&
    id(p.instance_id,'ins')&&id(p.image_id,'img')&&c.role_names?.includes(p.role_name)&&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(p.create_operation_id??'')&&
    ['image_sha256','source_sha256','launch_manifest_sha256','launch_binding_sha256'].every(k=>hash(p[k])))&&
    ['instance_id','role_name','create_operation_id'].every(k=>new Set(pins.map(p=>p[k])).size===pins.length),'RETAINED_NODE_PINS');
  return pins.find(p=>p.instance_id===instanceId);
}

/** All other launch parameters remain current and must reproduce the old hash. */
export function nodeLaunchConfig(c, instanceId) {
  const p=retainedNodePin(c,instanceId);
  return p?{...c,image_id:p.image_id,image_sha256:p.image_sha256,source_sha256:p.source_sha256}:c;
}

export function requireRetainedRequest(c, instanceId, request) {
  const p=retainedNodePin(c,instanceId);
  if(p)requireThat(request?.account_id===c.account_id&&request.region===c.region&&
    request.source_sha256===p.source_sha256&&request.image_sha256===p.image_sha256&&
    request.launch_manifest_sha256===p.launch_manifest_sha256&&canonical(request.services)===canonical(c.services),'RETAINED_NODE_REQUEST_DRIFT');
}

/** Provider configuration, not a second capacity policy. PG remains authoritative. */
export function validateConfig(c, {apply = false, expenditure = true} = {}) {
  requireThat(c?.version === 'tencent-execution-pool-v1', 'CONFIG_VERSION');
  retainedNodePin(c);
  requireThat(c.region === 'ap-beijing' && c.zone === 'ap-beijing-7' && c.instance_type === 'SA9.LARGE16', 'RESOURCE_SCOPE');
  requireThat(/^\d{1,20}$/.test(c.account_id) && /^[a-z0-9-]{1,40}$/.test(c.pool_tag), 'OWNERSHIP_SCOPE');
  requireThat((c.min_running===1 || (c.phase==='automatic'&&c.min_running===0)) && c.max_owned === 2, 'POOL_BOUND');
  requireThat(['single_node_validation', 'two_node_validation', 'automatic'].includes(c.phase), 'PHASE_REQUIRED');
  requireThat((c.global_model_limit === undefined || modelCapacity(c.global_model_limit)) &&
    [4,8].includes(c.node_model_limit), 'CAPACITY_BOUND');
  requireThat(c.compute_cny_per_hour === 0.8 && c.compute_cap_cny_per_hour === 1.6, 'COMPUTE_QUOTE');
  requireThat(Number.isSafeInteger(c.scale_up_wait_seconds) && c.scale_up_wait_seconds >= 30 &&
    Number.isSafeInteger(c.idle_seconds) && c.idle_seconds >= 60 &&
    Number.isSafeInteger(c.failure_cooldown_seconds) && c.failure_cooldown_seconds >= 60, 'COOLDOWN_BOUND');
  if (apply) {
    if (expenditure) requireThat(c.enabled === true, 'APPLY_DISABLED');
    requireThat(id(c.image_id, 'img') && id(c.vpc_id, 'vpc') && id(c.subnet_id, 'subnet') && id(c.security_group_id, 'sg'), 'MATERIAL_IDS_REQUIRED');
    requireThat(hash(c.source_sha256) && hash(c.image_sha256) && hash(c.network_review_sha256) && hash(c.quote_sha256), 'MANIFEST_REQUIRED');
    requireThat(c.role_names?.length === 2 && new Set(c.role_names).size === 2 && c.role_names.every(x => /^[A-Za-z0-9_-]{1,60}$/.test(x)), 'PER_NODE_ROLE_REQUIRED');
    if (expenditure) requireThat(Number.isFinite(c.noncompute_cap_cny_per_hour) && c.noncompute_cap_cny_per_hour >= 0 &&
      Number.isFinite(c.total_cap_cny_per_hour) && Math.round(c.total_cap_cny_per_hour * 1000) >= 1600 + Math.round(c.noncompute_cap_cny_per_hour * 1000), 'NONCOMPUTE_QUOTE_REQUIRED');
    if (expenditure && c.phase === 'automatic') requireThat(c.stop_charging_verified === true && hash(c.stop_charging_evidence_sha256), 'STOP_CHARGING_UNVERIFIED');
    if (expenditure) requireThat(c.private_pg_verified === true && c.service_credentials_verified === true, 'BOOTSTRAP_UNVERIFIED');
    if (expenditure && c.global_model_limit > 4) requireThat(hash(c.provider_budget_review_sha256), 'PROVIDER_BUDGET_UNVERIFIED');
  }
  return c;
}

export function planCapacity(snapshot, inventory, config, now = Date.now()) {
  validateConfig(config);
  const hold = reason => ({kind: 'hold', reason});
  if (!config.enabled || !snapshot.policy.managed_nodes) return hold('disabled');
  if (snapshot.policy.node_model_limit !== config.node_model_limit || snapshot.policy.max_nodes !== config.max_owned) return hold('policy_mismatch');
  if (snapshot.pending_cloud_reservations) return hold('pending_cloud_operation');
  if (inventory.length > 2) return hold('inventory_drift');
  if (inventory.some(x => x.cooldown_until && now < Date.parse(x.cooldown_until))) return hold('inventory_cooldown');
  const live = inventory.filter(x => x.instance_state !== 'STOPPED'); // unknown/starting still reserve costs
  const ready = snapshot.nodes.filter(x => x.state === 'ready');
  const automaticZero=config.phase==='automatic'&&config.min_running===0;
  // Zero is an explicit execution-pool policy. Idle selection still requires
  // positive PG activity evidence; the controller obtains the full drain proof
  // and freezes the epoch before any cloud Stop. A lost node is never idle proof.
  if(automaticZero&&ready.length>0&&
    (snapshot.effective_queued_work===0||!snapshot.policy.budget_available)){
    const idle=ready.find(n=>inventory.some(i=>i.instance_id===n.identity.instance_id&&i.instance_state==='RUNNING')&&
      (!snapshot.policy.budget_available||(n.ready_slots>0&&n.active_leases===0&&n.active_model_calls===0&&
        Number.isFinite(Date.parse(n.idle_since))&&now-Date.parse(n.idle_since)>=config.idle_seconds*1000)));
    if(idle)return {kind:'drain',identity:idle.identity,revision:idle.revision};
  }
  // Safe contraction is allowed even when the spend budget has been withdrawn.
  if (!automaticZero && (config.phase === 'automatic' || !snapshot.policy.budget_available) && ready.length > 1 && live.length > 1 &&
      (snapshot.effective_queued_work === 0 || !snapshot.policy.budget_available)) {
    const spare = ready.find(n => n.identity.instance_id !== config.resident_instance_id &&
      ready.some(other => other.identity.instance_id === config.resident_instance_id &&
        (other.ready_slots > 0 || !snapshot.policy.budget_available) &&
        n.capabilities.every(cap => other.capabilities.includes(cap))) &&
      (!snapshot.policy.budget_available || (n.ready_slots > 0 && n.active_leases === 0 && n.active_model_calls === 0 &&
      Number.isFinite(Date.parse(n.idle_since)) && now - Date.parse(n.idle_since) >= config.idle_seconds * 1000)));
    if (spare) return {kind: 'drain', identity: spare.identity, revision: spare.revision};
  }
  if (snapshot.policy.launch_blocked_by_operation_id) return hold('authorization_denial');
  if (!snapshot.policy.budget_available) return hold('budget');
  if (snapshot.policy.cooldown_until && now < Date.parse(snapshot.policy.cooldown_until)) return hold('policy_cooldown');
  const {global_model_limit:limit, provider_concurrency_limit:quota,
    provider_policy_sha256:providerReview, expense_policy_sha256:expenseReview} = snapshot.policy;
  if (!modelCapacity(limit) || !modelCapacity(quota) || limit > quota ||
      (config.global_model_limit !== undefined && config.global_model_limit !== limit)) return hold('policy_mismatch');
  if (limit > 4 && (!hash(providerReview) || providerReview !== config.provider_budget_review_sha256 || !hash(expenseReview))) {
    return hold('provider_budget_unverified');
  }
  const unsupplied = snapshot.groups.filter(g => g.effective_queued_work > 0 &&
    g.oldest_wait_seconds >= config.scale_up_wait_seconds &&
    g.available_run_slots === 0);
  const hasBudgetSlots = snapshot.active_model_calls < limit;
  if (hasBudgetSlots && (live.length < config.min_running ||
    ((live.length===0||config.phase !== 'single_node_validation') && unsupplied.length))) {
    const spare = inventory.find(x => x.instance_state === 'STOPPED');
    if (live.length >= 2 || (!spare && inventory.length >= 2)) return hold('max_owned');
    if ((live.length + 1) * config.compute_cny_per_hour > config.compute_cap_cny_per_hour) return hold('compute_cap');
    return {kind: spare ? 'start' : 'run', instance_id: spare?.instance_id ?? null,
      capabilities: live.length < 1 ? [...new Set(config.services.flatMap(s => s.capabilities))] : unsupplied.map(g => g.capability)};
  }
  return hold('capacity_or_demand');
}
