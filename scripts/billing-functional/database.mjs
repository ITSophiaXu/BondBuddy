import {Client} from 'pg';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {config,pgBase,repo,runtime,cleanEnvironment} from './config.mjs';

export async function ensureDatabase(){
  const saved=config(true),admin=new Client({connectionString:pgBase+'postgres',connectionTimeoutMillis:10000});await admin.connect();
  try{
    const exists=(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[saved.database])).rowCount;
    if(!exists){
      // Names are fixed/validated identifiers, never supplied by HTTP input.
      // Start empty and migrate: no template users or balances are copied.
      await admin.query(`CREATE DATABASE "${saved.database}"`);
      const result=spawnSync(process.execPath,['db/migrate.mjs'],{cwd:repo,env:{...cleanEnvironment(),DATABASE_URL:pgBase+saved.database},windowsHide:true,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
      writeFileSync(join(runtime,'migrations.log'),(result.stdout??'')+(result.stderr??''));
      if(result.status!==0)throw Error('Migration failed; new isolated database and diagnostics were retained');
    }
    const local=new Client({connectionString:pgBase+saved.database});await local.connect();
    try{
      if(exists){
        const marker=(await local.query('SELECT instance_id FROM bb_local_billing_instance')).rows[0];
        if(marker?.instance_id!==saved.id)throw Error('Existing database is not this functional test instance');
      }else{
        await local.query('CREATE TABLE bb_local_billing_instance(instance_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())');
        await local.query('INSERT INTO bb_local_billing_instance(instance_id) VALUES($1)',[saved.id]);
        await local.query(`CREATE TABLE bb_local_billing_reviews(id text PRIMARY KEY,owner_user_id text NOT NULL REFERENCES bb_users(id),
          project_id text NOT NULL REFERENCES bb_projects(id),request jsonb NOT NULL,quote jsonb NOT NULL,run_id text REFERENCES bb_runs(id),created_at timestamptz NOT NULL DEFAULT now())`);
      }
    }finally{await local.end();}
    return saved;
  }finally{await admin.end();}
}
