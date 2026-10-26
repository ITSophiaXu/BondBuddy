import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve,relative,join} from 'node:path';
import {Pool} from 'pg';

const root=process.cwd();
const local=resolve(root,'.local/supplement-preparation-real');
const template='postgresql://bb_g03_test@127.0.0.1:15526/bb_g03_template_20261026';
mkdirSync(local,{recursive:true});
const env={...process.env};
for(const name of Object.keys(env))if(/^(BB_|DATABASE_URL$|AZURE_|DEEPSEEK_|OPENAI_|CODEX_HOME$)/i.test(name))delete env[name];
env.BB_TEST_DATABASE_URL=template;
env.BB_RUN_RUNTIME_ENABLED='1';
env.BB_E2E_BASE_URL='http://127.0.0.1:5198';
env.BB_E2E_BROWSER_CHANNEL='msedge';
env.BB_SUPPLEMENT_REAL_EVIDENCE_DIR=join(local,'evidence');
env.PLAYWRIGHT_JSON_OUTPUT_FILE=join(local,'browser-report.json');
const mode=process.argv[2];
if(mode==='test'||mode==='tsc'){
  const args=mode==='test'?[resolve(root,'node_modules/@playwright/test/cli.js'),'test','--config','playwright.config.ts','run-supplement-real-main.spec.ts','--workers','1','--output',join(local,'browser-results'),'--reporter=line,json']
    :[resolve(root,'node_modules/typescript/bin/tsc'),'--noEmit','-p','apps/web/tsconfig.json'];
  const result=spawnSync(process.execPath,args,{cwd:mode==='test'?resolve(root,'apps/web'):root,env,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024});
  const output=(result.stdout??'')+(result.stderr??'');
  writeFileSync(join(local,`${mode}.log`),output);
  process.stdout.write(output);
  if(result.error)throw result.error;
  process.exitCode=result.status??1;
}else if(mode==='snapshot'){
  const pool=new Pool({connectionString:template});
  try{
    const evidence={server_version:(await pool.query('SHOW server_version')).rows[0].server_version,
      schema:(await pool.query('SELECT filename FROM bb_schema_migrations ORDER BY filename DESC LIMIT 2')).rows,
      template_run_count:(await pool.query('SELECT count(*)::int n FROM bb_runs')).rows[0].n,
      template_draft_count:(await pool.query('SELECT count(*)::int n FROM bb_run_supplement_drafts')).rows[0].n,
      remaining_clones:(await pool.query("SELECT datname FROM pg_database WHERE datname LIKE 'bb_g03_template_20261026_t%' ORDER BY datname")).rows};
    writeFileSync(join(local,'database-final.json'),JSON.stringify(evidence,null,2)+'\n');
    console.log(JSON.stringify(evidence,null,2));
    if(evidence.template_run_count||evidence.template_draft_count||evidence.remaining_clones.length)throw new Error('Test data did not clean up');
  }finally{await pool.end();}
}else if(mode==='source-before'||mode==='source-after'){
  const files=[];
  const walk=dir=>{for(const e of readdirSync(dir,{withFileTypes:true})){const file=join(dir,e.name);if(e.isDirectory())walk(file);else if(e.isFile())files.push(file);}};
  for(const dir of ['apps/web/src','apps/web/dist','apps/api/src','apps/api/dist','packages/contracts/src','packages/contracts/dist'])walk(resolve(root,dir));
  const entries=files.sort().map(file=>({path:relative(root,file).replaceAll('\\','/'),sha256:createHash('sha256').update(readFileSync(file)).digest('hex')}));
  writeFileSync(join(local,`${mode}.json`),JSON.stringify(entries,null,2)+'\n');
  console.log(`${mode}: ${entries.length} source/build files hashed`);
  if(mode==='source-after'){
    const before=JSON.parse(readFileSync(join(local,'source-before.json'),'utf8'));
    if(JSON.stringify(before)!==JSON.stringify(entries))throw new Error('Production source/build changed during integration verification');
  }
}else throw new Error('Choose tsc, test, snapshot, source-before or source-after');
