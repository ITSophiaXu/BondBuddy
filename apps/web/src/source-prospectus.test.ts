import assert from 'node:assert/strict';
import test from 'node:test';
import { reportingWindow, type SourceProspectus } from '@bondbuddy/contracts';
import { clearSourceSelections, readSourceFields, sourceFields } from './source-prospectus.js';

const material={material_id:'synthetic-original',material_version:2,sha256:'a'.repeat(64),role:'historical'};
const source:SourceProspectus={...material,issuer_name:'Old declared issuer',relation:'parent',market:'sse',offering:'private',
  reporting_periods:[{start:'2023-04-01',end:'2024-03-30',period_kind:'annual',scope:'parent',status:'user_asserted',evidence_refs:[]}],status:'user_asserted'};
function fields(values:Record<string,string>,quarter=''){
  return {querySelector:(selector:string)=>selector.endsWith(':checked')?(quarter?{value:quarter}:null):
    {value:values[selector.match(/data-source-field="([^"]+)"/)![1]]??''}} as unknown as HTMLElement;
}

test('the shared source form starts a replacement empty even when the old revision has the same hash',()=>{
  clearSourceSelections();
  const html=sourceFields(material,[{...source,material_version:1}],'synthetic-supplement');
  assert.match(html,/请补齐企业关系、原发行市场、原品种、原稿最新报告期后继续/);
  assert.doesNotMatch(html,/value="parent" selected|value="sse" selected|value="private" selected/);
  assert.doesNotMatch(html,/原稿发行人|Old declared issuer/);
  const next=readSourceFields(fields({relation:'subsidiary',market:'sse',offering:'private',year:'2025'}),material,undefined,'relation','synthetic-supplement');
  assert.equal(next.issuer_name,null);assert.deepEqual(next.reporting_periods,[]);assert.equal(next.material_version,2);
});

test('source controls preserve exact legacy periods on unrelated edits and isolate radio groups by scope',()=>{
  clearSourceSelections();
  const next=readSourceFields(fields({relation:'same_issuer',market:'sse',offering:'private',year:'2024'}),material,source,'relation','run-one');
  assert.deepEqual(next.reporting_periods,source.reporting_periods);assert.equal(next.issuer_name,source.issuer_name);
  const names=(scope:string)=>sourceFields(material,[source],scope).match(/name="([^"]+)"/g);
  assert.notDeepEqual(names('run-one'),names('run-two'));
  const changed=readSourceFields(fields({relation:'parent',market:'nafmii',offering:'mtn',year:'2025'},'09-30'),material,source,'quarter','run-one');
  assert.deepEqual(changed.reporting_periods,reportingWindow('nafmii','mtn','2025-09-30'));
  const incompatible=readSourceFields(fields({relation:'parent',market:'sse',offering:'mtn',year:'2025'},'09-30'),material,source,'market','run-one');
  assert.equal(incompatible.offering,null);
});
