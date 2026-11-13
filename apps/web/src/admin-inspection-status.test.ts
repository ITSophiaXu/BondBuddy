import assert from 'node:assert/strict';
import test from 'node:test';
import type {AdminInspectionRow as Row} from '@bondbuddy/contracts';
import {statusGroups,statusGroup,matchesStatusFilter,summarizeStatus,drillStatusFilter} from './admin-inspection-status.js';

const fixture:Record<string,Array<string|null>>={
 update:['succeeded','succeeded','paused','failed','queued'],
 review:['succeeded','paused','failed','running','awaiting_input'],
 workpaper:['succeeded','cancelled','rejected','test_completed'],
 generation:['preparing','validating','delivering','settlement_pending','future_state',null]
};
const runs:Row[]=Object.entries(fixture).flatMap(([kind,states])=>states.map((state,index)=>({id:`${kind}_${index}`,task_kind:kind,state})));
const kindOf=(run:Row)=>String(run.task_kind);

test('all current execution states belong to exactly one status group',()=>{
 const states=statusGroups.flatMap(group=>[...group.states]);
 assert.equal(new Set(states).size,states.length);
 for(const group of statusGroups)for(const state of group.states)assert.equal(statusGroup(state),group.key);
 for(const state of [null,undefined,'','future_state',0])assert.equal(statusGroup(state),'unknown_state');
 assert.equal(statusGroup('test_completed'),'test_completed');
 assert.equal(statusGroup('awaiting_input'),'awaiting_input');
});

test('status totals and each business type reconcile without combining pauses, tests or unknowns',()=>{
 const summary=summarizeStatus(runs,kindOf);
 assert.equal(summary.total.total,20);
 assert.deepEqual(summary.total.counts,{succeeded:4,paused:2,failed:2,in_progress:6,awaiting_input:1,cancelled:1,rejected:1,test_completed:1,unknown_state:2});
 assert.equal(Object.values(summary.total.counts).reduce((a,b)=>a+b,0),20);
 assert.deepEqual(summary.types.map(type=>[type.kind,type.total]),[['update',5],['review',5],['workpaper',4],['generation',6]]);
 for(const type of summary.types)assert.equal(Object.values(type.counts).reduce((a,b)=>a+b,0),type.total);
 for(const {key} of statusGroups)assert.equal(summary.types.reduce((sum,type)=>sum+type.counts[key],0),summary.total.counts[key]);
 assert.equal(summary.types.find(type=>type.kind==='generation')?.counts.unknown_state,2);
});

test('business type resolver and current state determine counts, not a previous failure or retry count',()=>{
 const recovered:Row={id:'recovered',task_kind:'generation',state:'succeeded',previous_state:'failed',attempts:5,error_code:'HISTORICAL_ERROR'};
 const summary=summarizeStatus([recovered],()=> 'workpaper');
 assert.equal(summary.total.total,1);assert.equal(summary.total.counts.succeeded,1);assert.equal(summary.total.counts.failed,0);
 assert.equal(summary.types[0].kind,'workpaper');assert.equal(summary.types[0].total,1);
 assert.equal(recovered.state,'succeeded');
});

test('empty scope has explicit zero counts and no invented task types',()=>{
 const summary=summarizeStatus([],kindOf);
 assert.equal(summary.total.total,0);assert.deepEqual(summary.types,[]);
 assert.deepEqual(Object.keys(summary.total.counts),statusGroups.map(group=>group.key));
 assert.ok(Object.values(summary.total.counts).every(count=>count===0));
});

test('state filters distinguish grouped ongoing work, unknown state and exact states',()=>{
 assert.equal(runs.filter(run=>matchesStatusFilter(run.state,'')).length,20);
 assert.equal(runs.filter(run=>matchesStatusFilter(run.state,'in_progress')).length,6);
 assert.equal(runs.filter(run=>matchesStatusFilter(run.state,'unknown_state')).length,2);
 assert.equal(runs.filter(run=>matchesStatusFilter(run.state,'queued')).length,1);
 assert.equal(runs.filter(run=>matchesStatusFilter(run.state,'paused')).length,2);
 assert.equal(runs.filter(run=>matchesStatusFilter(run.state,'future_state')).length,1);
 assert.equal(matchesStatusFilter('succeeded','test_completed'),false);
 assert.equal(matchesStatusFilter('paused','in_progress'),false);
 assert.equal(matchesStatusFilter('failed','attention'),false);
});

test('drilling a nonzero group preserves any narrower exact state or existing total scope',()=>{
 for(const current of ['','queued','running','paused','failed','in_progress','unknown_state','future_state']){
  const filtered=runs.filter(run=>matchesStatusFilter(run.state,current));
  assert.equal(drillStatusFilter(current,''),current);
  for(const {key} of statusGroups){
   const counted=filtered.filter(run=>statusGroup(run.state)===key);
   if(!counted.length)continue;
   const drilled=runs.filter(run=>matchesStatusFilter(run.state,drillStatusFilter(current,key)));
   assert.deepEqual(drilled.map(run=>run.id),counted.map(run=>run.id),`${current||'all'} -> ${key}`);
  }
 }
 assert.equal(drillStatusFilter('queued','in_progress'),'queued');
 assert.equal(drillStatusFilter('future_state','unknown_state'),'future_state');
});

test('attention and stale drilling keep the evidence-dependent active subset',()=>{
 assert.equal(drillStatusFilter('stale','in_progress'),'stale');
 assert.equal(drillStatusFilter('stale',''),'stale');
 assert.equal(drillStatusFilter('attention','in_progress'),'stale');
 for(const state of ['paused','awaiting_input','failed','rejected'])assert.equal(drillStatusFilter('attention',state),state);
 assert.equal(drillStatusFilter('attention',''),'attention');
});
