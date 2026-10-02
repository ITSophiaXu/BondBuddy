/** Routes the shared model_generation stage by the immutable run task kind. */
import type { NoHistoryStageAdapters } from './no-history-model-stage.js';
import { noHistoryModelGenerationStage } from './no-history-model-stage.js';
import { historicalModelGenerationStage } from './historical-model-stage.js';
import { loadHistoricalGenerationInput } from './historical-generation-input.js';
import { createFactEvidenceReviewGuardedLoader, type FactEvidenceReviewGateLoaderOptions } from './fact-evidence-review-gate.js';
import type { RunStage } from './run-pipeline.js';

export interface ModelGenerationRouterOptions {
  /** Trusted adapters are supplied only after their server-side sources are implemented. */
  noHistoryAdapters?: NoHistoryStageAdapters;
  /** Internal seam for focused router tests; production defaults to the #31 implementation. */
  historicalStage?: RunStage;
  /** #15 fact evidence review guard. Absent = off, so the historical stage keeps its current behavior. */
  factEvidenceReviewGate?: FactEvidenceReviewGateLoaderOptions;
}

function noHistoryCapabilityNotReady(): RunStage {
  return {
    name: 'model_generation',
    replay: true,
    run: async () => ({
      kind: 'pause',
      stage: 'capability_not_ready',
      reason: 'needs_review:no_history_generation_adapters_not_installed',
    }),
  };
}

/**
 * Keeps #31 update runs on their existing historical stage and sends generation runs through
 * #33's guarded stage when trusted adapters are installed. The production default has no
 * issuer profile, target facts, rule selector, or reference adapter, so generation pauses
 * before creating a prompt or contacting a model.
 */
export function modelGenerationRouter(options: ModelGenerationRouterOptions = {}): RunStage {
  const update = options.historicalStage ?? historicalModelGenerationStage(options.factEvidenceReviewGate
    ? { load: createFactEvidenceReviewGuardedLoader(loadHistoricalGenerationInput, options.factEvidenceReviewGate) }
    : {});
  const generation = options.noHistoryAdapters
    ? noHistoryModelGenerationStage(options.noHistoryAdapters)
    : noHistoryCapabilityNotReady();

  return {
    name: 'model_generation',
    replay: true,
    run: async ctx => {
      if ((ctx.values.get('input_lock') as { authoring_mode?: string })?.authoring_mode === 'unified_v1') {
        // Never change logical call IDs or resend calls on a previously started v3 run.
        // New runs use read-only, run-scoped material tools while they author each section.
        const legacy=Object.keys(ctx.checkpoint).some(k=>k.startsWith('unified_v3_'));
        return unifiedModelGenerationStage({direct:!legacy}).run(ctx);
      }
      if (ctx.run.task_kind === 'update') return update.run(ctx);
      if (ctx.run.task_kind === 'generation') return generation.run(ctx);
      return { kind: 'pause', stage: 'capability_not_ready', reason: 'unsupported_model_generation_task_kind' };
    },
  };
}
import { unifiedModelGenerationStage } from './unified-model-stage.js';
