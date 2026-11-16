"""One-command main-only release driver. Validate is default; --execute is explicit.
Root stages this file, main-cutover-adapter.py, bound plan, the two pinned SQL files
and a real off-host backup receipt. No model calls, worker stop, cloud action or DB restore.
"""
import argparse,importlib.util,json,os,pathlib,sys,time,traceback
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('main1420',HERE/'main-cutover-adapter.py');a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
def emit(v): print(json.dumps(v,sort_keys=True),flush=True)
def main():
 p=argparse.ArgumentParser();p.add_argument('--plan',required=True);p.add_argument('--root');p.add_argument('--owner');p.add_argument('--backup-receipt');p.add_argument('--sql-directory',default=str(HERE));p.add_argument('--execute',action='store_true');p.add_argument('--drain-timeout',type=int,default=300);args=p.parse_args()
 plan=a.read(args.plan);a.validate_plan(plan);a.need(1<=args.drain_timeout<=600,'BOUNDED_DRAIN_TIMEOUT')
 if not args.execute: emit({'status':'PASS','plan_valid':True,'production_changed':False,'execute_required':True});return
 a.need(args.root and args.owner and args.backup_receipt,'ROOT_OWNER_BACKUP_REQUIRED');backup=a.read(args.backup_receipt);session=a.Main(plan,args.root,args.owner);events=[];current='prepare';finished=False
 def step(name,fn):
  nonlocal current
  current=name;emit({'event':'starting','step':name,'at':a.utc()});result=fn();events.append({'step':name,'status':'PASS','at':a.utc(),'result':result});session.save('driver-events.private.json',events);emit({'event':'completed','step':name,'result':result});return result
 def proof(): return session.proof(backup)
 def wait_idle():
  deadline=time.monotonic()+args.drain_timeout;last=0
  while True:
   d=session.observe();active={k:d[k] for k in ('ops_leases','upload_leases')}
   if all(v==0 for v in active.values()): return {'actual_active':active,'queued_jobs':d['queued_jobs'],'queued_runs':d['queued_runs'],'ready_sessions':d['ready_sessions'],'worker_stopped':False,'observed_worker_job_leases':d.get('leases'),'observed_review_leases':d.get('review_leases'),'observed_model_holders':d.get('holders')}
   a.need(time.monotonic()<deadline,'NATURAL_ACTIVITY_DRAIN_TIMEOUT')
   if time.monotonic()-last>=15: emit({'event':'waiting_for_natural_activity','active':active,'at':a.utc()});last=time.monotonic()
   time.sleep(2)
 def hold_control():
  deadline=time.monotonic()+60
  while True:
   try: return session.hold_control()
   except BlockingIOError:
    a.need(time.monotonic()<deadline,'CONTROL_LOCK_BUSY');time.sleep(1)
 try:
  for name,key in ((a.MIGRATION,'migration_sha256'),('managed-performance-grants.sql','acl_sha256')):
   data=(pathlib.Path(args.sql_directory)/name).read_bytes();a.need(a.rawsha(data)==plan[key],'INPUT_SQL_HASH:'+name);session.atomic(session.root/name,data)
  session.save('backup-receipt.private.json',backup)
  step('prepare',session.prepare)
  step('close_ingress',session.close_ingress)
  step('wait_natural_activity',wait_idle)
  step('hold_control_barrier',hold_control)
  step('stop_api_ops',lambda:session.stop_producers(proof()))
  step('canonical_0185',lambda:session.migrate(proof()))
  step('performance_acl',lambda:session.apply_acl(proof()))
  for role in ('api','web','ops'): step('switch_'+role,lambda r=role:session.switch(r,proof()))
  step('verify_internal',lambda:session.verify_internal(proof()))
  step('restore_ingress',session.open_ingress)
  step('verify_live',session.verify_live)
  step('commit_main_components',session.commit_components)
  result=step('complete',session.complete);finished=True
  emit({'status':'PASS','scope':list(a.ROLES),'root':str(session.root),'steps':[x['step'] for x in events],'database_restored':False,'managed_deployment_included':False})
 except BaseException as error:
  failed=current;original_error=type(error).__name__+':'+str(error);recovery=[];session.save('driver-failure.private.json',{'failed_step':failed,'error':original_error,'traceback':traceback.format_exc(),'completed_steps':[x['step'] for x in events]})
  emit({'event':'failure','step':failed,'error':original_error,'completed_steps':[x['step'] for x in events],'public_write_boundary':session.state.get('public_write_boundary',False)})
  def recover(name,fn):
   result=fn();recovery.append({'step':name,'status':'PASS','result':result});emit({'event':'recovery','step':name,'result':result});return result
  try:
   if session.state.get('public_write_boundary'):
    # Traffic may have reached candidate code. Complete forward only; never replay old consumers.
    for role in a.ROLES: recover('verify_current_'+role,lambda r=role:session.verify(r))
    recover('reconcile_open_ingress',session.open_ingress)
    recover('verify_live_forward',session.verify_live)
    if not session.state.get('components_committed'): recover('commit_main_components_forward',session.commit_components)
    recover('complete_forward',session.complete);finished=True
   else:
    if not session.state.get('ingress_close_intent'):
     recover('abort_unmutated',session.abort_unmutated);finished=True
    else:
     # A curl timeout may have applied the closure; reconcile before touching services.
     if not session.state.get('ingress_closed'): recover('reconcile_ingress',session.close_ingress)
     if session.state.get('migration_attempt'): recover('reconcile_migration',session.reconcile_migration)
     if session.state.get('mutation_intent'):
      intent=session.state['mutation_intent'];c=session.inspect(intent['role'])
      if c['Id']!=plan['snapshot']['components'][intent['role']]['id']:
       try: recover('reconcile_'+intent['role'],lambda:session.reconcile(intent['role'],intent['kind']))
       except Exception as reconcile_error:
        # Reconcile persists owned identity before health verification. A recorded ID is required below.
        a.need(session.state['switched'].get(intent['role'],{}).get('id')==c['Id'],'UNOWNED_COMPOSE_OUTCOME:'+str(reconcile_error))
     for role in ('ops','web','api'):
      c=session.inspect(role)
      if c['Id']==plan['snapshot']['components'][role]['id']:
       recover('restore_original_'+role,lambda r=role:session.restore_original(r))
      else:
       recover('rollback_'+role,lambda r=role:session.switch(r,proof(),True))
     recover('restore_original_ingress',lambda:session.open_ingress(True))
     recover('verify_original_live',lambda:session.verify_live(True))
     recover('record_restored_components',lambda:session.commit_components(True))
     recover('complete_recovery',session.complete);finished=True
  except BaseException as recovery_error:
   recovery.append({'step':'recovery_stopped','status':'FAIL','error':type(recovery_error).__name__+':'+str(recovery_error)})
  session.save('driver-recovery.private.json',recovery)
  recovered_forward=finished and session.state.get('public_write_boundary',False) and session.state.get('components_committed',False)
  emit({'status':'PASS_RECOVERED_FORWARD' if recovered_forward else 'FAIL','failed_step':failed,'error':original_error,'root':str(session.root),'completed_steps':[x['step'] for x in events],'recovery':recovery,'owned_pending_retained':not finished,'database_restored':False,'automatic_model_or_task_replay':False})
  if not recovered_forward: raise SystemExit(1)
 finally:
  for fd,_ in reversed(session.fds): os.close(fd)
if __name__=='__main__': main()