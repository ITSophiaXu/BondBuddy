#!/usr/local/bin/node
// Explicit local-only command helper. Never exchanges or logs credentials.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const LOCAL_CREDENTIAL_ERROR='Local Copilot credential unavailable';
export const CREDENTIAL_TARGET='/run/secrets/bb-copilot-oauth';

export function parseLocalCopilotAuth(text){
 try{
  if(typeof text!=='string'||text.length>65536)throw Error();
  const auth=JSON.parse(text.replace(/^\uFEFF/,''));
  if(!auth||Array.isArray(auth)||typeof auth!=='object'||!Object.hasOwn(auth,'OPENAI_API_KEY'))throw Error();
  const token=auth.OPENAI_API_KEY;
  if(typeof token!=='string'||token.length>16384||!/^[\x21-\x7e]+$/.test(token))throw Error();
  return token;
 }catch{throw Error(LOCAL_CREDENTIAL_ERROR);}
}

export async function readLocalCopilotToken(source,read=readFile){
 try{
  if(source!==CREDENTIAL_TARGET)throw Error();
  return parseLocalCopilotAuth(await read(source,'utf8'));
 }catch{throw Error(LOCAL_CREDENTIAL_ERROR);}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{process.stdout.write(await readLocalCopilotToken(process.env.BB_COPILOT_OAUTH_FILE));}
 catch{process.stderr.write(LOCAL_CREDENTIAL_ERROR+'\n');process.exitCode=1;}
}
