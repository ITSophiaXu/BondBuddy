import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '@bondbuddy/api/data';
import { FORMAT_JSON_MAX, readFormatFile, runFormatPython } from './file-authoring-format.js';

export type ChapterRepairInput = {lockedInput:Buffer;baselineBytes:Buffer;operations:Buffer;signal?:AbortSignal};

export function chapterRepairError(error:unknown):string|undefined {
  const failure=error as {code?:unknown;stderr?:unknown};
  if(failure?.code!==1 || typeof failure.stderr!=='string')return;
  try{
    const report=JSON.parse(failure.stderr.trim());
    if(report.error==='WORD_EDIT_JSON_INVALID')return 'WORD_REPAIR_ANSWERS_INVALID';
    if(typeof report.error==='string' && /^WORD_REPAIR_[A-Z_]+$/.test(report.error))return report.error;
  }catch{ /* Infrastructure failures retain the normal retry path. */ }
}

/** Host-only workspace: never execute Python or consume edits from the model cwd. */
async function workspace<T>(input:ChapterRepairInput, action:(root:string)=>Promise<T>):Promise<T>{
  const data=JSON.parse(input.lockedInput.toString('utf8'));
  if(digest(input.baselineBytes)!==data.baseline_sha256)throw Error('INPUT_REVISION_CONFLICT');
  const root=await mkdtemp(join(tmpdir(),'bb-chapter-repair-'));
  try{
    await mkdir(join(root,'materials'));
    const trusted={...data,baseline_path:'materials/baseline.docx',materials:[{path:'materials/baseline.docx',sha256:data.baseline_sha256}]};
    await writeFile(join(root,'input.json'),JSON.stringify(trusted));
    await writeFile(join(root,'materials/baseline.docx'),input.baselineBytes);
    await writeFile(join(root,'operations.json'),input.operations);
    return await action(root);
  }finally{await rm(root,{recursive:true,force:true});}
}

export async function createChapterRepairScope(input:ChapterRepairInput):Promise<Buffer>{
  return workspace(input,async root=>{
    await runFormatPython(['repair-scope','--input',join(root,'input.json'),'--operations',join(root,'operations.json'),
      '--scope',join(root,'scope.json')],input.signal);
    return readFormatFile(root,'scope.json',FORMAT_JSON_MAX);
  });
}

export async function applyChapterRepairAnswers(input:ChapterRepairInput & {scope:Buffer;answers:Buffer}):Promise<Buffer>{
  return workspace(input,async root=>{
    await writeFile(join(root,'scope.json'),input.scope);
    await writeFile(join(root,'answers.json'),input.answers);
    await runFormatPython(['repair-answers','--input',join(root,'input.json'),'--operations',join(root,'operations.json'),
      '--scope',join(root,'scope.json'),'--answers',join(root,'answers.json'),'--candidate',join(root,'candidate.json')],input.signal);
    return readFormatFile(root,'candidate.json',FORMAT_JSON_MAX);
  });
}
