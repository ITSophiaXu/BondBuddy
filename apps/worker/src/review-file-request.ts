import { mkdir, writeFile, readFile, copyFile, lstat, realpath } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { isReviewReport } from '@bondbuddy/contracts';
import { digest, type PrivateBlobs } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { findReviewExecutionReport } from '@bondbuddy/api/review-report-execution';
import type { RunSupplementFilePreparation } from '@bondbuddy/api/run-supplement-preparation';
import type { CapturedSupplementFilePin } from '@bondbuddy/api/run-supplement-files';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import type { ReviewManifest } from './review-input.js';

const root = resolve(fileURLToPath(import.meta.url), '../../../..');
const helpers = join(root, 'python/bondbuddy_file_authoring');
const MAX = 100 * 1024 * 1024;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
type Material = { pin: ReviewManifest['materials'][number]; object_key: string; media_type: string; filename: string };
export type ReviewFileInput = { manifest: ReviewManifest; materials: Material[]; selected_findings: unknown[] };

export async function loadReviewSelectedFindings(pool: Pool, owner: string, projectId: string, manifest: ReviewManifest): Promise<unknown[]> {
  if (!manifest.review.source_report_id) return [];
  const source = await findReviewExecutionReport(pool, owner, projectId, manifest.review.source_report_id);
  if (!source || !isReviewReport(source.report) || source.content_sha256.trim() !== manifest.review.source_report_sha256
    || inputManifestHash(source.report) !== manifest.review.source_report_sha256
    || manifest.review.finding_ids.some(id => !source.report.findings.some((f: { finding_id: string }) => f.finding_id === id))) throw Error('INPUT_REVISION_CONFLICT');
  return source.report.findings.filter((f: { finding_id: string }) => manifest.review.finding_ids.includes(f.finding_id));
}

export async function checkedReviewFile(directory: string, name: string, max = MAX): Promise<Buffer> {
  const path = resolve(directory, name), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > max || await realpath(path) !== path) throw Error('REVIEW_OUTPUT_UNSAFE');
  return readFile(path);
}

type Continuation = { preparation: RunSupplementFilePreparation; readFile: (pin: CapturedSupplementFilePin) => Promise<Buffer> };

/** Shared by the production M3 stage and its internal supplement preparer.
 * This writer has no model, lease, collector, adoption or billing authority. */
