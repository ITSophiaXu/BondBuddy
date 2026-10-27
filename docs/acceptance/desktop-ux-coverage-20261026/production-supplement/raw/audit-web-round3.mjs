import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createConnection} from 'node:net';
import {resolve,join} from 'node:path';
import {Pool} from 'pg';

const root=process.cwd(),base=resolve(root,'.local/production-supplement-20261027');
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const rounds={};
for(const kind of ['mock','real']){
  const dir=join(base,`web-${kind}-round3`),[before,after,report,stability]=await Promise.all([
    json(join(dir,'source-before.json')),json(join(dir,'source-after.json')),json(join(dir,'results.json')),json(join(dir,'source-stability.json'))]);
  assert.equal(stability.stable,true);assert.equal(before.length,24);assert.deepEqual(before,after);
  assert.equal(report.stats.unexpected,0);assert.equal(report.stats.skipped,0);assert.equal(report.stats.expected,kind==='mock'?37:3);
  rounds[kind]={evidence_dir:dir,source_files:24,source_stable:true,stats:report.stats,exit:stability.exit};
}
const cases=[];
for(const kind of ['authoring','review','m4']){
  const dir=join(base,'web-real-round3',kind),[a,cleanup,bytes]=await Promise.all([
    json(join(dir,'assertions.json')),json(join(dir,'owned-cleanup.json')),readFile(join(dir,'browser-downloaded-successor.docx'))]);
  assert.equal(a.real_browser_http_pg_worker,true);assert.equal(a.synthetic_provider,true);assert.equal(a.synthetic_credit_lot,true);
  assert.equal(a.adoption.execution_version,2);assert.equal(a.resumed_without_local_journal,true);
  assert.equal(a.adoption.additional_points,4500);assert.equal(a.attempts.length,2);
  assert.ok(a.word_check.paragraphs>0);assert.equal(createHash('sha256').update(bytes).digest('hex'),a.downloaded_sha256);
  assert.deepEqual(cleanup.clone_remaining,[]);assert.equal(cleanup.http_app_closed,true);
  assert.match(cleanup.clone_name,/^bb_prod_supplement02_20261027_t[0-9]+_[a-f0-9]{8}$/);
  const screenshots=(await readdir(dir)).filter(name=>name.endsWith('.png'));
  cases.push({kind,evidence_dir:dir,execution_version:2,additional_points:4500,real_browser_http_pg_worker:true,
    synthetic_provider:true,synthetic_credit_lot:true,resumed_without_local_journal:true,word_paragraphs:a.word_check.paragraphs,
    downloaded_sha256:a.downloaded_sha256,browser_byte_route:a.browser_byte_route,counts_before_resume:a.counts_before_resume,screenshots,cleanup});
}
// Read-only cleanup audit against maintenance/postgres on the dedicated instance.
const pool=new Pool({connectionString:'postgresql://bb_successor_test@127.0.0.1:15542/postgres',max:1});
let remaining;
try{remaining=(await pool.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])',[cases.map(row=>row.cleanup.clone_name)])).rows;}finally{await pool.end();}
assert.deepEqual(remaining,[]);
async function listening(port){return new Promise(resolveListening=>{const socket=createConnection({host:'127.0.0.1',port});socket.setTimeout(3000);
  socket.once('connect',()=>{socket.destroy();resolveListening(true);});socket.once('error',()=>resolveListening(false));socket.once('timeout',()=>{socket.destroy();resolveListening(false);});});}
const ports={5187:await listening(5187),5199:await listening(5199)};assert.deepEqual(ports,{5187:false,5199:false});
const mockScreenshots=(await readdir(join(base,'web-mock-round3/screenshots'))).filter(name=>name.endsWith('.png'));
const audit={audited_at:new Date().toISOString(),rounds,cases,owned_clones_remaining:remaining,http_ports_listening:ports,mock_screenshot_count:mockScreenshots.length,web_noemit_exit:0,no_commits_or_pushes:true};
await writeFile(join(base,'web-real-round3/cleanup-audit.json'),JSON.stringify(audit,null,2));
process.stdout.write(JSON.stringify(audit,null,2)+'\n');
