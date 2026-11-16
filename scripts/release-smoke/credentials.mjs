import {copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {bindMount,protectPrivatePath} from './platform.mjs';
import {sha256} from './support.mjs';
import {parseLocalCopilotAuth,CREDENTIAL_TARGET} from './local-copilot-token.mjs';

const LOCAL_MODE='existing-local-codex-command-helper';
const OAUTH_MODE='copilot-oauth-exchange';
const HELPER_TARGET='/usr/local/bin/bb-copilot-token';
const HELPER_FILE='local-copilot-token.mjs';

export function selectReleaseCredential(settings={},env=process.env,home=homedir()){
 const explicit=env.BB_RELEASE_COPILOT_AUTH_FILE??settings.copilotAuthFile;
 const local=explicit!==undefined;
 const source=local?explicit:(env.BB_RELEASE_COPILOT_OAUTH_FILE??settings.copilotOAuthFile??join(home,'.local','share','copilot-api','github_token'));
 if(typeof source!=='string'||!source.trim()||source.includes('\0'))throw Error('Invalid local credential file configuration');
 return {source,mode:local?LOCAL_MODE:OAUTH_MODE,secretName:local?'copilot-auth.json':'copilot-oauth'};
}

// Select only from explicit configuration; OAuth failures never call this again
// with a different mode. Copy just the needed key, not unrelated auth metadata.
export function prepareReleaseCredential({out,directory,settings,sourceEnv=process.env,hostEnv,protect=protectPrivatePath}){
 const selected=selectReleaseCredential(settings,sourceEnv);
 const target=join(out,selected.secretName);
 try{
  if(selected.mode===LOCAL_MODE){
   const token=parseLocalCopilotAuth(readFileSync(selected.source,'utf8'));
   writeFileSync(target,JSON.stringify({OPENAI_API_KEY:token}),{mode:0o600,flag:'wx'});
  }else copyFileSync(selected.source,target);
 }catch{throw Error(selected.mode===LOCAL_MODE?'Local Copilot auth JSON is unavailable or invalid':'Copilot OAuth file is unavailable');}
 protect(target,'file',hostEnv);
 const volumes=[bindMount(target,CREDENTIAL_TARGET)];
 const report={credentialMode:selected.mode};
 if(selected.mode===LOCAL_MODE){
  const helper=Buffer.from(readFileSync(join(directory,HELPER_FILE),'utf8').replaceAll('\r\n','\n'));
  writeFileSync(join(out,HELPER_FILE),helper,{mode:0o555,flag:'wx'});
  volumes.push(bindMount(join(out,HELPER_FILE),HELPER_TARGET));
  report.credentialAdaptation={kind:'local-command-helper-overlay',sha256:sha256(helper),note:'Explicit existing local credential; Copilot command catalogs and sandbox remain. The production OAuth exchange was not exercised.'};
 }
 return {volumes,report};
}

// Resume must retain the recorded mode and the exact local helper. Supplying a
// different host option cannot turn an OAuth failure into a successful fallback.
export function assertReleaseCredential(report,compose,out){
 const mode=report.credentialMode??OAUTH_MODE;
 const volumes=compose.services?.worker?.volumes??[];
 const helpers=volumes.filter(m=>m?.target===HELPER_TARGET);
 if(mode===OAUTH_MODE){
  if(helpers.length||report.credentialAdaptation)throw Error('Unexpected credential helper overlay');
  return;
 }
 if(mode!==LOCAL_MODE)throw Error('Unknown release credential mode');
 const secrets=volumes.filter(m=>m?.target===CREDENTIAL_TARGET);
 const valid=(m,name)=>m?.type==='bind'&&m.read_only===true&&typeof m.source==='string'&&resolve(m.source)===resolve(join(out,name));
 if(helpers.length!==1||!valid(helpers[0],HELPER_FILE)||secrets.length!==1||!valid(secrets[0],'copilot-auth.json')||report.credentialAdaptation?.kind!=='local-command-helper-overlay')throw Error('Local credential mounts do not match the recorded mode');
 try{
  if(sha256(readFileSync(join(out,HELPER_FILE)))!==report.credentialAdaptation.sha256)throw Error();
  parseLocalCopilotAuth(readFileSync(join(out,'copilot-auth.json'),'utf8'));
 }catch{throw Error('Local credential evidence is unavailable or changed');}
}
