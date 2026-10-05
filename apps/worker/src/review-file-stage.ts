import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, readFile, copyFile, lstat, realpath } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isReviewReport } from '@bondbuddy/contracts';
import { digest } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { isReviewInput, reviewInputGate, type ReviewManifest } from './review-input.js';
import { codexModelStage, type RunStage, type StageContext } from './run-pipeline.js';
import { loadCodexAdapterConfig } from './codex-adapter.js';

const root = resolve(fileURLToPath(import.meta.url), '../../../..');
const helpers = join(root, 'python/bondbuddy_file_authoring');
const runFile = promisify(execFile);
const MAX = 100 * 1024 * 1024, TEXT_MAX = 4 * 1024 * 1024;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
type FileRef = { key: string; sha256: string; byte_size: number };
export type ReviewFileResult = { version: 'codex-review-file-v1'; input_hash: string; files: Record<string, FileRef>; error?: 'WORD_DELIVERY_UNAVAILABLE' };
type Material = { pin: ReviewManifest['materials'][number]; object_key: string; media_type: string; filename: string };
export type ReviewFileInput = { manifest: ReviewManifest; materials: Material[]; selected_findings: unknown[] };
const prefix = (ctx: StageContext) => `owners/${ctx.run.owner_user_id}/projects/${ctx.run.project_id}/runs/${ctx.run.id}/review-files/`;

export function validReviewFileResult(value: unknown, ctx: StageContext): value is ReviewFileResult {
  const result = value as ReviewFileResult | null;
  return !!result && result.version === 'codex-review-file-v1' && result.input_hash === ctx.run.input_hash.trim()
    && !!result.files && Object.entries(result.files).every(([name, file]) => ['report.docx', 'report.md', 'final-response.md'].includes(name)
      && file.key.startsWith(prefix(ctx)) && !file.key.includes('..') && file.key.endsWith(`/${file.sha256}/${name}`)
      && /^[a-f0-9]{64}$/.test(file.sha256) && Number.isSafeInteger(file.byte_size) && file.byte_size > 0 && file.byte_size <= MAX)
    && (result.error === 'WORD_DELIVERY_UNAVAILABLE' || !!result.files['report.docx']);
}

export async function loadReviewFileInput(ctx: StageContext): Promise<ReviewFileInput> {
  const row = (await ctx.pool.query('SELECT * FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
    [ctx.run.owner_user_id, ctx.run.project_id, ctx.run.input_revision])).rows[0];
  if (!row || !isReviewInput(row.manifest) || await reviewInputGate(ctx.pool, ctx.run, row)) throw Error('INPUT_REVISION_CONFLICT');
  const manifest = row.manifest as ReviewManifest;
  if (manifest.review.file_delivery?.version !== 'review-file-v1' || manifest.review.operation === 'revision'
    || !Array.isArray(manifest.review.file_delivery.knowledge)
    || manifest.review.file_delivery.knowledge.some(k => typeof k.markdown !== 'string' || digest(k.markdown) !== k.sha256)) throw Error('INPUT_REVISION_CONFLICT');
  const materials: Material[] = [];
  for (const pin of manifest.materials) {
    const material = (await ctx.pool.query('SELECT object_key,media_type,filename,sha256 FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL',
      [ctx.run.owner_user_id, ctx.run.project_id, pin.material_id, pin.material_version])).rows[0];
    if (!material || material.sha256.trim() !== pin.sha256) throw Error('INPUT_REVISION_CONFLICT');
    materials.push({ pin, object_key: material.object_key, media_type: material.media_type, filename: material.filename });
  }
  let selected_findings: unknown[] = [];
  if (manifest.review.source_report_id) {
    const source = (await ctx.pool.query('SELECT report,content_sha256 FROM bb_review_reports WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',
      [ctx.run.owner_user_id, ctx.run.project_id, manifest.review.source_report_id])).rows[0];
    if (!source || !isReviewReport(source.report) || source.content_sha256.trim() !== manifest.review.source_report_sha256
      || inputManifestHash(source.report) !== manifest.review.source_report_sha256
      || manifest.review.finding_ids.some(id => !source.report.findings.some((f: { finding_id: string }) => f.finding_id === id))) throw Error('INPUT_REVISION_CONFLICT');
    selected_findings = source.report.findings.filter((f: { finding_id: string }) => manifest.review.finding_ids.includes(f.finding_id));
  }
  return { manifest, materials, selected_findings };
}

