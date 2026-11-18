"""Apply only the two tested deferred-refund INSERT column grants under shared locks."""
import datetime,fcntl,hashlib,json,os,pathlib,re,stat,subprocess,sys
ROOT=pathlib.Path('/var/lib/bondbuddy/workpaper1551-20261118-r2/permissions')
STATE=pathlib.Path('/var/lib/bondbuddy/migration-908/state-main')
ROLES=['bb1361_formal_n1_author_v1','bb1361_formal_n1_review_v1','bb1361_formal_n2_author_v1','bb1361_formal_n2_review_v1']
TABLES={'bb_task_refund_units':['owner_user_id','reservation_id','item_id','run_id','ordinal','source_item_key','label','points','scope_quote_id','evidence_kind','evidence'],'bb_task_refund_unit_slices':['reservation_id','item_id','origin_lot_id','points']}
def need(ok,code):
 if not ok:raise RuntimeError(code)
def sha(b):return hashlib.sha256(b).hexdigest()
def command(args,data=None):
 p=subprocess.run(args,input=data,capture_output=True,timeout=45);need(p.returncode==0,'command_failed');return p.stdout

def sql(q):return command(['docker','exec','-i','bb-main-postgres-1','psql','-XqAt','-v','ON_ERROR_STOP=1','-U','bondbuddy','-d','bondbuddy'],q.encode()).decode().strip()
def save(name,value):
 data=value if isinstance(value,bytes) else (json.dumps(value,sort_keys=True,indent=2)+'\n').encode()
 fd=os.open(ROOT/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
def snapshot(query):
 return {role:json.loads(sql('BEGIN READ ONLY;SET LOCAL ROLE "'+role+'";SELECT coalesce(json_agg(name),\'[]\'::json) FROM ('+query+') q;ROLLBACK;')) for role in ROLES}
def main():
 need(os.geteuid()==0,'root_required');payload=json.load(sys.stdin)
 need(bool(re.fullmatch('[a-f0-9]{40}',payload['source'])),'source_commit')
 grants=payload['grants'].encode();module=payload['module'].encode()
 need(sha(grants)=='785413be65e1ca6b2023c0ae8599a6106443cb8055b5306d299927c6d1e31ab8','grants_hash')
 need(sha(module)=='258f33e9842279db61cb6c4abd03ce530e71cd6eb363126f84e77faa688878d9','preflight_hash')
 query=re.search(r'pool.query\(`([\s\S]+?)`\)',payload['module']).group(1)
 ops=json.loads(command(['docker','inspect','bb-main-ops-1']))[0];env=dict(v.split('=',1) for v in ops['Config']['Env'])
 pool=json.loads((pathlib.Path('/proc')/str(ops['State']['Pid'])/'root'/env['BB_EXECUTION_POOL_CONFIG'].lstrip('/')).read_bytes())
 fds=[]
 try:
  for path in [STATE/'config.lock',STATE/'deploy.lock',STATE/'migration.lock',pathlib.Path(pool['registration_directory'])/'control-tick.lock']:
   st=path.lstat();need(stat.S_ISREG(st.st_mode) and not path.is_symlink(),'unsafe_lock');fd=os.open(path,os.O_RDWR|os.O_NOFOLLOW);fds.append(fd);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  need(not (STATE/'pending-release.json').exists(),'other_release_pending')
  need(not ROOT.exists(),'prior_attempt_requires_reconciliation');ROOT.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
  parent=ROOT.parent.lstat();need(stat.S_ISDIR(parent.st_mode) and not ROOT.parent.is_symlink() and parent.st_uid==0 and parent.st_mode&0o077==0,'unsafe_receipt_root');ROOT.mkdir(mode=0o700)
  before=snapshot(query);need(all(set(x)<= {'refund_unit_insert','refund_slice_insert'} for x in before.values()),'unrelated_privilege_gap')
  acl=json.loads(sql("SELECT json_build_object('relations',(SELECT json_agg(t) FROM (SELECT relname,relacl::text FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('bb_task_refund_units','bb_task_refund_unit_slices'))t),'columns',(SELECT json_agg(t) FROM (SELECT c.relname,a.attname,a.attacl::text FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('bb_task_refund_units','bb_task_refund_unit_slices') AND a.attnum>0 AND NOT a.attisdropped)t));"))
  revoke=[]
  for role in ROLES:
   for table,columns in TABLES.items():
    for col in columns:
     if sql("SELECT has_column_privilege('"+role+"','public."+table+"','"+col+"','INSERT');")=='f':revoke.append('REVOKE INSERT('+col+') ON public.'+table+' FROM "'+role+'";')
  save('before.json',{'source':payload['source'],'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'missing':before,'acl':acl})
  save('rollback-new-grants.sql',('BEGIN;\nSET LOCAL lock_timeout=\'2s\';\n'+'\n'.join(revoke)+'\nCOMMIT;\n').encode())
  save('grants.sql',grants);save('preflight.mjs',module)
  if revoke:
   body='BEGIN;\nSET LOCAL lock_timeout=\'2s\';\nSET LOCAL statement_timeout=\'10s\';\n'+''.join(payload['grants'].replace(':"runtime_role"','"'+r+'"') for r in ROLES)+'COMMIT;'
   save('apply.sql',body.encode());sql(body)
  after=snapshot(query);need(all(not x for x in after.values()),'15_checks_failed')
  broad={r:{t:json.loads(sql("SELECT json_build_object('insert',has_table_privilege('"+r+"','public."+t+"','INSERT'),'update',has_table_privilege('"+r+"','public."+t+"','UPDATE'),'delete',has_table_privilege('"+r+"','public."+t+"','DELETE'),'truncate',has_table_privilege('"+r+"','public."+t+"','TRUNCATE'));")) for t in TABLES} for r in ROLES}
  need(all(not v for tables in broad.values() for rights in tables.values() for v in rights.values()),'unexpected_broad_privilege')
  receipt={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':payload['source'],'status':'GRANTS_APPLIED_15_CHECKS_PASS' if revoke else 'ALREADY_SATISFIED_15_CHECKS_PASS','before':before,'after':after,'negative':broad,'services_restarted':False,'original_tasks_retried':False,'business_acceptance':False}
  save('receipt.json',receipt);print(json.dumps(receipt))
 finally:
  for fd in reversed(fds):os.close(fd)
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'status':'FAIL','code':str(e) if isinstance(e,RuntimeError) else type(e).__name__,'automatic_retry':False}));raise SystemExit(1)