import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {repo,runtime,templateURL,blobConnection} from './config.mjs';

const docker='C:/Program Files/Docker/Docker/resources/bin/docker.exe';
const archive=join(runtime,'linux-test-snapshot.tar');
// Pack on the host once; importing one tar is much faster than copying thousands of
// files across Docker Desktop's Windows mount and preserves the frozen test inputs.
const packed=spawnSync('C:/Program Files/Git/usr/bin/tar.exe',['--force-local','--dereference','-cf',archive.replaceAll('\\','/'),'--exclude=node_modules/@bondbuddy',
  'apps','packages','knowledge','python','product-prototype','db','package.json','node_modules','scripts/local-integration'],
  {cwd:repo,encoding:'utf8',windowsHide:true});
if(packed.status!==0)throw new Error(packed.stderr||JSON.stringify({status:packed.status,signal:packed.signal,error:packed.error?.message}));
const args=['run','--rm','--name','bb-integration-worker-tests-20261012','--memory','1g','--cpus','2',
  '--mount',`type=bind,source=${archive},target=/snapshot.tar,readonly`,'--workdir','/app',
  '-e',`BB_TEST_DATABASE_URL=${templateURL.replace('127.0.0.1','host.docker.internal')}`,
  '-e',`BB_TEST_AZURITE_CONNECTION_STRING=${blobConnection.replace('127.0.0.1','host.docker.internal')}`,
  '-e','BB_PARSE_CACHE_OCR_VERSION=synthetic-ocr-1','-e','BB_PARSE_CACHE_BASIS_VERSION=synthetic-basis-1',
  '-e','BB_PAID_AUTHORING_ENABLED=0','-e','BB_PAID_REVIEW_ENABLED=0',
  'node:22-bookworm-slim','sh','-c','tar -xf /snapshot.tar -C /app && exec node scripts/local-integration/linux-test-entry.mjs'];
const result=spawnSync(docker,args,{cwd:repo,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
writeFileSync(join(runtime,'tests-worker-linux.log'),(result.stdout||'')+(result.stderr||''));
console.log(result.stdout,result.stderr);
process.exitCode=result.status??1;
