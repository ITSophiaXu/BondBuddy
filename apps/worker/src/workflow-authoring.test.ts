import test from 'node:test';
import assert from 'node:assert/strict';
import {PerformanceTraceRuntime,withPerformanceSpan,type PerformanceSpanRecord,type PerformanceSessionRecord} from '@bondbuddy/api/performance-trace';
import {buildAuthoringPlan,logicalChapterCall,validateProjection,assembleProjections,callDeadline,repairCallDeadline,blockIdentity,verifyPlan} from './workflow-authoring.js';
const h='a'.repeat(64), refs=['m0:0'];
const plan=()=>buildAuthoringPlan({inputHash:h,baselineHash:null,materialSnapshotHash:h,knowledgeHash:h,chapters:[{title:'第一章',source_node_ids:[]}],contextRefs:refs});
const projection=()=>({version:'document-projection-v1' as const,input_hash:h,plan_hash:plan().plan_hash,chapter_id:'chapter-0',batch_id:'batch-0',blocks:[{block_id:blockIdentity(plan().plan_hash,'chapter-0','batch-0',0),order:0,kind:'paragraph' as const,text:'text',rows:[],evidence:refs,pending:[],heading_level:null,style_key:'body' as const,table_id:null,row_order:null}],summary:[]});
test('logical call is stable across lease/token changes and changes on revision',()=>{
  assert.equal(logicalChapterCall('run',plan(),0,0,0),logicalChapterCall('run',plan(),0,0,0));
  assert.notEqual(logicalChapterCall('run',plan(),0,0,0),logicalChapterCall('run',plan(),0,0,1));
});
test('chapter budget is capped by persisted run deadline',()=>{
  assert.equal(callDeadline('2026-11-21T01:00:00Z',20*60000,Date.parse('2026-11-21T00:59:00Z')),60000);
  assert.throws(()=>callDeadline('2026-11-21T01:00:00Z',20*60000,Date.parse('2026-11-21T01:01:00Z')),/DEADLINE/);
});
test('later repairs share remaining run repair time and never extend the batch deadline',()=>{
  const now=Date.parse('2026-11-21T00:00:00Z'),run=new Date(now+1200000).toISOString(),batch=new Date(now+300000).toISOString();
  assert.equal(repairCallDeadline(run,1200000,300000,295000,batch,now),5000);
  assert.equal(repairCallDeadline(run,1200000,300000,0,new Date(now+1000).toISOString(),now),1000);
  assert.equal(repairCallDeadline(new Date(now+500).toISOString(),1200000,300000,0,batch,now),500);
  assert.throws(()=>repairCallDeadline(run,1200000,300000,300000,batch,now),/REPAIR_BUDGET/);
  assert.throws(()=>repairCallDeadline(run,1200000,300000,0,new Date(now-1).toISOString(),now),/DEADLINE/);
});
test('scope and evidence cannot cross frozen chapter boundary',()=>{
  const p={...projection(),extra:true};
  assert.throws(()=>validateProjection(p,plan(),0,0),/PROJECTION|SCOPE/);
  assert.throws(()=>validateProjection({...projection(),chapter_id:'other'},plan(),0,0),/SCOPE/);
});
test('missing and duplicate batch cannot produce a whole document',()=>{
  assert.throws(()=>assembleProjections(plan(),[]),/INCOMPLETE/);
  assert.throws(()=>assembleProjections(plan(),[projection(),projection()]),/CONFLICT/);
});
test('verified complete projection preserves stable identity and whole document hash',()=>{
  validateProjection(projection(),plan(),0,0);const assembled=assembleProjections(plan(),[projection()]);
  assert.equal(assembled.blocks[0]?.block_id,projection().blocks[0]!.block_id);
  assert.equal(assembled.plan_hash.length,64);
  assert.notEqual(assembled.plan_hash,plan().plan_hash);
});
test('all source nodes have exactly one deterministic batch and no truncation',()=>{
  const nodes=Array.from({length:25},(_,i)=>({node_id:`node-${i}`,kind:'paragraph',text:'text'}));
  const p=buildAuthoringPlan({inputHash:h,baselineHash:h,materialSnapshotHash:h,knowledgeHash:h,contextRefs:refs,chapters:[{title:'chapter',source_node_ids:nodes.map(n=>n.node_id)}],nodes});
  assert.deepEqual(p.chapters[0]!.batches.map(b=>b.allowed_node_ids.length),[12,12,1]);
  verifyPlan(p);
  assert.throws(()=>buildAuthoringPlan({inputHash:h,baselineHash:h,materialSnapshotHash:h,knowledgeHash:h,contextRefs:refs,chapters:[{title:'chapter',source_node_ids:['node-0']}],nodes}),/COVERAGE/);
});
test('missing evidence and oversized or nonrectangular tables reject before commit',()=>{
  const p=projection();p.blocks[0]!.evidence=[];assert.throws(()=>validateProjection(p,plan(),0,0),/EVIDENCE/);
  const table={...projection(),blocks:[{...projection().blocks[0]!,kind:'table' as const,style_key:'table' as const,table_id:'t',row_order:0,rows:[['a','b'],['c']]}]};
  assert.throws(()=>validateProjection(table,plan(),0,0),/TABLE/);
});

test('chapter telemetry retains batch and call identity through nested tools without invalidating coverage',async()=>{
  const spans=new Map<string,PerformanceSpanRecord>(),sessions=new Map<string,PerformanceSessionRecord>();
  const runtime=new PerformanceTraceRuntime(async(ss,ps)=>{for(const s of ss)sessions.set(s.session_id,s);for(const p of ps)spans.set(p.span_id,p);});
  const attrs={chapter_id:'chapter-0',batch_id:'batch-0',logical_call_id:h};
  await runtime.trace({ownerUserId:'owner',projectId:'project',runId:'run',jobId:'job'},async()=>{
    await withPerformanceSpan('workflow.chapter.call',attrs,async()=>{
      await withPerformanceSpan('model.exec',{},()=>withPerformanceSpan('model.tool',{tool_type:'read'},()=>undefined));
    });
    await withPerformanceSpan('workflow.chapter.persist',attrs,()=>undefined);
    await withPerformanceSpan('workflow.chapter.commit',attrs,()=>undefined);
  });
  await runtime.drain();
  const rows=[...spans.values()].filter(s=>s.step_key!=='run.execution');
  assert.equal(rows.length,5);
  for(const row of rows){assert.equal((row.attributes as Record<string,unknown>).chapter_id,attrs.chapter_id,row.step_key);assert.equal(row.attributes.batch_id,attrs.batch_id);assert.equal(row.attributes.logical_call_id,h);}
  assert.equal([...sessions.values()][0]!.invalid_attributes,0);
  assert.equal([...sessions.values()][0]!.complete,true);
});
