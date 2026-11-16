import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {sha256,contained,writeJson} from './support.mjs';
import {BILLING_SNAPSHOT_SQL} from './billing-sql.mjs';
import {MODEL_EVIDENCE_SQL} from './model-quality-evidence.mjs';
import {CONFIRMATION_SQL} from './upload-confirmation-evidence.mjs';

export const READ_ONLY_QUERY_CLI=`
import pg from 'pg';
const input=JSON.parse(await new Promise((ok,bad)=>{let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{data+=s;if(data.length>2000000)bad(Error('Oversized audit request'));});process.stdin.on('end',()=>ok(data));}));
const url=new URL(process.env.DATABASE_URL);
const blob=process.env.AZURE_STORAGE_CONNECTION_STRING?.match(/(?:^|;)BlobEndpoint=([^;]+)/)?.[1];
if(url.hostname!=='postgres'||url.pathname!=='/bb_release_smoke'||!blob||new URL(blob).hostname!=='azurite'||process.env.BB_DEPLOYMENT_TIER!=='local'||process.env.BB_RELEASE_TEST_INSTANCE!==input.project)throw Error('Refusing non-isolated release evidence query');
if(input.transaction?.isolation!=='repeatable read'||input.transaction?.readOnly!==true||typeof input.text!=='string'||!Array.isArray(input.values))throw Error('READ ONLY evidence request required');
const client=new pg.Client({connectionString:process.env.DATABASE_URL});
await client.connect();
try{
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 await client.query("SET LOCAL statement_timeout='30s'");
 const result=await client.query(input.text,input.values);
 process.stdout.write(JSON.stringify({rows:result.rows}));
}finally{await client.query('ROLLBACK');await client.end();}
`;

export function evidenceCommand(command,args,{cwd,env,input,timeoutMs=120000,maxBytes=20*1024*1024}={}){
 return new Promise((ok,bad)=>{
  const child=spawn(command,args,{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',done=false;
  const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);error?bad(error):ok(result);};
  const timer=setTimeout(()=>{child.kill('SIGTERM');finish(Error('Evidence subprocess timed out; no task resubmitted'));},timeoutMs);
  child.stdout.on('data',v=>{stdout+=v.toString();if(Buffer.byteLength(stdout)>maxBytes){child.kill('SIGTERM');finish(Error('Evidence subprocess output exceeded bound'));}});
  child.stderr.on('data',v=>{stderr=(stderr+v.toString()).slice(-8000);});
  child.on('error',error=>finish(error));child.on('close',(code,signal)=>finish(null,{code,signal,stdout,stderr}));
  child.stdin.on('error',error=>{if(error.code!=='EPIPE')finish(error);});child.stdin.end(JSON.stringify(input));
 });
}

