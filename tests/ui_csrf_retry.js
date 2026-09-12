// A server restart rotates the CSRF token; an open page should refresh and retry once.
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8').replace(/\nboot\(\);\s*$/,'');
const calls=[];
const context=vm.createContext({
  assert,
  document:{addEventListener(){}},
  localStorage:{getItem(){return null;}},
  fetch:async (url,options={})=>{
    calls.push({url,token:options.headers?.['X-Bond-Token']});
    if(url==='/api/health')return {ok:true,status:200,json:async()=>({csrf:'new-token',runtime:{},storage:{}})};
    if(calls.filter(call=>call.url==='/api/projects/p/run').length===1){
      return {ok:false,status:403,json:async()=>({error:'访问校验失败，请刷新页面后重试。'})};
    }
    return {ok:true,status:202,json:async()=>({run_id:'run'})};
  },
});
vm.runInContext(source,context);
vm.runInContext(`S.token='old-token';`,context);
(async()=>{
  const result=await vm.runInContext(`api('/api/projects/p/run',{method:'POST',body:'{}'})`,context);
  assert.equal(result.run_id,'run');
  assert.deepEqual(calls.map(call=>call.url),['/api/projects/p/run','/api/health','/api/projects/p/run']);
  assert.equal(calls[2].token,'new-token');
  console.log('PASS: stale CSRF tokens refresh and retry once.');
})().catch(error=>{console.error(error);process.exitCode=1;});
