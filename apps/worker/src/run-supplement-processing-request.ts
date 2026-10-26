import type { RunSupplementProcessingBasis, RunSupplementProcessingBasisInput, RunSupplementProcessingKind } from '@bondbuddy/api/run-supplement-preparation';
import { readRunSupplementProcessingPlan } from '@bondbuddy/api/run-supplement-processing-plan';

export type RunSupplementProcessingPlan = Awaited<ReturnType<typeof readRunSupplementProcessingPlan>>['plan'];
export type RunSupplementProcessingPreparation = RunSupplementProcessingBasis & { planHash: string; processingPlanId: string };
export type CompleteRunSupplementProcessingPreparation = RunSupplementProcessingPreparation & {
  priorWork: NonNullable<RunSupplementProcessingBasis['priorWork']>;
};
export type PreparedRunSupplementRequest<P> = {
  preparation: P;
  processingPlan?: RunSupplementProcessingPlan;
  buildPrompt: () => Promise<string>;
  verifyOriginals: (cwd: string) => Promise<void>;
  prepare: (cwd: string) => Promise<void>;
};

/** A durable plan remains preparation data. Every read revalidates its exact
 * basis at the real paused boundary; this does not grant an execution lease. */
export async function loadRunSupplementProcessingRequest(input: RunSupplementProcessingBasisInput,
  kind: RunSupplementProcessingKind, planId: string) {
  if (!planId) throw Error('INPUT_REVISION_CONFLICT');
  const saved = await readRunSupplementProcessingPlan({ ...input, kind, planId });
  const preparation: RunSupplementProcessingPreparation = { ...saved.basis,
    planHash: saved.plan.planHash, processingPlanId: saved.plan.id };
  const checkCurrent = async () => {
    const current = await readRunSupplementProcessingPlan({ ...input, kind, planId });
    if (current.plan.id !== saved.plan.id || current.plan.planHash !== saved.plan.planHash
      || current.plan.basisHash !== saved.plan.basisHash || current.basis.basisHash !== saved.basis.basisHash)
      throw Error('INPUT_REVISION_CONFLICT');
    return current.basis;
  };
  return { plan: saved.plan, preparation, checkCurrent };
}