export function createEvidenceReaders({out,repo,directory,report,env,compose,save}){
 const evidence=join(out,'runtime-evidence');mkdirSync(evidence,{recursive:true,mode:0o700});
 const cli=join(directory,'artifact-inspect-cli.mjs'),cliHash=sha256(readFileSync(cli));
 if(report.artifactInspector&&(report.artifactInspector.sha256!==cliHash||report.artifactInspector.imageId!==report.images.api.id||report.artifactInspector.sha!==report.sha||report.artifactInspector.tree!==report.tree))throw Error('Artifact inspector identity changed on resume');
 report.artifactInspector={sha256:cliHash,imageId:report.images.api.id,sha:report.sha,tree:report.tree};
 const qualityFile=join(directory,'word-quality-evidence-cli.mjs'),qualitySource=readFileSync(qualityFile,'utf8');
 const qualityIdentity={sha256:sha256(Buffer.from(qualitySource)),imageId:report.images.api.id,sha:report.sha,tree:report.tree};
 if(report.wordQualityInspector&&JSON.stringify(report.wordQualityInspector)!==JSON.stringify(qualityIdentity))throw Error('Quality evidence inspector changed on resume');report.wordQualityInspector=qualityIdentity;
 const fixedCli=join(evidence,'artifact-inspect-cli.mjs');copyFileSync(cli,fixedCli);
 const mapModule=join(evidence,'artifacts.mjs'),mapBytes=readFileSync(join(directory,'artifacts.mjs'));
 copyFileSync(join(directory,'artifacts.mjs'),mapModule);report.workpaperMapper={sha256:sha256(mapBytes),imageId:report.images.api.id};save();
 let sequence=0;
 return {
  async readWordQuality(input){
   const [command,args]=compose(['exec','-T','api','node','--input-type=module','-e',qualitySource+'\nawait qualityEvidenceMain();']);
   const result=await evidenceCommand(command,args,{cwd:repo,env,input:{...input,project:report.project},timeoutMs:120000});
   const record=join(evidence,'word-quality-'+Date.now()+'-'+(++sequence));
   writeJson(record+'.json',{at:new Date().toISOString(),inspector:report.wordQualityInspector,input,result});
   if(result.code!==0)throw Error('Stored Word quality evidence failed; see '+record+'.json');return JSON.parse(result.stdout);
  },
  async mapWorkpapers(batch){
   if(sha256(readFileSync(mapModule))!==report.workpaperMapper.sha256)throw Error('Workpaper mapper changed');
   const source="import {createExpectedWorkpapers} from '/artifacts.mjs';import {workpaperZipPath} from '/app/packages/contracts/dist/index.js';let input='';for await(const chunk of process.stdin)input+=chunk;process.stdout.write(JSON.stringify(createExpectedWorkpapers(JSON.parse(input),{workpaperZipPath})));";
   const result=await evidenceCommand('docker',['run','--rm','-i','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','256m','--cpus','1','--mount','type=bind,source='+mapModule+',target=/artifacts.mjs,readonly',report.images.api.id,'node','--input-type=module','-e',source],{cwd:repo,env,input:batch,timeoutMs:60000});
   if(result.code!==0)throw Error('Fixed application workpaper mapping failed: '+result.stderr);
   return JSON.parse(result.stdout);
  },
  async inspect(request){
   const path=contained(out,request.path),input={...request};delete input.path;
   if(sha256(readFileSync(fixedCli))!==cliHash)throw Error('Inspector bytes changed');
   const args=['run','--rm','-i','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','512m','--cpus','1',
    '--mount','type=bind,source='+fixedCli+',target=/inspector.mjs,readonly',
    '--mount','type=bind,source='+path+',target=/input/artifact,readonly',report.images.api.id,'node','/inspector.mjs','--file','/input/artifact','--api-root','/app'];
   const result=await evidenceCommand('docker',args,{cwd:repo,env,input,timeoutMs:120000});
   const record=join(evidence,'artifact-'+Date.now()+'-'+(++sequence));
   writeJson(record+'.json',{at:new Date().toISOString(),inspector:report.artifactInspector,input,result});
   let parsed;try{parsed=JSON.parse(result.stdout);}catch{throw Error('Artifact inspector returned no valid JSON; see '+record+'.json');}
   if(result.code!==0&&parsed.status==='passed')throw Error('Artifact inspector exit contradicts result');
   return parsed;
  },
  async execReadOnly(request){
   if(![BILLING_SNAPSHOT_SQL,MODEL_EVIDENCE_SQL,CONFIRMATION_SQL].includes(request.text)||request.transaction?.isolation!=='repeatable read'||request.transaction?.readOnly!==true)throw Error('Only fixed read-only release evidence queries are allowed');
   const [command,args]=compose(['exec','-T','api','node','--input-type=module','-e',READ_ONLY_QUERY_CLI]);
   const result=await evidenceCommand(command,args,{cwd:repo,env,input:{...request,project:report.project},timeoutMs:60000});
   const record=join(evidence,'billing-'+Date.now()+'-'+(++sequence));
   writeJson(record+'.json',{at:new Date().toISOString(),project:report.project,sha:report.sha,tree:report.tree,querySha256:sha256(request.text),scope:request.values,result});
   if(result.code!==0)throw Error('Read-only billing query failed; see '+record+'.json');
   return JSON.parse(result.stdout);
  },
 };
}
