import contextlib,copy,importlib.util,io,json,pathlib,sys,tempfile,unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('driver',ROOT/'run_main_cutover.py');d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
PLAN=json.loads((ROOT/'main-plan.synthetic.json').read_bytes())
class Fake:
 failure=None;latest=None
 def __init__(self,plan,root,owner):
  Fake.latest=self;self.p=plan;self.root=pathlib.Path(root);self.fds=[];self.calls=[];self.state={'switched':{}};self.ids={r:plan['snapshot']['components'][r]['id'] for r in d.a.ROLES};self.did_fail=False
 def mark(self,name):
  self.calls.append(name)
  if Fake.failure==name and not self.did_fail:self.did_fail=True;raise RuntimeError('injected '+name)
  return {'passed':name}
 def save(self,*x):pass
 def atomic(self,*x):pass
 def proof(self,*x):return {}
 def prepare(self):return self.mark('prepare')
 def close_ingress(self):self.state.update(ingress_close_intent=True,ingress_closed=True);return self.mark('close')
 def observe(self):return dict(leases=0,holders=0,ops_leases=0,upload_leases=0,review_leases=0,queued_jobs=1,queued_runs=1,ready_sessions=2)
 def hold_control(self):return self.mark('control')
 def stop_producers(self,p):return self.mark('stop')
 def migrate(self,p):self.state['migration_attempt']={'xid':'123'};return self.mark('migrate')
 def apply_acl(self,p):return self.mark('acl')
 def switch(self,r,p,rollback=False):
  self.state['mutation_intent']={'role':r,'kind':'rollback' if rollback else 'candidate'};self.ids[r]=('rollback-' if rollback else 'new-')+r
  result=self.mark(('rollback-' if rollback else 'switch-')+r);self.state['switched'][r]={'id':self.ids[r]};return result
 def verify_internal(self,p):self.state['internal_verified']=True;return self.mark('internal')
 def open_ingress(self,rollback=False):
  if not rollback:self.state['public_write_boundary']=True
  self.state['ingress_opened']=True;return self.mark('open-rollback' if rollback else 'open')
 def verify_live(self,rollback=False):return self.mark('live-rollback' if rollback else 'live')
 def commit_components(self,rollback=False):self.state['components_committed']=True;return self.mark('manifest-rollback' if rollback else 'manifest')
 def complete(self):self.state['phase']='complete';return self.mark('complete')
 def abort_unmutated(self):return self.mark('abort')
 def inspect(self,r):return {'Id':self.ids[r]}
 def reconcile_migration(self):return self.mark('reconcile-migration')
 def reconcile(self,r,kind):self.state['switched'][r]={'id':self.ids[r]};return self.mark('reconcile-'+r)
 def restore_original(self,r):return self.mark('restore-original-'+r)
 def verify(self,r):return self.mark('verify-'+r)
class DriverTests(unittest.TestCase):
 def run_driver(self,failure=None):
  Fake.failure=failure
  with tempfile.TemporaryDirectory() as folder:
   folder=pathlib.Path(folder);(folder/'backup.json').write_text('{}');(folder/d.a.MIGRATION).write_bytes((ROOT/d.a.MIGRATION).read_bytes());(folder/'managed-performance-grants.sql').write_bytes((ROOT/'managed-performance-grants.sql').read_bytes());out=io.StringIO();argv=['driver','--plan',str(ROOT/'main-plan.synthetic.json'),'--root',str(folder/'run'),'--owner','test-owner-1420','--backup-receipt',str(folder/'backup.json'),'--sql-directory',str(folder),'--execute'];code=0
   with patch.object(d.a,'Main',Fake),patch.object(sys,'argv',argv),contextlib.redirect_stdout(out):
    try:d.main()
    except SystemExit as error:code=error.code
   return Fake.latest.calls,[json.loads(x) for x in out.getvalue().splitlines()],code
 def test_success_orders_probe_before_stop_and_exact_roles(self):
  calls,events,code=self.run_driver();self.assertEqual(code,0);self.assertEqual(calls,['prepare','close','control','stop','migrate','acl','switch-api','switch-web','switch-ops','internal','open','live','manifest','complete']);self.assertEqual(events[-1]['status'],'PASS')
 def test_prepare_failure_clears_only_unmutated_pending(self):
  calls,events,code=self.run_driver('prepare');self.assertEqual(code,1);self.assertEqual(calls,['prepare','abort']);self.assertFalse(events[-1]['owned_pending_retained'])
 def test_partial_web_switch_reconciles_then_restores_original_entry(self):
  calls,events,code=self.run_driver('switch-web');self.assertEqual(code,1);self.assertIn('reconcile-web',calls);self.assertIn('rollback-api',calls);self.assertIn('rollback-web',calls);self.assertIn('restore-original-ops',calls);self.assertIn('open-rollback',calls);self.assertNotIn('open',calls);self.assertFalse(events[-1]['owned_pending_retained'])
 def test_after_public_write_boundary_only_completes_forward(self):
  calls,events,code=self.run_driver('live');self.assertEqual(code,0);self.assertNotIn('open-rollback',calls);self.assertFalse(any(x.startswith('rollback-') for x in calls));self.assertEqual(events[-1]['status'],'PASS_RECOVERED_FORWARD');self.assertEqual(calls[-4:],['open','live','manifest','complete'])
if __name__=='__main__':unittest.main(verbosity=2)
