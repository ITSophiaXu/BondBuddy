"""API and additive migration half of #1550. Called only while control holds shared locks."""
import pathlib,json,subprocess,hashlib,os,copy,datetime,shutil,importlib.util
ROOT=pathlib.Path('/var/lib/bondbuddy/taskqueue1550-api-20261118');P=ROOT/'private';PUBLIC=ROOT/'public'
CONTROL=pathlib.Path('/var/lib/bondbuddy/taskqueue1550-20261118');MIGRATION='0191_task_target_execution_mutex.sql'
def need(ok,msg):
 if not ok:raise RuntimeError(msg)
def read(p):return json.loads(p.read_bytes())
def sha(b):return hashlib.sha256(b).hexdigest()
def run(a,b=None,timeout=90):
 r=subprocess.run(a,input=b,capture_output=True,timeout=timeout);need(r.returncode==0,'api_command_failed:'+a[0]);return r.stdout
def inspect():return json.loads(run(['docker','inspect','bb-main-api-1']))[0]
def sql(q):return run(['docker','exec','-i','bb-main-postgres-1','psql','-X','-qAt','-U','bondbuddy','-d','bondbuddy','-v','ON_ERROR_STOP=1'],q.encode())
def save(p,v):
 raw=(json.dumps(v,indent=2,sort_keys=True)+'\n').encode();tmp=p.with_name(p.name+'.tmp');fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb')as f:f.write(raw);f.flush();os.fsync(f.fileno())
 os.replace(tmp,p)
def compare(c,overlay):
 spec=importlib.util.spec_from_file_location('prepare',CONTROL/'public/prepare-api.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);m.compare(read(P/'api.before.inspect.json'),c,overlay)
def validate(rollback=False):
 plan=read(P/'plan.json');rec=plan['roles']['api'];c=inspect();need(c['Image']==rec['image'],'api_image_drift')
 for name,h in rec['config_sha256'].items():need(sha((P/('api.'+name+'.compose.json')).read_bytes())==h,'api_config_hash')
 if not rollback:
  need(c['Id']==rec['before_id'],'api_container_drift');compare(c,[])
  for name,h in rec['source_configs'].items():need(sha(pathlib.Path(name).read_bytes())==h,'api_source_config_drift')
 else:compare(c,rec['overlay'])
 return plan
def stop(rollback=False):
 plan=validate(rollback);c=inspect()
 if c['State']['Running']:run(['docker','kill','--signal=TERM',c['Id']]);run(['docker','wait',c['Id']],timeout=90)
 need(not inspect()['State']['Running'],'api_still_running');return plan
def migrate():
 need(shutil.disk_usage(ROOT).free>=int(2.5*1024**3),'disk_margin');path=CONTROL/'public'/MIGRATION;data=path.read_bytes();need(sha(data)==MIGRATION_SHA,'migration_hash')
 existing=sql("BEGIN READ ONLY;SELECT count(*) FROM bb_schema_migrations WHERE filename='"+MIGRATION+"';ROLLBACK;").decode().strip();need(existing=='0','migration_already_present_reconcile')
 before=sql("BEGIN READ ONLY;SELECT pg_get_functiondef('public.bb_m3_project_run_mutex()'::regprocedure);ROLLBACK;")
 f=P/'mutex.before.sql';need(not f.exists(),'prior_migration_attempt');f.write_bytes(before);os.chmod(f,0o600)
 dump=P/'before-0191.dump';fd=os.open(dump,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb')as out:r=subprocess.run(['docker','exec','bb-main-postgres-1','pg_dump','-U','bondbuddy','-d','bondbuddy','-Fc'],stdout=out,stderr=subprocess.PIPE,timeout=180);out.flush();os.fsync(out.fileno())
 need(r.returncode==0 and dump.stat().st_size>10000,'backup_failed');run(['docker','exec','-i','bb-main-postgres-1','pg_restore','-l'],dump.read_bytes(),timeout=60)
 # Rehearse replacing and restoring this function inside a rolled-back transaction.
 sql('BEGIN;SET LOCAL lock_timeout=\'5s\';'+data.decode()+';'+before.decode()+';ROLLBACK;')
 need(sql("BEGIN READ ONLY;SELECT pg_get_functiondef('public.bb_m3_project_run_mutex()'::regprocedure);ROLLBACK;")==before,'rollback_rehearsal_changed_function')
 sql("BEGIN;SET LOCAL lock_timeout='10s';SELECT pg_advisory_xact_lock(hashtext('bb:migrate'));"+data.decode()+";INSERT INTO bb_schema_migrations(filename) VALUES('"+MIGRATION+"');COMMIT;")
 after=sql("BEGIN READ ONLY;SELECT pg_get_functiondef('public.bb_m3_project_run_mutex()'::regprocedure);ROLLBACK;");need(b'r.project_id = new.project_id' in after.lower()or b'r.project_id=NEW.project_id' in after,'migration_readback')
 result={'migration':MIGRATION,'sha256':sha(data),'backup':str(dump),'backup_bytes':dump.stat().st_size,'backup_sha256':sha(dump.read_bytes()),'function_before_sha256':sha(before),'function_after_sha256':sha(after),'function_restore_rehearsal':True,'ledger_applied':True,'full_data_restore_rehearsal':False};save(P/'migration.safe.json',result);return result
def start(rollback=False):
 plan=read(P/'plan.json');kind='before'if rollback else 'candidate';file=P/('api.'+kind+'.compose.json');run(['docker','compose','--project-name','bb-main','--project-directory',str(P),'-f',str(file),'up','-d','--no-deps','--no-build','--pull','never','--force-recreate','--wait','--wait-timeout','90','api'],timeout=120)
 c=inspect();need(c['State']['Running']and c['State'].get('Health',{}).get('Status','healthy')=='healthy','api_health');compare(c,[]if rollback else plan['roles']['api']['overlay'])
 if not rollback:
  root=pathlib.Path('/proc')/str(c['State']['Pid'])/'root'
  for f in plan['files']:need(sha((root/f['path'].lstrip('/')).read_bytes())==f['sha256'],'api_file_readback')
 result={'container_id':c['Id'],'image_id':c['Image'],'started_at':c['State']['StartedAt'],'started_utc':c['State']['StartedAt'],'running':True,'configuration_path':str(file),'configuration_files':[str(file)],'rollback':rollback,'verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat()};save(P/'activation.safe.json',result);return result
MIGRATION_SHA='d27e82cf8402ea8fb5e2f9c7cd6ca2946197d5a3ef28ab47e708edb377b6f380'
