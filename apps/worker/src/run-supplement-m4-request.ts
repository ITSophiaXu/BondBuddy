import { loadRunSupplementFilePreparation, type RunSupplementAuthoringPreparationInput,
  type RunSupplementFilePreparation } from '@bondbuddy/api/run-supplement-preparation';
import { readCapturedSupplementFile, type CapturedSupplementFilePin } from '@bondbuddy/api/run-supplement-files';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { readExecutionStages } from '@bondbuddy/api/run-execution';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import { buildM4DocumentRequest, loadM4DocumentSkill } from './m4-document-request.js';
import { loadM4SupplementInput } from './m4-input.js';
import { buildM4Method, m4PinnedModelGate } from './m4-method.js';
import { loadRunSupplementProcessingRequest, type PreparedRunSupplementRequest,
  type RunSupplementProcessingPreparation } from './run-supplement-processing-request.js';

type Options = { config?: ReturnType<typeof loadCodexAdapterConfig>; signal?: AbortSignal };

/** Service-internal preparation only. The original run is gated as itself; the
 * candidate does not acquire a lease, model call, artifact, adoption or fee. */
export function prepareRunSupplementM4Request(input: RunSupplementAuthoringPreparationInput,
  options: Options & { processingPlanId: string }): Promise<PreparedRunSupplementRequest<RunSupplementProcessingPreparation>>;
export function prepareRunSupplementM4Request(input: RunSupplementAuthoringPreparationInput, options?: Options):
  Promise<PreparedRunSupplementRequest<RunSupplementFilePreparation>>;
export async function prepareRunSupplementM4Request(input: RunSupplementAuthoringPreparationInput,
  options: Options & { processingPlanId?: string } = {}) {
  const durable = options.processingPlanId === undefined ? null
    : await loadRunSupplementProcessingRequest(input, 'm4', options.processingPlanId);
  const preparation = durable?.preparation ?? await loadRunSupplementFilePreparation(input, 'm4');
  const config = options.config ?? loadCodexAdapterConfig();
  const load = async () => {
    const current = durable ? await durable.checkCurrent() : await loadRunSupplementFilePreparation(input, 'm4');
    if (!durable && 'planHash' in current && current.planHash !== preparation.planHash) throw Error('INPUT_REVISION_CONFLICT');
    const loaded = await loadM4SupplementInput({pool: input.db, owner: input.owner, projectId: input.projectId,
      runId: input.runId, sourceExecution: current.sourceExecution, manifest: current.manifest,
      candidateInputHash: current.candidateInputHash});
    if (loaded.input.manifest.kind !== 'document') throw Error('INPUT_REVISION_CONFLICT');
    const skill = loadM4DocumentSkill(loaded.input.manifest);
    const gate = await m4PinnedModelGate({pool: input.db, owner: input.owner, runId: input.runId,
      execution: current.sourceExecution}, config);
    const methodHash = inputManifestHash(await buildM4Method('document', skill, config));
    if (gate || current.priorWork && (current.priorWork.metadata.method_hash !== methodHash
      || current.priorWork.metadata.skill_sha256 !== skill.sha256))
      throw Error(gate?.reason ?? 'm4_document_method_changed');
    if (durable) {
      // Even with zero provider attempts, a previously saved method remains
      // binding. No-prior-work is not permission to choose another model.
      const row = (await input.db.query('SELECT checkpoint FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2',
        [input.owner, input.runId])).rows[0];
      if (!row || inputManifestHash(row.checkpoint) !== current.checkpointHash) throw Error('INPUT_REVISION_CONFLICT');
      const savedMethod = readExecutionStages(row.checkpoint, current.sourceExecution).m4_document_method;
      if (savedMethod && inputManifestHash(savedMethod) !== methodHash) throw Error('m4_document_method_changed');
      await durable.checkCurrent();
    }
    return {loaded, skill, methodHash};
  };
  const {loaded, skill, methodHash} = await load();
  const priorWork = preparation.priorWork;
  const continuation = preparation.priorWork ? {
    preparation: 'basisHash' in preparation ? { ...preparation, priorWork: preparation.priorWork } : preparation,
    readFile: (pin: CapturedSupplementFilePin) => readCapturedSupplementFile({ ...input, source: priorWork!.source, pin }),
  } : undefined;
  const request = buildM4DocumentRequest({context: {blobs: input.blobs, signal: options.signal,
    inputHash: preparation.candidateInputHash}, input: loaded.input, skill, methodHash, continuation});
  return {preparation: structuredClone(preparation), ...(durable ? { processingPlan: structuredClone(durable.plan) } : {}),
    buildPrompt: request.buildPrompt, verifyOriginals: async (cwd: string) => {
      if (durable) await load();
      await request.verifyOriginals(cwd);
      if (durable) await load();
    },
    prepare: async (cwd: string) => {
      const before = await load();
      if (inputManifestHash(before.loaded.input) !== inputManifestHash(loaded.input)) throw Error('INPUT_REVISION_CONFLICT');
      await request.prepare(cwd);
      await request.verifyOriginals(cwd);
      const after = await load();
      if (inputManifestHash(after.loaded.input) !== inputManifestHash(loaded.input)) throw Error('INPUT_REVISION_CONFLICT');
    }};
}
