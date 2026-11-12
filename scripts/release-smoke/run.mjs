import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {parseArgs} from 'node:util';
import {SAMPLE_REF,CASES,REPORT_SCHEMA,sha256,writeJson,verdict,caseCompletionTime,assertLocalContext,assertTestReport} from './support.mjs';
import {hostEnvironment,protectPrivatePath} from './platform.mjs';
import {prepareReleaseCredential,assertReleaseCredential} from './credentials.mjs';
import {assertArchiveSupport,extractArchive,gitArchive} from './archive.mjs';
import {dependencyOptions,dependencyDockerfile,dependencyBuildArgs,assertNodeBaseUnchanged} from './dependencies.mjs';
import {uploadConfirmationEnvironment} from './uploads.mjs';
import {newExecutionBudget,assertExecutionBudget,assertWorkerBudget} from './budget.mjs';
import {newFlowBudget,assertFlowBudget} from './journey-state.mjs';
import {createEvidenceReaders} from './runtime-evidence.mjs';
import {assertControllerCandidate} from './controller.mjs';
import {loadFixedFixtures,assertFixtureBindings} from './fixtures.mjs';
import {imageContract,requiredImageTargets} from './image-contract.mjs';
import {confirmationService,workerParseService,configureConfirmationMode,describeConfirmationRuntime,runConfirmationPreflight} from './upload-confirmation-preflight.mjs';
import {verifyConfirmationEvidence} from './upload-confirmation-evidence.mjs';

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
const report=resume?JSON.parse(readFileSync(reportFile)): {schema:REPORT_SCHEMA,flowBudget:newFlowBudget(),startedAt:new Date().toISOString(),status:'blocked',modelMode:'live',modelProbe:'not_run',realPayment:false,executionBudget:newExecutionBudget(),cases:CASES.map(id=>({id,status:'not_run'}))};
if(resume)writeJson(join(out,'report-before-'+Date.now()+'.json'),report);
report.commandHistory??=[];report.commandHistory.push({at:new Date().toISOString(),executable:process.execPath,args:process.argv.slice(1)});
delete report.error;
let context=process.env.BB_RELEASE_DOCKER_CONTEXT||settings.dockerContext||(resume?report.dockerContext:undefined);
const proxy=process.env.BB_RELEASE_HTTP_PROXY||settings.httpProxy;
const targetPlatform=process.env.BB_RELEASE_PLATFORM||settings.platform;
const dependencies=dependencyOptions({nodeImage:process.env.BB_RELEASE_NODE_IMAGE,cachedCodex:process.env.BB_RELEASE_CODEX_TARBALL_IN_NODE_IMAGE,pipIndexUrl:process.env.BB_RELEASE_PIP_INDEX_URL});
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
 assertExecutionBudget(report.executionBudget);assertFlowBudget(report.flowBudget);
 writeJson(reportFile,report);
 if(!resume&&!values.ref&&sync('git',['status','--porcelain']))throw Error('Working tree has uncommitted changes. Commit the candidate, or explicitly select the committed version with --ref.');
 context=context||sync('docker',['context','show']);
 env.DOCKER_CONTEXT=context;
 assertLocalContext(JSON.parse(sync('docker',['context','inspect',context]))[0]);
 sync('docker',['info','--format','{{.ServerVersion}}']);
 if(sync('docker',['info','--format','{{.OSType}}'])!=='linux')throw Error('Switch Docker Desktop to Linux containers before running the release test');
 sync('docker',['buildx','version']);
 assertArchiveSupport(env);
 const {chromium,request}=await import('@playwright/test');
 if(!existsSync(chromium.executablePath())&&!process.env.BB_RELEASE_BROWSER_CHANNEL)throw Error('Install the host browser first: npx playwright install chromium');
 try{sync('docker',['compose','version']);compose=(args)=>['docker',['compose','-p',report.project,'-f',join(out,'compose.json'),...args]];}
 catch{sync('docker-compose',['version']);compose=(args)=>['docker-compose',['-p',report.project,'-f',join(out,'compose.json'),...args]];}
 if(!resume){
  report.sha=sync('git',['rev-parse','--verify',(values.ref||'HEAD')+'^{commit}']);
  report.tree=sync('git',['rev-parse',report.sha+'^{tree}']);
  report.imageContract=imageContract(execFileSync('git',['cat-file','blob',report.sha+':deploy/m1/Dockerfile'],{cwd:repo,env}));
  report.controllerFiles=assertControllerCandidate({repo,directory,sha:report.sha,env});
  report.sampleRef=SAMPLE_REF;report.project='bb-release-'+randomBytes(5).toString('hex');
  report.dockerContext=context;report.platform=sync('docker',['info','--format','{{.OSType}}/{{.Architecture}}']);
  report.baseURL='http://localhost:5288';report.model='gpt-6-sol';report.provider='copilot_enterprise';
  const source=join(out,'source');mkdirSync(source);
  writeFileSync(join(out,'source.tar'),gitArchive(repo,report.sha,env));
  extractArchive(join(out,'source.tar'),source,env);
  report.archivedControllerFiles=assertControllerCandidate({repo,directory:join(source,'scripts/release-smoke'),sourceRoot:source,strictRaw:true,sha:report.sha,env});
  // The unmerged sample PR is data only. Do not merge its application code.
  const samples=join(out,'samples');mkdirSync(samples);
  writeFileSync(join(out,'samples.tar'),gitArchive(repo,SAMPLE_REF,env,['tests/samples']));
  extractArchive(join(out,'samples.tar'),samples,env);
  const locked=loadFixedFixtures({repo,samples,env}),fixtures=locked.fixtures;report.fixtureHashes=locked.fixtureHashes;
  const account={username:'release_test',password:'Release-'+randomBytes(18).toString('hex')};
  writeJson(join(out,'private.json'),{fixtures,account});
  const credential=prepareReleaseCredential({out,directory,settings,hostEnv:env});
  Object.assign(report,credential.report);
  const image={api:`bondbuddy-release-api:${report.sha.slice(0,12)}`,worker:`bondbuddy-release-worker:${report.sha.slice(0,12)}`,web:`bondbuddy-release-web:${report.sha.slice(0,12)}`};
  if(report.imageContract.confirmation)image['upload-confirmation']=`bondbuddy-release-upload-confirmation:${report.sha.slice(0,12)}`;
  if(dependencies.nodeImage)report.nodeBase={reference:dependencies.nodeImage,id:sync('docker',['image','inspect','--format','{{.Id}}',dependencies.nodeImage])};
  if(dependencies.pipIndexUrl)report.pipIndexUrl=dependencies.pipIndexUrl;
  let dockerfile=join(source,'deploy/m1/Dockerfile');
  const prepared=dependencyDockerfile(readFileSync(dockerfile,'utf8'),dependencies);
  report.dockerfileSha256=prepared.originalSha256;
  if(prepared.adaptation){
   dockerfile=join(out,'Dockerfile.local-dependencies');writeFileSync(dockerfile,prepared.text);
   copyFileSync(join(source,'deploy/m1/Dockerfile.dockerignore'),dockerfile+'.dockerignore');
   report.dependencyAdaptation=prepared.adaptation;
  }
  writeJson(reportFile,report);
  // Fixed candidate sources; explicit local dependency adaptations are recorded above.
  for(const target of ['worker','api','web',...(report.imageContract.confirmation?['upload-confirmation']:[])]){
   if(report.nodeBase)assertNodeBaseUnchanged(report.nodeBase,sync('docker',['image','inspect','--format','{{.Id}}',dependencies.nodeImage]));
   await command('docker',['build',...(targetPlatform?['--platform',targetPlatform]:[]),'-f',dockerfile,'--target',target,'--build-arg',`BB_RELEASE_SHA=${report.sha}`,...dependencyBuildArgs(dependencies),...Object.entries(proxyEnv).filter(([k])=>k!=='NODE_USE_ENV_PROXY').flatMap(([k,v])=>['--build-arg',`${k}=${v}`]),'-t',image[target],source],`build-${target}.log`);
  }
  if(report.nodeBase)assertNodeBaseUnchanged(report.nodeBase,sync('docker',['image','inspect','--format','{{.Id}}',dependencies.nodeImage]));
  report.images=Object.fromEntries(Object.entries(image).map(([k,v])=>[k,{tag:v,id:sync('docker',['image','inspect','--format','{{.Id}}',v]),platform:sync('docker',['image','inspect','--format','{{.Os}}/{{.Architecture}}',v])}]));
  const password=randomBytes(20).toString('hex');
  const common={DATABASE_URL:`postgresql://bondbuddy:${password}@postgres:5432/bb_release_smoke`,AZURE_STORAGE_CONNECTION_STRING:'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://azurite:10000/devstoreaccount1;',BB_LIBRARY_CONTAINER:'release-private',BB_DEPLOYMENT_TIER:'local',BB_TRIAL_GUARD:'off',BB_RUN_RUNTIME_ENABLED:'1',BB_SUBSCRIPTION_BILLING_ENABLED:'1',BB_PAID_AUTHORING_ENABLED:'1',BB_PAID_REVIEW_ENABLED:'1',BB_TERMS_VERSION:'release-smoke-v1',BB_ALLOWED_ORIGIN:report.baseURL,BB_RELEASE_TEST_INSTANCE:report.project};
  Object.assign(common,proxyEnv);
  const apparmor=JSON.parse(sync('docker',['info','--format','{{json .SecurityOptions}}'])).some(x=>x==='name=apparmor');
  if(apparmor&&context.startsWith('colima-'))await command('colima',['ssh','--profile',context.slice('colima-'.length),'--','sudo','bash',join(source,'deploy/m1/scripts/install-codex-file-sandbox.sh')],'sandbox-install.log');
  const seccomp=JSON.parse(readFileSync(join(source,'deploy/m1/security/integrity-browser-seccomp.json')));
  // Narrow proc-mount permissions as in local-integration/linux-worker.mjs.
  // AppArmor engines additionally use the repository's product profile.
  seccomp.syscalls=seccomp.syscalls.flatMap(rule=>rule.names.includes('mount')&&rule.action==='SCMP_ACT_ALLOW'?[{...rule,names:rule.names.filter(n=>n!=='mount')},{...rule,names:['mount'],args:[...(rule.args??[]),{index:3,value:14,op:'SCMP_CMP_NE'}]}]:[rule]);
  writeJson(join(out,'seccomp.json'),seccomp);
  report.workerSandbox={profile:'integrity-browser-seccomp.json',sha256:sha256(readFileSync(join(out,'seccomp.json'))),init:true,procMountRestriction:true};
  const workerEnv={...common,BB_CODEX_AUTH_MODE:'copilot_enterprise',BB_COPILOT_OAUTH_FILE:'/run/secrets/bb-copilot-oauth',BB_CODEX_PROVIDER:report.provider,BB_CODEX_BASE_URL:'https://api.enterprise.githubcopilot.com',BB_CODEX_MODEL:report.model,BB_CODEX_REASONING_EFFORT:'max',BB_CODEX_CONFIG_VERSION:'release-smoke-v1',BB_CODEX_TIMEOUT_MS:String(report.flowBudget.structuredTimeoutMs),BB_CODEX_MAX_SCHEMA_REASKS:String(report.flowBudget.maxSchemaReasks),BB_CODEX_AUTHORING_TIMEOUT_MS:String(report.executionBudget.authoringTimeoutMs),BB_CODEX_WORK_ROOT:'/tmp/bb-codex',BB_REPO_ROOT:'/app',BB_PYTHON:'/opt/venv/bin/python',BB_PYTHON_BIN:'/opt/venv/bin/python',BB_PARSE_STAGING_DIR:'/var/lib/bondbuddy/parse-staging',BB_PARSE_CACHE_OCR_VERSION:'tesseract-5.3.0-eng-chi_sim-osd-v1',BB_PARSE_CACHE_BASIS_VERSION:'release-smoke-v1',BB_WORKER_CONCURRENCY:'2',BB_WORKER_PARSE_SLOTS:'1',BB_WORKER_GROUP:'release-smoke',BB_REVIEW_WEB_SEARCH_ENABLED:'0'};
  const worker={image:image.worker,init:true,environment:workerEnv,read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true','seccomp='+join(out,'seccomp.json').replaceAll('\\','/')],tmpfs:['/tmp:rw,nosuid,nodev,size=4g,mode=1777'],volumes:['parse:/var/lib/bondbuddy/parse-staging',...credential.volumes],mem_limit:'6g',cpus:4,stop_grace_period:'30s'};
  Object.assign(workerEnv,uploadConfirmationEnvironment());
  if(apparmor)worker.security_opt.push('apparmor=bondbuddy-codex-v1');
  writeJson(join(out,'compose.json'),{services:{
   postgres:{image:'postgres:16',environment:{POSTGRES_USER:'bondbuddy',POSTGRES_PASSWORD:password,POSTGRES_DB:'bb_release_smoke'},volumes:['pg:/var/lib/postgresql/data'],healthcheck:{test:['CMD-SHELL','pg_isready -U bondbuddy -d bb_release_smoke'],interval:'2s',retries:30}},
   azurite:{image:'mcr.microsoft.com/azure-storage/azurite:3.35.0',command:'azurite-blob --blobHost 0.0.0.0 --location /data --skipApiVersionCheck --disableProductStyleUrl',volumes:['blob:/data']},
   migrate:{image:image.api,environment:common,command:['node','db/migrate.mjs']},
   api:{image:image.api,environment:common,read_only:true,tmpfs:['/tmp:rw,nosuid,nodev,size=1g,mode=1777'],cap_drop:['ALL'],security_opt:['no-new-privileges:true'],volumes:['upload:/var/lib/bondbuddy/upload-spool'],mem_limit:'2g'},
   worker,
   ...(report.imageContract.confirmation?{'upload-confirmation':confirmationService(image['upload-confirmation'],common),'worker-parse':workerParseService(image.worker,common,workerEnv)}:{}),
   web:{image:image.web,ports:['127.0.0.1:5288:8080'],depends_on:['api']}
  },volumes:{pg:{},blob:{},upload:{},parse:{},...(report.imageContract.confirmation?{confirmation:{},'confirmation-small':{}}:{})}});
  writeJson(reportFile,report);
  await command(...compose(['up','-d','--wait','postgres','azurite']),'infra.log');
  await command(...compose(['run','--rm','migrate']),'migration.log');
  await command(...compose(['up','-d','--wait','api','web','worker']),'startup.log');
  assertWorkerBudget(report.executionBudget,workerEnv.BB_CODEX_AUTHORING_TIMEOUT_MS,sync(...compose(['exec','-T','worker','node','-p',"process.env.BB_CODEX_AUTHORING_TIMEOUT_MS"])));
  await command(...compose(['exec','-T','worker','node','-e',"require('fs').writeFileSync('/tmp/release-probe.txt','Synthetic release preflight. Reply with exactly READY. Do not read files or use tools.')"]),'probe-prepare.log');
  await command(...compose(['exec','-T','worker','node','apps/worker/dist/codex-probe-cli.js','--prompt-file','/tmp/release-probe.txt','--timeout-ms','90000']),'model-probe.log');
  report.modelProbe='passed';writeJson(reportFile,report);
  await command(...compose(['exec','-T','-e','BB_RELEASE_ACCOUNT','api','node','--input-type=module','-e',readFileSync(join(directory,'seed.mjs'),'utf8')]),'seed.log',{BB_RELEASE_ACCOUNT:JSON.stringify([account.username,account.password])});
 }
 assertTestReport(report);
 assertReleaseCredential(report,JSON.parse(readFileSync(join(out,'compose.json'),'utf8')),out);
 const workerSettings=JSON.parse(readFileSync(join(out,'compose.json'))).services.worker.environment;
 assertWorkerBudget(report.executionBudget,workerSettings.BB_CODEX_AUTHORING_TIMEOUT_MS,sync(...compose(['exec','-T','worker','node','-p',"process.env.BB_CODEX_AUTHORING_TIMEOUT_MS"])));
 const save=()=>writeJson(reportFile,report);
 report.controllerFiles=assertControllerCandidate({repo,directory,sha:report.sha,env});
 const fixedDirectory=join(out,'source/scripts/release-smoke');
 report.archivedControllerFiles=assertControllerCandidate({repo,directory:fixedDirectory,sourceRoot:join(out,'source'),strictRaw:true,sha:report.sha,env});
 const locked=loadFixedFixtures({repo,samples:join(out,'samples'),env});
 const privateData=assertFixtureBindings(JSON.parse(readFileSync(join(out,'private.json'))),report,locked);
 const readers=createEvidenceReaders({out,repo,directory:fixedDirectory,report,env,compose,save});
 const rawContract=imageContract(execFileSync('git',['cat-file','blob',report.sha+':deploy/m1/Dockerfile'],{cwd:repo,env}));
 if(report.imageContract&&JSON.stringify(report.imageContract)!==JSON.stringify(rawContract))throw Error('Raw candidate image contract changed');
 if(rawContract.confirmation){
  if(!report.imageContract)throw Error('New candidate has no image capability proof');
  if(!report.uploadConfirmation&&report.cases.some(c=>c.status!=='not_run'))throw Error('Upload preflight must precede the original five flows; do not backfill an old run');
  const snapshot=async mode=>{
   const runtime={};
   for(const service of ['api','worker','worker-parse','upload-confirmation']){
    const container=sync(...compose(['ps','--status','running','-q',service]));
    if(['worker-parse','upload-confirmation'].includes(service)&&mode==='legacy'){if(container)throw Error('A split confirmation consumer is active during legacy preflight');continue;}
    if(!/^[a-f0-9]{64}$/.test(container))throw Error('Missing or ambiguous preflight container: '+service);
    const actual=JSON.parse(sync('docker',['inspect',container]))[0],image=JSON.parse(sync('docker',['image','inspect',actual.Image]))[0];
    runtime[service]=describeConfirmationRuntime(service,actual,image);
    if(runtime[service].revision!==report.sha)throw Error('Preflight container belongs to another candidate');
   }
   return runtime;
  };
  await runConfirmationPreflight({report,privateData,save,directory:fixedDirectory,requestFactory:options=>request.newContext(options),snapshot,
   async configure(mode){
    const file=join(out,'compose.json'),config=JSON.parse(readFileSync(file));
    configureConfirmationMode(config,mode);writeJson(file,config);
    if(mode==='legacy')await command(...compose(['stop','worker-parse','upload-confirmation']),'confirmation-legacy-stop.log');
    await command(...compose(['up','-d','--no-deps','--force-recreate','--wait','worker',...(mode==='size-split'?['worker-parse','upload-confirmation']:[])]),'confirmation-'+mode+'-startup.log');
   },logs:async(container,since)=>sync('docker',['logs','--since',since,container]),execReadOnly:readers.execReadOnly});
  verifyConfirmationEvidence({...report,completedAt:new Date().toISOString()},{commit:report.sha,tree:report.tree,imageContract:rawContract,confirmationInspectorSha256:sha256(readFileSync(join(fixedDirectory,'upload-confirmation-preflight.mjs')))});
 }
 for(const service of requiredImageTargets({imageContract:rawContract})){
  const container=sync(...compose(['ps','-q',service]));
  if(!container||sync('docker',['inspect','--format','{{.Image}}',container])!==report.images[service].id)throw Error('Running '+service+' does not match the recorded test image');
 }
 const {runJourneys}=await import(pathToFileURL(join(fixedDirectory,'flows.mjs')).href);
 await runJourneys({out,report,privateData,save,...readers});
 report.status=verdict(report.cases);if(report.status==='passed')report.completedAt??=new Date(caseCompletionTime(report.cases)).toISOString();
}catch(error){report.status='blocked';report.error=String(error.message);console.error(report.error);process.exitCode=1;}
finally{
 if(compose&&existsSync(join(out,'compose.json')))try{await command(...compose(['logs','--no-color','--tail','150']),'services.log');}catch{}
 if(report.status==='passed'&&!values.keep){
  try{await command(...compose(['down','--volumes']),'cleanup.log');for(const name of ['copilot-oauth','copilot-auth.json'])rmSync(join(out,name),{force:true});report.cleanup='completed';}
  catch(error){report.status='blocked';report.cleanup='failed';report.error='Business flows passed, but isolated environment cleanup failed: '+error.message;}
 }else report.cleanup='retained';
 report.lastAttemptFinishedAt=new Date().toISOString();report.finishedAt=report.completedAt??report.lastAttemptFinishedAt;writeJson(reportFile,report);
 const credentialSummary=report.credentialMode==='existing-local-codex-command-helper'?`显式本地 command helper；SHA-256：${report.credentialAdaptation?.sha256??'缺失'}。正式 OAuth 换票未经验证。`:(report.credentialMode??'尚未选择');
 const rows=report.cases.map(c=>`| ${c.id} | ${c.status} | ${c.runId??'—'} | ${(c.error??'').replaceAll('|','/').replaceAll('\n',' ')} |`).join('\n');
 writeFileSync(join(out,'report.md'),`# 本地发布前测试\n\n结论：${report.status}\n\n候选提交：${report.sha??'尚未锁定'}\n\n模型：${report.model??'未调用'}；真实支付：未执行。\n\n凭据模式：${credentialSummary}\n\n| 用例 | 状态 | 任务 | 错误 |\n|---|---|---|---|\n${rows}\n\n${report.error??''}\n\n本报告只判断已列出的基础流程，不表示财务内容或专业审核通过。\n`,{mode:0o600});
 console.log(JSON.stringify({status:report.status,report:reportFile,cases:report.cases.map(({id,status})=>({id,status}))},null,2));
 if(report.status!=='passed')process.exitCode=1;
 // Failed/unfinished jobs are retained. Cleanup targets only this random project,
 // never a global prune or another environment's containers/volumes.
}
