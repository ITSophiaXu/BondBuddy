import { mkdir, writeFile, readFile, copyFile, lstat, realpath } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, type PrivateBlobs } from '@bondbuddy/api/data';
import type { RunSupplementAuthoringPreparation } from '@bondbuddy/api/run-supplement-preparation';
import type { CapturedSupplementFilePin } from '@bondbuddy/api/run-supplement-files';
import type { UnifiedInput } from './unified-input.js';
import type { CompleteRunSupplementProcessingPreparation } from './run-supplement-processing-request.js';

const repo = resolve(fileURLToPath(import.meta.url), '../../../..');
const helpers = join(repo, 'python/bondbuddy_file_authoring');
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const AUTHORING_FILE_MAX = 100 * 1024 * 1024;

export function editingSource(input: UnifiedInput) {
  return [...input.materials].filter(m => ['project_output', 'historical', 'reference'].includes(m.pin.role)).sort((a, b) => {
    const rank = (m: typeof a) => m.pin.material_id === input.manifest.authoring.review_result?.source_material.material_id ? -2
      : m.pin.role === 'project_output' ? -1 : input.manifest.authoring.source_prospectuses.find(s => s.material_id === m.pin.material_id)?.relation === 'same_issuer' ? 0 : 1;
    return rank(a) - rank(b) || a.pin.material_id.localeCompare(b.pin.material_id);
  })[0] ?? null;
}

export async function checkedAuthoringFile(root: string, name: string, max = AUTHORING_FILE_MAX) {
  const path = join(root, name), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > max
    || await realpath(path) !== resolve(path)) throw Error('WORD_OUTPUT_UNSAFE');
  return readFile(path);
}

type Continuation = {
  preparation: RunSupplementAuthoringPreparation | CompleteRunSupplementProcessingPreparation;
  readFile: (pin: CapturedSupplementFilePin) => Promise<Buffer>;
};

/** The production stage and the internal continuation preparer use this same writer.
 * This builder has no lease, provider, result collector, billing or adoption authority. */
