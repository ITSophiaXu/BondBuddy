import test from 'node:test';
import assert from 'node:assert/strict';
import {Value} from '@sinclair/typebox/value';
import {adminSchemas} from './admin-logs.js';

test('workflow operational alerts survive the strict admin response contract',()=>{
  const kinds=['spool_pending_stale','spool_low_disk','provider_due_scan_stale','workflow_handoff_stale','workflow_chapter_budget_exhausted','workflow_usage_unknown'];
  const alert=(kind:string)=>({items:[{alert_id:'synthetic-alert',kind,severity:'warning',detail:{run_id:'synthetic-run'},created_at:'2026-11-21T00:00:00Z',acked_at:null}]});
  for(const kind of kinds)assert.equal(Value.Check(adminSchemas.AdminAlertsResponse,alert(kind)),true,kind);
  assert.equal(Value.Check(adminSchemas.AdminAlertsResponse,alert('unregistered_kind')),false);
  assert.equal(Value.Check(adminSchemas.AdminAlertsResponse,{items:[{...alert(kinds[0]!).items[0],detail:{private_payload:'x'.repeat(129)}}]}),false);
});
