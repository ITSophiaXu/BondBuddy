import {test} from 'node:test';
import assert from 'node:assert/strict';
import {uploadActivity,uploadFinishing,uploadProgressHtml,uploadTransfer} from './upload-progress.js';

test('one upload bar includes server completion and never succeeds on byte completion',()=>{
 assert.match(uploadProgressHtml(uploadTransfer(40,100),'测试.pdf'),/value="36"/);
 const transferred=uploadTransfer(100,100);
 const saving=uploadProgressHtml(uploadActivity('文件已保存，正在读取版本记录…',transferred),'测试.pdf');
 assert.match(saving,/value="90"/);assert.match(saving,/正在上传文件/);
 assert.doesNotMatch(saving,/value="100"|100%|读取版本|确认保存|上传成功/);
 assert.match(uploadProgressHtml(uploadFinishing()),/value="90"/);
 const complete=uploadProgressHtml(transferred,'测试.pdf',{complete:true});
 assert.match(complete,/value="100"/);assert.match(complete,/上传成功/);
});
test('unknown totals and invalid measurements never invent a percentage',()=>{
 for(const [loaded,total] of [[1,0],[NaN,10],[1,Infinity]])assert.doesNotMatch(uploadProgressHtml(uploadTransfer(loaded,total)),/ value=|NaN|Infinity|%/);
 assert.equal(uploadTransfer(-2,10).loaded,0);assert.equal(uploadTransfer(20,10).loaded,10);
});
test('failure and paused uploads stop motion; retry starts at zero; success is explicit',()=>{
 assert.match(uploadProgressHtml(uploadActivity(),'<原文件>.pdf',{error:'保存失败 <重试>'}),/data-upload-state="error"/);
 assert.match(uploadProgressHtml(uploadActivity(),'文件',{paused:true}),/value="0"/);
 assert.match(uploadProgressHtml(uploadTransfer(0,100)),/value="0"/);
 assert.match(uploadProgressHtml(undefined,'文件',{complete:true}),/上传成功/);
 assert.match(uploadProgressHtml(undefined,'<script>.pdf'),/&lt;script&gt;/);
 const failed=uploadProgressHtml(uploadFinishing(),'文件',{error:'上传失败，请重试。',complete:true});
 assert.match(failed,/上传失败，请重试/);assert.doesNotMatch(failed,/value="100"|上传成功|100%/);
 assert.match(uploadProgressHtml(uploadFinishing('请重新选择原文件'), '文件',{paused:true}),/请重新选择原文件/);
});

test('an existing live status container owns announcements without nested live regions',()=>{
 const html=uploadProgressHtml(uploadTransfer(40,100),'测试.pdf',{announce:false});
 assert.match(html,/value="36"/);assert.match(html,/正在上传文件/);assert.doesNotMatch(html,/role="(?:status|alert)"/);
});
