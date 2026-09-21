import { askCodex, launch, object, string } from '../lib/codex.mjs';
import { startBridge } from '../lib/bridge.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { ROOT } from '../lib/platform.mjs';
import { join } from 'node:path';
const folder=join(ROOT,'qa','artifacts','codex-protocol');await mkdir(folder,{recursive:true});
let calls=0;
const response=await askCodex({prompt:'只返回JSON：{"message":"ok"}。不使用任何工具。',schema:object({message:string}),folder,key:'protocol',settings:{apiKey:'LOCAL_TEST_ONLY',model:'deepseek-chat'},bridgeFactory:s=>startBridge({...s,fetcher:async(url,request)=>{calls++;await writeFile(join(folder,'translated-request.json'),JSON.stringify(JSON.parse(request.body),null,2));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"message":"ok"}'}}],usage:{prompt_tokens:100,completion_tokens:10}}));}}),runner:async(a,o)=>{const result=await launch(a,{...o,timeoutMs:60000});await writeFile(join(folder,'cli-output.json'),JSON.stringify(result,null,2));return result;}});
console.log(JSON.stringify({message:response.value.message,calls,usage:response.usage,upstream:'mocked-local-only',codex:'real-cli'}));
