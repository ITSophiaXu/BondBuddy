// Slow operations must show immediate feedback and ignore duplicate clicks.
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8').replace(/\nboot\(\);\s*$/,'');

const requests=[];
const pending=[];
let downloads=0;
const context=vm.createContext({
  assert,
  document:{
    addEventListener(){},
    querySelector(){return null;},
    createElement(){
      return {
        style:{},
        click(){downloads++;},
        remove(){},
      };
    },
    body:{append(){}},
  },
  localStorage:{getItem(){return null;}},
  fetch:(url,options={})=>new Promise(resolve=>{
    requests.push({url,options});
    pending.push({url,resolve});
  }),
  URL:{
    createObjectURL(){return 'blob:download';},
    revokeObjectURL(){},
  },
  setTimeout(callback){callback();},
});
vm.runInContext(source,context);
vm.runInContext(`
render=()=>{};
refresh=async()=>{};
toast=()=>{};
S.p={id:'project',original_id:'file',job:{status:'idle'}};
S.draft='请核对资产总额';
`,context);

(async()=>{
  const send=vm.runInContext('sendMessage()',context);
  assert.equal(vm.runInContext('S.sending',context),true);
  assert.equal(vm.runInContext('S.pendingMessage.projectId',context),'project');
  assert.equal(vm.runInContext('S.pendingMessage.text',context),'请核对资产总额');
  await vm.runInContext('sendMessage()',context);
  assert.equal(requests.filter(request=>request.url.endsWith('/chat')).length,1);
  pending.shift().resolve({ok:true,status:202,json:async()=>({run_id:'run'})});
  await send;
  assert.equal(vm.runInContext('S.sending',context),false);
  assert.equal(vm.runInContext('S.pendingMessage',context),null);

  vm.runInContext("S.p={id:'origin',original_id:'file',job:{status:'idle'}};S.draft='原项目问题';",context);
  const failedSend=vm.runInContext('sendMessage()',context);
  vm.runInContext("S.p={id:'other',original_id:'other-file',job:{status:'idle'}};S.draft='另一项目草稿';",context);
  pending.shift().resolve({ok:false,status:400,json:async()=>({error:'TEST FAILURE'})});
  await assert.rejects(failedSend,/TEST FAILURE/);
  assert.equal(vm.runInContext('S.draft',context),'另一项目草稿');
  assert.equal(vm.runInContext('S.pendingMessage',context),null);

  const download=vm.runInContext("downloadExport('/api/projects/project/export?view=revision','Word 修订版','fallback.docx')",context);
  assert.equal(vm.runInContext('S.exporting.title',context),'Word 修订版');
  await vm.runInContext("downloadExport('/api/projects/project/export?view=revision','Word 修订版','fallback.docx')",context);
  assert.equal(requests.filter(request=>request.url.includes('/export?')).length,1);
  pending.shift().resolve({
    ok:true,
    status:200,
    headers:{get(){return "attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.docx";}},
    blob:async()=>({size:123}),
  });
  await download;
  assert.equal(vm.runInContext('S.exporting',context),null);
  assert.equal(downloads,1);
  assert.ok(vm.runInContext('exportModal.toString()',context).includes('data-action="download-export"'));
  console.log('PASS: Chat and export show pending state and suppress duplicate clicks.');
})().catch(error=>{console.error(error);process.exitCode=1;});
