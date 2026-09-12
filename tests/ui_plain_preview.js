// Exercise ordinary DOCX review and source navigation without Word preview services.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8').replace(/\nboot\(\);\s*$/, '');
let located = null;
const context = vm.createContext({
  assert,
  document: {addEventListener(){},getElementById(id){return {scrollIntoView(){located=id;}};}},
  localStorage:{getItem(){return null;}},
  setTimeout(fn){fn();},
});
vm.runInContext(source, context);
async function main(){
  await vm.runInContext(`(async()=>{
    const paragraph={id:'p',type:'paragraph',text:'资产总额100万元【待核对日期】',chapter:'财务',locator:'正文段落 1'};
    const cell={id:'c',text:'100',rowspan:2,colspan:1};
    const change={target_id:'p',before:paragraph.text,after:'资产总额120万元【待核对日期】',origin:'agent',status:'pending',needs_review:false,diff:[{type:'equal',old:'资产总额'},{type:'replace',old:'100',new:'120'},{type:'equal',old:'万元【待核对日期】'}]};
    const cellChange={...change,target_id:'c',before:'100',after:'120',diff:[{type:'replace',old:'100',new:'120'}]};
    S.p={id:'fixture',mode:'financial',changes:[change,cellChange],coverage:{},job:{status:'completed'},stats:{changes:2,scanned:2},document:{extension:'.docx',warnings:[],layout_tasks:[{target_id:'c',text:'【待确认：报告期列安排】'}],blocks:[{id:'h',type:'heading',level:1,text:'财务会计信息'},paragraph,{id:'table',type:'table',rows:[[{id:'header',text:'期末金额'}],[cell],[{id:'merged',text:'',merged:true}]]}]}};
    S.selected='p';S.changeIndex=new Map([['p',change],['c',cellChange]]);S.targetIndex=new Map([['p',paragraph],['c',cell]]);
    for(const view of ['revision','final']){
      S.view=view;
      const html=renderDocument();
      assert.ok(html.includes('普通预览') && html.includes('财务会计信息'));
      assert.ok(html.includes('doc-p') && html.includes('data-target="c"'));
      assert.ok(html.includes('is-selected') && html.includes('cell-changed'));
      assert.ok(html.includes('rowspan="2"') && !html.includes('doc-merged'));
      assert.ok(html.includes('【待核对日期】') && html.includes('【待确认：报告期列安排】'));
      assert.equal(html.includes('<del'),view==='revision');
      assert.ok(!html.includes('正在读取') && !html.includes('原格式预览暂时无法打开'));
    }
    let modalHtml='',requests=[];
    api=async url=>{requests.push(url);assert.equal(url,'/api/projects/fixture/files/source');return {id:'source',name:'附注.docx',extension:'.docx',category:'notes',size:100,uploaded_at:'2026-09-11',segments:[{id:'s1',text:'<script>示例</script>',locator:'正文段落 1'},{id:'s2',text:'资产总额120万元',locator:'表 1 · 第 2 行 · 第 2 列'}]};};
    openModal=(title,subtitle,body)=>{modalHtml=body;};
    await showSource('source','s2','资产总额120万元');
    assert.equal(requests.length,1);
    assert.ok(modalHtml.includes('id="src-s2" class="source-segment highlight"'));
    assert.ok(modalHtml.includes('表 1 · 第 2 行 · 第 2 列') && modalHtml.includes('资产总额120万元'));
    assert.ok(modalHtml.includes('&lt;script&gt;') && !modalHtml.includes('<script>'));
    assert.ok(modalHtml.includes('/files/source/raw'));
  })()`,context);
  assert.equal(located,'src-s2');
  console.log('PASS: Ordinary DOCX review keeps revisions, brackets, table highlights and source navigation without Word preview.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
