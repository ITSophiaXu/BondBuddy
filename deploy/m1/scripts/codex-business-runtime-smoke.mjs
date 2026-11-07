// Run inside the official Codex-only image with --network none. Provider replies are synthetic.
// Tests the existing business catalog and parameter builder, real CLI context event and a shell tool.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { codexConfigOverrides } from '../../../apps/worker/dist/codex-adapter.js';
const actualVersion=execFileSync('/opt/codex/bin/codex',['--version'],{encoding:'utf8'}).trim();
const pinnedVersion=(await readFile(new URL('../Dockerfile',import.meta.url),'utf8')).match(/ARG CODEX_VERSION=([^\s]+)/)[1];
assert.equal(actualVersion,`codex-cli ${pinnedVersion}`);
const root=await mkdtemp('/tmp/bb-codex-business-');
let server;
try {
 await mkdir(join(root,'home'));
 let calls=0,toolName='',toolOutput=false;
 server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const request=JSON.parse(raw);calls++;
  assert.equal(request.model,'deepseek-flash');assert.equal(request.service_tier,undefined);
  let item;
  if(calls===1){
   const tool=request.tools.find(t=>t.name==='exec_command');assert.ok(tool,'catalog exposes unified exec');toolName=tool.name;
   item={type:'function_call',id:'fc_synthetic',call_id:'call_synthetic',name:tool.name,arguments:JSON.stringify({cmd:'printf synthetic-business-tool',max_output_tokens:100})};
  }else{
   toolOutput=JSON.stringify(request.input).includes('synthetic-business-tool');
   item={type:'message',id:'msg_synthetic',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic complete.',annotations:[]}]};
  }
  const response={id:`resp_${calls}`,object:'response',status:'completed',model:'deepseek-flash',output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  for(const event of [{type:'response.created',response:{...response,status:'in_progress',output:[]}},
   {type:'response.output_item.added',output_index:0,item}, {type:'response.output_item.done',output_index:0,item}, {type:'response.completed',response}])res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const config={model_id:'deepseek-flash',model_provider:'deepseek',base_url:`http://127.0.0.1:${server.address().port}`,wire_api:'responses',credential:{kind:'env',name:'BB_SYNTHETIC_KEY'},reasoning_effort:null};
 const overrides=codexConfigOverrides(config,true);
 assert.ok(overrides.includes('model_context_window=1000000'));assert.ok(overrides.includes('model_auto_compact_token_limit=900000'));
 // The test container has no external network. Allow only this synthetic tool execution so it
 // can validate CLI/catalog capability independently of the deployment's existing file sandbox.
 const args=['exec','--json','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--cd',root,
  ...overrides,'--sandbox','danger-full-access','--enable','shell_tool','--enable','unified_exec','-'];
 const child=spawn('/opt/codex/bin/codex',args,{env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:join(root,'home'),CODEX_HOME:join(root,'home'),BB_SYNTHETIC_KEY:'synthetic-not-a-key'}});
 let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
 const deadline=setTimeout(()=>child.kill('SIGKILL'),30000);child.stdin.end('Synthetic protocol test. Execute one harmless shell command then respond.');
 const status=await new Promise(r=>child.on('close',r));clearTimeout(deadline);
 assert.equal(status,0,stderr+'\n'+stdout);assert.equal(calls,2);assert.ok(toolOutput);
 async function files(path){const result=[];for(const entry of await readdir(path,{withFileTypes:true})){const p=join(path,entry.name);if(entry.isDirectory())result.push(...await files(p));else result.push(p);}return result;}
 const events=[];
 for(const path of await files(join(root,'home')))if(path.endsWith('.jsonl'))for(const line of (await readFile(path,'utf8')).split('\n').filter(Boolean))events.push(JSON.parse(line));
 const windows=events.filter(e=>e.payload?.type==='token_count').map(e=>e.payload.info?.model_context_window).filter(Boolean);
 assert.ok(windows.length,'real CLI emits context diagnostics');assert.ok(windows.every(n=>n===1000000),JSON.stringify(windows));
 console.log(JSON.stringify({cli:actualVersion,provider:'synthetic-loopback',actual_context_windows:windows,configured_compression:900000,tool:toolName,tool_output_observed:toolOutput,calls}));
} finally {server?.close();await rm(root,{recursive:true,force:true});}
