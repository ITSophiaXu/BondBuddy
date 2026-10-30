import {test} from 'node:test';
import assert from 'node:assert/strict';
import {uploadActivity,uploadProgressHtml,uploadTransfer} from './upload-progress.js';

test('only byte callbacks produce a percentage; saving remains indeterminate',()=>{
 assert.match(uploadProgressHtml(uploadTransfer(40,100),'测试.pdf'),/value="40"/);
 const saving=uploadProgressHtml(uploadActivity('文件已保存，正在读取版本记录…'),'测试.pdf');
 assert.doesNotMatch(saving,/ value=|100%/);assert.match(saving,/正在读取版本记录/);
 assert.match(uploadProgressHtml(uploadTransfer(100,100)),/文件传输完成，正在确认保存/);
});
test('unknown totals and invalid measurements never invent a percentage',()=>{
 for(const [loaded,total] of [[1,0],[NaN,10],[1,Infinity]])assert.doesNotMatch(uploadProgressHtml(uploadTransfer(loaded,total)),/ value=|NaN|Infinity|%/);
 assert.equal(uploadTransfer(-2,10).loaded,0);assert.equal(uploadTransfer(20,10).loaded,10);
});
test('failure and paused uploads stop motion; retry starts at zero; success is explicit',()=>{
 assert.match(uploadProgressHtml(uploadActivity(),'<原文件>.pdf',{error:'保存失败 <重试>'}),/data-upload-state="error"/);
 assert.match(uploadProgressHtml(uploadActivity(),'文件',{paused:true}),/value="0"/);
 assert.match(uploadProgressHtml(uploadTransfer(0,100)),/value="0"/);
 assert.match(uploadProgressHtml(undefined,'文件',{complete:true}),/文件已保存/);
 assert.match(uploadProgressHtml(undefined,'<script>.pdf'),/&lt;script&gt;/);
});

test('an existing live status container owns announcements without nested live regions',()=>{
 const html=uploadProgressHtml(uploadTransfer(40,100),'测试.pdf',{announce:false});
 assert.match(html,/value="40"/);assert.match(html,/正在上传文件/);assert.doesNotMatch(html,/role="(?:status|alert)"/);
});
