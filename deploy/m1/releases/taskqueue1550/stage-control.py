"""Stage #1550 node/control files and private descriptors; do not activate them."""
import base64,copy,datetime,hashlib,json,os,pathlib,re,subprocess,sys,urllib.parse
ROOT=pathlib.Path('/var/lib/bondbuddy/taskqueue1550-20261118')
OLD_PIN='51600119c096e2d5dab5e3827687e1dfc307e89695a04823876c449faa885a6b'
BOOTSTRAP_HASHES={'deploy/m1/security/codex-seccomp.json': '4ec7b3837baee01df32a894ad7ac1eeaf8bbf1eb812df8fc3f0b3793f7569a24', 'deploy/m1/security/integrity-browser-seccomp.json': 'b6b702deb98325db37b881ac92e8891ffaded3fcd711359d51dcde15fcf00ac1', 'deploy/tencent-elasticity/bootstrap.mjs': '4f649698add7f404ab3af60a96bf2b2afa57bc9949305e233c8d5791125fbaa9', 'deploy/tencent-elasticity/business-overlay.mjs': '61d183f3391da82578ed7cdb875509feb9668e61bfc1b80909050958012b0bbd', 'deploy/tencent-elasticity/compose.yaml': '3c604483ef133e97c6edd3b2b1b222490b269906129b9ec2debf98e677ec4ed4', 'deploy/tencent-elasticity/node-adapter.mjs': '432e7a88730d65c3497b9f027a5f49d240d53491bbe43e5071445f8d078e228b', 'deploy/tencent-elasticity/policy.mjs': '0d10b87f4cabd06381eb638f9d47df7b9ce3a04449bb1a4555e7cf15d6498b5c', 'deploy/tencent-elasticity/private-egress.mjs': '690e49ef8ae15f1ac93a4ec6e7e4a963702ff8d9881fcb95b23bda232b8392cb'}
NEW_PIN='c2a67c07f99f1204400d4c8d161bcaae2bc592a776889908cb19f6a52c70bec3'
def need(ok,code):
 if not ok:raise RuntimeError(code)
def sha(b):return hashlib.sha256(b).hexdigest()
def run(a,b=None):
 p=subprocess.run(a,input=b,capture_output=True,timeout=90);need(p.returncode==0,'staging_command_failed');return p.stdout

def write(path,data,mode=0o600):
 need(not path.is_symlink(),'symlink_rejected')
 if path.exists():need(path.read_bytes()==data,'existing_stage_drift');return
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 with os.fdopen(fd,'wb') as out:out.write(data);out.flush();os.fsync(out.fileno())

