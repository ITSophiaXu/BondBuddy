import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {Pool} from 'pg';

const url='postgresql://bb_g03_test@127.0.0.1:15526/bb_g03_template_20261026';
const mode=process.argv[2];
if(mode==='migrate'){
  const pool=new Pool({connectionString:url});
  try{
    if((await pool.query('SELECT count(*)::int n FROM bb_runs')).rows[0].n!==0)throw new Error('Template must remain empty');
    const name='0118_run_supplement_drafts.sql';
    const applied=await pool.query('SELECT 1 FROM bb_schema_migrations WHERE filename=$1',[name]);
    if(applied.rowCount)throw new Error('Migration already applied; do not rerun');
    await pool.query('BEGIN');
    await pool.query(readFileSync(`db/migrations/${name}`,'utf8'));
    await pool.query('INSERT INTO bb_schema_migrations(filename) VALUES($1)',[name]);
    await pool.query('COMMIT');
    console.log(`Applied ${name}; PostgreSQL ${(await pool.query('SHOW server_version')).rows[0].server_version}`);
  }catch(error){await pool.query('ROLLBACK');throw error;}finally{await pool.end();}
}else if(mode==='test'||mode==='regression'){
  const env={...process.env};
  for(const name of Object.keys(env))if(/^(BB_|DATABASE_URL$|AZURE_|DEEPSEEK_|OPENAI_|CODEX_HOME$)/i.test(name))delete env[name];
  env.BB_TEST_DATABASE_URL=url;env.BB_RUN_RUNTIME_ENABLED='1';
  const files=mode==='test'?['apps/api/dist/run-supplement-draft.pg.test.js']:['apps/api/dist/run-origin-immutability.pg.test.js','apps/api/dist/queue.test.js'];
  const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...files],{env,stdio:'inherit',windowsHide:true});
  if(result.error)throw result.error;
  process.exitCode=result.status??1;
}else throw new Error('Choose migrate, test or regression');
