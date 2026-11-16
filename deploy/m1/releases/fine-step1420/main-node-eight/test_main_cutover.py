import copy,datetime,importlib.util,json,pathlib,tempfile,unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('adapter',ROOT/'main-cutover-adapter.py');a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
PLAN=json.loads((ROOT/'main-plan.synthetic.json').read_bytes())
def guarded():
 s=a.Main.__new__(a.Main);s.p=copy.deepcopy(PLAN);s.owner='test-owner-1420';s.fds=[None]*len(PLAN['snapshot']['locks']);s.state={};s.locks=lambda:{};s.pending_check=lambda:None;s.protected=lambda:None
 c={'handler':'static_response','status_code':503};s.caddy=lambda:c;s.inspect=lambda r:{'HostConfig':{'NetworkMode':'bb-main_default','PortBindings':{'8080/tcp':[{'HostIp':'127.0.0.1','HostPort':'18090'}]}}}
 db={'leases':0,'holders':0,'ops_leases':0,'upload_leases':0,'review_leases':0,'queued_jobs':1,'queued_runs':1,'ready_sessions':2,'jobs_running':0,'runs_active_states':0,'policy':{'node_model_limit':8,'global_model_limit':8,'max_nodes':2,'budget_available':False}}
 s.observe=lambda:db;s.queued_fingerprint=lambda:{'jobs':{'count':1,'sha256':'a'*64},'runs':{'count':1,'sha256':'b'*64}}
 proof={'owner':s.owner,'source':PLAN['base_source'],'closed_caddy_sha256':a.sha(c),'ingress_closed':True,'direct_public_write_paths_closed':True,'backup':{'producer_exit':0,'decoder_exit':0,'full_archive_decoded':True,'bytes':100000,'sha256':'c'*64,'source_container_id':PLAN['snapshot']['preserved']['postgres']['id'],'ledger_sha256':a.sha(PLAN['ledger_before']),'completed_at':a.utc()}}
 return s,proof,db
