import assert from 'node:assert/strict';
import test from 'node:test';
import {workpaperItemProgress} from './workpaper-item-progress.js';

const started='2026-11-13T13:20:00.000Z',updated='2026-11-13T13:38:00.000Z';
const running={run_id:'synthetic-run',run_state:'running',run_created_at:started,run_updated_at:started,last_event_at:updated,lease_interrupted:false};

test('workpaper progress retains the last business phase while ordinary activity refreshes time',()=>{
 const progress=workpaperItemProgress({...running,stage:'provider_call',progress_stage:'model_generation',progress_reason:'m4_writing_files'});
 assert.deepEqual(progress,{phase:'writing_files',started_at:started,updated_at:updated,interrupted:false});
 assert.equal(workpaperItemProgress({...running,progress_reason:'m4_reading_materials'})?.phase,'preparing_materials');
 assert.equal(workpaperItemProgress({...running,progress_reason:'m4_document_working'})?.phase,'generating');
 assert.equal(workpaperItemProgress({...running,progress_reason:'m4_registering_artifacts'})?.phase,'delivering');
});

test('quiet model calls remain generating; interruption requires the database lease observation',()=>{
 const quiet={...running,last_event_at:started,stage:'provider_call'};
 assert.equal(workpaperItemProgress(quiet)?.phase,'generating');
 assert.equal(workpaperItemProgress(quiet)?.interrupted,false);
 assert.equal(workpaperItemProgress({...quiet,lease_interrupted:true})?.interrupted,true);
 assert.equal(workpaperItemProgress({...quiet,run_state:'queued',lease_interrupted:true})?.interrupted,false);
});

test('workpaper progress represents queued, delivery and settlement states without leaking raw fields',()=>{
 for(const [state,phase] of [['queued','queued'],['validating','validating'],['delivering','delivering'],['settlement_pending','settling']] as const){
  const progress=workpaperItemProgress({...running,run_state:state,progress_reason:'m4_document_working',lease_interrupted:true});
  assert.equal(progress?.phase,phase);assert.equal(progress?.interrupted,false);
  assert.deepEqual(Object.keys(progress!).sort(),['interrupted','phase','started_at','updated_at']);
 }
 assert.equal(workpaperItemProgress({...running,stage:'private internal checkpoint'})?.phase,'preparing_materials');
});

test('historical and terminal items omit progress; valid timestamps fall back safely',()=>{
 for(const state of ['succeeded','failed','cancelled','paused','awaiting_input','rejected'])assert.equal(workpaperItemProgress({...running,run_state:state}),undefined);
 assert.equal(workpaperItemProgress({...running,run_id:null}),undefined);
 assert.equal(workpaperItemProgress({...running,run_created_at:'invalid'}),undefined);
 assert.equal(workpaperItemProgress({...running,last_event_at:'invalid',run_updated_at:new Date(updated)})?.updated_at,updated);
 assert.equal(workpaperItemProgress({...running,last_event_at:null,run_updated_at:null})?.updated_at,started);
});