export function buildFileAuthoringRequest(options: {
  input: UnifiedInput; inputHash: string; blobs: PrivateBlobs; continuation?: Continuation;
}) {
  const { input, inputHash, blobs, continuation } = options;
  const source = editingSource(input);
  const priorClean = continuation?.preparation.priorWork.files.find(file => file.name === 'clean.docx');
  const reuseClean = !!continuation && !continuation.preparation.delta.discardPreviousOutput;
  if (reuseClean && !priorClean) throw Error('INPUT_REVISION_CONFLICT');
  const baselineKind = reuseClean ? 'saved_clean_work' : !source ? 'none' : source.pin.role === 'project_output'
    ? 'project_output' : source.mediaType === DOCX ? 'uploaded_source' : 'reconstructed_pdf';
  const sourceHash = reuseClean ? priorClean!.sha256 : source?.pin.sha256 ?? null;
  const originals = new Map<string, string>();
  const buildPrompt = async () => `请在切换实际处理工作时发送一条独立的用户可见进度消息，严格使用 BB_PROGRESS:read_materials、BB_PROGRESS:read_knowledge、BB_PROGRESS:analyze、BB_PROGRESS:write_document、BB_PROGRESS:check_document 或 BB_PROGRESS:prepare_download 中的相应一项，并在其后用「 | 」附上一句不超过240字的用户可见工作摘要，说明刚完成或当前处理的具体步骤。每次取得中间进展都发送一条，不包含思考过程、材料正文、命令、内部路径或密钥。请先完整阅读 task.md 和 input.json，再自主使用本次原始材料和知识文件完成整份募集书及 output/ 下的交付文件。一次执行完成，不返回全文修改 JSON，不等待逐批请求。输入锁：${inputHash}。${continuation ? `\n本次请求准备基于已保存旧工作和候选补充材料。先阅读 continuation.json 和 previous_work/，结合材料新增、替换及原稿声明变化进行新的处理；旧工作不是本次新成果，不重发或伪装旧调用。现无可靠章节依赖图，须结合完整候选材料保守复核全文，保留仍有依据的旧内容，重新处理受材料变化影响的内容，不能声称已完成章节级增量复用。${reuseClean ? '本轮实际编辑基线为 previous_work/clean.docx；新的修订稿显示相对该已保存工作稿的变化，不重建从最初上传原稿开始的完整修订历史。旧 tracked 和 baseline 仅供回查，不与本轮修订历史混用。' : '本次已明确放弃旧成果关联；previous_work/ 仅供来源回查，禁止把其中的 clean、tracked 或 baseline 用作本轮编辑基线或复制为新成果。按本次候选原稿及 baseline_path 编制。'}旧 scratch 工作记录未保留，不能假定已恢复中途章节进度。` : ''}`;

  const prepare = async (cwd: string) => {
    originals.clear();
    for (const dir of ['materials', 'knowledge', 'scratch', 'output', ...(continuation ? ['previous_work'] : [])])
      await mkdir(join(cwd, dir), { mode: 0o700 });
    const materials = [];
    for (const [i, material] of input.materials.entries()) {
      const suffix = material.mediaType === DOCX ? '.docx' : /\.(pdf|xlsx|txt|csv|png|jpg|jpeg)$/i.test(material.filename)
        ? extname(material.filename).toLowerCase() : '.bin';
      const path = `materials/m${i}${suffix}`;
      if (blobs.readToFile) {
        const received = await blobs.readToFile(material.objectKey, join(cwd, path), AUTHORING_FILE_MAX);
        if (!received || received.sha256 !== material.pin.sha256) throw Error('INPUT_REVISION_CONFLICT');
      } else {
        const bytes = await blobs.getIfExistsBounded(material.objectKey, AUTHORING_FILE_MAX);
        if (!bytes || digest(bytes) !== material.pin.sha256) throw Error('INPUT_REVISION_CONFLICT');
        await writeFile(join(cwd, path), bytes, { mode: 0o400 });
      }
      originals.set(path, material.pin.sha256);
      materials.push({ ...material.pin, filename: material.filename, path,
        source_information: input.manifest.authoring.source_prospectuses.find(s => s.material_id === material.pin.material_id) ?? null,
        editing_baseline: !reuseClean && material === source });
    }
    const knowledge = [];
    for (const [i, item] of input.manifest.authoring.knowledge.entries()) {
      if (digest(item.markdown) !== item.sha256) throw Error('INPUT_REVISION_CONFLICT');
      const path = `knowledge/k${i}.md`;
      await writeFile(join(cwd, path), item.markdown, { mode: 0o400 }); originals.set(path, item.sha256);
      knowledge.push({ ...item, markdown: undefined, local_path: path });
    }
    let continuationData: Record<string, unknown> | undefined;
    if (continuation) {
      const preparation = continuation.preparation, files = [];
      for (const pin of preparation.priorWork.files) {
        if (!['tracked.docx', 'clean.docx', 'baseline.docx', 'delivery.md'].includes(pin.name)) throw Error('INPUT_REVISION_CONFLICT');
        const bytes = await continuation.readFile(pin);
        if (bytes.length !== pin.byteSize || digest(bytes) !== pin.sha256) throw Error('INPUT_REVISION_CONFLICT');
        const path = `previous_work/${pin.name}`;
        await writeFile(join(cwd, path), bytes, { mode: 0o400 }); originals.set(path, pin.sha256);
        files.push({ ...pin, path, use: reuseClean && pin.name === 'clean.docx' ? 'editing_baseline' : 'source_reference' });
      }
      continuationData = { version: preparation.version, owner: preparation.owner, project_id: preparation.projectId,
        run_id: preparation.runId, supplement_revision: preparation.revision, request_id: preparation.requestId,
        request_hash: preparation.requestHash, source_execution: preparation.sourceExecution,
        checkpoint_hash: preparation.checkpointHash, candidate_input_hash: preparation.candidateInputHash,
        plan_hash: preparation.planHash, ...('basisHash' in preparation
          ? { basis_hash: preparation.basisHash, processing_plan_id: preparation.processingPlanId } : {}), delta: preparation.delta,
        previous_work: { source: preparation.priorWork.source, result_hash: preparation.priorWork.resultHash, files },
        processing: 'new_processing_with_full_document_review', scratch_recovery: 'not_retained',
        revision_history: reuseClean ? 'changes_from_saved_clean_only' : 'candidate_source_baseline' };
      const bytes = JSON.stringify(continuationData, null, 2);
      await writeFile(join(cwd, 'continuation.json'), bytes, { mode: 0o400 }); originals.set('continuation.json', digest(bytes));
    }
    const data = { version: 'codex-file-input-v1', revision_author: `BondBuddy-${inputHash.slice(0, 12)}`, input_hash: inputHash,
      target: { issuer_name: input.manifest.issuer_name, market: input.manifest.market, offering: input.manifest.offering, details: input.manifest.update_details },
      requirements: input.requirements, materials, knowledge, source_review: input.manifest.authoring.review_result ?? null,
      previous_output: input.manifest.authoring.previous_output ?? null,
      ...(continuationData ? { continuation: continuationData } : {}),
      baseline_path: reuseClean ? 'previous_work/clean.docx' : materials.find(material => material.editing_baseline)?.path ?? null,
      baseline_kind: baselineKind,
      output: { tracked: 'output/tracked.docx', clean: 'output/clean.docx', baseline: 'output/baseline.docx', delivery: 'output/delivery.md' } };
    const bytes = JSON.stringify(data, null, 2);
    await writeFile(join(cwd, 'input.json'), bytes, { mode: 0o400 }); originals.set('input.json', digest(bytes));
    for (const name of ['task.md', 'read_material.py', 'word_patch.py']) await copyFile(join(helpers, name), join(cwd, name));
  };
  const verifyOriginals = async (cwd: string) => {
    if (!originals.has('input.json')) throw Error('INPUT_REVISION_CONFLICT');
    for (const [path, hash] of originals) if (digest(await checkedAuthoringFile(cwd, path)) !== hash) throw Error('INPUT_REVISION_CONFLICT');
  };
  return { buildPrompt, prepare, verifyOriginals, source, baselineKind, sourceHash };
}
