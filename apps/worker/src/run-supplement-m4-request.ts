import { loadRunSupplementFilePreparation, type RunSupplementAuthoringPreparationInput } from '@bondbuddy/api/run-supplement-preparation';
import { readCapturedSupplementFile } from '@bondbuddy/api/run-supplement-files';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import { buildM4DocumentRequest, loadM4DocumentSkill } from './m4-document-request.js';
import { loadM4SupplementInput } from './m4-input.js';
import { buildM4Method, m4PinnedModelGate } from './m4-method.js';

/** Service-internal preparation only. The original run is gated as itself; the
 * candidate does not acquire a lease, model call, artifact, adoption or fee. */
export async function prepareRunSupplementM4Request(input: RunSupplementAuthoringPreparationInput,
  options: {config?: ReturnType<typeof loadCodexAdapterConfig>; signal?: AbortSignal} = {}) {
  const preparation = await loadRunSupplementFilePreparation(input, 'm4');
  const config = options.config ?? loadCodexAdapterConfig();
  const load = async () => {
    const current = await loadRunSupplementFilePreparation(input, 'm4');
    if (current.planHash !== preparation.planHash) throw Error('INPUT_REVISION_CONFLICT');
    const loaded = await loadM4SupplementInput({pool: input.db, owner: input.owner, projectId: input.projectId,
      runId: input.runId, sourceExecution: current.sourceExecution, manifest: current.manifest,
      candidateInputHash: current.candidateInputHash});
    if (loaded.input.manifest.kind !== 'document') throw Error('INPUT_REVISION_CONFLICT');
    const skill = loadM4DocumentSkill(loaded.input.manifest);
    const gate = await m4PinnedModelGate({pool: input.db, owner: input.owner, runId: input.runId,
      billingMode: loaded.run.billing_mode}, config);
    const methodHash = inputManifestHash(await buildM4Method('document', skill, config));
    if (gate || current.priorWork.metadata.method_hash !== methodHash || current.priorWork.metadata.skill_sha256 !== skill.sha256)
      throw Error(gate?.reason ?? 'm4_document_method_changed');
    return {loaded, skill, methodHash};
  };
  const {loaded, skill, methodHash} = await load();
  const request = buildM4DocumentRequest({context: {blobs: input.blobs, signal: options.signal,
    inputHash: preparation.candidateInputHash}, input: loaded.input, skill, methodHash,
    continuation: {preparation, readFile: pin => readCapturedSupplementFile({...input,
      source: preparation.priorWork.source, pin})}});
  return {preparation: structuredClone(preparation), buildPrompt: request.buildPrompt, verifyOriginals: request.verifyOriginals,
    prepare: async (cwd: string) => {
      const before = await load();
      if (inputManifestHash(before.loaded.input) !== inputManifestHash(loaded.input)) throw Error('INPUT_REVISION_CONFLICT');
      await request.prepare(cwd);
      await request.verifyOriginals(cwd);
      const after = await load();
      if (inputManifestHash(after.loaded.input) !== inputManifestHash(loaded.input)) throw Error('INPUT_REVISION_CONFLICT');
    }};
}
