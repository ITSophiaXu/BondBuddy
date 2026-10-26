import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root=process.cwd(),dir=resolve(root,'.local/supplement-source');mkdirSync(dir,{recursive:true});
const mode=process.argv[2],env={...process.env};
for(const name of Object.keys(env))if(/^(BB_|DATABASE_URL$|AZURE_|OPENAI_|DEEPSEEK_)/i.test(name))delete env[name];
const tsc=resolve(root,'node_modules/typescript/bin/tsc');
const modes={
 'contracts-build':[tsc,'-p','packages/contracts/tsconfig.json'],
 'api-build':[tsc,'-p','apps/api/tsconfig.json'],
 'web-tsc':[tsc,'--noEmit','-p','apps/web/tsconfig.json'],
 'web-unit-build':[tsc,'-p','apps/web/tsconfig.test.json'],
 'compiler-unit-tests':['--test','apps/api/dist/run-supplement-input.test.js'],
 'source-unit-tests':['--test','apps/web/dist-test/source-prospectus.test.js'],
 'contracts-check':['packages/contracts/dist/check-examples.js'],
};
if(!Object.hasOwn(modes,mode))throw new Error('Unknown isolated build or pure test mode');
let n=1;while(existsSync(join(dir,`${mode}-${n}.json`))||existsSync(join(dir,`${mode}-${n}.log`)))n++;
const started=new Date().toISOString(),args=modes[mode];
const result=spawnSync(process.execPath,args,{cwd:root,env,encoding:'utf8',windowsHide:true,maxBuffer:64*1024*1024});
const output=(result.stdout??'')+(result.stderr??'');
writeFileSync(join(dir,`${mode}-${n}.log`),output,{flag:'wx'});
writeFileSync(join(dir,`${mode}-${n}.json`),JSON.stringify({started,finished:new Date().toISOString(),args,cwd:root,status:result.status,error:result.error?.message},null,2)+'\n',{flag:'wx'});
process.stdout.write(output);process.exitCode=result.status??1;
