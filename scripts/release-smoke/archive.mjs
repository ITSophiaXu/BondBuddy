import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('./extract-archive.py',import.meta.url));
const python=()=>process.env.BB_RELEASE_TEST_PYTHON||'python';
const options=env=>({env,stdio:'pipe',windowsHide:true,timeout:5*60000,maxBuffer:20*1024*1024});

export function gitArchive(repo,ref,env,paths=[]){
 // Windows core.autocrlf=true otherwise changes Linux shebangs and source
 // hashes during git archive. Scope these overrides to this child command.
 return execFileSync('git',['-c','core.autocrlf=false','-c','core.eol=lf','archive',ref,...paths],{
  ...options(env),cwd:repo,maxBuffer:512*1024*1024,
 });
}

export function assertArchiveSupport(env){
 if(process.platform==='win32')execFileSync(python(),['-I',script,'--check'],options(env));
 else execFileSync('tar',['--version'],options(env));
}

export function extractArchive(archive,destination,env){
 // Python uses Unicode filesystem APIs; Windows bsdtar can skip UTF-8 Git
 // paths. Keep the archived bytes unchanged and refuse unsafe members.
 if(process.platform==='win32')execFileSync(python(),['-I',script,archive,destination],options(env));
 else execFileSync('tar',['-xf',archive,'-C',destination],options(env));
}
