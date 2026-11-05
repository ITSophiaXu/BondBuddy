import {Client} from 'pg';
import {spawnSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {config,databaseURL,repo,runtime,cleanEnvironment} from './config.mjs';

export async function assertDatabase(client,saved){
  const identity=(await client.query('SELECT current_database() name,current_user role')).rows[0];
  if(identity.name!=='bb_alipay_acceptance'||identity.role!=='bondbuddy_alipay_local')throw Error('Wrong local database identity');
  const markers=(await client.query('SELECT instance_id,workspace FROM bb_local_alipay_instance')).rows;
  if(markers.length!==1||markers[0].instance_id!==saved.id||markers[0].workspace!==repo)throw Error('Unowned Alipay acceptance database');
}
export async function ensureDatabase(){
  const saved=config(true),client=new Client({connectionString:databaseURL,connectionTimeoutMillis:10000});await client.connect();
  try{
    await client.query("SELECT pg_advisory_lock(hashtextextended('bb-local-alipay-bootstrap',0))");
    const identity=(await client.query('SELECT current_database() name,current_user role')).rows[0];
    if(identity.name!==saved.database||identity.role!=='bondbuddy_alipay_local')throw Error('Wrong local database identity');
    if(!(await client.query("SELECT to_regclass('public.bb_local_alipay_instance') marker")).rows[0].marker){
      if((await client.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n!==0)throw Error('Refusing to initialize a nonempty unowned database');
      await client.query('BEGIN');
      try{await client.query('CREATE TABLE bb_local_alipay_instance(instance_id text PRIMARY KEY,workspace text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())');
        await client.query('INSERT INTO bb_local_alipay_instance(instance_id,workspace) VALUES($1,$2)',[saved.id,repo]);await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}
    }
    await assertDatabase(client,saved);
    const result=spawnSync(process.execPath,['db/migrate.mjs'],{cwd:repo,env:{...cleanEnvironment(),DATABASE_URL:databaseURL},windowsHide:true,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
    appendFileSync(join(runtime,'migrations.log'),`\n[${new Date().toISOString()}]\n`+(result.stdout??'')+(result.stderr??'')+`\nexit=${result.status}\n`);
    if(result.status!==0||result.error)throw Error('Local migration failed; inspect .local/alipay-integration/migrations.log. Data retained.');
    return saved;
  }finally{await client.end();}
}
