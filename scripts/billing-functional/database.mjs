import {Client} from 'pg';
import {spawnSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {config,pgBase,repo,runtime,cleanEnvironment} from './config.mjs';

export async function ensureDatabase(){
  const saved=config(true);
  if(!/^bb_billing_functional_[a-f0-9]{16}$/.test(saved.database)||!/^[-a-f0-9]{36}$/.test(saved.id))throw Error('Invalid local functional database identity');
  const admin=new Client({connectionString:pgBase+'postgres',connectionTimeoutMillis:10000});await admin.connect();
  try{
    const exists=(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[saved.database])).rowCount;
    if(!exists){
      // Names are fixed/validated identifiers, never supplied by HTTP input.
      // Start empty: no template users or balances are copied.
      await admin.query(`CREATE DATABASE "${saved.database}"`);
    }
    const local=new Client({connectionString:pgBase+saved.database});await local.connect();
    try{
      if((await local.query('SELECT current_database() database')).rows[0].database!==saved.database)throw Error('Connected database name differs from the local instance');
      if(!exists){
        // Establish ownership before migration so an interrupted first install
        // can safely retry the same instance without deleting partial history.
        await local.query('CREATE TABLE bb_local_billing_instance(instance_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())');
        await local.query('INSERT INTO bb_local_billing_instance(instance_id) VALUES($1)',[saved.id]);
      }
      const markers=(await local.query('SELECT instance_id FROM bb_local_billing_instance')).rows;
      if(markers.length!==1||markers[0].instance_id!==saved.id)throw Error('Existing database is not this functional test instance');
      // Migrate new AND existing owned instances. The repository migration
      // runner skips recorded migrations; no wallet, account or table is reset.
      const result=spawnSync(process.execPath,['db/migrate.mjs'],{cwd:repo,env:{...cleanEnvironment(),DATABASE_URL:pgBase+saved.database},windowsHide:true,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
      appendFileSync(join(runtime,'migrations.log'),`\n[${new Date().toISOString()}] ${saved.database} ${exists?'upgrade':'install'}\n`+(result.stdout??'')+(result.stderr??'')+`\nexit=${result.status} signal=${result.signal??'none'}${result.error?' error='+result.error.message:''}\n`);
      if(result.status!==0||result.error)throw Error('Migration failed; isolated database and append-only migration diagnostics were retained');
      await local.query(`CREATE TABLE IF NOT EXISTS bb_local_billing_reviews(id text PRIMARY KEY,owner_user_id text NOT NULL REFERENCES bb_users(id),
        project_id text NOT NULL REFERENCES bb_projects(id),request jsonb NOT NULL,quote jsonb NOT NULL,run_id text REFERENCES bb_runs(id),created_at timestamptz NOT NULL DEFAULT now())`);
    }finally{await local.end();}
    return saved;
  }finally{await admin.end();}
}
