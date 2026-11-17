// Real pinned CLI + native MCP + automatic compaction, synthetic loopback provider only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadCodexAdapterConfig, runCodexProcess } from './codex-adapter.js';

const binary=process.env.BB_TEST_CODEX_BIN;
const digest=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const flatten=(value:any):string=>typeof value==='string'?value:Array.isArray(value)?value.map(flatten).join('\n'):value&&typeof value==='object'?Object.values(value).map(flatten).join('\n'):'';
function tools(value:any,namespace?:string):{name:string;namespace?:string;type:string}[]{return Array.isArray(value)?value.flatMap(x=>x.type==='namespace'?tools(x.tools,x.name):[{type:x.type,name:x.name,...(namespace?{namespace}:{})}]):[];}

test('real Codex 0.169 SessionStart injects the newest checkpoint after native automatic compaction',{
  skip:!binary?'set BB_TEST_CODEX_BIN to pinned Linux CLI':process.platform!=='linux'?'Linux native sandbox required':false,
  timeout:90000,
},async t=>{
  await mkdir(join(homedir(),'.cache'),{recursive:true});
  const root=await mkdtemp(join(homedir(),'.cache','bb-session-start-protocol-')),cwd=join(root,'cwd'),home=join(root,'home');
  for(const path of [cwd,home,join(cwd,'scratch'),join(cwd,'output')])await mkdir(path);
  t.after(()=>rm(root,{recursive:true,force:true}));
  const version=await promisify(execFile)(binary!,['--version'],{env:{...process.env,HOME:home,CODEX_HOME:home,TMPDIR:home}});
  assert.equal(version.stdout.trim(),'codex-cli 0.169.0');
  const locked=JSON.stringify({version:'codex-file-input-v1',input_hash:'a'.repeat(64),baseline_sha256:'b'.repeat(64),format_tools:{version:'controlled-docx-v1'}});
  const operations=JSON.stringify({version:'word-operations-v1',input_hash:'a'.repeat(64),baseline_sha256:'b'.repeat(64),operations:[{id:'synthetic_saved_edit',kind:'replace_text'}]});
  await writeFile(join(cwd,'input.json'),locked);await writeFile(join(cwd,'output/operations.json'),operations);
  await writeFile(join(cwd,'scratch/工作记录.md'),'SYNTHETIC_OLD_PREFIX_MUST_NOT_BE_REREAD\n'+'historical notes '.repeat(20000)+'\nSYNTHETIC_LEGACY_TAIL_ONLY');
  const wrapper=join(root,'wrapper.mjs');
  await writeFile(wrapper,`import {spawn} from 'node:child_process';const args=process.argv.slice(2);args.splice(1,0,'-c','model_catalog_json="/opt/bondbuddy/codex-copilot-file-authoring-model-catalog.json"');const c=spawn(${JSON.stringify(binary)},args,{stdio:'inherit'});c.on('error',()=>process.exit(97));c.on('close',code=>process.exit(code??98));`);
  const tokenName='BB_SYNTHETIC_SESSION_START_TOKEN',prior=process.env[tokenName];process.env[tokenName]='synthetic-session-start-only';
  t.after(()=>{if(prior===undefined)delete process.env[tokenName];else process.env[tokenName]=prior;});
  const seen:{compact:boolean;fresh:boolean;prefix:boolean;hashes:boolean;sessionStart:boolean}[]=[],violations:string[]=[];
  const nextAction='SYNTHETIC_NEXT_UNFINISHED_ACTION_AFTER_SAVED_BATCH';
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk as Buffer);
    const body=JSON.parse(Buffer.concat(chunks).toString()),declared=tools(body.tools),isCompact=declared.length===0;
    const normal=seen.filter(x=>!x.compact).length+1,text=flatten(body);
    const observation={compact:isCompact,fresh:text.includes(nextAction),prefix:text.includes('SYNTHETIC_OLD_PREFIX_MUST_NOT_BE_REREAD'),hashes:text.includes(digest(locked))&&text.includes(digest(operations)),sessionStart:text.includes('BB_CONTINUATION_SESSION_START_V1 source=compact')};seen.push(observation);
    if(req.headers.authorization!=='Bearer synthetic-session-start-only')violations.push('synthetic_auth_missing');
    if(observation.prefix)violations.push('unbounded_legacy_worklog_reread');
    let item:Record<string,unknown>;
    if(isCompact)item={type:'message',id:'msg_compact',role:'assistant',status:'completed',content:[{type:'output_text',text:'SYNTHETIC_INTENTIONALLY_OLD_HANDOFF: consult current checkpoint for next action, not the historical log.',annotations:[]}]};
    else {
      if(normal>=2&&(!observation.fresh||!observation.hashes||!observation.sessionStart))violations.push('fresh_session_start_state_missing_after_compaction');
      if(normal<=2){
        const name=normal===1?'checkpoint':'status',tool=declared.find(x=>x.type==='function'&&x.name.endsWith(name)&&(x.namespace?.includes('bb_continuation')||x.name.includes('bb_continuation')));
        if(!tool){violations.push('continuation_tool_missing');res.writeHead(400);res.end('synthetic continuation tool missing');return;}
        item={type:'function_call',id:'fc_'+name,call_id:'call_'+name,name:tool.name,...(tool.namespace?{namespace:tool.namespace}:{}),arguments:JSON.stringify(normal===1?{phase:'write_document',next_action:nextAction,pending:['SYNTHETIC_REMAINING_SOURCE_CHECK']}: {})};
      } else item={type:'message',id:'msg_done',role:'assistant',status:'completed',content:[{type:'output_text',text:'synthetic protocol completed; no real delivery claimed',annotations:[]}]};
    }
    const inputTokens=isCompact?100:normal===1?129000:100,response={id:'resp_'+seen.length,object:'response',status:'completed',model:'gpt-6-sol',output:[item],usage:{input_tokens:inputTokens,output_tokens:5,total_tokens:inputTokens+5,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}])res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');
    res.end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  const config=loadCodexAdapterConfig({BB_CODEX_PROVIDER:'synthetic',BB_CODEX_MODEL:'gpt-6-sol',BB_CODEX_CREDENTIAL_ENV:tokenName,BB_CODEX_REASONING_EFFORT:'max',BB_CODEX_CONFIG_VERSION:'synthetic-session-start-v1',BB_MODEL_GATEWAY_MODE:'enforce',BB_MODEL_MAX_REQUEST_BYTES:'2097152'});
  const result=await runCodexProcess({...config,command:[process.execPath,wrapper],base_url:'http://127.0.0.1:'+(server.address() as AddressInfo).port,work_root:root,timeout_ms:60000,kill_grace_ms:500},{prompt:'SYNTHETIC same ongoing task; continue actual saved work.',cwd,home,codexHome:home,schemaFile:null,ephemeral:true,resumeThreadId:null,fileAuthoring:true,fileRecovery:true,fileCompletion:true,captureExecLog:true,gatewayLog:()=>{}});
  assert.equal(result.turn_completed,true,result.exec_log?.bytes.toString());assert.equal(result.stop,null);
  assert.doesNotMatch(result.exec_log?.bytes.toString()??'',/MCP tool call requires approval/,'the fixed local checkpoint writer must remain callable under approval_policy=never');
  assert.equal(seen.filter(x=>x.compact).length,1);assert.equal(seen.filter(x=>!x.compact).length,3);assert.deepEqual(violations,[],JSON.stringify({seen}));
  assert.equal(await readFile(join(cwd,'output/operations.json'),'utf8'),operations,'saved edits remain byte-identical across compaction');
  const state=JSON.parse(await readFile(join(cwd,'scratch/continuation.json'),'utf8'));
  assert.equal(state.progress.next_action,nextAction);assert.equal(state.output_snapshot.files['operations.json'].sha256,digest(operations));
});
