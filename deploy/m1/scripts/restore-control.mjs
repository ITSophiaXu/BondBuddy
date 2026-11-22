// Private operator entry points. Never starts a service, sends a model call or repairs a ledger.
import {lstatSync,readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {BlobServiceClient} from '@azure/storage-blob';
import {Pool} from 'pg';

const fail=code=>{throw Error(code);};
/** Connection-string ordering, shared-key rotation and endpoint aliases cannot conceal the same account. */
export function assertRestoreStorageIsolated(source,target){
  if(!source||!target)fail('RESTORE_STORAGE_CONNECTIONS_REQUIRED');
  const identity=value=>{
    const client=BlobServiceClient.fromConnectionString(value),url=new URL(client.url);
    const entries=value.split(';').filter(Boolean).map(part=>{const at=part.indexOf('=');return [part.slice(0,at).trim().toLowerCase(),part.slice(at+1).trim()];});
    if(new Set(entries.map(([key])=>key)).size!==entries.length)fail('RESTORE_STORAGE_IDENTITY_UNAVAILABLE');
    const parts=Object.fromEntries(entries),account=parts.accountname??(parts.usedevelopmentstorage?.toLowerCase()==='true'?'devstoreaccount1':undefined);
    if(!account)fail('RESTORE_STORAGE_IDENTITY_UNAVAILABLE');
    return {account:account.toLowerCase(),route:url.origin.toLowerCase()+url.pathname.replace(/\/$/,'')};
  };
  const a=identity(source),b=identity(target);
  if(a.account===b.account||a.route===b.route)fail('RESTORE_STORAGE_NOT_ISOLATED');
  return {state:'storage_isolated'};
}
function requestFile(path){
  if(!path)fail('RESTORE_CONTROL_REQUEST_REQUIRED');
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>1024*1024)fail('RESTORE_CONTROL_REQUEST_UNSAFE');
  const request=JSON.parse(readFileSync(path,'utf8'));
  if(!request||typeof request!=='object'||Array.isArray(request))fail('RESTORE_CONTROL_REQUEST_INVALID');
  return request;
}
export async function runRestoreControl(mode,input,env=process.env){
  assertRestoreStorageIsolated(env.AZURE_STORAGE_CONNECTION_STRING,env.BB_RESTORE_STORAGE_CONNECTION_STRING);
  if(mode==='validate-storage')return {state:'storage_isolated'};
  if(!['fence','reconcile','resume'].includes(mode))fail('RESTORE_CONTROL_MODE_INVALID');
  if(!env.BB_RESTORE_OPERATOR_ID||!env.RESTORE_DATABASE_URL||!env.DATABASE_URL||!env.BB_RESTORE_DATABASE_NAME
    ||env.RESTORE_DATABASE_URL===env.DATABASE_URL)fail('RESTORE_CONTROL_ENVIRONMENT_REQUIRED');
  const pool=new Pool({connectionString:env.RESTORE_DATABASE_URL});
  try{
    const name=(await pool.query('SELECT current_database() name')).rows[0].name;
    const source=decodeURIComponent(new URL(env.DATABASE_URL).pathname.slice(1));
    if(name!==env.BB_RESTORE_DATABASE_NAME||name===source)fail('RESTORE_DATABASE_NOT_ISOLATED');
    const {azureBlobs}=await import('../../../apps/api/dist/data.js');
    const blobs=azureBlobs(env.BB_RESTORE_STORAGE_CONNECTION_STRING,env.BB_PROVIDER_RESULT_CONTAINER??'bondbuddy-private');
    const readObject=async ref=>{
      if(typeof ref!=='string'||!ref||ref.includes('\0'))fail('RESTORE_OBJECT_REF_INVALID');
      const bytes=await blobs.getIfExistsBounded(ref,10*1024*1024);
      if(!bytes)fail('RESTORE_OBJECT_MISSING');return bytes;
    };
    if(mode==='reconcile'){
      const {resumeDatabaseRestoreGate}=await import('../../../apps/api/dist/evidence-gate.js');
      return await resumeDatabaseRestoreGate(pool,env.BB_RESTORE_OPERATOR_ID,input,readObject);
    }
    const {fenceRestoredExecutionEpoch,resumeRestoredRun}=await import('../../../apps/api/dist/queue.js');
    if(mode==='fence')return await fenceRestoredExecutionEpoch(pool,env.BB_RESTORE_OPERATOR_ID,input,{readObject});
    const allowed=await resumeRestoredRun(pool,env.BB_RESTORE_OPERATOR_ID,input.owner_user_id,input.run_id,
      {quarantineId:input.quarantine_id,manifestSha256:input.manifest_sha256},{blobs});
    if(!allowed)fail('RESTORE_RUN_NOT_RECOVERABLE');
    return {state:'queued',run_id:input.run_id};
  }finally{await pool.end();}
}
async function main(){
  const [mode,path]=process.argv.slice(2);
  const result=await runRestoreControl(mode,mode==='validate-storage'?undefined:requestFile(path));
  process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.code??error.message);process.exitCode=1;});
