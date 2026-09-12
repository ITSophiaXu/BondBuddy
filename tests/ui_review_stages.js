// Rendering checks with synthetic data; no browser or model is involved.
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8').replace(/\nboot\(\);\s*$/,'');
const context=vm.createContext({document:{addEventListener(){}},localStorage:{getItem(){return null;}},assert});
vm.runInContext(source,context);
vm.runInContext(`
const target={id:'t',text:'资产总额100万元',chapter:'财务会计信息',locator:'正文1'};
const candidate={target_id:'t',before:target.text,after:'【待核对：资产总额100万元】',status:'needs_review',needs_review:true,origin:'scan',review_stage:'awaiting_agent',sources:[],diff:[{type:'replace',old:target.text,new:'【待核对：资产总额100万元】'}]};
const originalTodo={target_id:'o',before:'【原稿待补充】',after:'【原稿待补充】',status:'needs_review',review_stage:'original_todo',origin:'scan',chapter:'原稿'};
S.p={changes:[candidate,originalTodo],targets:[target],coverage:{},stats:{scanned:0,total:2},job:{status:'failed'}};
S.targetIndex=new Map([['t',target]]);S.changeIndex=new Map([['t',candidate]]);S.selected='t';
for(const view of ['revision','final']){
  S.view=view;const html=renderedText(target);
  assert.ok(html.includes('【待核对：资产总额100万元】'));
  assert.ok(!html.includes('<ins') && !html.includes('<del'));
}
const detail=renderSource();
assert.ok(detail.includes('来源尚未匹配'));
assert.ok(!detail.includes('更新后') && !detail.includes('填写确认'));
S.queue='needs_review';const human=renderQueue();
assert.ok(human.includes('【原稿待补充】'));
assert.ok(!human.includes('资产总额100万元'));
S.queue='awaiting_agent';const waiting=renderQueue();
assert.ok(waiting.includes('资产总额100万元'));
assert.ok(!waiting.includes('【原稿待补充】'));
candidate.review_stage='pending';candidate.status='pending';candidate.needs_review=false;candidate.origin='agent';candidate.after='资产总额120万元';candidate.diff=[{type:'replace',old:target.text,new:candidate.after}];
S.view='revision';assert.ok(renderedText(target).includes('<ins'));
`,context);
console.log('PASS: Agent processing, human review, original brackets, and genuine revisions remain distinct.');