class Boundaries(unittest.TestCase):
 def test_valid_plan(self): self.assertTrue(a.validate_plan(PLAN))
 def test_plan_rejects_old_source_image_ledger_policy_and_scope(self):
  mutations=[lambda p:p.update(base_source='f4894e7f'),lambda p:p.update(api_image='sha256:3595f2e15dfc36891f04f6178e9d4dd74f35b885a93645ea3ed28f7a0773fdfd'),lambda p:p['ledger_before'].pop(),lambda p:p.update(preserve_node_model_limit=4),lambda p:p['targets'].update({'worker-parse':{}}),lambda p:p['snapshot']['components']['api']['code_mounts'].pop(),lambda p:p['mount_file_preimages'].pop()]
  for mutation in mutations:
   p=copy.deepcopy(PLAN);mutation(p)
   with self.subTest(p=str(mutation)),self.assertRaises(RuntimeError):a.validate_plan(p)
 def test_queued_jobs_and_ready_workers_do_not_block(self):
  s,p,d=guarded();self.assertEqual(s.guard(p)['queued_jobs'],1);self.assertEqual(s.guard(p)['ready_sessions'],2)
 def test_live_budget_true_is_preserved_and_allowed(self):
  s,p,d=guarded();d['policy']['budget_available']=True;before=copy.deepcopy(d['policy']);s.run=lambda *args,**kw:self.fail('no policy writes allowed')
  self.assertTrue(s.guard(p)['policy']['budget_available']);self.assertEqual(d['policy'],before)
 def test_each_main_producer_lease_blocks(self):
  for key in ('ops_leases','upload_leases'):
   s,p,d=guarded();d[key]=1
   with self.subTest(key=key),self.assertRaisesRegex(RuntimeError,'PRODUCER_LEASES'):s.guard(p)
 def test_existing_worker_progress_does_not_block(self):
  s,p,d=guarded();d.update(leases=1,holders=8,review_leases=1,queued_jobs=0,queued_runs=0);s.state['queued_fingerprint']={'old':'allowed to progress'}
  self.assertEqual(s.guard(p)['leases'],1);self.assertEqual(s.guard(p)['holders'],8)
 def test_backup_cannot_be_faked_by_only_boolean(self):
  s,p,d=guarded();p['backup']={'verified':True}
  with self.assertRaisesRegex(RuntimeError,'BACKUP_REQUIRED'):s.guard(p)
 def test_backup_source_and_full_decode_required(self):
  for key,value in (('source_container_id','other'),('ledger_sha256','d'*64),('decoder_exit',1),('full_archive_decoded',False)):
   s,p,d=guarded();p['backup'][key]=value
   with self.subTest(key=key),self.assertRaises(RuntimeError):s.guard(p)
 def test_control_locks_required_at_mutation_guard(self):
  s,p,d=guarded();s.fds=s.fds[:3]
  with self.assertRaisesRegex(RuntimeError,'CONTROL_LOCK_BARRIER'):s.guard(p)
 def test_remaining_proxy_is_rejected(self):
  with self.assertRaisesRegex(RuntimeError,'REVERSE_PROXY'):a.closed_caddy({'handlers':[{'handler':'static_response','status_code':503},{'handler':'reverse_proxy','upstreams':[{'dial':'127.0.0.1:18090'}]}]})
 def test_arbitrary_static_status_not_closed(self):
  with self.assertRaisesRegex(RuntimeError,'503_REQUIRED'):a.closed_caddy({'handler':'static_response','status_code':200})
 def test_public_or_host_bind_rejected(self):
  for host,mode in (('0.0.0.0','bridge'),('','bridge'),('127.0.0.1','host')):
   with self.subTest(host=host,mode=mode),self.assertRaises(RuntimeError):a.direct_loopback({'HostConfig':{'NetworkMode':mode,'PortBindings':{'80/tcp':[{'HostIp':host}]}}})
 def test_unknown_role_rejected_before_io(self):
  s,p,d=guarded();s.inspect=lambda r:self.fail('unexpected inspect')
  for role in ('postgres','worker-parse','authoring','review','../api'):
   with self.subTest(role=role),self.assertRaisesRegex(RuntimeError,'ROLE_SCOPE'):s.switch(role,p)
 def test_host_preimage_detects_changed_bytes(self):
  with tempfile.TemporaryDirectory() as folder:
   path=pathlib.Path(folder)/'control.mjs';path.write_text('before');s=a.Main.__new__(a.Main);s.p={'snapshot':{'components':{'ops':{'code_mounts':[],'config_files':{}}}},'mount_file_preimages':[{'role':'ops','host':str(path),'target':'/app/control.mjs','bytes':6,'sha256':a.rawsha(b'before')}]};c={'State':{'Pid':0,'Running':False}}
   s.preimages('ops',c,False);path.write_text('after!')
   with self.assertRaisesRegex(RuntimeError,'HOST_MOUNT_PREIMAGE_DRIFT'):s.preimages('ops',c,False)
 def test_unknown_commit_cannot_be_retried_or_marked_committed(self):
  s=a.Main.__new__(a.Main);s.state={'migration_attempt':{'xid':'123'}};s.p=PLAN;s.sql=lambda q:{'xid_status':'in progress','ledger':PLAN['ledger_before'],'sessions':False,'spans':False};s.commit_state=lambda phase:s.state.update(phase=phase)
  with self.assertRaisesRegex(RuntimeError,'STILL_IN_PROGRESS'):s.reconcile_migration()
  self.assertEqual(s.state['phase'],'migration_unknown');self.assertNotIn('commit_confirmed',s.state['migration_attempt'])
 def test_committed_xid_requires_exact189_and_both_tables(self):
  for ledger,tables in ((PLAN['ledger_before'],True),(PLAN['ledger_after'],False)):
   s=a.Main.__new__(a.Main);s.state={'migration_attempt':{'xid':'123'}};s.p=PLAN;s.sql=lambda q:{'xid_status':'committed','ledger':ledger,'sessions':tables,'spans':tables};s.commit_state=lambda phase:s.state.update(phase=phase)
   with self.subTest(ledger=len(ledger)),self.assertRaisesRegex(RuntimeError,'COMMITTED_SCHEMA_MISMATCH'):s.reconcile_migration()
 def test_committed_xid_reconciles_without_ddl(self):
  s=a.Main.__new__(a.Main);s.state={'migration_attempt':{'xid':'123'}};s.p=PLAN;s.sql=lambda q:{'xid_status':'committed','ledger':PLAN['ledger_after'],'sessions':True,'spans':True};s.commit_state=lambda phase:s.state.update(phase=phase);s.run=lambda *args,**kw:self.fail('DDL must not run')
  r=s.reconcile_migration();self.assertEqual(r['ledger_count'],189);self.assertTrue(s.state['migration_attempt']['commit_confirmed'])
 def test_aborted_xid_requires_no_tables(self):
  s=a.Main.__new__(a.Main);s.state={'migration_attempt':{'xid':'123'}};s.p=PLAN;s.sql=lambda q:{'xid_status':'aborted','ledger':PLAN['ledger_before'],'sessions':True,'spans':False};s.commit_state=lambda phase:None
  with self.assertRaisesRegex(RuntimeError,'ABORTED_SCHEMA_MISMATCH'):s.reconcile_migration()
 def test_restore_original_refuses_post_open_boundary(self):
  s,p,d=guarded();s.state['public_write_boundary']=True
  with self.assertRaisesRegex(RuntimeError,'RESTORE_SCOPE'):s.restore_original('api')
 def test_ownership_rejects_foreign_or_missing_labels(self):
  s,p,d=guarded()
  for labels in ({},{a.LABEL+'owner':'other',a.LABEL+'kind':'candidate',a.LABEL+'plan':a.sha(PLAN)}):
   with self.subTest(labels=labels),self.assertRaisesRegex(RuntimeError,'OWNED_CONTAINER'):s.ownership({'Config':{'Labels':labels}},'candidate')
 def test_prepare_does_not_call_stop_guard_or_caddy_mutation(self):
  import inspect
  source=inspect.getsource(a.Main.prepare)
  self.assertNotIn('stop_producers(',source);self.assertNotIn('self.guard(',source);self.assertNotIn('caddy_set(',source);self.assertIn("'create'",source);self.assertIn("'--no-build'",source)
if __name__=='__main__': unittest.main(verbosity=2)
