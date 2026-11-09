import type {PoolClient} from 'pg';
/** Shared only by pin registration and destructive Blob operations. Full reads
 * never hold this lock or the project lock. Hash collisions only serialize work. */
export async function lockStorageObject(client:PoolClient,owner:string,key:string){
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([owner,key])]);
}
