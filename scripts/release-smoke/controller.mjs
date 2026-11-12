import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {sha256} from './support.mjs';

export function assertControllerCandidate({repo,directory,sha,env,sourceRoot=repo,strictRaw=false}){
 const paths=execFileSync('git',['ls-tree','-r','--name-only',sha,'scripts/release-smoke'],{cwd:repo,env,encoding:'utf8'}).trim().split('\n').filter(p=>/^scripts\/release-smoke\/[^/]+\.(?:mjs|py)$/.test(p)&&!p.endsWith('.test.mjs'));
 const live=readdirSync(directory).filter(name=>/\.(?:mjs|py)$/.test(name)&&!name.endsWith('.test.mjs')).map(name=>'scripts/release-smoke/'+name).sort();
 if(JSON.stringify([...paths].sort())!==JSON.stringify(live))throw Error('Release controller files differ from committed candidate');
 return paths.map(path=>{
  const original=execFileSync('git',['cat-file','blob',sha+':'+path],{cwd:repo,env,maxBuffer:4*1024*1024});
  const actual=readFileSync(join(sourceRoot,path));
  if(strictRaw&&!actual.equals(original))throw Error('Archived release controller differs from candidate: '+path);
  if(actual.toString('utf8').replaceAll('\r\n','\n')!==original.toString('utf8').replaceAll('\r\n','\n'))throw Error('Release controller differs from candidate: '+path);
  return {path,gitSha256:sha256(original),checkoutSha256:sha256(actual),checkoutEolNormalized:sha256(original)!==sha256(actual)};
 });
}
