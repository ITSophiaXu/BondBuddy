import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadProjectCollection, taskHref, taskView, inFolder, type ProjectTask, type ProjectItem, type ProjectFile } from './project-collection-model.js';
import { authoringTasks,taskLabel } from './project-collection-model.js';
const task=(state:ProjectTask['state']='running',kind:ProjectTask['kind']='update'):ProjectTask=>({run_id:'exact-run',project_id:'project 1',kind,state,stage:null,created_at:'2026-10-20T00:00:00Z',updated_at:'2026-10-20T00:00:00Z',artifact_id:null,report_id:null,topic_id:null,document_type:null,operation:null});
test('authoring restore pages past newer review and topic tasks without selecting another project',async()=>{
 const reads:(string|undefined)[]=[];
 const result=await authoringTasks(async cursor=>{reads.push(cursor);return {project_id:'project 1',items:cursor?[task('paused'),{...task('succeeded','generation'),run_id:'legacy'}, {...task(),project_id:'foreign'}]:[task('running','review'),{...task('running','generation'),topic_id:'topic'}],page:{has_more:!cursor,next_cursor:cursor?null:'next'}};},'project 1',()=>false);
 assert.deepEqual(reads,[undefined,'next']);assert.deepEqual(result.map(t=>t.run_id),['exact-run','legacy']);
});
test('authoring restore rejects looping pagination instead of showing incomplete task history',async()=>{
 await assert.rejects(authoringTasks(async()=>({project_id:'p',items:[],page:{has_more:true,next_cursor:'same'}}),'p',()=>false),/pagination/);
});
test('task links keep exact execution and route by actual task kind, including file topics',()=>{
  assert.match(taskHref({...task('failed','review'),report_id:'report-1'}),/project%201\/review\?from=projects&run=exact-run&tab=making&report_id=report-1/);
  assert.match(taskHref({...task('succeeded'),artifact_id:'old-result'}),/#\/artifacts\/old-result/);
  assert.match(taskHref({...task('running','generation'),topic_id:'topic-1'}),/#generate\?from=projects&run=exact-run&topic=topic-1/);
  assert.match(taskHref(task('paused')),/run=exact-run/);
  assert.equal(taskHref({...task('succeeded','review'),operation:'revision',artifact_id:'exact-edition'}),'#/artifacts/exact-edition');
});
test('all runtime states have accurate actions and unknown phases never leak logs',()=>{
  for(const state of ['preparing','queued','running','validating','delivering','settlement_pending'] as const)assert.equal(taskView(task(state)).action,'查看进度');
  for(const state of ['failed','rejected'] as const)assert.equal(taskView(task(state)).action,'查看原因');
  assert.equal(taskView(task('succeeded')).tone,'done');assert.equal(taskView(task('test_completed')).tone,'attention');
  assert.equal(taskView({...task(),stage:'private prompt contents'}).detail,'正在更新募集书');
});

test('historical file-update task links retain the original run independently of check identity',()=>{
  const patch={...task('succeeded','generation'),operation:'file_patch' as const,project_id:'project / 债券',run_id:'patch?old&run=1'};
  const target=taskHref(patch),query=new URLSearchParams(target.split('?')[1]);
  assert.ok(target.startsWith('#consistency?'));assert.equal(query.get('project'),patch.project_id);
  assert.equal(query.get('update_run'),patch.run_id);assert.equal(query.has('run'),false);
  const check={...patch,operation:'file_check' as const,run_id:'check / 旧轮'};
  const checkQuery=new URLSearchParams(taskHref(check).split('?')[1]);
  assert.equal(checkQuery.get('run'),check.run_id);assert.equal(checkQuery.has('update_run'),false);
});

test('file-update failure entry promises its recorded task state rather than an unavailable failure cause',()=>{
  const failed={...task('failed','generation'),operation:'file_patch' as const};
  for(const state of ['failed','rejected'] as const){
    assert.equal(taskView({...failed,state}).action,'查看任务');
    assert.equal(taskView({...failed,state,operation:'file_check'}).action,'查看原因');
  }
  assert.equal(taskView({...failed,state:'running'}).action,'查看进度');
  assert.equal(taskView({...failed,state:'succeeded'}).action,'查看结果');
});
test('collection pagination never turns partial pages into totals; empty and abort are distinct',async()=>{
  const item=(id:string):ProjectItem=>({project_id:id,name:id,draft_revision:1,updated_at:'2026-10-20T00:00:00Z'});
  let n=0;const rows=await loadProjectCollection(async()=>++n===1?{items:[item('a')],page:{has_more:true,next_cursor:'2'}}:{items:[item('a'),item('b')],page:{has_more:false,next_cursor:null}},()=>false);
  assert.equal(rows?.length,2);
  await assert.rejects(loadProjectCollection(async()=>({items:[item('a')],page:{has_more:true,next_cursor:'same'}}),()=>false));
  assert.equal(await loadProjectCollection(async()=>({items:[],page:{has_more:false,next_cursor:null}}),()=>true),null);
});
test('file tree includes child files directly in parent folders',()=>{
  const file={folder:'4.2'} as ProjectFile;assert.ok(inFolder(file,'4'));assert.ok(inFolder(file,'all'));assert.ok(!inFolder(file,'4.1'));
});
test('workpaper checks keep exact execution routes and never restore as prospectus authoring',async()=>{
  const checks=['workpaper_assessment','workpaper_check'].map(operation=>({...task('paused','generation'),run_id:operation,operation}));
  for(const t of checks){
    const url=taskHref(t),q=new URLSearchParams(url.split('?')[1]);
    assert.ok(url.startsWith('#generate?'));assert.equal(q.get('run'),t.run_id);assert.equal(q.get('operation'),t.operation);
    assert.equal(q.get('project'),t.project_id);assert.equal(q.get('step'),'workpapers');assert.match(taskLabel(t),/底稿/);
  }
  assert.deepEqual(await authoringTasks(async()=>({project_id:'project 1',items:checks,page:{has_more:false,next_cursor:null}}),'project 1',()=>false),[]);
  let pages=0;const observed:ProjectTask[]=[];
  assert.deepEqual(await authoringTasks(async cursor=>{pages++;return {project_id:'project 1',items:cursor?[checks[0]]:[checks[1]],page:{has_more:!cursor,next_cursor:cursor?null:'older'}};},'project 1',()=>false,t=>observed.push(t)),[]);
  assert.equal(pages,2);assert.deepEqual(observed,[checks[1],checks[0]]);
});
