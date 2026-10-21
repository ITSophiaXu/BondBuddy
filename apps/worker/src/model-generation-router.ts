import { projectQaModelStage } from './project-qa-stage.js';
import { integrityModelStage } from './integrity-stage.js';
/** Routes the shared model_generation stage by the immutable run task kind. */
import type { NoHistoryStageAdapters } from './no-history-model-stage.js';
import { noHistoryModelGenerationStage } from './no-history-model-stage.js';
import { historicalModelGenerationStage } from './historical-model-stage.js';
import { loadHistoricalGenerationInput } from './historical-generation-input.js';
import { createFactEvidenceReviewGuardedLoader, type FactEvidenceReviewGateLoaderOptions } from './fact-evidence-review-gate.js';
import type { RunStage } from './run-pipeline.js';
import { loadReviewInput } from './review-input.js';
import { reviewModelStage } from './review-model-stage.js';
import { reviewFileStage } from './review-file-stage.js';
import { reviewPublicStage } from './review-public-stage.js';
import { unifiedModelGenerationStage } from './unified-model-stage.js';
import { fileAuthoringStage } from './file-authoring-stage.js';
import { reviewRevisionCliStage } from './review-revision-cli-stage.js';
import { m4DocumentStage } from './m4-document-stage.js';
import { m4QaStage } from './m4-qa-stage.js';
import { projectFileModelStage } from './project-file-stage.js';

export interface ModelGenerationRouterOptions {
  /** Trusted adapters are supplied only after their server-side sources are implemented. */
  noHistoryAdapters?: NoHistoryStageAdapters;
  /** Internal seam for focused router tests; production defaults to the #31 implementation. */
  historicalStage?: RunStage;
  /** Internal seams keep integration tests on the real contained adapter with synthetic replies. */
  reviewStage?: RunStage;
  publicStage?: RunStage;
  revisionStage?: RunStage;
  legacyRevisionStage?: RunStage;
  fileStage?: RunStage;
  m4Document?:RunStage;
  m4Qa?:RunStage;
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
      if((ctx.values.get('input_lock') as {project_qa_mode?:string})?.project_qa_mode)return projectQaModelStage().run(ctx);
      if((ctx.values.get('input_lock') as {integrity_mode?:string})?.integrity_mode)return integrityModelStage().run(ctx);
    if((ctx.values.get('input_lock') as {project_file_mode?:string})?.project_file_mode)return projectFileModelStage().run(ctx);
      const m4=(ctx.values.get('input_lock') as {m4_mode?:string})?.m4_mode;
      if(m4==='document')return (options.m4Document??m4DocumentStage()).run(ctx);
      if(m4==='qa')return (options.m4Qa??m4QaStage()).run(ctx);
      if (!options.reviewStage && ['review-file-v1','review-correction-v2'].includes((ctx.values.get('input_lock') as { file_delivery?: string })?.file_delivery ?? ''))
        return reviewFileStage().run(ctx);
      if ((ctx.values.get('input_lock') as { review_mode?: string })?.review_mode === 'review_v1') {
        const result = await (options.reviewStage ?? reviewModelStage({ loadInput: loadReviewInput })).run(ctx);
        if (result.kind !== 'done') return result;
        ctx.values.set('model_generation', result.value);
        const publicResult = await (options.publicStage ?? reviewPublicStage()).run(ctx);
        if (publicResult.kind !== 'done') return publicResult;
        return { ...result, value: { ...(result.value as Record<string, unknown>), report: publicResult.value },
          ...(result.checkpoint || publicResult.checkpoint ? { checkpoint: { ...result.checkpoint,
            ...(publicResult.checkpoint ? { public_review: publicResult.checkpoint } : {}) } } : {}) };
      }
      const locked = ctx.values.get('input_lock') as {authoring_mode?:string;review_revision?:boolean}|undefined;
      if (locked?.authoring_mode === 'unified_v1') {
        // An accepted M3 finding revision stays on its bounded source/report/plan path.
        // Ordinary new authoring uses original files; previously started calls keep their identity.
        if(locked.review_revision){
          const keys=Object.keys(ctx.checkpoint), prior=ctx.checkpoint.model_generation;
          const legacy=keys.some(k=>/^review_revision_\d+(_prompt)?$/.test(k)) || prior?.version==='unified-plan-v1';
          const cli=keys.some(k=>k.startsWith('review_revision_cli_')) || prior?.execution_mode==='review-revision-cli-v1';
          if(legacy&&cli)return {kind:'pause',stage:'capability_not_ready',reason:'revision_execution_mode_changed'};
          return legacy ? (options.legacyRevisionStage ?? unifiedModelGenerationStage()).run(ctx)
            : (options.revisionStage ?? reviewRevisionCliStage()).run(ctx);
        }
        const old=Object.keys(ctx.checkpoint).some(k=>/^unified_v[34]_/.test(k));
        if(old){const legacy=Object.keys(ctx.checkpoint).some(k=>k.startsWith('unified_v3_'));return unifiedModelGenerationStage({direct:!legacy}).run(ctx);}
        return (options.fileStage ?? fileAuthoringStage()).run(ctx);
      }
      if (ctx.run.task_kind === 'update') return update.run(ctx);
      if (ctx.run.task_kind === 'generation') return generation.run(ctx);
      return { kind: 'pause', stage: 'capability_not_ready', reason: 'unsupported_model_generation_task_kind' };
    },
  };
}
