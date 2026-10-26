import { loadRunSupplementAuthoringPreparation } from '@bondbuddy/api/run-supplement-preparation';
import { readCapturedSupplementFile } from '@bondbuddy/api/run-supplement-files';
import { buildFileAuthoringRequest } from './file-authoring-request.js';
import { loadUnifiedRequirements, type UnifiedManifest, type UnifiedInput } from './unified-input.js';

/** Internal preparation only. No StageContext, model call, collector, adoption,
 * execution version, queue resume or fee authority is created by this function. */
export async function prepareRunSupplementAuthoringRequest(
  input: Parameters<typeof loadRunSupplementAuthoringPreparation>[0],
) {
  const preparation = await loadRunSupplementAuthoringPreparation(input);
  const manifest = preparation.manifest as UnifiedManifest;
  const candidate: UnifiedInput = { manifest,
    materials: preparation.materials.map(material => ({ ...material, records: [] })),
    requirements: await loadUnifiedRequirements({ pool: input.db, blobs: input.blobs,
      owner: input.owner, projectId: input.projectId, manifest }) };
  const request = buildFileAuthoringRequest({ input: candidate, inputHash: preparation.candidateInputHash,
    blobs: input.blobs, continuation: { preparation,
      readFile: pin => readCapturedSupplementFile({ ...input, source: preparation.priorWork.source, pin }) } });
  const checkCurrent = async () => {
    const current = await loadRunSupplementAuthoringPreparation(input);
    if (current.planHash !== preparation.planHash) throw Error('INPUT_REVISION_CONFLICT');
    const requirements = await loadUnifiedRequirements({ pool: input.db, blobs: input.blobs,
      owner: input.owner, projectId: input.projectId, manifest });
    if (JSON.stringify(requirements) !== JSON.stringify(candidate.requirements)) throw Error('INPUT_REVISION_CONFLICT');
  };
  return { preparation: structuredClone(preparation), buildPrompt: request.buildPrompt, verifyOriginals: request.verifyOriginals,
    prepare: async (cwd: string) => {
      // Recheck on both sides of workspace I/O. A prepared workspace is still
      // data only: any future executor must separately acquire its own authority.
      await checkCurrent();
      await request.prepare(cwd);
      await request.verifyOriginals(cwd);
      await checkCurrent();
    } };
}
