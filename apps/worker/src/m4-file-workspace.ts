import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, copyFile, lstat, realpath, chmod,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import type { StageContext } from './run-pipeline.js';
import type { M4WorkerInput } from './m4-input.js';
import type { loadM4RuntimeSkill } from './m4-runtime-skills.js';

const root = resolve(fileURLToPath(import.meta.url), '../../../..');
const runFile = promisify(execFile);
export const M4_FILE_MAX = 100 * 1024 * 1024;
export const M4_TEXT_MAX = 4 * 1024 * 1024;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
type Skill = ReturnType<typeof loadM4RuntimeSkill>;
const helpers = [['python/bondbuddy_file_authoring/read_material.py','read_material.py'],
  ['python/bondbuddy_file_authoring/report_from_text.py','report_from_text.py'],
  ['python/bondbuddy_m4_finance.py','bondbuddy_m4_finance.py'],
  ['python/bondbuddy_m4_finance_tool.py','finance.py']] as const;
export async function m4ToolHashes() {
  const entries=await Promise.all([...helpers, ['python/bondbuddy_file_authoring/effective_source.py','effective_source.py'] as const,
    ['python/bondbuddy_file_authoring/check.py','accepted_docx_check.py'] as const,
    ['python/bondbuddy_m4_preview.py','artifact_preview.py'] as const].map(async ([path,name])=>[name,digest(await readFile(join(root,path)))]));
  return Object.fromEntries(entries) as Record<string,string>;
}
export function m4AuthorizedSources(input:M4WorkerInput) {
  return [...input.materials.map(file=>({kind:'material',id:file.pin.material_id,project_id:file.pin.source_project_id,
    version:file.pin.material_version,sha256:file.pin.sha256})),
  ...input.artifacts.map(file=>({kind:'artifact',id:file.pin.artifact_id,project_id:file.pin.source_project_id,
    version:file.pin.artifact_version,sha256:file.pin.sha256}))];
}

export async function checkedM4File(directory: string, name: string, max = M4_FILE_MAX) {
  const path = resolve(directory, name);
  if (!path.startsWith(resolve(directory) + (process.platform === 'win32' ? '\\' : '/'))) throw Error('M4_OUTPUT_UNSAFE');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > max || await realpath(path) !== path) throw Error('M4_OUTPUT_UNSAFE');
  return readFile(path);
}

export async function prepareM4Files(ctx: StageContext, input: M4WorkerInput, skill: Skill, cwd: string, replySchema?: unknown) {
  for (const name of ['materials', 'scratch', 'output']) await mkdir(join(cwd, name), {mode: 0o700});
  const originals = new Map<string, string>();
  const material = [], artifacts = [];
  const copy = async (key: string, sha256: string, path: string) => {
    if (ctx.blobs.readToFile) {
      const received = await ctx.blobs.readToFile(key, join(cwd, path), M4_FILE_MAX);
      if (!received || received.sha256 !== sha256) throw Error('INPUT_REVISION_CONFLICT');
    } else {
      const bytes = await ctx.blobs.getIfExistsBounded(key, M4_FILE_MAX);
      if (!bytes || digest(bytes) !== sha256) throw Error('INPUT_REVISION_CONFLICT');
      await writeFile(join(cwd, path), bytes, {mode: 0o400});
    }
    originals.set(path, sha256);
  };
  const effective = async (path: string, index: string) => {
    if (!path.endsWith('.docx')) return path;
    const accepted = `materials/${index}-effective.docx`;
    try{await runFile(process.env.BONDBUDDY_WORD_PYTHON ?? process.env.BONDBUDDY_TEST_PYTHON ?? 'python3',
      ['-m', 'bondbuddy_file_authoring.effective_source', join(cwd, path), join(cwd, accepted)],
      {cwd: root, env: {...process.env, PYTHONPATH: join(root, 'python'), PYTHONDONTWRITEBYTECODE: '1'}, timeout: 120000, signal: ctx.signal, maxBuffer: 8192});}
    catch{throw Error('M4_MATERIAL_UNREADABLE');}
    originals.set(accepted, digest(await checkedM4File(cwd, accepted)));
    return accepted;
  };
  for (const [i, file] of input.materials.entries()) {
    const extension = file.mediaType === DOCX ? '.docx' : /\.(pdf|xlsx|txt|csv|png|jpg|jpeg)$/i.test(file.filename) ? extname(file.filename).toLowerCase() : '.bin';
    const path = `materials/m${i}${extension}`;
    await copy(file.objectKey, file.pin.sha256, path);
    const isSource = input.manifest.kind === 'document'
      ? inputManifestHash(file.pin) === inputManifestHash(input.manifest.input.source_material)
      : input.manifest.context.source_material && inputManifestHash(file.pin) === inputManifestHash(input.manifest.context.source_material);
    material.push({...file.pin, filename: file.filename, path, effective_path: await effective(path, `m${i}`),
      purpose: isSource ? 'source_prospectus' : input.manifest.kind === 'document' && input.manifest.template_material && inputManifestHash(file.pin) === inputManifestHash(input.manifest.template_material) ? 'template' : 'adopted_evidence'});
  }
  for (const [i, file] of input.artifacts.entries()) {
    const path = `materials/a${i}${file.mediaType===DOCX?'.docx':file.mediaType==='text/plain'?'.txt':'.bin'}`;
    if (file.bodyContent!==undefined && file.mediaType==='text/plain') {
      const bytes=Buffer.from(file.bodyContent,'utf8');
      if (digest(bytes)!==file.pin.sha256 || bytes.length>M4_TEXT_MAX) throw Error('INPUT_REVISION_CONFLICT');
      await writeFile(join(cwd,path),bytes,{mode:0o400}); originals.set(path,file.pin.sha256);
    } else await copy(file.objectKey, file.pin.sha256, path);
    artifacts.push({...file.pin, filename: file.filename, path, effective_path: await effective(path, `a${i}`)});
  }
  const data = {version: 'm4-file-workspace-v1', input_hash: ctx.run.input_hash.trim(), task: input.manifest,
    requirements: input.manifest.kind === 'document' ? input.manifest.input.requirements.map(r => r.text) : [],
    materials: material, artifacts, authorized_sources:m4AuthorizedSources(input), skill: {id: skill.id, version: skill.version, sha256: skill.sha256},
    ...(replySchema ? {reply_schema: replySchema} : {}),
    output: input.manifest.kind === 'document' ? {document: 'output/document.docx', preparation_note: 'output/preparation-note.docx'} : {reply: 'output/reply.json'}};
  await writeFile(join(cwd, 'input.json'), JSON.stringify(data, null, 2), {mode: 0o400});
  await writeFile(join(cwd, 'SKILL.md'), skill.content, {mode: 0o400});
  for (const name of ['input.json', 'SKILL.md']) originals.set(name, digest(await checkedM4File(cwd, name)));
  for (const [path,name] of helpers) {
    await copyFile(join(root,path), join(cwd,name));
    await chmod(join(cwd,name),0o400);
    originals.set(name, digest(await checkedM4File(cwd, name)));
  }
  return originals;
}

