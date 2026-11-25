import {execFile} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {withPerformanceSpan} from '@bondbuddy/api/performance-trace';

const repo=resolve(fileURLToPath(import.meta.url),'../../../..');
export type DirectPageReport={version:'direct-docx-page-v1';status:'passed'|'mismatch';baseline_pages:number;result_pages:number;
  ratio:number;minimum_ratio:number;libreoffice_version:string};

export async function acceptAndRenderDirectDocx(input:{tracked:Buffer;baseline:Buffer;author:string;signal?:AbortSignal}):Promise<{clean:Buffer;pages:DirectPageReport}>{
  const minimum=Number(process.env.BB_DIRECT_DOCX_MIN_PAGE_RATIO??'0.7');
  if(!Number.isFinite(minimum)||minimum<=0||minimum>1)throw Error('WORD_PAGE_THRESHOLD_INVALID');
  const root=await mkdtemp(join(tmpdir(),'bb-direct-docx-'));
  try{
    const tracked=join(root,'tracked.docx'),baseline=join(root,'baseline.docx'),clean=join(root,'clean.docx');
    await Promise.all([writeFile(tracked,input.tracked),writeFile(baseline,input.baseline)]);
    const {stdout}=await withPerformanceSpan('document.direct.render',{minimum_ratio:minimum},()=>promisify(execFile)(
      process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON??'python3',
      ['-B','-s','-m','bondbuddy_file_authoring.direct_delivery','--tracked',tracked,'--baseline',baseline,'--clean',clean,
        '--author',input.author,'--minimum-ratio',String(minimum)],
      {cwd:repo,env:{...process.env,PYTHONPATH:join(repo,'python'),PYTHONIOENCODING:'utf-8'},timeout:660000,maxBuffer:1024*1024,signal:input.signal}));
    const pages=JSON.parse(stdout.trim()) as DirectPageReport;
    if(pages.version!=='direct-docx-page-v1'||!['passed','mismatch'].includes(pages.status)||
      !Number.isInteger(pages.baseline_pages)||pages.baseline_pages<1||!Number.isInteger(pages.result_pages)||pages.result_pages<1||
      !Number.isFinite(pages.ratio)||pages.minimum_ratio!==minimum||typeof pages.libreoffice_version!=='string')
      throw Error('WORD_PAGE_REPORT_INVALID');
    return {clean:await readFile(clean),pages};
  }finally{await rm(root,{recursive:true,force:true});}
}
