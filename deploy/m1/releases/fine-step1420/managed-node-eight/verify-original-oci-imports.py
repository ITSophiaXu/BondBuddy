#!/usr/bin/env python3
"""Import/function verification only on cached base OCI; no env/DB/provider/worker start."""
import json,subprocess,hashlib,sys
from pathlib import Path
root=Path(__file__).resolve().parent;d=json.loads((root/'descriptor.json').read_text());source=json.loads((root/'source-descriptor.json').read_text());receipts=[]
program="""import assert from 'node:assert/strict';import {Pool} from 'pg';
await import('./apps/worker/dist/runtime.js');await import('./apps/worker/dist/codex-adapter.js');await import('./apps/api/dist/queue.js');await import('@bondbuddy/api/performance-trace');await import('./packages/contracts/dist/index.js');await import('./packages/contracts/dist/performance.js');
const {modelCallConcurrency,PgModelCallBudget}=await import('./apps/worker/dist/model-call-budget.js');
for(const n of [1,4,8])assert.equal(modelCallConcurrency({BB_MODEL_CALL_CONCURRENCY:String(n)}),n);
for(const n of ['0','9','-1','1.5','8x'])assert.throws(()=>modelCallConcurrency({BB_MODEL_CALL_CONCURRENCY:n}));
const pool=new Pool({host:'127.0.0.1',port:1,max:1});const budget=new PgModelCallBudget(pool,8);assert.throws(()=>new PgModelCallBudget(pool,9));await budget.sessions.end();await pool.end();
console.log(JSON.stringify({status:'PASS',node:process.version,imports:6,node_limit8:true,network:'none',worker_started:false,database_connected:false,model_called:false}));"""
for role in ['authoring','review']:
 image=source['underlying_images'][role];p=subprocess.run(['docker','image','inspect','--format','{{.Id}}',image],capture_output=True,text=True,check=True);assert p.stdout.strip()==image
 args=['docker','run','--rm','--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','1536m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:size=16m,mode=1777','--entrypoint','node','--workdir','/app']
 for row in d['files']:
  if row['service_id']!=role:continue
  path=root/'payload'/role/row['path'];b=path.read_bytes();assert len(b)==row['bytes'] and hashlib.sha256(b).hexdigest()==row['sha256'];args+=['--mount',f'type=bind,source={path},target=/app/{row["path"]},readonly']
 result=subprocess.run(args+[image,'--input-type=module','-e',program],capture_output=True,text=True,timeout=120)
 row={'role':role,'image':image,'exit_code':result.returncode,'stdout':result.stdout,'stderr':result.stderr};receipts.append(row)
 if result.returncode:break
(root/'oci-import-verification.json').write_text(json.dumps({'version':'managed-performance-role-closure-verification-v1','receipts':receipts},indent=2)+'\n')
print(json.dumps(receipts));sys.exit(0 if len(receipts)==2 and all(r['exit_code']==0 for r in receipts) else 1)
