"""Stage #1420 node/control files and private descriptors; do not activate them."""
import base64,copy,datetime,hashlib,json,os,pathlib,re,subprocess,sys,urllib.parse
ROOT=pathlib.Path('/var/lib/bondbuddy/timing1478-20261116')
OLD_PIN='2d86f1351c8c7cf1b49609d7ff442b06344a0c45aa003b5ca0efb4a64a7e7654'
NEW_PIN='8776d6abebc19efa6643a649b69428bccc56f11d0646d66a00bf9141efdd4ed5'
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
 expected={'main-cutover-adapter.py':'00e5291ed4b70aa21dfab3f616cea10b427952aeee8f17cd8e974e323255ef67','overlay.tar.gz':NEW_PIN,'business-overlay.mjs':'75e10607d1886e1b11e3be809d664a4cd362bc2597e238511175bc96487f44e4','bootstrap.mjs':'8a160df7157942f1703c4c7d99e57fa7642b3d9931dc97ba2e1cf0354a55c94e'}
 for name,digest in expected.items():
  b=base64.b64decode(payload['files'][name]);need(sha(b)==digest,'public_hash');write(public/name,b,0o644)
 desc=payload['descriptor'];need(desc['sha256']==NEW_PIN and desc['bytes']==435959 and len(desc['files'])==70,'descriptor_scope')
 c=json.loads(run(['docker','inspect','bb-main-ops-1']))[0];need(c['State']['Running'],'ops_running')
 env=dict(v.split('=',1) for v in c['Config']['Env']);pool_target=env['BB_EXECUTION_POOL_CONFIG'];effective=pathlib.Path('/proc')/str(c['State']['Pid'])/'root'/pool_target.lstrip('/');pool_raw=effective.read_bytes();pool=json.loads(pool_raw)
 authority_path=pathlib.Path('/var/lib/bondbuddy/elastic-pg-mtls/authority.json');authority_raw=authority_path.read_bytes();authority=json.loads(authority_raw)
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
const client=BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING).getContainerClient('bondbuddy-private').getBlockBlobClient('releases/fine-step1420/recovery-'+v.sha256+'.tar.gz');
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
  for role in ['authoring','review']:new['service_environments'][role]['BB_RELEASE_SHA']=source
  nb=(json.dumps(new,sort_keys=True,separators=(',',':'))+'\n').encode();write(target,nb);os.chown(target,p.stat().st_uid,p.stat().st_gid)
  for config in [new_pool,new_authority['pool']]:
   entry=next(z for z in config['node_secrets'] if z['role_name']==x['role_name']);entry['service_template_file']=str(target)
  template_records.append({'role':x['role_name'],'before_path':str(p),'before_sha256':sha(b),'after_path':str(target),'after_sha256':sha(nb)})
 new_pool_bytes=(json.dumps(new_pool,sort_keys=True,separators=(',',':'))+'\n').encode();new_authority_bytes=(json.dumps(new_authority,sort_keys=True,separators=(',',':'))+'\n').encode()
 write(private/'pool.private.json',new_pool_bytes);os.chown(private/'pool.private.json',effective.stat().st_uid,effective.stat().st_gid);write(private/'authority.private.json',new_authority_bytes)
 volumes=[{'type':'bind','source':str(private/'pool.private.json'),'target':pool_target,'read_only':True}]
 volumes += [{'type':'bind','source':r['after_path'],'target':r['after_path'],'read_only':True} for r in template_records]
 volumes += [{'type':'bind','source':str(public/name),'target':'/app/deploy/tencent-elasticity/'+name,'read_only':True} for name in ['business-overlay.mjs','bootstrap.mjs']]
 overlay={'services':{'ops':{'volumes':volumes}}};write(private/'ops.compose.private.json',(json.dumps(overlay)+'\n').encode())
 plan={'source_commit':source,'archive_sha256':NEW_PIN,'ops_id':c['Id'],'ops_image':c['Image'],'pool_target':pool_target,'pool_before_sha256':sha(pool_raw),'pool_after_sha256':sha(new_pool_bytes),'authority_before_sha256':sha(authority_raw),'authority_after_sha256':sha(new_authority_bytes),'templates':template_records,'compose_files':c['Config']['Labels']['com.docker.compose.project.config_files'].split(','),'working_directory':c['Config']['Labels']['com.docker.compose.project.working_dir'],'control_lock':pool['registration_directory']+'/control-tick.lock','retained_warm_bootstraps_unchanged':new_pool.get('retained_warm_bootstraps')==pool.get('retained_warm_bootstraps'),'blob_verified':True,'sas_expiry_preserved':expiry,'activated':False}
 write(private/'plan.safe.json',(json.dumps(plan,sort_keys=True,indent=2)+'\n').encode());print(json.dumps(plan))
if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'status':'FAIL','error_type':type(e).__name__,'code':str(e) if isinstance(e,RuntimeError) else 'sanitized_error'}));raise SystemExit(1)
