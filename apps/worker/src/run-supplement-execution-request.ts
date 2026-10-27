import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { readExecutionStages } from '@bondbuddy/api/run-execution';
import { readAdoptedRunSupplementExecution, readAdoptedRunSupplementFile } from '@bondbuddy/api/run-supplement-execution';
import type { RunSupplementProcessingKind } from '@bondbuddy/api/run-supplement-preparation';
import type { CapturedSupplementFilePin } from '@bondbuddy/api/run-supplement-files';
import type { StageContext } from './run-pipeline.js';
import { buildFileAuthoringRequest } from './file-authoring-request.js';
import { buildReviewFileRequest, type ReviewFileInput } from './review-file-request.js';
import { buildM4DocumentRequest } from './m4-document-request.js';
import { buildM4Method } from './m4-method.js';
import type { UnifiedInput } from './unified-input.js';
import type { M4WorkerInput } from './m4-input.js';
import type { CodexAdapterConfig } from './codex-adapter.js';

type Adopted = Awaited<ReturnType<typeof readAdoptedRunSupplementExecution>>;
type Material = { pin: { material_id: string; material_version: number; sha256: string; source_project_id?: string; role?: string };
  filename: string; objectKey?: string; mediaType?: string; object_key?: string; media_type?: string };
type LoadedInput = { manifest: Record<string, unknown>; materials: Material[] };
type Request = { buildPrompt: () => Promise<string>; prepare: (cwd: string) => Promise<void>; verifyOriginals: (cwd: string) => Promise<void> };
const conflict = () => Error('INPUT_REVISION_CONFLICT');
const same = (left: unknown, right: unknown) => inputManifestHash(left) === inputManifestHash(right);

function exactInput(ctx: StageContext, adopted: Adopted, input: LoadedInput) {
  const { basis } = adopted;
  if (ctx.lease.executionVersion !== 2 || !['production', 'non_production_test'].includes(ctx.run.channel ?? '')
    || ctx.run.channel !== adopted.source.run.channel
    || basis.candidateInputHash !== ctx.lease.inputHash || !same(input.manifest, basis.manifest)
    || inputManifestHash(input.manifest) !== ctx.lease.inputHash
    || inputManifestHash(adopted.source.checkpoint) !== basis.checkpointHash) throw conflict();
  const material = (value: Material) => ({ material_id: value.pin.material_id, material_version: value.pin.material_version,
    sha256: value.pin.sha256, source_project_id: value.pin.source_project_id ?? ctx.run.project_id,
    filename: value.filename, objectKey: value.objectKey ?? value.object_key, mediaType: value.mediaType ?? value.media_type });
  // The ordinary M1 loader can append its separately authorized prior project
  // artifact. Its immutable pin stays in manifest.authoring.previous_output;
  // it is not an extra material or a replacement for the saved clean baseline.
  const actual = input.materials.filter(value => value.pin.role !== 'project_output').map(material);
  const expected = basis.materials.map(material);
  const sorted = (values: ReturnType<typeof material>[]) => values.sort((a, b) => inputManifestHash(a).localeCompare(inputManifestHash(b)));
  if (!same(sorted(actual), sorted(expected))) throw conflict();
}

function checkedRequest<R extends Request>(request: R, checkCurrent: () => Promise<void>): R {
  // Preserve every builder field and accessor. In particular linkedSource is a
  // getter populated by prepare(), so a spread would freeze it at its old null.
  const checked = Object.create(Object.getPrototypeOf(request), Object.getOwnPropertyDescriptors(request)) as R;
  checked.buildPrompt = async () => { await checkCurrent(); return request.buildPrompt(); };
  checked.prepare = async cwd => {
    await checkCurrent(); await request.prepare(cwd); await request.verifyOriginals(cwd); await checkCurrent();
  };
  checked.verifyOriginals = async cwd => {
    await checkCurrent(); await request.verifyOriginals(cwd); await checkCurrent();
  };
  return checked;
}

async function execution<I extends LoadedInput>(ctx: StageContext, kind: RunSupplementProcessingKind, input: I,
  loadCurrent: () => Promise<I>) {
  const scope = { pool: ctx.pool, blobs: ctx.blobs, lease: ctx.lease, kind };
  const adopted = await readAdoptedRunSupplementExecution(scope);
  exactInput(ctx, adopted, input);
  const identity = { adoption: adopted.adoption.id, plan: adopted.plan.planHash, basis: adopted.basis.basisHash };
  const checkCurrent = async () => {
    const current = await readAdoptedRunSupplementExecution(scope);
    if (!same(identity, { adoption: current.adoption.id, plan: current.plan.planHash, basis: current.basis.basisHash })) throw conflict();
    const loaded = await loadCurrent();
    exactInput(ctx, current, loaded);
    if (!same(loaded, input)) throw conflict();
  };
  const priorWork = adopted.basis.priorWork;
  const continuation = priorWork ? { preparation: { ...adopted.basis, planHash: adopted.plan.planHash,
    processingPlanId: adopted.plan.id, priorWork },
    readFile: (pin: CapturedSupplementFilePin) => readAdoptedRunSupplementFile({ ...scope, pin }) } : undefined;
  return { adopted, continuation, checkCurrent };
}

/** These bundles belong to a real adopted V2 lease. Paused candidate preparers
 * remain data-only and are never substituted for the current execution gate. */
export async function adoptedFileAuthoringRequest(ctx: StageContext, input: UnifiedInput, loadCurrent: () => Promise<UnifiedInput>) {
  const saved = await execution(ctx, 'authoring', input, loadCurrent);
  const request = buildFileAuthoringRequest({ input, inputHash: ctx.lease.inputHash, blobs: ctx.blobs, continuation: saved.continuation });
  return { input, request: checkedRequest(request, saved.checkCurrent) };
}

export async function adoptedReviewFileRequest(ctx: StageContext, input: ReviewFileInput, loadCurrent: () => Promise<ReviewFileInput>,
  config?: CodexAdapterConfig) {
  const saved = await execution(ctx, 'review', input, loadCurrent);
  const request = buildReviewFileRequest({ input, inputHash: ctx.lease.inputHash, blobs: ctx.blobs, config, continuation: saved.continuation });
  return { input, request: checkedRequest(request, saved.checkCurrent) };
}

export async function adoptedM4DocumentRequest(ctx: StageContext, input: M4WorkerInput, loadCurrent: () => Promise<M4WorkerInput>,
  skill: Parameters<typeof buildM4DocumentRequest>[0]['skill'], config: CodexAdapterConfig) {
  const saved = await execution(ctx, 'm4', input, loadCurrent);
  const method = await buildM4Method('document', skill, config), methodHash = inputManifestHash(method);
  const frozen = readExecutionStages(saved.adopted.source.checkpoint, saved.adopted.basis.sourceExecution).m4_document_method;
  const prior = saved.adopted.basis.priorWork;
  if ((frozen !== undefined && !same(frozen, method))
    || (prior && (prior.metadata.method_hash !== methodHash || prior.metadata.skill_sha256 !== skill.sha256)))
    throw Error('m4_document_method_changed');
  const request = buildM4DocumentRequest({ context: { blobs: ctx.blobs, signal: ctx.signal, inputHash: ctx.lease.inputHash },
    input, skill, methodHash, continuation: saved.continuation });
  const checkCurrent = async () => {
    await saved.checkCurrent();
    if (!same(await buildM4Method('document', skill, config), method)) throw Error('m4_document_method_changed');
  };
  return { input, methodHash, request: checkedRequest(request, checkCurrent) };
}
