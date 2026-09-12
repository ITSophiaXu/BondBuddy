// Upload selections made during an active upload must be queued, not dropped.
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8').replace(/\nboot\(\);\s*$/,'');
const fields={
  'upload-role':{value:'source'},
  'upload-category':{value:'financial'},
  'upload-status':null,
  'global-upload-status':null,
  toasts:{append(){}},
};
const context=vm.createContext({
  assert,
  document:{
    addEventListener(){},
    getElementById(id){return fields[id] || null;},
    createElement(){return {className:'',textContent:'',remove(){}};},
  },
  localStorage:{getItem(){return null;}},
  URLSearchParams,
  setTimeout(){},
});
vm.runInContext(source,context);
vm.runInContext(`
S.p={id:'project',original_id:null,job:{status:'idle'}};
drainUploadQueue=async()=>{};
uploadFiles([{name:'报表.xlsx',size:100}]);
assert.equal(S.uploads.length,1);
S.uploading=true;
uploadFiles([{name:'附注.docx',size:200}]);
assert.equal(S.uploads.length,2);
assert.equal(S.uploads[1].status,'queued');
assert.equal(S.uploads[1].projectId,'project');
`,context);
console.log('PASS: Additional file selections join the active upload queue.');
