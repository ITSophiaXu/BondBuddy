import pathlib,subprocess,json,base64,datetime,hashlib
ROOT=pathlib.Path(__file__).resolve().parents[4];C=ROOT/'deploy/m1/releases/managed-db1484'
OLD=ROOT
node='C:/Users/yingx/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
program="const fs=require('fs');const ts=require(process.argv[1]);const r=ts.transpileModule(fs.readFileSync(0,'utf8'),{reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}});if(r.diagnostics?.some(d=>d.category===1))process.exit(2);process.stdout.write(r.outputText);"
tests={}
for name in ['managed-run-retries.test','run-lease-heartbeat.test']:
 src=(ROOT/'apps/worker/src'/(name+'.ts')).read_bytes()
 tests[name+'.js']=subprocess.check_output([node,'-e',program,str(OLD/'node_modules/typescript/lib/typescript.js')],input=src).decode()
payload={'descriptor':json.loads((C/'descriptor.json').read_bytes()),'archive':base64.b64encode((C/'overlay.tar.gz').read_bytes()).decode(),'tests':tests,'helper_tests':{name:base64.b64encode((ROOT/name).read_bytes()).decode() for name in ['deploy/tencent-elasticity/business-overlay.mjs','deploy/tencent-elasticity/bootstrap.mjs','deploy/tencent-elasticity/compose.yaml','deploy/tencent-elasticity/node-adapter.mjs','deploy/tencent-elasticity/policy.mjs','deploy/m1/releases/managed-db1484/candidate.test.mjs','deploy/m1/releases/managed-db1484/descriptor.json','deploy/m1/releases/managed-db1484/overlay.tar.gz','deploy/m1/releases/fine-step1420/managed-node-eight/boot-public-config.json','deploy/m1/releases/fine-step1420/managed-node-eight/package-summary.json']}}
remote=r'''
import pathlib,json,base64,hashlib,tarfile,io,subprocess,datetime,sys
v=json.load(sys.stdin);d=v['descriptor'];b=base64.b64decode(v['archive']);assert hashlib.sha256(b).hexdigest()==d['sha256']
root=pathlib.Path('/var/lib/bondbuddy/acl1484-validation')/d['sha256'];root.mkdir(parents=True,exist_ok=True)
with tarfile.open(fileobj=io.BytesIO(b),mode='r:gz') as t:
 for f in d['files']:
  key=f['service_id']+'/'+f['path'];data=t.extractfile(key).read();assert hashlib.sha256(data).hexdigest()==f['sha256'];p=root/key;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data);p.chmod(0o644)
for name,source in v['tests'].items():assert '/' not in name;p=root/name;p.write_text(source);p.chmod(0o644)
for name,data in v['helper_tests'].items():
 p=root/'helper-tests'/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(base64.b64decode(data));p.chmod(0o644)
images={'authoring':'sha256:861a93b76a21edd03764a02d22cf4f3ad66579b9d1d6e79fcc21616c9b1c3576','review':'sha256:ea4f4de5d307485ecda4c22c6d105132bc51549b4b6bbe477e6d7db6f2a684a2'}
receipts=[]
for role,image in images.items():
 p=subprocess.run(['docker','image','inspect','--format','{{.Id}}',image],capture_output=True,timeout=15);assert p.returncode==0 and p.stdout.decode().strip()==image
 args=['docker','run','--rm','--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','1536m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:size=16m,mode=1777','--entrypoint','node','--workdir','/app']
 for f in d['files']:
  if f['service_id']==role:args+=['--mount',f'type=bind,source={root/role/f["path"]},target=/app/{f["path"]},readonly']
 for name in ['managed-run-retries.test.js','run-lease-heartbeat.test.js']:
  args+=['--mount',f'type=bind,source={root/name},target=/app/apps/worker/dist/{name},readonly']
 for name in v['helper_tests']:args+=['--mount',f'type=bind,source={root/"helper-tests"/name},target=/app/{name},readonly']
 smoke="await import('./apps/worker/dist/runtime.js');await import('./apps/worker/dist/run-pipeline.js');await import('@bondbuddy/api/performance-trace');const {modelCallConcurrency}=await import('./apps/worker/dist/model-call-budget.js');if(modelCallConcurrency({BB_MODEL_CALL_CONCURRENCY:'8'})!==8)throw Error('capacity');console.log('IMPORT_AND_8_SLOTS_PASS');"
 p=subprocess.run(args+[image,'--input-type=module','-e',smoke],capture_output=True,timeout=90)
 row={'role':role,'image':image,'import_exit':p.returncode,'import_stdout':p.stdout.decode(),'import_stderr':p.stderr.decode()};receipts.append(row)
 if p.returncode:continue
 p=subprocess.run(args+[image,'--test','--test-concurrency=1','deploy/m1/releases/managed-db1484/candidate.test.mjs',*[f'apps/worker/dist/{name}' for name in ['managed-run-retries.test.js','run-lease-heartbeat.test.js']]],capture_output=True,timeout=120)
 row.update(test_exit=p.returncode,test_stdout=p.stdout.decode(),test_stderr=p.stderr.decode())
print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archive_sha256':d['sha256'],'network':'none','database_connected':False,'models_called':False,'production_consumers_changed':False,'receipts':receipts}))
'''
# Feed data after code via a separate Python -c argument, quoted using POSIX shell rules.
import shlex
argv=['C:/Windows/System32/OpenSSH/ssh.exe','-F','work/team-log-access-20261111/admin-ssh-config','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','bb-azure-admin','sudo -n python3 -B -c '+shlex.quote(remote)]
p=subprocess.run(argv,input=json.dumps(payload).encode(),capture_output=True,timeout=300,cwd='C:/Users/yingx/OneDrive - Microsoft/Documents/ChatGPT/BondDraftAI')
if p.returncode:print(json.dumps({'status':'FAIL','exit_code':p.returncode,'error':'sanitized remote validation failure'}));raise SystemExit(1)
(C/'oci-validation.json').write_bytes(p.stdout);v=json.loads(p.stdout);print(json.dumps({'archive_sha256':v['archive_sha256'],'receipts':[{k:r.get(k) for k in ['role','import_exit','test_exit','import_stderr']} for r in v['receipts']]}))
