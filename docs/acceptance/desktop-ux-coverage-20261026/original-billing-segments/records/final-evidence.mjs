import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync,readFileSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
const out=resolve('.local/billing-segments-20261027');
const read=path=>JSON.parse(readFileSync(join(out,path),'utf8').replace(/^\uFEFF/,''));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const accepted={};const sourceManifests={};
const allowed=['apps/api/src/run-billing-segments.pg.test.ts','apps/api/dist/run-billing-segments.pg.test.js'];
function diff(a,b){const old=new Map(a.map(file=>[file.path,file.sha256])),current=new Map(b.map(file=>[file.path,file.sha256]));
  return[...new Set([...old.keys(),...current.keys()])].filter(path=>old.get(path)!==current.get(path));}
for(const mode of ['functional','compat','sql','regression']){
  const dirs=readdirSync(out).filter(value=>value.startsWith(`${mode}-`)).sort();
  const rows=dirs.map(dir=>({dir,summary:read(`${dir}/summary.json`)}));
  const last=rows.at(-1);assert.equal(last.summary.exitCode,0,mode);assert.equal(last.summary.totals.fail,0);
  const before=read(`${last.dir}/sources-before.json`),after=read(`${last.dir}/sources-after.json`);
  const changes=diff(before,after);assert.ok(changes.every(path=>allowed.includes(path)));
  accepted[mode]={...last.summary,directory:last.dir,changesDuringRun:changes};sourceManifests[mode]=after;
}
const final=sourceManifests.functional.map(file=>{const bytes=readFileSync(file.path);return{path:file.path,bytes:bytes.length,sha256:sha(bytes)};});
for(const mode of Object.keys(accepted)){
  const changes=diff(sourceManifests[mode],final);assert.ok(changes.every(path=>allowed.includes(path)));
  accepted[mode].changesToFinal=changes;
}
assert.deepEqual(diff(sourceManifests.functional,final),[]);
const migration=read('migrate-final02-result.json'),build=read('build-api-final.json'),types=read('final-typecheck.json');
assert.equal(migration.success,true);assert.equal(build.exitCode,0);assert.equal(types.exitCode,0);
assert.equal(sha(readFileSync('db/migrations/0138_run_billing_segments.sql')),
  migration.migrationsAfter.find(file=>file.path==='0138_run_billing_segments.sql').sha256);
const summary={recordedAt:new Date().toISOString(),baseCommit:'05155d3d066e653101e71ff8682ee9c2fe10ceb1',
  scope:'Original V1 fee segment/binding/meter used by actual debits, progress, finalizers, history and audit; paid successors remain disabled',
  migration:{template:'bb_segments_final02_20261027',from:'template0',count:migration.audit.migration_count,sourcesStable:true},
  build,finalTypecheck:types,accepted,sourceEntries:final.length,
  sourceInterpretation:'Only the corrected functional test source/JS differs from earlier SQL/compat runs and overlaps unrelated regression. All production code, SQL, selected regression tests and their dependencies are identical. Final corrected functional suite and noEmit typecheck validate the final file.',
  preservedNonAdopted:['First migration observed SQL edits: source stability false; not adopted.',
    'First stable 0138 template predates explicit TRUNCATE guard improvement; final02 is adopted.',
    'First build failed on two functional-test TypeScript errors; fixed.',
    'First functional run: 1 pass / 11 fail from DTO policy assumption and leftover queued fixture tasks; corrected run adopted without accumulating repeated counts.'],
  limitations:['No additional reservation, B1 rework billing, zero-additional successor binding, paid V2, public adoption or browser acceptance is established.',
    'G03/UX-A03 and the complete original goal remain active; previous desktop counters are unchanged.'],success:true};
writeFileSync(join(out,'sources-final.json'),JSON.stringify(final));writeFileSync(join(out,'final-evidence.json'),JSON.stringify(summary,null,2));
process.stdout.write(JSON.stringify({success:true,sourceEntries:final.length,results:Object.fromEntries(Object.entries(accepted).map(([key,row])=>[key,{exitCode:row.exitCode,totals:row.totals,sourcesStable:row.sourcesStable,changesToFinal:row.changesToFinal}]))})+'\n');
