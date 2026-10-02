import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {callMaterialTool,type MaterialToolData} from './authoring-material-tools.js';
const data:MaterialToolData={materials:[{id:'m0',filename:'synthetic.xlsx',context:{relation:null},records:Array.from({length:600},(_,i)=>({id:`m0r${i}`,text:i===499?'净资产120万元':'合成表格 '+i,uncertainty:[],locator:{sheet:'财务',cell:`B${i+1}`}}))}]};
test('material search finds facts past the first page; bounded reads retain table source coordinates',()=>{
 const found=callMaterialTool(data,'search_material',{material_id:'m0',query:'净资产'}) as any;
 assert.equal(found.records[0].index,499);assert.equal(found.records[0].locator.cell,'B500');
 const first=callMaterialTool(data,'read_records',{material_id:'m0',offset:480,limit:30}) as any;
 assert.equal(first.records.length,30);assert.equal(first.next_offset,510);
 const end=callMaterialTool(data,'read_records',{material_id:'m0',offset:590}) as any;
 assert.equal(end.records.length,10);assert.equal(end.next_offset,null);
});
test('material tools reject arbitrary paths, commands, other-project identifiers and oversized ranges',()=>{
 for(const args of [{material_id:'../../other-project',offset:0},{material_id:'m0',offset:0,path:'/run/secrets/key'},{material_id:'m0',offset:-1},{material_id:'m0',offset:0,limit:9999}])assert.throws(()=>callMaterialTool(data,'read_records',args));
 assert.throws(()=>callMaterialTool(data,'exec',{command:'cat /proc/self/environ'}));
 assert.equal((callMaterialTool(data,'search_material',{material_id:'m0',query:'.*'}) as any).records.length,0,'literal, not arbitrary regex');
});
test('the stdio MCP transport actually serves run-local material tools',async()=>{
 const root=await mkdtemp(join(tmpdir(),'bb-material-mcp-'));
 try{
  const path=join(root,'materials.json');await writeFile(path,JSON.stringify(data));
  const child=spawn(process.execPath,[fileURLToPath(new URL('./authoring-material-tools.js',import.meta.url)),path],{stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  child.stdin.end([{id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}},{method:'notifications/initialized'},{id:2,method:'tools/list'},{id:3,method:'tools/call',params:{name:'search_material',arguments:{material_id:'m0',query:'净资产'}}}].map(x=>JSON.stringify({jsonrpc:'2.0',...x})).join('\n')+'\n');
  const code=await new Promise(r=>child.on('close',r));assert.equal(code,0,err);
  const responses=out.trim().split('\n').map(x=>JSON.parse(x));assert.equal(responses.length,3);assert.equal(responses[1].result.tools.length,3);
  assert.equal(JSON.parse(responses[2].result.content[0].text).records[0].id,'m0r499');
 }finally{await rm(root,{recursive:true,force:true});}
});
