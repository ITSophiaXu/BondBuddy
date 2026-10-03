// Synthetic model driver; it starts the real MCP process, never a model provider.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const args=process.argv.slice(2), setting=name=>args.find(a=>a.startsWith(name+'='))?.slice(name.length+1);
let prompt='';for await(const part of process.stdin)prompt+=part;
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
emit({type:'thread.started',thread_id:'synthetic-material-thread'});
if(prompt!=='stdout-only'){
  const child=spawn(JSON.parse(setting('mcp_servers.bb_materials.command')),JSON.parse(setting('mcp_servers.bb_materials.args')),{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const pending=new Map();let n=0,errors='';child.stderr.on('data',b=>errors+=b);
  createInterface({input:child.stdout}).on('line',line=>{const response=JSON.parse(line);pending.get(response.id)?.(response.result);pending.delete(response.id);});
  const rpc=(method,params)=>new Promise(resolve=>{const id=++n;pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  await rpc('initialize',{protocolVersion:'2024-11-05'});
  emit({type:'item.started',item:{type:'mcp_tool_call',server:'bb_materials',tool:'read_records'}});
  const result=await rpc('tools/call',{name:'read_records',arguments:{material_id:'m0',offset:1,limit:1}});
  if(result.isError)throw Error(result.content[0].text);
  emit({type:'item.completed',item:{type:'mcp_tool_call',server:'bb_materials',tool:'read_records'}});
  const closed=new Promise((resolve,reject)=>child.once('close',code=>code?reject(Error(errors)):resolve()));child.stdin.end();await closed;
}else emit({type:'item.completed',item:{type:'mcp_tool_call',server:'bb_materials',tool:'read_records',result:{records:[{id:'r1'}]}}});
emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({cited:['r1']})}});
emit({type:'turn.completed',usage:{input_tokens:100,output_tokens:20}});
