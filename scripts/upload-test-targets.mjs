import {BlobServiceClient} from '@azure/storage-blob';

const loopback=new Set(['localhost','127.0.0.1','[::1]']);
/** Validate both raw targets before any connection, clone, or fixture write. */
export function localUploadTargets(databaseUrl,storageConnection){
 let database,storage;
 try{
  database=new URL(databaseUrl);
  if(!['postgres:','postgresql:'].includes(database.protocol)||!loopback.has(database.hostname)||database.search||database.hash||database.pathname.length<2)throw Error();
  storage=BlobServiceClient.fromConnectionString(storageConnection);
  const endpoint=new URL(storage.url);
  if(endpoint.protocol!=='https:'||!loopback.has(endpoint.hostname)||endpoint.search||endpoint.hash)throw Error();
 }catch{throw Error('Upload fixtures require explicit loopback PostgreSQL and HTTPS Blob targets');}
 return {database,storage};
}
