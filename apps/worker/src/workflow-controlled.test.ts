import test from 'node:test';
import assert from 'node:assert/strict';
import type {AuthoringWorkflowV1} from '@bondbuddy/contracts';
import {buildAuthoringPlan} from './workflow-authoring.js';
import {validControlled,visiblePending,verifyAcceptedReceipt,controlledOperation} from './workflow-controlled.js';
const h='a'.repeat(64);
const w={plan:buildAuthoringPlan({inputHash:h,baselineHash:h,materialSnapshotHash:h,knowledgeHash:h,contextRefs:['m0:0'],nodes:[{node_id:'p',kind:'paragraph',text:'old'},{node_id:'t',kind:'table',text:'table'}],chapters:[{title:'chapter',source_node_ids:['p','t']}]})} as AuthoringWorkflowV1;
const common={node_id:'p',before:'old',evidence:['m0:0'],pending:[]};
test('large aggregate requires its exact host-bound digest anchor',()=>{
  const edit={...common,node_id:'t',kind:'insert_column' as const,column_index:0,values:['x'],before:'sha256:'+h};
  assert.deepEqual(controlledOperation(edit,'op',{scope_only:true,text_sha256:h}).before,{sha256:h});
  assert.throws(()=>controlledOperation({...edit,before:'sha256:'+'b'.repeat(64)},'op',{scope_only:true,text_sha256:h}),/ANCHOR_MISMATCH/);
});
test('controlled data operations allow bounded paragraph/table/period additions',()=>{
  for(const op of [{...common,kind:'insert_paragraph',text:'new',position:'after',style_node_id:'p'}, {...common,node_id:'t',before:'table',kind:'insert_column',column_index:0,position:'after',values:['2026','10']}, {...common,kind:'insert_table',rows:[['项目','金额'],['收入','10']],position:'after'}]){
    assert.equal(validControlled({reviewed:['p','t'],edits:[op],summary:[]},w,0,0),true,op.kind);
  }
});
test('pending annotations retain every concrete uncertainty within bounded comments',()=>{
  const comments=visiblePending(['OCR第8页缺失','OCR第8页缺失','x'.repeat(4096)]);
  assert.equal(comments.filter(c=>c.includes('OCR第8页缺失')).length,1);
  assert.equal(comments.every(c=>c.startsWith('待人工确认：')&&c.length<=4096),true);
  assert.equal(comments.join('').split('x').length-1,4096);
});
test('editor receipt must bind host operation, request hash, version and acceptance',()=>{
  const request={workspace_id:'run',op_id:'op',batch_id:'b',projection_version:2};
  const receipt={version:'word-edit-receipt-v2',status:'accepted',...request,input_hash:h,projection_version:3,receipt_object_path:`.operations.json.objects/${h}.json`,receipt_sha256:h};
  verifyAcceptedReceipt(receipt,request,h);
  for(const delta of [{status:'reverted'},{input_hash:'b'.repeat(64)},{op_id:'other'},{projection_version:1}])assert.throws(()=>verifyAcceptedReceipt({...receipt,...delta},request,h),/RECEIPT_INVALID/);
});
test('controlled data operations reject cross-scope styles and arbitrary executable fields',()=>{
  assert.equal(validControlled({reviewed:['p','t'],edits:[{...common,kind:'insert_paragraph',text:'new',style_node_id:'other'}],summary:[]},w,0,0),false);
  assert.equal(validControlled({reviewed:['p','t'],edits:[{...common,kind:'replace_text',after:'new',code:'execute'}],summary:[]},w,0,0),false);
});
