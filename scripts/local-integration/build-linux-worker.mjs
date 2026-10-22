import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {repo,runtime,workerImage} from './config.mjs';
const dir=join(runtime,'linux-worker-build');mkdirSync(dir,{recursive:true});
const codexArchive=join(dir,'codex-npm-linux-x64-0.154.0.tgz');
const codexBytes=existsSync(codexArchive)?readFileSync(codexArchive):Buffer.from(await (await fetch(
 'https://github.com/openai/codex/releases/download/rust-v0.154.0/codex-npm-linux-x64-0.154.0.tgz',
 {signal:AbortSignal.timeout(180000)})).arrayBuffer());
if(createHash('sha512').update(codexBytes).digest('base64')!=='a4FI3A8sGtwGrOqltrPbrS2hajrHQG591EwmRfiRoLMb10VxdBtUGW4gu6IJVYENiYGA7k3P4jlRHEoCZU/s9Q==')throw Error('Pinned official Codex archive integrity mismatch');
if(!existsSync(codexArchive))writeFileSync(codexArchive,codexBytes);
const archive=join(dir,'worker-snapshot.tar');
const files=['package.json','node_modules','python','knowledge','product-prototype/knowledge','deploy/m1/codex-model-catalog.json','deploy/m1/codex-authoring-model-catalog.json','deploy/m1/codex-file-authoring-model-catalog.json','scripts/local-integration'];
for(const name of ['contracts','domain','rule-pack-registry','rule-applicability-context'])files.push(`packages/${name}/dist`,`packages/${name}/package.json`);
for(const name of ['api','worker'])files.push(`apps/${name}/dist`,`apps/${name}/package.json`);
if(!process.argv.includes('--reuse-snapshot')){
 const packed=spawnSync('C:/Program Files/Git/usr/bin/tar.exe',['--force-local','-cf',archive.replaceAll('\\','/'),'--exclude=node_modules/@bondbuddy','--exclude=.env*','--exclude=__pycache__',...files],{cwd:repo,encoding:'utf8',windowsHide:true});
 if(packed.status!==0)throw Error(packed.stderr||packed.error?.message);
}
// Include the immutable runtime skills used by review and material authoring.
const assets=spawnSync('C:/Program Files/Git/usr/bin/tar.exe',['--force-local','-cf',join(dir,'runtime-assets.tar').replaceAll('\\','/'),
 'apps/worker/skills','scripts/local-integration/linux-worker-entry.mjs','scripts/local-integration/local-model-token.mjs'],{cwd:repo,encoding:'utf8',windowsHide:true});
if(assets.status!==0)throw Error(assets.stderr||assets.error?.message);
copyFileSync(join(repo,'scripts/local-integration/Dockerfile.worker'),join(dir,'Dockerfile'));
copyFileSync(join(repo,'python/requirements.txt'),join(dir,'requirements.txt'));
copyFileSync(join(repo,'scripts/local-integration/verify-python-packages.py'),join(dir,'verify-python-packages.py'));
// Only an allow-listed build context is sent to Docker; runtime files and credentials stay outside it.
writeFileSync(join(dir,'.dockerignore'),'*\n!Dockerfile\n!requirements.txt\n!verify-python-packages.py\n!worker-snapshot.tar\n!runtime-assets.tar\n!codex-npm-linux-x64-0.154.0.tgz\n');
const revision=spawnSync('git',['-c',`safe.directory=${repo.replaceAll('\\','/')}`,'rev-parse','HEAD'],{cwd:repo,encoding:'utf8',windowsHide:true});
if(revision.status!==0||!/^[a-f0-9]{40}$/.test(revision.stdout.trim()))throw Error('Cannot identify local worker source revision');
const sourceHash=createHash('sha256').update(readFileSync(archive)).digest('hex');
const result=spawnSync('C:/Program Files/Docker/Docker/resources/bin/docker.exe',['build','--progress=plain',
 '--label',`com.bondbuddy.product-commit=${revision.stdout.trim()}`,'--label',`com.bondbuddy.source-archive-sha256=${sourceHash}`,
 '-t',workerImage,dir],{cwd:repo,windowsHide:true,stdio:'inherit'});
process.exitCode=result.status??1;
