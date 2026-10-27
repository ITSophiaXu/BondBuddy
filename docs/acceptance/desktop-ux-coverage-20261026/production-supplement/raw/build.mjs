import {mkdirSync,writeFileSync,createWriteStream,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const out=resolve('.local/production-supplement-20261027',`build-${new Date().toISOString().replaceAll(/[-:.]/g,'')}-${process.pid}`);
mkdirSync(out,{recursive:false});
writeFileSync(join(out,'runner.mjs'),readFileSync(new URL(import.meta.url)));
const steps=[['contracts','node_modules/typescript/bin/tsc','-p','packages/contracts/tsconfig.json'],
 ['api','node_modules/typescript/bin/tsc','-p','apps/api/tsconfig.json'],
 ['worker','node_modules/typescript/bin/tsc','-p','apps/worker/tsconfig.json'],
 ['web-types','node_modules/typescript/bin/tsc','--noEmit','-p','apps/web/tsconfig.json'],
 ['web','node_modules/vite/bin/vite.js','build','apps/web']];
const results=[];
const selection=process.argv[2];
if(selection&&!steps.some(step=>step[0]===selection))throw Error('Unknown build step');
for(const [name,...args] of steps.filter(step=>!selection||step[0]===selection)){
 const startedAt=new Date().toISOString(),stdout=createWriteStream(join(out,`${name}-stdout.log`)),stderr=createWriteStream(join(out,`${name}-stderr.log`));
 const child=spawn(process.execPath,args,{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.pipe(stdout);child.stderr.pipe(stderr);
 const [exitCode,signal]=await new Promise(r=>child.once('close',(code,signal)=>r([code,signal])));
 await Promise.all([stdout,stderr].map(s=>new Promise(r=>s.writableFinished?r():s.once('finish',r))));
 const sha=file=>createHash('sha256').update(readFileSync(join(out,file))).digest('hex');
 const result={name,args,startedAt,completedAt:new Date().toISOString(),exitCode,signal,stdoutSha256:sha(`${name}-stdout.log`),stderrSha256:sha(`${name}-stderr.log`)};
 results.push(result);writeFileSync(join(out,'summary.json'),JSON.stringify(results,null,2));process.stdout.write(JSON.stringify({...result,out})+'\n');
 if(exitCode!==0){process.exitCode=exitCode??1;break;}
}
