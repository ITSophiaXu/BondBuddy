"""Apply only migration 0190 and the reviewed four-role ACL delta under existing release locks."""
import datetime,fcntl,hashlib,json,os,pathlib,subprocess,sys
ROOT=pathlib.Path('/var/lib/bondbuddy/db1484-20261117');STATE=pathlib.Path('/var/lib/bondbuddy/migration-908/state-main')
ROLES=['bb1361_formal_n1_author_v1','bb1361_formal_n1_review_v1','bb1361_formal_n2_author_v1','bb1361_formal_n2_review_v1']
def need(ok,code):
 if not ok:raise RuntimeError(code)
def sql(q):
 p=subprocess.run(['docker','exec','-i','bb-main-postgres-1','psql','-X','-qAt','-U','bondbuddy','-d','bondbuddy','-v','ON_ERROR_STOP=1'],input=q.encode(),capture_output=True,timeout=45)
 need(p.returncode==0,'sql_failed:'+p.stderr.decode()[-1500:]);return p.stdout.decode().strip()
def save(name,v):
 p=ROOT/'private'/name
 with p.open('x') as f:json.dump(v,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
 os.chmod(p,0o600)
def main():
 payload=json.load(sys.stdin);need(payload['action'] in ['validate','apply'],'action')
 fds=[]
 try:
  for name in ['config.lock','deploy.lock','migration.lock']:
   fd=os.open(STATE/name,os.O_RDWR|os.O_NOFOLLOW);fds.append(fd);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  need(not (STATE/'pending-release.json').exists(),'release_pending')
  before=json.loads(sql("""BEGIN READ ONLY;SELECT json_build_object('ledger',(SELECT count(*) FROM bb_schema_migrations),'function',to_regprocedure('public.bb_lock_evidence_gate(boolean)')::text,'roles',(SELECT json_agg(rolname ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'bb1361_formal_n%_%_v1'),'leases',(SELECT count(*) FROM bb_jobs WHERE execution_node_id IS NOT NULL AND lease_token IS NOT NULL)+(SELECT count(*) FROM bb_review_messages WHERE execution_node_id IS NOT NULL AND lease_token IS NOT NULL),'holders',(SELECT count(*) FROM bb_model_capacity_holders),'not_stopped',(SELECT count(*) FROM bb_execution_nodes WHERE state<>'stopped'),'pending_ops',(SELECT count(*) FROM bb_execution_cloud_operations WHERE state NOT IN ('completed','cancelled','rejected')));ROLLBACK;"""))
  need(before['roles']==sorted(ROLES) and before['ledger']==190 and before['function'] is None,'migration_preimage')
  need(all(before[k]==0 for k in ['leases','holders','not_stopped','pending_ops']),'drain_guard')
  migration=payload['migration'];delta=payload['delta'];preflight=payload['preflight_sql']
  need(hashlib.sha256(migration.encode()).hexdigest()==payload['migration_sha256'],'migration_hash')
  need('CREATE FUNCTION public.bb_lock_evidence_gate' in migration and 'REVOKE ALL' in migration,'migration_scope')
  if payload['action']=='validate':print(json.dumps({'status':'PASS','action':'validate','database':before}));return
  backup=json.loads(sql("""BEGIN READ ONLY;SELECT json_build_object('relations',(SELECT json_agg(json_build_object('name',relname,'owner',pg_get_userbyid(relowner),'acl',relacl)) FROM pg_class WHERE relname IN ('bb_model_capacity_order','bb_credit_reservations','bb_project_file_check_attempts','bb_run_model_activity','bb_evidence_gate_events')),'columns',(SELECT json_agg(json_build_object('table',c.relname,'column',a.attname,'acl',a.attacl)) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relname IN ('bb_credit_reservations','bb_run_model_activity') AND a.attnum>0));ROLLBACK;"""))
  save('database-before.json',{'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'guard':before,'acl':backup,'source':payload['source']})
  statements=["BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='15s';",migration,"INSERT INTO bb_schema_migrations(filename) VALUES ('0190_managed_evidence_gate_lock.sql');"]
  delta=delta[delta.index('BEGIN;')+6:delta.rindex('COMMIT;')]
  for role in ROLES:statements.append(delta.replace(':"runtime_role"','"'+role+'"'))
  statements.append("COMMIT;")
  sql('\n'.join(statements))
  tests=[]
  for role in ROLES:
   result=sql('BEGIN;SET LOCAL ROLE "'+role+'";'+preflight+";SELECT json_build_object('role',current_user,'superuser',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),'audit_mutation',has_table_privilege(current_user,'public.bb_evidence_gate_events','UPDATE,DELETE,TRUNCATE'));SELECT public.bb_lock_evidence_gate(false);SELECT public.bb_lock_evidence_gate(true);SELECT run_id FROM public.bb_project_file_check_attempts LIMIT 0;ROLLBACK;")
   rows=[x for x in result.splitlines() if x.strip()];need(len(rows)==1,'preflight_failed')
   row=json.loads(rows[0]);need(row['role']==role and not row['superuser'] and not row['audit_mutation'],'role_scope');tests.append(row)
  fn=json.loads(sql("SELECT json_build_object('owner',pg_get_userbyid(proowner),'security_definer',prosecdef,'config',proconfig,'public_execute',EXISTS(SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee=0 AND privilege_type='EXECUTE')) FROM pg_proc WHERE oid='public.bb_lock_evidence_gate(boolean)'::regprocedure;"))
  need(fn['owner']=='bondbuddy' and fn['security_definer'] and fn['config']==['search_path=pg_catalog'] and not fn['public_execute'],'function_scope')
  receipt={'status':'PASS','migration':'0190_managed_evidence_gate_lock.sql','source':payload['source'],'roles':tests,'function':fn,'ledger':int(sql('SELECT count(*) FROM bb_schema_migrations')),'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'customer_runs_retried':False}
  save('database-after.safe.json',receipt);print(json.dumps(receipt))
 finally:
  for fd in reversed(fds):os.close(fd)
if __name__=='__main__':main()


