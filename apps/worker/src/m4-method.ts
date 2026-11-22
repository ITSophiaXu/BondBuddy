import type { StageContext, StageOutcome } from './run-pipeline.js';
import type { CodexAdapterConfig } from './codex-adapter.js';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { checkpointStage } from '@bondbuddy/api/queue';
import { m4ToolHashes } from './m4-file-workspace.js';
import type { loadM4RuntimeSkill } from './m4-runtime-skills.js';

/** Billing and durable replay both use the exact model, never a silently substituted provider. */
export async function m4ModelGate(
  ctx: StageContext,
  config: CodexAdapterConfig,
): Promise<Extract<StageOutcome, { kind: 'pause' }> | null> {
  if (ctx.run.billing_mode !== 'metered_credits') return null;
  const row = (
    await ctx.pool.query(
      `SELECT c.config FROM bb_credit_reservations r
    JOIN bb_m4_quotes q ON q.id=r.quote_id AND q.owner_user_id=r.owner_user_id
    JOIN bb_m4_billing_configs c ON c.id=q.config_id WHERE r.owner_user_id=$1 AND r.run_id=$2`,
      [ctx.run.owner_user_id, ctx.run.id],
    )
  ).rows[0];
  return row?.config?.model_id === config.model_id
    ? null
    : { kind: 'pause', stage: 'capability_not_ready', reason: 'm4_pinned_model_changed' };
}
export async function m4PinnedMethod(
  ctx: StageContext,
  kind: 'document' | 'qa',
  skill: ReturnType<typeof loadM4RuntimeSkill>,
  config: CodexAdapterConfig,
) {
  const method = {
    version: `m4-${kind}-method-v1`,
    skill_id: skill.id,
    skill_version: skill.version,
    skill_sha256: skill.sha256,
    helper_sha256: await m4ToolHashes(),
    model: {
      model_id: config.model_id,
      model_provider: config.model_provider,
      base_url: config.base_url,
      model_config_version: config.model_config_version,
      reasoning_effort: config.reasoning_effort,
    },
  };
  const hash = inputManifestHash(method),
    key = `m4_${kind}_method`,
    saved = ctx.checkpoint[key];
  if (saved && inputManifestHash(saved) !== hash)
    return {
      hash,
      gate: {
        kind: 'pause',
        stage: 'capability_not_ready',
        reason: `m4_${kind}_method_changed`,
      } as const,
    };
  if (!saved) {
    await checkpointStage(ctx.pool, ctx.lease, key, method);
    ctx.checkpoint[key] = method;
  }
  return { hash, gate: null };
}
