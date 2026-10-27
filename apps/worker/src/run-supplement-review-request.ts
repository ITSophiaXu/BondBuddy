import { loadRunSupplementFilePreparation, type RunSupplementAuthoringPreparationInput,
  type RunSupplementFilePreparation } from '@bondbuddy/api/run-supplement-preparation';
import { readCapturedSupplementFile, type CapturedSupplementFilePin } from '@bondbuddy/api/run-supplement-files';
import { readRunExecutionInput } from '@bondbuddy/api/run-execution-input';
import { isReviewInput, reviewInputGate, type ReviewManifest } from './review-input.js';
import { buildReviewFileRequest, loadReviewSelectedFindings, type ReviewFileInput } from './review-file-request.js';
import { loadRunSupplementProcessingRequest, type PreparedRunSupplementRequest,
  type RunSupplementProcessingPreparation } from './run-supplement-processing-request.js';

/** Internal M3 preparation only. The candidate never becomes a StageContext or
 * execution input; no provider, collector, queue, adoption or fee action occurs. */
export function prepareRunSupplementReviewRequest(input: RunSupplementAuthoringPreparationInput):
  Promise<PreparedRunSupplementRequest<RunSupplementFilePreparation>>;
export function prepareRunSupplementReviewRequest(input: RunSupplementAuthoringPreparationInput,
  options: { processingPlanId: string }): Promise<PreparedRunSupplementRequest<RunSupplementProcessingPreparation>>;
export async function prepareRunSupplementReviewRequest(input: RunSupplementAuthoringPreparationInput,
  options: { processingPlanId?: string } = {}) {
  const durable = options.processingPlanId === undefined ? null
    : await loadRunSupplementProcessingRequest(input, 'review', options.processingPlanId);
  const preparation = durable?.preparation ?? await loadRunSupplementFilePreparation(input, 'review');
  const checkSource = async () => {
    const resolved = await readRunExecutionInput(input.db, input.owner, input.runId, preparation.sourceExecution);
    if (resolved.run.project_id !== input.projectId || resolved.run.task_kind !== 'review'
      || !resolved.input || !isReviewInput(resolved.input.manifest)
      || await reviewInputGate(input.db, resolved.run, resolved.input, resolved.reviewExecution, preparation.sourceExecution))
      throw Error('INPUT_REVISION_CONFLICT');
  };
  await checkSource();
  const manifest = preparation.manifest as ReviewManifest;
  const candidate: ReviewFileInput = { manifest,
    materials: preparation.materials.map(material => ({ pin: material.pin, filename: material.filename,
      media_type: material.mediaType, object_key: material.objectKey })),
    selected_findings: await loadReviewSelectedFindings(input.db, input.owner, input.projectId, manifest) };
  const priorWork = preparation.priorWork;
  const continuation = preparation.priorWork ? {
    preparation: 'basisHash' in preparation ? { ...preparation, priorWork: preparation.priorWork } : preparation,
    readFile: (pin: CapturedSupplementFilePin) => readCapturedSupplementFile({ ...input, source: priorWork!.source, pin }),
  } : undefined;
  const request = buildReviewFileRequest({ input: candidate, inputHash: preparation.candidateInputHash,
    blobs: input.blobs, continuation });
  const checkCurrent = async () => {
    if (durable) await durable.checkCurrent();
    else {
      const current = await loadRunSupplementFilePreparation(input, 'review');
      if (current.planHash !== preparation.planHash) throw Error('INPUT_REVISION_CONFLICT');
    }
    await checkSource();
    const selected = await loadReviewSelectedFindings(input.db, input.owner, input.projectId, manifest);
    if (JSON.stringify(selected) !== JSON.stringify(candidate.selected_findings)) throw Error('INPUT_REVISION_CONFLICT');
  };
  if (durable) await checkCurrent();
  return { preparation: structuredClone(preparation), ...(durable ? { processingPlan: structuredClone(durable.plan) } : {}),
    buildPrompt: request.buildPrompt, verifyOriginals: async (cwd: string) => {
      if (durable) await checkCurrent();
      await request.verifyOriginals(cwd);
      if (durable) await checkCurrent();
    },
    prepare: async (cwd: string) => {
      await checkCurrent();
      await request.prepare(cwd);
      await request.verifyOriginals(cwd);
      await checkCurrent();
    } };
}
