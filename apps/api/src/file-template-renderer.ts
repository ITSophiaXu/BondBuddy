import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Problem} from './data.js';
let active=0;
/** Fixed worker program; user paths/commands are never accepted. */
export async function renderTemplatePreview(bytes:Buffer):Promise<Buffer>{
 if(active>=1)throw new Problem(503,'DATA_UNAVAILABLE','预览转换繁忙，请稍后重试。');active++;
 const root=fileURLToPath(new URL('../../../',import.meta.url)),base=resolve(process.env.BB_TEMPLATE_PREVIEW_STAGING_DIR??process.env.BB_UPLOAD_SPOOL_DIR??tmpdir());let staging:string|undefined;
 try{
  await mkdir(base,{recursive:true,mode:0o700});staging=await mkdtemp(join(base,'bb-template-preview-'));const input=join(staging,'input.docx'),output=join(staging,'preview.pdf');await writeFile(input,bytes,{mode:0o600});
  await promisify(execFile)(process.env.BONDBUDDY_WORD_PYTHON??'python3',['-B','-m','bondbuddy_template_preview',input,output],{cwd:root,env:{...process.env,PYTHONPATH:join(root,'python'),TMPDIR:staging,TMP:staging,TEMP:staging},timeout:60000,maxBuffer:16384,windowsHide:true});
  const pdf=await readFile(output);if(pdf.length>16*1024*1024||!pdf.subarray(0,5).equals(Buffer.from('%PDF-')))throw Error('invalid PDF');return pdf;
 }catch{throw new Problem(503,'DATA_UNAVAILABLE','版式预览暂不可用，可先查看已脱敏的结构预览，稍后重试。');}
 finally{active--;if(staging&&relative(base,resolve(staging)).startsWith('bb-template-preview-'))await rm(resolve(staging),{recursive:true,force:true});}
}
