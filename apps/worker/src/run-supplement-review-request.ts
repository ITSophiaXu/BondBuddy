import { loadRunSupplementFilePreparation, type RunSupplementAuthoringPreparationInput } from '@bondbuddy/api/run-supplement-preparation';
import { readCapturedSupplementFile } from '@bondbuddy/api/run-supplement-files';
import { readRunExecutionInput } from '@bondbuddy/api/run-execution-input';
import { isReviewInput, reviewInputGate, type ReviewManifest } from './review-input.js';
import { buildReviewFileRequest, loadReviewSelectedFindings, type ReviewFileInput } from './review-file-request.js';

/** Internal M3 preparation only. The candidate never becomes a StageContext or
 * execution input; no provider, collector, queue, adoption or fee action occurs. */
export async function prepareRunSupplementReviewRequest(input: RunSupplementAuthoringPreparationInput) {
  const preparation = await loadRunSupplementFilePreparation(input, 'review');
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
  const request = buildReviewFileRequest({ input: candidate, inputHash: preparation.candidateInputHash,
    blobs: input.blobs, continuation: { preparation,
      readFile: pin => readCapturedSupplementFile({ ...input, source: preparation.priorWork.source, pin }) } });
  const checkCurrent = async () => {
    const current = await loadRunSupplementFilePreparation(input, 'review');
    if (current.planHash !== preparation.planHash) throw Error('INPUT_REVISION_CONFLICT');
    await checkSource();
    const selected = await loadReviewSelectedFindings(input.db, input.owner, input.projectId, manifest);
    if (JSON.stringify(selected) !== JSON.stringify(candidate.selected_findings)) throw Error('INPUT_REVISION_CONFLICT');
  };
  return { preparation: structuredClone(preparation), buildPrompt: request.buildPrompt, verifyOriginals: request.verifyOriginals,
    prepare: async (cwd: string) => {
      await checkCurrent();
      await request.prepare(cwd);
      await request.verifyOriginals(cwd);
      await checkCurrent();
    } };
}
