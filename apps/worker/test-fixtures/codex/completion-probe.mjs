// Run inside the pinned worker image with --network none. The only provider is
// this synthetic loopback Responses server; no real model or customer data.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileCompletionArgs } from '/app/apps/worker/dist/file-authoring-completion.js';

for (const scenario of ['corrected', 'still_missing', 'already_ready']) {
  const root = await mkdtemp('/tmp/bb-completion-probe-');
  for (const name of ['output','scratch','home']) await mkdir(join(root,name));
  await writeFile(join(root,'input.json'),JSON.stringify({version:'codex-file-input-v1',format_tools:{version:'controlled-docx-v1'}}));
  if(scenario==='already_ready')await writeFile(join(root,'output/operations.json'),'synthetic availability fixture');
  let calls=0,feedback=false;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    calls++;feedback ||= raw.includes('BB_AUTHORING_OUTPUT_INCOMPLETE');
    if(scenario==='corrected' && calls===2)await writeFile(join(root,'output/operations.json'),'synthetic availability fixture');
    const message={type:'message',id:`msg_${calls}`,role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic final response.',annotations:[]}]};
    const response={id:`resp_${calls}`,object:'response',status:'completed',model:'gpt-6-sol',output:[message],usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    for(const event of [{type:'response.created',response:{...response,status:'in_progress',output:[]}},
      {type:'response.output_item.done',output_index:0,item:message},{type:'response.completed',response}])res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  const args=['exec','--json','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--ephemeral','--sandbox','read-only','--cd',root,
    '-c','model="gpt-6-sol"','-c','model_provider="fixture"','-c','model_providers.fixture.name="fixture"',
    '-c',`model_providers.fixture.base_url="http://127.0.0.1:${port}"`,'-c','model_providers.fixture.wire_api="responses"',
    '-c','model_providers.fixture.env_key="BB_FIXTURE_KEY"','-c','web_search="disabled"',
    '-c','model_catalog_json="/opt/bondbuddy/codex-file-authoring-model-catalog.json"',...fileCompletionArgs(),'-'];
  let stdout='',stderr='';
  const child=spawn('/opt/codex/bin/codex',args,{cwd:root,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:join(root,'home'),CODEX_HOME:join(root,'home'),BB_FIXTURE_KEY:'synthetic-not-a-key'}});
  child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const timeout=setTimeout(()=>child.kill('SIGKILL'),45000);
  child.stdin.end('Synthetic protocol test. Reply with one short final sentence.');
  const exit=await new Promise(resolve=>child.on('close',resolve));clearTimeout(timeout);
  server.close();
  try{
    assert.equal(exit,0,stderr+'\n'+stdout);
    assert.equal(calls,scenario==='already_ready'?1:2,stderr+'\n'+stdout);
    assert.equal(feedback,scenario!=='already_ready');
    const events=stdout.split('\n').filter(x=>x.startsWith('{')).map(JSON.parse);
    const completed=events.filter(e=>e.type==='turn.completed');
    console.log(JSON.stringify({scenario,calls,feedback,completed,hook_events:events.filter(e=>e.type.startsWith('hook.'))}));
    assert.equal(completed.at(-1).usage.input_tokens,10*calls,'CLI reports cumulative usage across Stop continuation');
    assert.equal(completed.at(-1).usage.output_tokens,5*calls);
  }finally{await rm(root,{recursive:true,force:true});}
}
