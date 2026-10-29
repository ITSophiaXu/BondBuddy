// Local, private-bundle smoke test. Never calls a model or creates billable runs.
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {isolatedTestDatabase} from '../apps/api/dist/test-database.js';
import {createServer} from '../apps/api/dist/server.js';
if(!process.env.BB_TEST_DATABASE_URL||!['localhost','127.0.0.1','[::1]'].includes(new URL(process.env.BB_TEST_DATABASE_URL).hostname))throw Error('Use an isolated local migrated test database');
if(!process.env.BB_FILE_TEMPLATE_BUNDLE)throw Error('Set BB_FILE_TEMPLATE_BUNDLE to the private bundle directory');
const db=await isolatedTestDatabase(undefined,'private-bundle-smoke'),pool=new Pool({connectionString:db}),memory=new Map(),owner='bundle-'+randomUUID();
const blobs={put:async(k,b)=>{memory.set(k,b)},get:async k=>memory.get(k),getIfExists:async k=>memory.get(k)??null,getIfExistsBounded:async(k,max)=>{const b=memory.get(k);return b&&b.length<=max?b:null},exists:async k=>memory.has(k),delete:async k=>{memory.delete(k)}};
const app=createServer({pool,blobs,allowedOrigin:'http://bundle.test',principal:async()=>({userId:owner,csrfVerified:true})});
app.addHook('onError',async(_request,_reply,error)=>{console.error('bundle_check_failed',error.name,error.message)});
async function call(method,url,payload){const r=await app.inject({method,url,payload,headers:{origin:'http://bundle.test'}});if(r.statusCode>=300)throw Error(r.statusCode+': '+r.body);return r.json()}
try{
 const p=await call('POST','/api/v1/projects',{name:'Private bundle verification',kind:'generation',issuer_name:'Synthetic issuer',market:'sse',offering:'private'}),base='/api/v1/projects/'+p.project_id+'/file-generation';
 const workspace=await call('GET',base),a=await call('POST',base+'/builtin',{request_id:'verify-bundle',version:workspace.builtin.version,part:'all'});
 const matches=await call('GET',base+'/matches?'+new URLSearchParams({catalogue_id:a.catalogue.catalogue_id,set_id:a.set.set_id}));
 console.log(JSON.stringify({version:workspace.builtin.version,templates:a.set.records.length,catalogue:a.catalogue.entries.length,unique_objects:memory.size,matches:matches.matches.reduce((acc,r)=>(acc[r.status]=(acc[r.status]??0)+1,acc),{}),storage:'in-memory private blob adapter',database:'isolated PostgreSQL clone',model:'not called'}));
}finally{await app.close();await pool.end()}
