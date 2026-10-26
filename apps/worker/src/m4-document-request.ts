import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { M4DocumentManifest, ProjectFileText } from '@bondbuddy/contracts';
import { digest } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import type { RunSupplementFilePreparation } from '@bondbuddy/api/run-supplement-preparation';
import type { CapturedSupplementFilePin } from '@bondbuddy/api/run-supplement-files';
import { loadM4RuntimeSkill } from './m4-runtime-skills.js';
import { checkedM4File, prepareM4Files, verifyM4Originals, type M4FilePreparationContext } from './m4-file-workspace.js';
import type { M4WorkerInput } from './m4-input.js';
import { prepareProjectFileSource } from './project-file-tools.js';
import type { CompleteRunSupplementProcessingPreparation } from './run-supplement-processing-request.js';

export function loadM4DocumentSkill(manifest: M4DocumentManifest) {
  return loadM4RuntimeSkill(manifest.input.project_file ? 'm4-project-file' : ({init:'m4-init-report',underwriter:'m4-underwriter',
    legal:'m4-legal',private_summary:'m4-private-summary',application:'m4-application',recommendation:'m4-recommendation',
    annual:'m4-project-file',semiannual:'m4-project-file',issuer:'m4-project-file',financial:'m4-project-file',
    credit:'m4-project-file',proceeds:'m4-project-file'} as const)[manifest.input.document_type]);
}

/** Production document stage and service-internal supplement preparation share
 * this actual prompt and workspace writer. No model/collector or fee authority. */
export function buildM4DocumentRequest(options: {context: M4FilePreparationContext; input: M4WorkerInput;
  skill: ReturnType<typeof loadM4RuntimeSkill>; methodHash: string;
  continuation?: {preparation: RunSupplementFilePreparation | CompleteRunSupplementProcessingPreparation;
    readFile: (pin: CapturedSupplementFilePin) => Promise<Buffer>}}) {
  const {context, input, skill, methodHash, continuation} = options;
  if (input.manifest.kind !== 'document') throw Error('INPUT_REVISION_CONFLICT');
  let originals = new Map<string, string>(), linkedSource: ProjectFileText | null = null;
  const buildPrompt = async () => `${skill.content}\n\n完整阅读 input.json 及 knowledge 指定的对应市场编制知识 MD；存在 template_path 时从该固定 Word 模板复制正文并按其章节字体填写，使用 render_template.py 填充内容槽位或保留格式扩展章节、表格，禁止凭空另建通用样式，按准确来源、模板、用户要求和底稿一次编制完整文书与独立编制说明。必须写出两份真实Word，不能以聊天文字冒充成果。固定方法：${methodHash}。在读取材料、分析、编制正文和保存文件等实际操作切换时，简短报告用户可见进度，格式为 BB_PROGRESS:read_materials|正在核对本次材料。可用类型 read_materials、read_knowledge、analyze、write_document、check_document、prepare_download。只描述实际发生的工作，不写命令、路径、内部标识或推理内容。${continuation ? '\n本次为补料后的请求准备。完整阅读 continuation.json 与 previous_work/ 中已保存的文书和编制说明，按材料新增、替换和未变清单重新处理并保守复核全文；旧工作可能含已过期事实，仅作为来源回查和工作参考，不等于本轮新成果。原任务的主文档、模板、正式 edit_base、知识及固定方法保持明确，禁止把旧工作伪装成新的授权底稿、材料或成果，不得直接重发旧文件。仍有依据的内容可以保留，受补料影响的内容必须重新编制。未保留 scratch，不能声称恢复任意中途章节或已完成章节级增量复用。' : ''}`;
  const prepare = async (cwd: string) => {
    const priorOriginals = new Map<string, string>();
    let continuationData: Record<string, unknown> | undefined;
    if (continuation) {
      const p = continuation.preparation;
      if (p.kind !== 'm4' || p.priorWork.source.resultSchemaVersion !== 'codex-m4-document-v1'
        || !['document.docx', 'preparation-note.docx'].every(name => p.priorWork.files.some(file => file.name === name)))
        throw Error('INPUT_REVISION_CONFLICT');
      await mkdir(join(cwd, 'previous_work'), {mode: 0o700});
      const files = [];
      for (const pin of p.priorWork.files) {
        if (!['document.docx', 'preparation-note.docx'].includes(pin.name)) throw Error('INPUT_REVISION_CONFLICT');
        const bytes = await continuation.readFile(pin);
        if (bytes.length !== pin.byteSize || digest(bytes) !== pin.sha256) throw Error('INPUT_REVISION_CONFLICT');
        const path = `previous_work/${pin.name}`;
        await writeFile(join(cwd, path), bytes, {mode: 0o400}); priorOriginals.set(path, pin.sha256);
        files.push({...pin, path, use: 'source_reference'});
      }
      continuationData = {version: p.version, kind: p.kind, owner: p.owner, project_id: p.projectId, run_id: p.runId,
        supplement_revision: p.revision, request_id: p.requestId, request_hash: p.requestHash,
        source_execution: p.sourceExecution, checkpoint_hash: p.checkpointHash, candidate_input_hash: p.candidateInputHash,
        plan_hash: p.planHash, ...('basisHash' in p ? {basis_hash: p.basisHash, processing_plan_id: p.processingPlanId} : {}),
        delta: p.delta, previous_work: {source: p.priorWork.source,
          result_hash: p.priorWork.resultHash, metadata: p.priorWork.metadata, files},
        processing: 'new_processing_with_full_document_review', scratch_recovery: 'not_retained'};
      const bytes = JSON.stringify(continuationData, null, 2);
      await writeFile(join(cwd, 'continuation.json'), bytes, {mode: 0o400}); priorOriginals.set('continuation.json', digest(bytes));
    }
    originals = await prepareM4Files(context, input, skill, cwd, undefined, continuationData);
    for (const [path, hash] of priorOriginals) originals.set(path, hash);
    linkedSource = await prepareProjectFileSource(context, input, cwd);
    if (linkedSource) {
      originals.set('source-spans.json', digest(await checkedM4File(cwd, 'source-spans.json', 32 * 1024 * 1024)));
      const sourcePin = (input.manifest as M4DocumentManifest).input.source_material;
      const source = input.materials.find(file => inputManifestHash(file.pin) === inputManifestHash(sourcePin))!;
      const path = `scratch/association-source.${source.mediaType === 'application/pdf' ? 'pdf' : 'docx'}`;
      originals.set(path, digest(await checkedM4File(cwd, path)));
    }
  };
  return {buildPrompt, prepare, verifyOriginals: async (cwd: string) => {
    if (!originals.has('input.json')) throw Error('INPUT_REVISION_CONFLICT');
    await verifyM4Originals(cwd, originals);
  }, get linkedSource() {return linkedSource;}};
}