async function checkedFile(directory: string, name: string, max = MAX): Promise<Buffer> {
  const path = resolve(directory, name), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > max || await realpath(path) !== path) throw Error('REVIEW_OUTPUT_UNSAFE');
  return readFile(path);
}

export function reviewFileStage(options: { model?: typeof codexModelStage; load?: typeof loadReviewFileInput; config?: ReturnType<typeof loadCodexAdapterConfig> } = {}): RunStage {
  return { name: 'model_generation', replay: true, run: async ctx => {
    const input = await (options.load ?? loadReviewFileInput)(ctx), { manifest } = input;
    const originals = new Map<string, string>();
    const prepare = async (cwd: string) => {
      for (const dir of ['materials', 'knowledge', 'scratch', 'output']) await mkdir(join(cwd, dir), { mode: 0o700 });
      const materials = [];
      for (const [index, material] of input.materials.entries()) {
        const suffix = material.media_type === DOCX ? '.docx' : /\.(pdf|xlsx|txt|csv|png|jpg|jpeg)$/i.test(material.filename) ? extname(material.filename).toLowerCase() : '.bin';
        const path = `materials/m${index}${suffix}`;
        if (ctx.blobs.readToFile) {
          const stored = await ctx.blobs.readToFile(material.object_key, join(cwd, path), MAX);
          if (!stored || stored.sha256 !== material.pin.sha256) throw Error('INPUT_REVISION_CONFLICT');
        } else {
          const bytes = await ctx.blobs.getIfExistsBounded(material.object_key, MAX);
          if (!bytes || digest(bytes) !== material.pin.sha256) throw Error('INPUT_REVISION_CONFLICT');
          await writeFile(join(cwd, path), bytes, { mode: 0o400 });
        }
        originals.set(path, material.pin.sha256);
        materials.push({ ...material.pin, path, filename: material.filename, review_source: material.pin.material_id === manifest.review.input.source_material_ref!.material_id });
      }
      const knowledge = [];
      for (const [index, item] of manifest.review.file_delivery!.knowledge.entries()) {
        if (digest(item.markdown) !== item.sha256) throw Error('INPUT_REVISION_CONFLICT');
        const path = `knowledge/k${index}.md`;
        await writeFile(join(cwd, path), item.markdown, { mode: 0o400 }); originals.set(path, item.sha256);
        knowledge.push({ source: item.path, path, sha256: item.sha256 });
      }
      const data = { version: 'review-file-input-v1', input_hash: ctx.run.input_hash.trim(),
        project: { issuer_name: manifest.issuer_name, market: manifest.market, offering: manifest.offering },
        requirements: manifest.review.input.requirements, as_of: manifest.review.input.as_of,
        scope: { operation: manifest.review.operation, selected_findings: input.selected_findings, source_report_id: manifest.review.source_report_id },
        materials, knowledge, public_search: (options.config ?? loadCodexAdapterConfig()).web_search,
        output: { report: 'output/report.docx', text: 'output/report.md' } };
      await writeFile(join(cwd, 'input.json'), JSON.stringify(data, null, 2), { mode: 0o400 });
      originals.set('input.json', digest(await readFile(join(cwd, 'input.json'))));
      for (const name of ['review.md', 'read_material.py', 'report_from_text.py']) await copyFile(join(helpers, name), join(cwd, name));
    };
    const collect = async (cwd: string, intent: { call_id: string }, response: { text: string } = { text: '' }): Promise<ReviewFileResult> => {
      for (const [path, sha] of originals) if (digest(await checkedFile(cwd, path)) !== sha) throw Error('INPUT_REVISION_CONFLICT');
      const files: Record<string, FileRef> = {}, output = join(cwd, 'output');
      const retain = async (name: string, bytes: Buffer) => {
        if (!bytes.length || bytes.length > (name.endsWith('.docx') ? MAX : TEXT_MAX)) return;
        const sha256 = digest(bytes), key = `${prefix(ctx)}${intent.call_id}/${sha256}/${name}`;
        await ctx.blobs.put(key, bytes, name.endsWith('.docx') ? DOCX : 'text/markdown');
        const stored = await ctx.blobs.getIfExistsBounded(key, MAX);
        if (!stored || digest(stored) !== sha256) throw Error('REVIEW_OUTPUT_STORE_FAILED');
        files[name] = { key, sha256, byte_size: bytes.length };
      };
      // Preserve the actual final response before any format conversion. Never publish it to logs.
      if (response.text.trim()) await retain('final-response.md', Buffer.from(response.text));
      let reportText: Buffer | undefined, word: Buffer | undefined;
      try { reportText = await checkedFile(output, 'report.md', TEXT_MAX); } catch { /* Optional text companion. */ }
      if (reportText) await retain('report.md', reportText);
      try { word = await checkedFile(output, 'report.docx'); } catch { /* Plain CLI responses can still be exported. */ }
      if (!word) {
        const text = reportText ?? (response.text.trim() ? Buffer.from(response.text) : undefined);
        if (text && text.length <= TEXT_MAX) {
          const exportDir = await mkdtemp(join(cwd, '..', 'report-export-'));
          await writeFile(join(exportDir, 'returned-report.txt'), text, { mode: 0o600 });
          // A deterministic local export, never a second model call or a JSON/schema re-ask.
          try {
            await runFile(process.env.BONDBUDDY_WORD_PYTHON ?? process.env.BONDBUDDY_TEST_PYTHON ?? 'python3',
              [join(helpers, 'report_from_text.py'), join(exportDir, 'returned-report.txt'), join(exportDir, 'returned-report.docx')],
              { timeout: 120000, signal: ctx.signal, maxBuffer: 1024 * 1024 });
            word = await checkedFile(exportDir, 'returned-report.docx');
          } catch { /* Saved text remains available for delivery-only recovery. */ }
          finally { await rm(exportDir, { recursive: true, force: true }); }
        }
      }
      if (word) await retain('report.docx', word);
      return { version: 'codex-review-file-v1', input_hash: ctx.run.input_hash.trim(), files,
        ...(!files['report.docx'] ? { error: 'WORD_DELIVERY_UNAVAILABLE' as const } : {}) };
    };
    const config = options.config ?? loadCodexAdapterConfig();
    return (options.model ?? codexModelStage)({ name: 'review_file_v1', logicalCallId: 'review-file-v1',
      config: { ...config, work_root: join(process.env.BB_PARSE_STAGING_DIR ?? config.work_root, 'review-files'), max_output_bytes: 32 * 1024 * 1024 },
      buildPrompt: async () => `请完整阅读 review.md 和 input.json，自主复核并把完整报告写入 output/report.md 与 output/report.docx。返回文件，不输出固定JSON，不等待分批请求。输入锁：${ctx.run.input_hash.trim()}。`,
      schema: {}, validate: value => validReviewFileResult(value, ctx), resultSchemaVersion: 'codex-review-file-v1', templateVersion: 'review-file-v1',
      fileWorkspace: { prepare, collect } }).run(ctx);
  } };
}

export function reviewFileDeliveryStage(): RunStage {
  return { name: 'word_delivery', replay: true, run: async ctx => {
    const result = ctx.values.get('model_generation');
    if (!validReviewFileResult(result, ctx)) return { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' };
    const file = result.files['report.docx'];
    if (!file) return { kind: 'fail', code: 'WORD_DELIVERY_UNAVAILABLE' };
    const gate = await ctx.validateBeforeModelCall?.(); if (gate) return gate;
    const bytes = await ctx.blobs.getIfExistsBounded(file.key, MAX);
    if (!bytes || bytes.length !== file.byte_size || digest(bytes) !== file.sha256) return { kind: 'fail', code: 'WORD_DELIVERY_UNAVAILABLE' };
    return { kind: 'deliver', bytes, deliveryPolicy: 'generated_review_v1',
      wordSummary: { writer_version: 'codex-review-file-v1', delivery_policy: 'generated_review_v1', content_review: 'not_performed', structured_report: 'not_requested' } };
  } };
}
