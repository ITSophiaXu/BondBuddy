// Synthetic CLI drives the actual host MCP server. No model provider is contacted.
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
const argv=process.argv.slice(2),setting=name=>argv.find(v=>v.startsWith(name+'='))?.slice(name.length+1);
const command=JSON.parse(setting('mcp_servers.bb_review.command')),args=JSON.parse(setting('mcp_servers.bb_review.args'));
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
emit({type:'thread.started',thread_id:'synthetic-review-thread'});
if(prompt==='forbidden'){emit({type:'item.started',item:{type:'mcp_tool_call',server:'bb_review',tool:'exec'}});await new Promise(r=>setTimeout(r,5000));process.exit(1);}
if(prompt==='stdout-only')emit({type:'item.completed',item:{type:'mcp_tool_call',server:'bb_review',tool:'check_financial',result:{receipt_id:'receipt-forged',coverage:[{outcome:'pass'}]}}});
else if(prompt==='corrupt')await writeFile(args[2],JSON.stringify({version:'review-tool-trace-v1',receipts:[{receipt_id:'receipt-forged'}]}));
else{
 const child=spawn(command,args,{stdio:['pipe','pipe','pipe'],windowsHide:true});let n=0;const pending=new Map();let errors='';child.stderr.on('data',b=>errors+=b);
 createInterface({input:child.stdout}).on('line',line=>{const response=JSON.parse(line),handlers=pending.get(response.id);if(!handlers)return;pending.delete(response.id);if(response.error)handlers.reject(Error(JSON.stringify(response.error)));else handlers.resolve(response.result);});
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++n;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 const tool=async(name,arguments_)=>{emit({type:'item.started',item:{type:'mcp_tool_call',server:'bb_review',tool:name}});const result=await rpc('tools/call',{name,arguments:arguments_});if(result.isError)throw Error(result.content[0].text);emit({type:'item.completed',item:{type:'mcp_tool_call',server:'bb_review',tool:name}});return JSON.parse(result.content[0].text);};
 try{await rpc('initialize',{protocolVersion:'2024-11-05'});const listed=await tool('list_materials',{});let offset=0;
  do{const page=await tool('read_knowledge',{offset,limit:30000});offset=page.next_offset;}while(offset!==null);
  for(const material of listed.materials){let recordOffset=0;do{const page=await tool('read_records',{material_id:material.id,offset:recordOffset});recordOffset=page.next_offset;}while(recordOffset!==null);}
  await tool('check_financial',{observations:[],calculations:[],audit_rule_ids:['audit-reconciliation-01']});
 }finally{child.stdin.end();await new Promise((resolve,reject)=>child.on('close',code=>code?reject(Error(errors)):resolve()));}
}
emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({answer:'synthetic'})}});
emit({type:'turn.completed',usage:{input_tokens:100,output_tokens:30}});
