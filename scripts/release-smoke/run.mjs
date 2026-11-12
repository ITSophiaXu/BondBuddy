import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {parseArgs} from 'node:util';
import {SAMPLE_REF,CASES,writeJson,verifiedFile,verdict,assertLocalContext,assertTestReport} from './support.mjs';
import {hostEnvironment,bindMount,protectPrivatePath} from './platform.mjs';
import {prepareReleaseCredential,assertReleaseCredential} from './credentials.mjs';
import {assertArchiveSupport,extractArchive,gitArchive} from './archive.mjs';

const directory=dirname(fileURLToPath(import.meta.url)),repo=resolve(directory,'../..');
const settingsFile=join(directory,'.local.json');
const settings=existsSync(settingsFile)?JSON.parse(readFileSync(settingsFile,'utf8').replace(/^\uFEFF/,'')):{};
if(!settings||Array.isArray(settings)||Object.entries(settings).some(([k,v])=>!['dockerContext','httpProxy','platform','copilotOAuthFile','copilotAuthFile'].includes(k)||typeof v!=='string'))throw Error('Invalid release-smoke/.local.json settings');
const {values}=parseArgs({options:{ref:{type:'string'},resume:{type:'string'},keep:{type:'boolean'},help:{type:'boolean'}}});
if(values.help){console.log('npm run test:release -- [--ref COMMIT | --resume ABSOLUTE_RUN_DIRECTORY] [--keep]\nRuns real-model local Docker smoke tests. See scripts/release-smoke/README.md.');process.exit(0);}
if(values.ref&&values.resume)throw Error('--ref and --resume are mutually exclusive');
const resume=values.resume,out=resume?resolve(resume):join(directory,'.runtime',new Date().toISOString().replaceAll(':','-')+'-'+randomBytes(3).toString('hex'));
mkdirSync(out,{recursive:true,mode:0o700});
const env=hostEnvironment();
protectPrivatePath(out,'directory',env);
const reportFile=join(out,'report.json');
const report=resume?JSON.parse(readFileSync(reportFile)): {startedAt:new Date().toISOString(),status:'blocked',modelMode:'live',modelProbe:'not_run',realPayment:false,cases:CASES.map(id=>({id,status:'not_run'}))};
if(resume)writeJson(join(out,'report-before-'+Date.now()+'.json'),report);
delete report.error;
let context=process.env.BB_RELEASE_DOCKER_CONTEXT||settings.dockerContext||(resume?report.dockerContext:undefined);
const proxy=process.env.BB_RELEASE_HTTP_PROXY||settings.httpProxy;
const targetPlatform=process.env.BB_RELEASE_PLATFORM||settings.platform;
if(targetPlatform&&!/^linux\/(amd64|arm64)$/.test(targetPlatform))throw Error('BB_RELEASE_PLATFORM must be linux/amd64 or linux/arm64');
if(proxy){const u=new URL(proxy);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('Use an unauthenticated local proxy URL for this test environment');}
const proxyEnv=proxy?{HTTPS_PROXY:proxy,HTTP_PROXY:proxy,https_proxy:proxy,http_proxy:proxy,NO_PROXY:'postgres,azurite,api,localhost,127.0.0.1',no_proxy:'postgres,azurite,api,localhost,127.0.0.1',NODE_USE_ENV_PROXY:'1'}:{};
const sync=(cmd,args)=>execFileSync(cmd,args,{cwd:repo,env,encoding:'utf8',maxBuffer:20*1024*1024}).trim();
let compose;
async function command(cmd,args,logName,extraEnv={}){
 const {createWriteStream}=await import('node:fs');
 const log=createWriteStream(join(out,logName),{flags:'a',mode:0o600});
 console.log(`${new Date().toISOString()} ${logName}`);
 try{await new Promise((ok,bad)=>{
  const child=spawn(cmd,args,{cwd:repo,env:{...env,...extraEnv},windowsHide:true,stdio:['ignore','pipe','pipe']});
  const timer=setTimeout(()=>{child.kill('SIGTERM');bad(Error(logName+': timed out; preserved logs, no automatic retry'));},logName.startsWith('build-')?45*60000:5*60000);
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  child.once('error',error=>{clearTimeout(timer);bad(error);});child.once('exit',(code,signal)=>{clearTimeout(timer);code===0?ok():bad(Error(`${logName}: exit ${code??signal}; see ${join(out,logName)}`));});
 });}finally{await new Promise(r=>log.end(r));}
}
try{
 writeJson(reportFile,report);
 if(!resume&&!values.ref&&sync('git',['status','--porcelain']))throw Error('Working tree has uncommitted changes. Commit the candidate, or explicitly select the committed version with --ref.');
 context=context||sync('docker',['context','show']);
 env.DOCKER_CONTEXT=context;
 assertLocalContext(JSON.parse(sync('docker',['context','inspect',context]))[0]);
 sync('docker',['info','--format','{{.ServerVersion}}']);
 if(sync('docker',['info','--format','{{.OSType}}'])!=='linux')throw Error('Switch Docker Desktop to Linux containers before running the release test');
 sync('docker',['buildx','version']);
 assertArchiveSupport(env);
 const {chromium}=await import('@playwright/test');
 if(!existsSync(chromium.executablePath())&&!process.env.BB_RELEASE_BROWSER_CHANNEL)throw Error('Install the host browser first: npx playwright install chromium');
 try{sync('docker',['compose','version']);compose=(args)=>['docker',['compose','-p',report.project,'-f',join(out,'compose.json'),...args]];}
 catch{sync('docker-compose',['version']);compose=(args)=>['docker-compose',['-p',report.project,'-f',join(out,'compose.json'),...args]];}
 if(!resume){
  report.sha=sync('git',['rev-parse','--verify',(values.ref||'HEAD')+'^{commit}']);
  report.tree=sync('git',['rev-parse',report.sha+'^{tree}']);
  report.sampleRef=SAMPLE_REF;report.project='bb-release-'+randomBytes(5).toString('hex');
  report.dockerContext=context;report.platform=sync('docker',['info','--format','{{.OSType}}/{{.Architecture}}']);
  report.baseURL='http://localhost:5288';report.model='gpt-6-sol';report.provider='copilot_enterprise';
  const source=join(out,'source');mkdirSync(source);
  writeFileSync(join(out,'source.tar'),gitArchive(repo,report.sha,env));
  extractArchive(join(out,'source.tar'),source,env);
  // The unmerged sample PR is data only. Do not merge its application code.
  const samples=join(out,'samples');mkdirSync(samples);
  writeFileSync(join(out,'samples.tar'),gitArchive(repo,SAMPLE_REF,env,['tests/samples']));
  extractArchive(join(out,'samples.tar'),samples,env);
  const old=join(samples,'tests/samples/2026-09-25'),recent=join(samples,'tests/samples/2026-11-05');
  const rq=JSON.parse(readFileSync(join(old,'manifest.json'))).cases.find(c=>c.case_id==='rq-202509');
  const assets=JSON.parse(readFileSync(join(recent,'manifest.json'))).assets;
  const asset=id=>{const a=assets.find(x=>x.file_id===id);if(!a)throw Error('Missing fixture '+id);return verifiedFile(recent,a.path,a.sha256);};
  const fixtures={rq:rq.files.map(f=>({path:verifiedFile(old,f.path,f.sha256),role:f.upload_role})),dongying:asset('nov05-f012'),financial:['nov05-f014','nov05-f015','nov05-f016'].map(asset),questions:asset('nov05-f013')};
  report.fixtureHashes=[...rq.files,...assets.filter(a=>['nov05-f012','nov05-f013','nov05-f014','nov05-f015','nov05-f016'].includes(a.file_id))].map(a=>({id:a.file_id,sha256:a.sha256}));
  const account={username:'release_test',password:'Release-'+randomBytes(18).toString('hex')};
  writeJson(join(out,'private.json'),{fixtures,account});
  const credential=prepareReleaseCredential({out,directory,settings,hostEnv:env});
  Object.assign(report,credential.report);
  const image={api:`bondbuddy-release-api:${report.sha.slice(0,12)}`,worker:`bondbuddy-release-worker:${report.sha.slice(0,12)}`,web:`bondbuddy-release-web:${report.sha.slice(0,12)}`};
  writeJson(reportFile,report);
  // Same production Dockerfile, no source/test overlays in any product container.
  for(const target of ['worker','api','web'])await command('docker',['build',...(targetPlatform?['--platform',targetPlatform]:[]),'-f',join(source,'deploy/m1/Dockerfile'),'--target',target,'--build-arg',`BB_RELEASE_SHA=${report.sha}`,...Object.entries(proxyEnv).filter(([k])=>k!=='NODE_USE_ENV_PROXY').flatMap(([k,v])=>['--build-arg',`${k}=${v}`]),'-t',image[target],source],`build-${target}.log`);
  report.images=Object.fromEntries(Object.entries(image).map(([k,v])=>[k,{tag:v,id:sync('docker',['image','inspect','--format','{{.Id}}',v]),platform:sync('docker',['image','inspect','--format','{{.Os}}/{{.Architecture}}',v])}]));
  const password=randomBytes(20).toString('hex');
  const common={DATABASE_URL:`postgresql://bondbuddy:${password}@postgres:5432/bb_release_smoke`,AZURE_STORAGE_CONNECTION_STRING:'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://azurite:10000/devstoreaccount1;',BB_LIBRARY_CONTAINER:'release-private',BB_DEPLOYMENT_TIER:'local',BB_TRIAL_GUARD:'off',BB_RUN_RUNTIME_ENABLED:'1',BB_SUBSCRIPTION_BILLING_ENABLED:'1',BB_PAID_AUTHORING_ENABLED:'1',BB_PAID_REVIEW_ENABLED:'1',BB_TERMS_VERSION:'release-smoke-v1',BB_ALLOWED_ORIGIN:report.baseURL,BB_RELEASE_TEST_INSTANCE:report.project};
  Object.assign(common,proxyEnv);
  const apparmor=JSON.parse(sync('docker',['info','--format','{{json .SecurityOptions}}'])).some(x=>x==='name=apparmor');
  if(apparmor&&context.startsWith('colima-'))await command('colima',['ssh','--profile',context.slice('colima-'.length),'--','sudo','bash',join(source,'deploy/m1/scripts/install-codex-file-sandbox.sh')],'sandbox-install.log');
  const seccomp=JSON.parse(readFileSync(join(source,'deploy/m1/security/codex-seccomp.json')));
  // Narrow proc-mount permissions as in local-integration/linux-worker.mjs.
  // AppArmor engines additionally use the repository's product profile.
  seccomp.syscalls=seccomp.syscalls.flatMap(rule=>rule.names.includes('mount')&&rule.action==='SCMP_ACT_ALLOW'?[{...rule,names:rule.names.filter(n=>n!=='mount')},{...rule,names:['mount'],args:[...(rule.args??[]),{index:3,value:14,op:'SCMP_CMP_NE'}]}]:[rule]);
  writeJson(join(out,'seccomp.json'),seccomp);
  const workerEnv={...common,BB_CODEX_AUTH_MODE:'copilot_enterprise',BB_COPILOT_OAUTH_FILE:'/run/secrets/bb-copilot-oauth',BB_CODEX_PROVIDER:report.provider,BB_CODEX_BASE_URL:'https://api.enterprise.githubcopilot.com',BB_CODEX_MODEL:report.model,BB_CODEX_REASONING_EFFORT:'max',BB_CODEX_CONFIG_VERSION:'release-smoke-v1',BB_CODEX_TIMEOUT_MS:'600000',BB_CODEX_AUTHORING_TIMEOUT_MS:'3600000',BB_CODEX_WORK_ROOT:'/tmp/bb-codex',BB_REPO_ROOT:'/app',BB_PYTHON:'/opt/venv/bin/python',BB_PYTHON_BIN:'/opt/venv/bin/python',BB_PARSE_STAGING_DIR:'/var/lib/bondbuddy/parse-staging',BB_PARSE_CACHE_OCR_VERSION:'tesseract-5.3.0-eng-chi_sim-osd-v1',BB_PARSE_CACHE_BASIS_VERSION:'release-smoke-v1',BB_WORKER_CONCURRENCY:'2',BB_WORKER_PARSE_SLOTS:'1',BB_WORKER_GROUP:'release-smoke',BB_REVIEW_WEB_SEARCH_ENABLED:'0'};
  const worker={image:image.worker,environment:workerEnv,read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true','seccomp='+join(out,'seccomp.json').replaceAll('\\','/')],tmpfs:['/tmp:rw,nosuid,nodev,size=4g,mode=1777'],volumes:['parse:/var/lib/bondbuddy/parse-staging',...credential.volumes],mem_limit:'6g',cpus:4,stop_grace_period:'30s'};
  if(apparmor)worker.security_opt.push('apparmor=bondbuddy-codex-v1');
  writeJson(join(out,'compose.json'),{services:{
   postgres:{image:'postgres:16',environment:{POSTGRES_USER:'bondbuddy',POSTGRES_PASSWORD:password,POSTGRES_DB:'bb_release_smoke'},volumes:['pg:/var/lib/postgresql/data'],healthcheck:{test:['CMD-SHELL','pg_isready -U bondbuddy -d bb_release_smoke'],interval:'2s',retries:30}},
   azurite:{image:'mcr.microsoft.com/azure-storage/azurite:3.35.0',command:'azurite-blob --blobHost 0.0.0.0 --location /data --skipApiVersionCheck --disableProductStyleUrl',volumes:['blob:/data']},
   migrate:{image:image.api,environment:common,command:['node','db/migrate.mjs']},
   api:{image:image.api,environment:common,read_only:true,tmpfs:['/tmp:rw,nosuid,nodev,size=1g,mode=1777'],cap_drop:['ALL'],security_opt:['no-new-privileges:true'],volumes:['upload:/var/lib/bondbuddy/upload-spool'],mem_limit:'2g'},
   worker,
   web:{image:image.web,ports:['127.0.0.1:5288:8080'],depends_on:['api']}
  },volumes:{pg:{},blob:{},upload:{},parse:{}}});
  writeJson(reportFile,report);
  await command(...compose(['up','-d','--wait','postgres','azurite']),'infra.log');
  await command(...compose(['run','--rm','migrate']),'migration.log');
  await command(...compose(['up','-d','--wait','api','web','worker']),'startup.log');
  await command(...compose(['exec','-T','worker','node','-e',"require('fs').writeFileSync('/tmp/release-probe.txt','Synthetic release preflight. Reply with exactly READY. Do not read files or use tools.')"]),'probe-prepare.log');
  await command(...compose(['exec','-T','worker','node','apps/worker/dist/codex-probe-cli.js','--prompt-file','/tmp/release-probe.txt','--timeout-ms','90000']),'model-probe.log');
  report.modelProbe='passed';writeJson(reportFile,report);
  await command(...compose(['exec','-T','-e','BB_RELEASE_ACCOUNT','api','node','--input-type=module','-e',readFileSync(join(directory,'seed.mjs'),'utf8')]),'seed.log',{BB_RELEASE_ACCOUNT:JSON.stringify([account.username,account.password])});
 }
 assertTestReport(report);
 assertReleaseCredential(report,JSON.parse(readFileSync(join(out,'compose.json'),'utf8')),out);
 for(const service of ['api','worker','web']){
  const container=sync(...compose(['ps','-q',service]));
  if(!container||sync('docker',['inspect','--format','{{.Image}}',container])!==report.images[service].id)throw Error('Running '+service+' does not match the recorded test image');
 }
 for(const entry of report.cases.filter(c=>c.status==='passed')){
  const required=entry.id==='update-rq-202509'?2:1,files=(entry.downloads??[]).slice(-required);
  if(files.length!==required)throw Error('Passed case is missing its download evidence: '+entry.id);
  for(const file of files)verifiedFile(out,file.path,file.sha256);
 }
 const {runJourneys}=await import('./flows.mjs');
 await runJourneys({out,report,privateData:JSON.parse(readFileSync(join(out,'private.json'))),save:()=>writeJson(reportFile,report)});
 report.status=verdict(report.cases);
}catch(error){report.status='blocked';report.error=String(error.message);console.error(report.error);process.exitCode=1;}
finally{
 if(compose&&existsSync(join(out,'compose.json')))try{await command(...compose(['logs','--no-color','--tail','150']),'services.log');}catch{}
 if(report.status==='passed'&&!values.keep){
  try{await command(...compose(['down','--volumes']),'cleanup.log');for(const name of ['copilot-oauth','copilot-auth.json'])rmSync(join(out,name),{force:true});report.cleanup='completed';}
  catch(error){report.status='blocked';report.cleanup='failed';report.error='Business flows passed, but isolated environment cleanup failed: '+error.message;}
 }else report.cleanup='retained';
 report.finishedAt=new Date().toISOString();writeJson(reportFile,report);
 const credentialSummary=report.credentialMode==='existing-local-codex-command-helper'?`显式本地 command helper；SHA-256：${report.credentialAdaptation?.sha256??'缺失'}。正式 OAuth 换票未经验证。`:(report.credentialMode??'尚未选择');
 const rows=report.cases.map(c=>`| ${c.id} | ${c.status} | ${c.runId??'—'} | ${(c.error??'').replaceAll('|','/').replaceAll('\n',' ')} |`).join('\n');
 writeFileSync(join(out,'report.md'),`# 本地发布前测试\n\n结论：${report.status}\n\n候选提交：${report.sha??'尚未锁定'}\n\n模型：${report.model??'未调用'}；真实支付：未执行。\n\n凭据模式：${credentialSummary}\n\n| 用例 | 状态 | 任务 | 错误 |\n|---|---|---|---|\n${rows}\n\n${report.error??''}\n\n本报告只判断已列出的基础流程，不表示财务内容或专业审核通过。\n`,{mode:0o600});
 console.log(JSON.stringify({status:report.status,report:reportFile,cases:report.cases.map(({id,status})=>({id,status}))},null,2));
 if(report.status!=='passed')process.exitCode=1;
 // Failed/unfinished jobs are retained. Cleanup targets only this random project,
 // never a global prune or another environment's containers/volumes.
}