def main():
 need(os.geteuid()==0,'root_required');payload=json.load(sys.stdin);source=payload['source_commit'];need(bool(re.fullmatch('[a-f0-9]{40}',source)),'source_commit')
 ROOT.mkdir(mode=0o700,parents=True,exist_ok=True);need(ROOT.stat().st_uid==0 and ROOT.stat().st_mode&0o077==0,'root_permissions')
 for name in ['private','public']:(ROOT/name).mkdir(mode=0o700,exist_ok=True)
 public=ROOT/'public';private=ROOT/'private'
 expected={'main-cutover-adapter.py':'59818258171123633d3c4d5a7cc8037e4ec2082a997bf18e7bfefd7a54849a4c','overlay.tar.gz':NEW_PIN,'business-overlay.mjs':'3dbb89ddd456e96b02f938fefd39142365948d754381228e1babb32fc18992fe'}
 expected.update({'prepare-api.py': '52a82c8da6bc2b1fa4287640283e935b1e8ccfdcc62051b6548a5b1ddd47a02c', 'api-cutover.py': 'b11266adaf82b73cae0346499a6c80e94e178b59513ac360820c5d140f238141', '0191_task_target_execution_mutex.sql': 'd27e82cf8402ea8fb5e2f9c7cd6ca2946197d5a3ef28ab47e708edb377b6f380'})
 for name,digest in expected.items():
  b=base64.b64decode(payload['files'][name]);need(sha(b)==digest,'public_hash');write(public/name,b,0o644)
 desc=payload['descriptor'];need(desc['sha256']==NEW_PIN and desc['bytes']==648118 and len(desc['files'])==118,'descriptor_scope')
 c=json.loads(run(['docker','inspect','bb-main-ops-1']))[0];need(c['State']['Running'],'ops_running')
 env=dict(v.split('=',1) for v in c['Config']['Env']);pool_target=env['BB_EXECUTION_POOL_CONFIG'];effective=pathlib.Path('/proc')/str(c['State']['Pid'])/'root'/pool_target.lstrip('/');pool_raw=effective.read_bytes();pool=json.loads(pool_raw)
 authority_path=pathlib.Path('/var/lib/bondbuddy/elastic-pg-mtls/authority.json');authority_raw=authority_path.read_bytes();authority=json.loads(authority_raw)
 app_root=pathlib.Path('/proc')/str(c['State']['Pid'])/'root/app'
 for name,digest in BOOTSTRAP_HASHES.items():need(sha((app_root/name).read_bytes())==digest,'live_bootstrap_code_drift:'+name)
 bootstrap_js="""import {bootstrapUserData}from './deploy/tencent-elasticity/bootstrap.mjs';import {createHash}from 'node:crypto';let s='';for await(const b of process.stdin)s+=b;const c=JSON.parse(s);const r={account_id:c.account_id,region:c.region,source_sha256:c.source_sha256,image_sha256:c.image_sha256,services:c.services};const slots=[0,1].map(slot=>{const data=bootstrapUserData(c,r,slot),bytes=Buffer.byteLength(data);if(bytes>16384)throw Error('cloud_bootstrap_size_limit');return{slot,bytes,sha256:createHash('sha256').update(data).digest('hex')};});process.stdout.write(JSON.stringify(slots));"""
 bootstrap_args=['docker','run','--rm','-i','--network','none','--read-only','--memory','256m','--pids-limit','64','-w','/app','--entrypoint','node']
 for name in BOOTSTRAP_HASHES:
  source=public/'business-overlay.mjs' if name=='deploy/tencent-elasticity/business-overlay.mjs' else app_root/name
  stable=public/'bootstrap-fixture'/name;stable.parent.mkdir(mode=0o700,parents=True,exist_ok=True);write(stable,source.read_bytes(),0o644)
  source=stable
  bootstrap_args+=['--mount','type=bind,src='+str(source)+',dst=/app/'+name+',readonly']
 bootstrap_args += [c['Image'],'--input-type=module','-e',bootstrap_js]
 bootstrap_slots=json.loads(run(bootstrap_args,json.dumps({**pool,'business_overlay_sha256':NEW_PIN}).encode()))

 need(pool['business_overlay_sha256']==authority['pool']['business_overlay_sha256']==OLD_PIN,'pool_preimage')
 need([pool[k] for k in ['node_model_limit','global_model_limit','max_owned','min_running','idle_seconds']]==[8,8,2,0,300],'capacity_drift')
 templates=[]
 for index,x in enumerate(pool['node_secrets'],1):
  p=pathlib.Path(x['service_template_file']);b=p.read_bytes();t=json.loads(b);need(t['business_overlay']['sha256']==OLD_PIN,'template_preimage');templates.append((x,p,b,t))
 expiry=urllib.parse.parse_qs(urllib.parse.urlsplit(templates[0][3]['business_overlay']['url']).query)['se'][0]
 need(datetime.datetime.fromisoformat(expiry.replace('Z','+00:00'))>datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=1),'existing_url_expiry')
 # Existing account and private container; SAS remains only in protected files.
 js="""import {BlobServiceClient,BlobSASPermissions} from '@azure/storage-blob';import {createHash} from 'node:crypto';
let s='';for await(const b of process.stdin)s+=b;const v=JSON.parse(s),data=Buffer.from(v.archive,'base64');
if(createHash('sha256').update(data).digest('hex')!==v.sha256)throw Error('hash');
const client=BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING).getContainerClient('bondbuddy-private').getBlockBlobClient('releases/taskqueue1550/permissions-'+v.sha256+'.tar.gz');
try{await client.uploadData(data,{conditions:{ifNoneMatch:'*'},blobHTTPHeaders:{blobContentType:'application/gzip'}});}catch(e){if(e.statusCode!==409&&e.statusCode!==412)throw e;}
const actual=await client.downloadToBuffer();if(createHash('sha256').update(actual).digest('hex')!==v.sha256)throw Error('readback');
const url=await client.generateSasUrl({permissions:BlobSASPermissions.parse('r'),startsOn:new Date(Date.now()-300000),expiresOn:new Date(v.expiry)});process.stdout.write(JSON.stringify({url,bytes:actual.length,sha256:v.sha256}));"""
 blob=json.loads(run(['docker','exec','-i','bb-main-api-1','node','--input-type=module','-e',js],json.dumps({'archive':payload['files']['overlay.tar.gz'],'sha256':NEW_PIN,'expiry':expiry}).encode()))
 need(blob['sha256']==NEW_PIN and blob['bytes']==desc['bytes'],'blob_readback');new_desc={**desc,'url':blob['url']};descriptor_path=private/'business-overlay.descriptor.private.json'
 if descriptor_path.exists():
  existing=json.loads(descriptor_path.read_bytes());need({k:v for k,v in existing.items() if k!='url'}==desc,'existing_descriptor_drift');new_desc=existing
 write(descriptor_path,(json.dumps(new_desc)+'\n').encode())
 new_pool=copy.deepcopy(pool);new_authority=copy.deepcopy(authority);new_pool['business_overlay_sha256']=NEW_PIN;new_authority['pool']['business_overlay_sha256']=NEW_PIN
 template_records=[]
 for index,(x,p,b,t) in enumerate(templates,1):
  target=private/f'service-template-{index}.private.json';new=copy.deepcopy(t);new['business_overlay']=new_desc
  nb=(json.dumps(new,sort_keys=True,separators=(',',':'))+'\n').encode();write(target,nb);os.chown(target,p.stat().st_uid,p.stat().st_gid)
  for config in [new_pool,new_authority['pool']]:
   entry=next(z for z in config['node_secrets'] if z['role_name']==x['role_name']);entry['service_template_file']=str(target)
  template_records.append({'role':x['role_name'],'before_path':str(p),'before_sha256':sha(b),'after_path':str(target),'after_sha256':sha(nb)})
 new_pool_bytes=(json.dumps(new_pool,sort_keys=True,separators=(',',':'))+'\n').encode();new_authority_bytes=(json.dumps(new_authority,sort_keys=True,separators=(',',':'))+'\n').encode()
 write(private/'pool.private.json',new_pool_bytes);os.chown(private/'pool.private.json',effective.stat().st_uid,effective.stat().st_gid);write(private/'authority.private.json',new_authority_bytes)
 volumes=[{'type':'bind','source':str(private/'pool.private.json'),'target':pool_target,'read_only':True}]
 volumes += [{'type':'bind','source':r['after_path'],'target':r['after_path'],'read_only':True} for r in template_records]
 volumes += [{'type':'bind','source':str(public/'business-overlay.mjs'),'target':'/app/deploy/tencent-elasticity/business-overlay.mjs','read_only':True}]
 overlay={'services':{'ops':{'volumes':volumes}}};write(private/'ops.compose.private.json',(json.dumps(overlay)+'\n').encode())
 plan={'manifest_before_sha256':sha(pathlib.Path('/var/lib/bondbuddy/migration-908/state-main/current-components.json').read_bytes()),'source_commit':source,'archive_sha256':NEW_PIN,'ops_id':c['Id'],'ops_image':c['Image'],'pool_target':pool_target,'pool_before_sha256':sha(pool_raw),'pool_after_sha256':sha(new_pool_bytes),'authority_before_sha256':sha(authority_raw),'authority_after_sha256':sha(new_authority_bytes),'templates':template_records,'compose_files':c['Config']['Labels']['com.docker.compose.project.config_files'].split(','),'working_directory':c['Config']['Labels']['com.docker.compose.project.working_dir'],'control_lock':pool['registration_directory']+'/control-tick.lock','retained_warm_bootstraps_unchanged':new_pool.get('retained_warm_bootstraps')==pool.get('retained_warm_bootstraps'),'blob_verified':True,'sas_expiry_preserved':expiry,'activated':False,'bootstrap_code_sha256':BOOTSTRAP_HASHES,'bootstrap_slots':bootstrap_slots}
 write(private/'plan.safe.json',(json.dumps(plan,sort_keys=True,indent=2)+'\n').encode());print(json.dumps(plan))
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'status':'FAIL','error_type':type(e).__name__,'code':str(e) if isinstance(e,RuntimeError) else 'sanitized_error'}));raise SystemExit(1)
