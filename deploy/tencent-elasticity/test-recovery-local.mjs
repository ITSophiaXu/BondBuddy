// Local synthetic fault integration; never accepts a production connection string.
import {spawnSync} from 'node:child_process';
import {readFileSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
const root=fileURLToPath(new URL('../..',import.meta.url));
const suffix=randomBytes(5).toString('hex'),name=`bb-pool-recovery-${suffix}`,pg=name+'-pg',blob=name+'-blob',network=name+'-net';
const evidence=resolve(root,'work/pool-recovery');mkdirSync(evidence,{recursive:true});
function docker(args,{input,allowFailure=false,timeout=240000}={}){
 const r=spawnSync('docker',args,{input,encoding:'utf8',timeout,maxBuffer:40*1024*1024});
 if(r.error)throw r.error;
 if(r.status&&!allowFailure)throw Error(`${args[0]} failed: ${r.stderr.slice(-3000)} ${r.stdout.slice(-3000)}`);
 return r;
}
const endpoint=docker(['context','inspect','--format','{{.Endpoints.docker.Host}}']).stdout.trim();
if(!/^(?:npipe:|unix:\/\/\/var\/run\/docker.sock$)/.test(endpoint))throw Error('Local Docker required');
const created=[];let net=false;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{
 docker(['network','create','--internal','--subnet',`10.247.${randomBytes(1)[0]}.0/28`,'--label','io.bondbuddy.test=pool-recovery',network]);net=true;
 docker(['run','-d','--name',pg,'--network',network,'--network-alias','pg','--tmpfs','/var/lib/postgresql/data:rw','-e','POSTGRES_DB=pool_test','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:16']);created.push(pg);
 for(let i=0;i<60;i++){if(docker(['exec',pg,'pg_isready','-U','postgres'],{allowFailure:true}).status===0)break;if(i===59)throw Error('PG not ready');await wait(500);}
 const migrations=readdirSync(resolve(root,'db/migrations')).filter(f=>/^\d+.*\.sql$/.test(f)).sort();
 const sql=migrations.map(f=>'\\echo '+f+'\nBEGIN;\n'+readFileSync(resolve(root,'db/migrations',f),'utf8').replace(/\r\n/g,'\n')+'\n;\nCOMMIT;').join('\n');
 docker(['exec','-i',pg,'psql','-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d','pool_test'],{input:sql});
 console.log('PASS isolated PG16 migrations: '+migrations.length);
 const key=randomBytes(32).toString('base64');
 docker(['run','-d','--name',blob,'--network',network,'--network-alias','blob','-e',`AZURITE_ACCOUNTS=test:${key}`,'mcr.microsoft.com/azure-storage/azurite:3.35.0','azurite-blob','--blobHost','0.0.0.0','--skipApiVersionCheck']);created.push(blob);
 const setup='cp -a /deps/node_modules/. /code/node_modules/\nfor p in contracts domain rule-pack-registry rule-applicability-context; do ln -sfn /code/packages/$p /code/node_modules/@bondbuddy/$p; done\nln -sfn /code/apps/api /code/node_modules/@bondbuddy/api\nln -sfn /code/apps/worker /code/node_modules/@bondbuddy/worker\n';
 const files=[
 'deploy/tencent-elasticity/controller.pg.test.mjs','deploy/tencent-elasticity/fenced-stop.pg.test.mjs','deploy/tencent-elasticity/run-completion.pg.test.mjs','deploy/tencent-elasticity/secret-retirement.test.mjs',
 'deploy/tencent-elasticity/enrollment.test.mjs','deploy/tencent-elasticity/controller.test.mjs','deploy/tencent-elasticity/bootstrap-warm-entry.test.mjs',
 'apps/worker/dist/managed-run-recovery.pg.test.js','apps/worker/dist/model-capacity-billing.pg.test.js','apps/worker/dist/m4-pipeline.pg.test.js',
 'apps/api/dist/outcome-billing.pg.test.js'];
 const result=docker(['run','--rm','--name',name+'-tests','--network',network,'--tmpfs','/code/node_modules',
 '--mount',`type=bind,source=${root},target=/code,readonly`,'-w','/code','-e','BB_TEST_DATABASE_URL=postgresql://postgres@pg/pool_test',
 '-e',`BB_TEST_AZURITE_CONNECTION_STRING=DefaultEndpointsProtocol=http;AccountName=test;AccountKey=${key};BlobEndpoint=http://blob:10000/test;`,
 'bb-pool-recovery-test:20261118','sh','-c',setup+'exec node --test --test-concurrency=2 '+files.join(' ')],{allowFailure:true,timeout:600000});
 writeFileSync(resolve(evidence,'integration.tap'),result.stdout+result.stderr);
 console.log(result.stdout.slice(-10000));if(result.stderr)console.log(result.stderr.slice(-3000));
 if(result.status)throw Error('Integration tests failed; see work/pool-recovery/integration.tap');
}finally{
 for(const c of [name+'-tests',...created.reverse()])docker(['rm','-f',c],{allowFailure:true});
 if(net)docker(['network','rm',network],{allowFailure:true});
}