/** Recompute the model's operands with immutable host authorization; never accept its claimed answer. */
export async function verifyM4Calculation(ctx:StageContext,cwd:string) {
  let request:Buffer;
  try { request=await checkedM4File(join(cwd,'output'),'calculation-request.json',1024*1024); }
  catch (error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return null; throw error; }
  await runFile(process.env.BONDBUDDY_WORD_PYTHON ?? process.env.BONDBUDDY_TEST_PYTHON ?? 'python3',
    ['-B','-m','bondbuddy_m4_finance_tool','--workspace',cwd,'--input',join(cwd,'output/calculation-request.json'),
      '--output',join(cwd,'scratch/host-calculation.json')],
    {cwd:root,env:{...process.env,PYTHONPATH:join(root,'python'),PYTHONDONTWRITEBYTECODE:'1'},signal:ctx.signal,timeout:30000,maxBuffer:8192});
  const result=JSON.parse((await checkedM4File(join(cwd,'scratch'),'host-calculation.json',1024*1024)).toString('utf8')) as Record<string,unknown>;
  return {request_sha256:digest(request),result};
}

export async function verifyM4Originals(cwd: string, originals: Map<string, string>) {
  for (const [path, hash] of originals) if (digest(await checkedM4File(cwd, path)) !== hash) throw Error('INPUT_REVISION_CONFLICT');
}

/** Optional faithful preview of the stored bytes. A preview failure never masquerades as content. */
export async function m4ArtifactPreview(ctx:StageContext,bytes:Buffer):Promise<string|undefined> {
  const base=resolve(tmpdir()),directory=await mkdtemp(join(base,'bb-m4-preview-'));
  if(!directory.startsWith(base+(process.platform==='win32'?'\\':'/')))throw Error('M4_OUTPUT_UNSAFE');
  const python=process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON??'python3';
  const opts={cwd:root,env:{...process.env,PYTHONPATH:join(root,'python'),PYTHONDONTWRITEBYTECODE:'1'},signal:ctx.signal,timeout:30000,maxBuffer:1024*1024};
  try {
    await writeFile(join(directory,'actual.docx'),bytes,{mode:0o600});
    await runFile(python,['-B','-m','bondbuddy_file_authoring.effective_source',join(directory,'actual.docx'),join(directory,'effective.docx')],opts);
    const result=await runFile(python,['-B','-m','bondbuddy_m4_preview',join(directory,'effective.docx')],opts);
    return result.stdout.trim()||undefined;
  } catch {if(ctx.signal.aborted)throw Error('M4_PREVIEW_CANCELLED');return undefined;}
  finally {await rm(directory,{recursive:true,force:true});}
}
