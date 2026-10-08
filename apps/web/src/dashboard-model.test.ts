import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardGroup, dashboardPresentation, dashboardHref, loadDashboardProjects, type DashboardProject } from './dashboard-model.js';
const project=(id:string,status:DashboardProject['status']='draft',kind:DashboardProject['kind']='update'):DashboardProject=>({project_id:id,name:id,draft_revision:1,updated_at:'2026-10-08T08:00:00Z',status,kind});
const page=(items:DashboardProject[],next:string|null=null)=>({items,page:{has_more:!!next,next_cursor:next}});
test('counts only delivered success as complete; in-flight settlement and old artifacts do not hide failures',()=>{
  for(const status of ['queued','running','preparing','validating','delivering','settlement_pending'] as const)assert.equal(dashboardGroup(project(status,status)),'active');
  for(const status of ['draft','failed','paused','cancelled','rejected','awaiting_input','test_completed'] as const)assert.equal(dashboardGroup({...project(status,status),latest_artifact:{artifact_id:'old',version:1,run_id:'old-run',created_at:'2026-10-07T00:00:00Z'}}),'attention');
  assert.equal(dashboardGroup(project('success','succeeded')),'done');
});
test('complete metadata pagination deduplicates and excludes archived/QA without treating page one as the total',async()=>{
  const pages=[page([project('a'),project('b','running','review')],'next'),page([project('b','running','review'),project('c','succeeded','generation'),project('q','draft','qa'),{...project('archived'),archived_at:'2026-10-01T00:00:00Z'}])];
  const seen:(string|undefined)[]=[];const result=await loadDashboardProjects(async cursor=>{seen.push(cursor);return pages.shift()!;},()=>false);
  assert.deepEqual(seen,[undefined,'next']);assert.deepEqual(result?.map(p=>p.project_id),['c','b','a']);
});
test('incomplete pagination and cancelled reads never return partial counts',async()=>{
  let calls=0;await assert.rejects(loadDashboardProjects(async()=>{if(calls++===0)return page([project('a')],'next');throw new Error('offline');},()=>false));
  await assert.rejects(loadDashboardProjects(async()=>page([project('a')],'same'),()=>false));
  assert.equal(await loadDashboardProjects(async()=>page([project('a')]),()=>true),null);
});
test('three task types open their own project and preserve dashboard filters; failed review opens task reason',()=>{
  const gen={...project('gen','succeeded','generation'),latest_run:{run_id:'run 1',state:'succeeded' as const,updated_at:'2026-10-08T00:00:00Z'}};
  assert.match(dashboardHref(gen,'generation','done'),/^#\/projects\/gen\?/);assert.match(dashboardHref(gen,'generation','done'),/run=run\+1/);
  assert.match(dashboardHref(project('review','failed','review'),'all','attention'),/review\?from=dashboard.*tab=making/);
  assert.match(dashboardHref(project('draft'),'update','attention'),/step=details/);
  assert.equal(dashboardPresentation(project('review','running','review')).action,'查看进度');
  assert.equal(dashboardPresentation(gen).action,'查看结果');
});
