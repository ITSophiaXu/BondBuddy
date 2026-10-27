// SYNTHETIC bounded Codex-process stand-in. No network, tools, business processing or Word.
// The real contained adapter starts this process and persists its result through its journal.
import {appendFile,readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';

const option=name=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const started=option('supplement-started'),release=option('supplement-release');
if(!started||!release||!isAbsolute(started)||!isAbsolute(release))throw Error('Missing absolute test control paths');
let prompt='';
for await(const chunk of process.stdin)prompt+=chunk;
if(!prompt.includes('SYNTHETIC generic in-flight pause mechanics'))throw Error('Unexpected fixture prompt');
const out=value=>process.stdout.write(JSON.stringify(value)+'\n');
out({type:'thread.started',thread_id:'0199a1f0-0000-7000-8000-00000000c0de'});
out({type:'turn.started'});
await appendFile(started,JSON.stringify({synthetic:true,pid:process.pid})+'\n',{mode:0o600});
const deadline=Date.now()+45000;
while(true){
  try{if((await readFile(release,'utf8')).trim()==='release-synthetic-result')break;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(Date.now()>deadline)throw Error('Synthetic adapter release was not supplied');
  await new Promise(resolve=>setTimeout(resolve,20));
}
out({type:'item.completed',item:{id:'synthetic-answer',type:'agent_message',text:JSON.stringify({answer:'SYNTHETIC saved in-flight result',n:16})}});
out({type:'turn.completed',usage:{input_tokens:12,cached_input_tokens:0,output_tokens:4,reasoning_output_tokens:0}});
