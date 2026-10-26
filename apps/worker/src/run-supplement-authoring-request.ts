import { loadRunSupplementAuthoringPreparation, type RunSupplementAuthoringPreparation,
  type RunSupplementAuthoringPreparationInput } from '@bondbuddy/api/run-supplement-preparation';
import { readCapturedSupplementFile, type CapturedSupplementFilePin } from '@bondbuddy/api/run-supplement-files';
import { buildFileAuthoringRequest } from './file-authoring-request.js';
import { loadUnifiedRequirements, type UnifiedManifest, type UnifiedInput } from './unified-input.js';
import { loadRunSupplementProcessingRequest, type PreparedRunSupplementRequest,
  type RunSupplementProcessingPreparation } from './run-supplement-processing-request.js';

/** Internal preparation only. No StageContext, model call, collector, adoption,
 * execution version, queue resume or fee authority is created by this function. */
export function prepareRunSupplementAuthoringRequest(input: RunSupplementAuthoringPreparationInput):
  Promise<PreparedRunSupplementRequest<RunSupplementAuthoringPreparation>>;
export function prepareRunSupplementAuthoringRequest(input: RunSupplementAuthoringPreparationInput,
  options: { processingPlanId: string }): Promise<PreparedRunSupplementRequest<RunSupplementProcessingPreparation>>;
export async function prepareRunSupplementAuthoringRequest(input: RunSupplementAuthoringPreparationInput,
  options: { processingPlanId?: string } = {}) {
  const durable = options.processingPlanId === undefined ? null
    : await loadRunSupplementProcessingRequest(input, 'authoring', options.processingPlanId);
  const preparation = durable?.preparation ?? await loadRunSupplementAuthoringPreparation(input);
  const manifest = preparation.manifest as UnifiedManifest;
  const candidate: UnifiedInput = { manifest,
    materials: preparation.materials.map(material => ({ ...material, records: [] })),
    requirements: await loadUnifiedRequirements({ pool: input.db, blobs: input.blobs,
      owner: input.owner, projectId: input.projectId, manifest }) };
  const priorWork = preparation.priorWork;
  const continuation = preparation.priorWork ? {
    preparation: 'basisHash' in preparation ? { ...preparation, priorWork: preparation.priorWork } : preparation,
    readFile: (pin: CapturedSupplementFilePin) => readCapturedSupplementFile({ ...input, source: priorWork!.source, pin }),
  } : undefined;
  const request = buildFileAuthoringRequest({ input: candidate, inputHash: preparation.candidateInputHash,
    blobs: input.blobs, continuation });
  const checkCurrent = async () => {
    if (durable) await durable.checkCurrent();
    else {
      const current = await loadRunSupplementAuthoringPreparation(input);
      if (current.planHash !== preparation.planHash) throw Error('INPUT_REVISION_CONFLICT');
    }
    const requirements = await loadUnifiedRequirements({ pool: input.db, blobs: input.blobs,
      owner: input.owner, projectId: input.projectId, manifest });
    if (JSON.stringify(requirements) !== JSON.stringify(candidate.requirements)) throw Error('INPUT_REVISION_CONFLICT');
  };
  // The initial private requirement read is also checked against the same plan.
  if (durable) await checkCurrent();
  return { preparation: structuredClone(preparation), ...(durable ? { processingPlan: structuredClone(durable.plan) } : {}),
    buildPrompt: request.buildPrompt, verifyOriginals: async (cwd: string) => {
      if (durable) await checkCurrent();
      await request.verifyOriginals(cwd);
      if (durable) await checkCurrent();
    },
    prepare: async (cwd: string) => {
      // Recheck on both sides of workspace I/O. A prepared workspace is still
      // data only: any future executor must separately acquire its own authority.
      await checkCurrent();
      await request.prepare(cwd);
      await request.verifyOriginals(cwd);
      await checkCurrent();
    } };
}
