from pathlib import Path
import tarfile,io,gzip,json,hashlib
root=Path(__file__).resolve().parents[4];out=Path(__file__).parent
base=root/'deploy/m1/releases/fine-step1420/node-maintenance/recovery-candidate'
sha=lambda b:hashlib.sha256(b).hexdigest()
prior=json.loads((base/'descriptor.json').read_bytes());raw=(base/'overlay.tar.gz').read_bytes()
assert sha(raw)==prior['sha256']=='c4749d922f49eaa8fcbdc334881552dd7db5bdaa540ef154064de5f29e375b5e'
with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as t:entries={m.name:t.extractfile(m).read() for m in t}
manifest=json.loads((out/'compiled-manifest.json').read_bytes())
files={(f['service_id'],f['path']):f for f in prior['files']}
for role in ['authoring','review']:
 for f in manifest['files']:
  b=(out/f['path']).read_bytes();assert sha(b)==f['sha256']
  entries[role+'/'+f['path']]=b
  files[(role,f['path'])]={'service_id':role,**{k:f[k] for k in ['path','bytes','sha256']}}
migration='db/migrations/0190_managed_evidence_gate_lock.sql'
entries[migration]=(root/migration).read_bytes().replace(b'\r\n',b'\n')
buf=io.BytesIO()
with tarfile.open(fileobj=buf,mode='w',format=tarfile.USTAR_FORMAT) as t:
 for name,b in sorted(entries.items()):
  m=tarfile.TarInfo(name);m.size=len(b);m.mode=0o644;m.uid=m.gid=0;m.mtime=0;t.addfile(m,io.BytesIO(b))
raw=gzip.compress(buf.getvalue(),compresslevel=9,mtime=0)
d={'version':'shared-business-eight-permissions-v1','sha256':sha(raw),'bytes':len(raw),'files':[files[k] for k in sorted(files)]}
(out/'overlay.tar.gz').write_bytes(raw)
(out/'descriptor.json').write_text(json.dumps(d,indent=2)+'\n',encoding='utf-8')
helper=root/'deploy/tencent-elasticity/business-overlay.mjs'
text=helper.read_text(encoding='utf-8')
if "const PERMISSIONS_VERSION" not in text:
 text=text.replace("const isPerformanceVersion = version => [PERFORMANCE_VERSION, RECOVERY_PERFORMANCE_VERSION].includes(version);","const PERMISSIONS_VERSION = 'shared-business-eight-permissions-v1';\nconst isPerformanceVersion = version => [PERFORMANCE_VERSION, RECOVERY_PERFORMANCE_VERSION, PERMISSIONS_VERSION].includes(version);")
 anchor="const performanceProfile = version => version===RECOVERY_PERFORMANCE_VERSION"
 assert text.count(anchor)==1
 addition="const permissionsPaths = Object.fromEntries(Object.entries(recoveryPerformancePaths).map(([role,paths])=>[role,[...paths,'apps/api/dist/evidence-gate.js','apps/worker/dist/managed-database-preflight.js'].sort()]));\n"
 addition+="const permissionsSql = Object.freeze({...recoveryPerformanceSql,"+json.dumps(migration)+":"+json.dumps({'bytes':len(entries[migration]),'sha256':sha(entries[migration])})+"});\n"
 text=text.replace(anchor,addition+"const performanceProfile = version => version===PERMISSIONS_VERSION ? {paths:permissionsPaths,sql:permissionsSql,count:74} : version===RECOVERY_PERFORMANCE_VERSION")
 text=text.replace("version = files?.length===70 ?", "version = files?.length===74 ? PERMISSIONS_VERSION : files?.length===70 ?")
 helper.write_text(text,encoding='utf-8',newline='\n')
(out/'business-overlay.mjs').write_bytes(helper.read_bytes())
record={'base_archive_sha256':prior['sha256'],'archive_sha256':d['sha256'],'modules':manifest,'unchanged_base_files':sum(1 for f in prior['files'] if files[(f['service_id'],f['path'])]==f),'changed_existing_files':[f['service_id']+'/'+f['path'] for f in prior['files'] if files[(f['service_id'],f['path'])]!=f],'runtime_files':len(d['files']),'sql_execution':'only 0190 by migration owner; archive SQL is never executed by nodes'}
assert record['unchanged_base_files']==68 and len(d['files'])==74
(out/'source-manifest.json').write_text(json.dumps(record,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'archive_sha256':d['sha256'],'bytes':d['bytes'],'files':len(d['files']),'unchanged_prior':68}))
