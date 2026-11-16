"""Read-only deployment guards and timing counts; no customer content."""
import pathlib,subprocess,json,hashlib,datetime
STATE=pathlib.Path('/var/lib/bondbuddy/migration-908/state-main')
def run(a,b=None):
 p=subprocess.run(a,input=b,capture_output=True,timeout=30)
 if p.returncode:raise RuntimeError('read_command_failed')
 return p.stdout
def sha(b):return hashlib.sha256(b).hexdigest()
def observe():
 q="SELECT json_build_object('ledger_count',(SELECT count(*) FROM bb_schema_migrations),'jobs_active',(SELECT count(*) FROM bb_jobs WHERE state IN ('queued','running')),'managed_leases',(SELECT count(*) FROM bb_jobs WHERE execution_node_id IS NOT NULL AND lease_token IS NOT NULL)+(SELECT count(*) FROM bb_review_messages WHERE execution_node_id IS NOT NULL AND lease_token IS NOT NULL),'holders',(SELECT count(*) FROM bb_model_capacity_holders),'nodes',(SELECT json_agg(json_build_object('id',id,'instance_id',instance_id,'epoch',epoch,'state',state,'revision',revision)) FROM bb_execution_nodes),'pending_ops',(SELECT count(*) FROM bb_execution_cloud_operations WHERE state NOT IN ('completed','cancelled','rejected')),'sessions',(SELECT count(*) FROM bb_performance_sessions),'spans',(SELECT count(*) FROM bb_performance_spans));"
 db=json.loads(run(['docker','exec','-i','bb-main-postgres-1','psql','-X','-qAt','-U','bondbuddy','-d','bondbuddy','-v','ON_ERROR_STOP=1'],('BEGIN READ ONLY;'+q+'ROLLBACK;').encode()))
 c=json.loads(run(['docker','inspect','bb-main-ops-1']))[0];env=dict(x.split('=',1) for x in c['Config']['Env']);f=pathlib.Path('/proc')/str(c['State']['Pid'])/'root'/env['BB_EXECUTION_POOL_CONFIG'].lstrip('/');p=json.loads(f.read_bytes())
 return {'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'database':db,'ops':{'id':c['Id'],'image':c['Image'],'running':c['State']['Running']},'pool_sha256':sha(f.read_bytes()),'pool_pin':p['business_overlay_sha256'],'authority_sha256':sha(pathlib.Path('/var/lib/bondbuddy/elastic-pg-mtls/authority.json').read_bytes()),'manifest_sha256':sha((STATE/'current-components.json').read_bytes()),'pending_release':(STATE/'pending-release.json').exists(),'authority_user':run(['systemctl','show','bondbuddy-elastic-control-authority.service','--property=User','--value']).decode().strip()}
if __name__=='__main__':
 try:print(json.dumps(observe()))
 except Exception as e:print(json.dumps({'status':'FAIL','code':str(e) if isinstance(e,RuntimeError) else type(e).__name__}));raise SystemExit(1)
