import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createConnection} from 'node:net';
import {resolve,join} from 'node:path';
import {Pool} from 'pg';

const root=process.cwd(),base=resolve(root,'.local/production-supplement-20261027'),evidence=join(base,'web-real-round6');
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const [before,after,report,stability,baseline]=await Promise.all([
  json(join(evidence,'source-before.json')),json(join(evidence,'source-after.json')),json(join(evidence,'results.json')),
  json(join(evidence,'source-stability.json')),json(join(base,'web-real-round3/source-before.json'))]);
assert.equal(stability.stable,true);assert.equal(stability.files,27);assert.equal(stability.exit.code,0);assert.deepEqual(before,after);
assert.equal(report.stats.unexpected,0);assert.equal(report.stats.skipped,0);assert.equal(report.stats.expected,3);
const baselineByPath=new Map(baseline.map(row=>[row.path,row]));
const productFiles=before.filter(row=>!row.path.startsWith('apps/web/tests/')&&!row.path.startsWith('apps/worker/test-fixtures/'));
for(const row of productFiles)assert.equal(row.sha256,baselineByPath.get(row.path)?.sha256,`Product bytes changed: ${row.path}`);
const cases=[];
for(const kind of ['authoring','review','m4']){
  const dir=join(evidence,kind),[a,wallet,cleanup,bytes,phases,browserTeardown]=await Promise.all([
    json(join(dir,'assertions.json')),json(join(dir,'wallet-five-stages.json')),json(join(dir,'owned-cleanup.json')),readFile(join(dir,'browser-downloaded-successor.docx')),
    json(join(dir,'owned-cleanup-phases.json')),json(join(dir,'owned-browser-teardown.json'))]);
  assert.equal(a.real_browser_http_pg_worker,true);assert.equal(a.synthetic_provider,true);assert.equal(a.synthetic_credit_lot,true);
  assert.equal(a.adoption.execution_version,2);assert.equal(a.resumed_without_local_journal,true);assert.equal(a.adoption.additional_points,4500);
  assert.equal(a.attempts.length,2);assert.equal(createHash('sha256').update(bytes).digest('hex'),a.downloaded_sha256);
  assert.equal(a.marker_read_from_uploaded_bytes,true);assert.match(a.adopted_material_marker,/^SYNTHETIC_[A-Za-z0-9_]+_ADOPTED$/);
  assert.ok(a.word_check.text.includes(a.adopted_material_marker));
  assert.ok(a.original_word_evidence.length>0&&a.original_word_evidence.every(row=>row.read_method==='persisted_private_blob'&&!row.word_check.text.includes(a.adopted_material_marker)&&row.sha256!==a.downloaded_sha256));
  const calls=a.after.provider_calls;assert.equal(calls.length,2);assert.equal(calls[0].reflected_material_marker,null);
  assert.equal(calls[1].reflected_material_marker,a.adopted_material_marker);
  assert.ok(calls[1].reflected_material_reads.some(row=>row.marker===a.adopted_material_marker&&row.material_id===a.uploaded_material.material_id&&row.sha256===a.uploaded_material.sha256));
  assert.deepEqual(Object.keys(wallet.required_five_stages),['before_pause','paused','supplement_saved','before_adoption_consent','succeeded']);
  const stages=Object.entries(wallet.required_five_stages).map(([stage,s])=>{
    assert.equal(s.http.before.enabled,true);assert.deepEqual(s.http.before,s.http.after);assert.equal(s.database.isolation,'repeatable read');
    assert.equal(s.http.after.available,s.totals.available);assert.equal(s.http.after.frozen,s.totals.reserved);
    assert.equal(s.totals.available+s.totals.reserved+s.totals.consumed,s.totals.granted);
    return {stage,...s.totals};
  });
  assert.equal(wallet.checks.successor_consumed_points,4500);assert.equal(wallet.checks.adoption_debit,0);assert.equal(wallet.checks.adoption_frozen,0);
  for(const key of ['paused_through_saving_and_quote_refresh_unchanged','original_fee_preserved','ledger_append_only','all_http_wallets_match_rr_lots','all_lot_ledger_wallet_totals_conserved'])assert.equal(wallet.checks[key],true);
  assert.deepEqual(cleanup.clone_remaining,[]);assert.equal(cleanup.http_app_closed,true);assert.match(cleanup.clone_name,/^bb_prod_supplement02_20261027_t[0-9]+_[a-f0-9]{8}$/);
  assert.deepEqual(browserTeardown.map(row=>row.phase),['before_context_close','after_context_close']);
  assert.ok(browserTeardown.every(row=>row.business_evidence_complete&&row.browser_at_blank));
  for(const name of ['before_app_close','after_app_close','before_fixture_cleanup','after_fixture_cleanup','before_owned_drop','after_owned_drop'])
    assert.ok(phases.some(row=>row.phase===name),`Missing cleanup phase ${name}`);
  assert.ok(phases.every(row=>row.business_evidence_complete&&row.browser_at_blank&&row.browser_context_closed));
  const pending=phases.find(row=>row.phase==='app_close_pending_2s');
  if(pending){assert.deepEqual(pending.active_http,[]);assert.equal(pending.pool.waiting,0);assert.ok(pending.pg_activity.every(row=>row.state==='idle'));}
  const afterCleanup=phases.find(row=>row.phase==='after_fixture_cleanup');assert.equal(afterCleanup.pool.total,0);assert.equal(afterCleanup.pool.waiting,0);
  cases.push({kind,evidence_dir:dir,real_browser_http_pg_worker:true,synthetic_provider:true,synthetic_credit_lot:true,
    adopted_material_marker:a.adopted_material_marker,uploaded_material_sha256:a.uploaded_material.sha256,marker_read_from_uploaded_bytes:true,
    original_word_read_method:'persisted_private_blob',v1_marker_absent:true,browser_download_v2_marker_present:true,downloaded_sha256:a.downloaded_sha256,
    word_paragraphs:a.word_check.paragraphs,browser_byte_route:a.browser_byte_route,resumed_without_local_journal:true,counts_before_resume:a.counts_before_resume,
    required_wallet_stages:stages,wallet_checks:wallet.checks,screenshots:(await readdir(dir)).filter(name=>name.endsWith('.png')),
    cleanup_phases:phases.map(({phase,at,http_connections,active_http,pool})=>({phase,at,http_connections,active_http,pool})),cleanup});
}
const pool=new Pool({connectionString:'postgresql://bb_successor_test@127.0.0.1:15542/postgres',max:1});
let remaining;try{remaining=(await pool.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])',[cases.map(row=>row.cleanup.clone_name)])).rows;}finally{await pool.end();}
assert.deepEqual(remaining,[]);
async function listening(port){return new Promise(done=>{const socket=createConnection({host:'127.0.0.1',port});socket.setTimeout(3000);
  socket.once('connect',()=>{socket.destroy();done(true);});socket.once('error',()=>done(false));socket.once('timeout',()=>{socket.destroy();done(false);});});}
const ports={5187:await listening(5187),5199:await listening(5199)};assert.deepEqual(ports,{5187:false,5199:false});
const audit={audited_at:new Date().toISOString(),evidence_dir:evidence,stats:report.stats,exit:stability.exit,
  frozen_files:27,source_and_artifacts_stable:true,product_hashes_unchanged_from_round3:true,unchanged_product_file_count:productFiles.length,
  cases,owned_clones_remaining:remaining,http_ports_listening:ports,web_noemit_exit:0};
await writeFile(join(evidence,'cleanup-audit.json'),JSON.stringify(audit,null,2));process.stdout.write(JSON.stringify(audit,null,2)+'\n');
