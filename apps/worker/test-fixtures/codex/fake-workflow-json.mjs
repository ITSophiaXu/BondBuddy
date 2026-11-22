// Synthetic JSON provider. No supplier request, web access or command tool is used.
import {appendFileSync} from 'node:fs';
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const input=JSON.parse(prompt.trim());
const outline=Array.isArray(input.required_titles);
if(!outline&&(!input.input_hash||!input.plan_hash||!input.chapter_id||!input.batch_id||!Array.isArray(input.block_ids)))throw Error('SYNTHETIC_WORKFLOW_INPUT_INVALID');
if(process.env.BB_SYNTHETIC_JSON_STATE)appendFileSync(process.env.BB_SYNTHETIC_JSON_STATE,JSON.stringify(outline?{outline:true}:{chapter:input.chapter_id,batch:input.batch_id})+'\n');
if(process.argv.includes('--stall')){
 process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'synthetic-interrupted-thread'})+'\n');
 process.on('SIGTERM',()=>{});
 await new Promise(()=>setInterval(()=>{},1000));
}
const common={rows:[],evidence:['target'],pending:['Synthetic fixture; requires professional review'],table_id:null,row_order:null};
let projection=outline?{chapters:input.required_titles}:{version:'document-projection-v1',input_hash:input.input_hash,plan_hash:input.plan_hash,chapter_id:input.chapter_id,batch_id:input.batch_id,
 blocks:[{...common,block_id:input.block_ids[0],order:0,kind:'heading',text:input.title,heading_level:1,style_key:'heading'},
  {...common,block_id:input.block_ids[1],order:1,kind:'paragraph',text:'Synthetic '+input.target.issuer_name+' '+input.title+'; no real financial assertion.',heading_level:null,style_key:'body'}],
 summary:['Synthetic provider fixture; no DeepSeek request was sent']};
if(!outline&&input.nodes?.length){
 const target=input.nodes.find(n=>n.kind==='paragraph'&&n.part==='word/document.xml'&&!n.parent_node_id&&n.text.includes('本段'))??input.nodes.find(n=>n.kind==='paragraph'&&n.part==='word/document.xml'&&!n.parent_node_id);
 projection={reviewed:input.nodes.map(n=>n.node_id),edits:target?[{node_id:target.node_id,before:target.text,after:target.text+' Synthetic verified edit '+input.chapter_id+'.',kind:'replace_text',evidence:['target'],pending:['Synthetic pending '+input.chapter_id+'; professional review required']}]:[],summary:['Synthetic controlled chapter '+input.chapter_id]};
}
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'synthetic-workflow-thread'})+'\n');
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(projection)}})+'\n');
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}})+'\n');