export function buildReviewFileRequest(options: {
  input: ReviewFileInput; inputHash: string; blobs: PrivateBlobs;
  config?: ReturnType<typeof loadCodexAdapterConfig>; continuation?: Continuation;
}) {
  const { input, inputHash, blobs, continuation } = options, { manifest } = input;
  const correction = manifest.review.file_delivery?.version === 'review-correction-v2';
  if (continuation && (continuation.preparation.kind !== 'review'
    || continuation.preparation.priorWork.source.resultSchemaVersion !== 'codex-review-file-v1'
    || !['full_review', 'differential_review'].includes(manifest.review.operation)
    || manifest.review.origin?.accepted_proposal || Object.hasOwn(manifest.review.file_delivery!, 'export')))
    throw Error('INPUT_REVISION_CONFLICT');
  const originals = new Map<string, string>();
  const buildPrompt = async () => `请完整阅读 review.md 和 input.json，在本轮中自主完成复核，把完整报告写入 output/report.md 与 output/report.docx，并检查文件已保存。每个问题以三级标题列出，原文披露字段逐字引用待复核源稿；系统将据此生成原生修订和批注。即使没有发现问题，也须在报告中说明实际覆盖范围、核验结论和未覆盖内容。返回文件，不输出固定JSON，不等待分批请求。输入锁：${inputHash}。

进度消息仅用于中途通知，不是最终成果：切换实际复核工作时，在 commentary 中独立发送 BB_REVIEW_PROGRESS:类别:状态，随后继续工作，不要在进度消息后结束本轮。类别限 read_materials、read_knowledge、check_financial、check_compliance、search_public、compare_sources、prepare_report；状态限 started、completed、failed。进度消息只报告实际动作，不附带思考过程、正文或路径。完整报告写入文件后才发送 final，简述成果及限制。${continuation ? '\n本次请求准备基于已保存旧报告与候选补充材料。先阅读 continuation.json 和 previous_work/，按其中的新增、替换及原稿变化，结合完整候选材料重新核对报告。严格保持 input.json 中的待复核源稿、operation 和 selected_findings 范围；旧报告只作来源参考，不是新报告、已核事实或自动接受的问题。所有拟保留的问题及核验结论都须按候选材料重新核实，重新核对引用、适用条件和未覆盖范围，受变化影响或缺乏依据的内容必须重新处理。不得把旧报告或旧批注复制为本次新成果，不得把旧问题自动加入 selected_findings 或扩大复核范围。现无可靠问题或章节依赖图，不能声称已完成精确增量复核；旧 scratch 工作记录未保留，不能声称恢复未保存的复核进度。新的报告和批注只写入 output/。' : ''}`;
  const prepare = async (cwd: string) => {
    for (const dir of ['materials', 'knowledge', 'scratch', 'output', ...(continuation ? ['previous_work'] : [])]) await mkdir(join(cwd, dir), { mode: 0o700 });
    const materials = [];
    for (const [index, material] of input.materials.entries()) {
      const suffix = material.media_type === DOCX ? '.docx' : material.media_type === 'application/pdf' ? '.pdf' : /\.(pdf|xlsx|txt|csv|png|jpg|jpeg)$/i.test(material.filename) ? extname(material.filename).toLowerCase() : '.bin';
      const path = `materials/m${index}${suffix}`;
      if (blobs.readToFile) {
        const stored = await blobs.readToFile(material.object_key, join(cwd, path), MAX);
        if (!stored || stored.sha256 !== material.pin.sha256) throw Error('INPUT_REVISION_CONFLICT');
      } else {
        const bytes = await blobs.getIfExistsBounded(material.object_key, MAX);
        if (!bytes || digest(bytes) !== material.pin.sha256) throw Error('INPUT_REVISION_CONFLICT');
        await writeFile(join(cwd, path), bytes, { mode: 0o400 });
      }
      originals.set(path, material.pin.sha256);
      const source = manifest.review.input.source_material_ref!;
      materials.push({ ...material.pin, path, filename: material.filename, review_source: material.pin.material_id === source.material_id && material.pin.material_version === source.material_version && material.pin.sha256 === source.sha256 });
    }
    const knowledge = [];
    for (const [index, item] of manifest.review.file_delivery!.knowledge.entries()) {
      if (digest(item.markdown) !== item.sha256) throw Error('INPUT_REVISION_CONFLICT');
      const path = `knowledge/k${index}.md`;
      await writeFile(join(cwd, path), item.markdown, { mode: 0o400 }); originals.set(path, item.sha256);
      knowledge.push({ source: item.path, path, sha256: item.sha256 });
    }
    let continuationData: Record<string, unknown> | undefined;
    if (continuation) {
      const preparation = continuation.preparation, files = [];
      if (!preparation.priorWork.files.some(pin => pin.name === 'report.docx')) throw Error('INPUT_REVISION_CONFLICT');
      for (const pin of preparation.priorWork.files) {
        if (!['report.docx', 'model-report.docx', 'report.md', 'final-response.md', 'comments.docx', 'comments.pdf', 'annotations.json', 'revision.docx', 'clean.docx', 'baseline.docx', 'editor.json'].includes(pin.name)) throw Error('INPUT_REVISION_CONFLICT');
        const bytes = await continuation.readFile(pin);
        if (bytes.length !== pin.byteSize || digest(bytes) !== pin.sha256) throw Error('INPUT_REVISION_CONFLICT');
        const path = `previous_work/${pin.name}`;
        await writeFile(join(cwd, path), bytes, { mode: 0o400 }); originals.set(path, pin.sha256);
        files.push({ ...pin, path, use: 'source_reference' });
      }
      continuationData = { version: preparation.version, kind: preparation.kind, owner: preparation.owner,
        project_id: preparation.projectId, run_id: preparation.runId, supplement_revision: preparation.revision,
        request_id: preparation.requestId, request_hash: preparation.requestHash, source_execution: preparation.sourceExecution,
        checkpoint_hash: preparation.checkpointHash, candidate_input_hash: preparation.candidateInputHash,
        plan_hash: preparation.planHash, delta: preparation.delta,
        previous_work: { source: preparation.priorWork.source, result_hash: preparation.priorWork.resultHash, files,
          metadata: preparation.priorWork.metadata, status: 'unverified_reference' },
        processing: 'new_review_with_full_candidate_material_recheck', scratch_recovery: 'not_retained' };
      const bytes = JSON.stringify(continuationData, null, 2);
      await writeFile(join(cwd, 'continuation.json'), bytes, { mode: 0o400 }); originals.set('continuation.json', digest(bytes));
    }
    const data = { version: 'review-file-input-v1', input_hash: inputHash,
      project: { issuer_name: manifest.issuer_name, market: manifest.market, offering: manifest.offering },
      requirements: manifest.review.input.requirements, as_of: manifest.review.input.as_of,
      scope: { operation: manifest.review.operation, selected_findings: input.selected_findings, source_report_id: manifest.review.source_report_id },
      materials, knowledge, public_search: (options.config ?? loadCodexAdapterConfig()).web_search,
      ...(continuationData ? { continuation: continuationData } : {}),
      output: { report: 'output/report.docx', text: 'output/report.md' } };
    await writeFile(join(cwd, 'input.json'), JSON.stringify(data, null, 2), { mode: 0o400 });
    originals.set('input.json', digest(await readFile(join(cwd, 'input.json'))));
    for (const name of ['review.md', 'read_material.py', 'report_from_text.py']) await copyFile(join(helpers, name), join(cwd, name));
    if (correction) await copyFile(join(helpers, 'review-correction.md'), join(cwd, 'review.md'));
  };
  const verifyOriginals = async (cwd: string) => {
    for (const [path, sha] of originals) if (digest(await checkedReviewFile(cwd, path)) !== sha) throw Error('INPUT_REVISION_CONFLICT');
  };
  return { buildPrompt, prepare, verifyOriginals };
}
