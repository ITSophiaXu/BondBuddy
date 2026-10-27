import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync,readFileSync,writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
const out=resolve('.local/supplement-b1-20261027');
const read=path=>JSON.parse(readFileSync(join(out,path),'utf8').replace(/^\uFEFF/,''));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const apiDir=readdirSync(out).find(value=>/^api-/.test(value));
const regDir=readdirSync(out).find(value=>/^regression-/.test(value));
const api=read(`${apiDir}/summary.json`),reg=read(`${regDir}/summary.json`),sql=read('sql-pg-root-final/result.json');
const migrated=read('migrate-result.json'),typecheck=read('final-typecheck.json'),contracts=read('contracts-results.json');
assert.equal(migrated.success,true);assert.equal(sql.exitCode,0);assert.equal(sql.sourceStable,true);assert.equal(typecheck.exitCode,0);
assert.equal(reg.success,true);
assert.ok(api.invocations.every(value=>value.exitCode===0));
const changes=(before,after)=>{
  const a=new Map(before.map(value=>[value.path,value.sha256])),b=new Map(after.map(value=>[value.path,value.sha256]));
  return [...new Set([...a.keys(),...b.keys()])].filter(path=>a.get(path)!==b.get(path));
};
const prior=read(`${apiDir}/sources-before.json`),after=read(`${apiDir}/sources-after.json`);
const runtimeBefore=read(`${apiDir}/runtime-before.json`),runtimeAfter=read(`${apiDir}/runtime-after.json`);
const expectedSource='apps/api/src/run-supplement-quotes-sql.pg.test.ts';
const expectedRuntime='apps/api/dist/run-supplement-quotes-sql.pg.test.js';
assert.deepEqual(changes(prior,after),[expectedSource]);
assert.deepEqual(changes(runtimeBefore,runtimeAfter),[expectedRuntime]);
const final=[...after,...runtimeAfter].map(value=>{
  const bytes=readFileSync(value.path);return{path:value.path,bytes:bytes.length,sha256:sha(bytes)};
});
const finalChanges=changes([...after,...runtimeAfter],final);
assert.ok(finalChanges.every(path=>path===expectedRuntime));
for(const file of sql.after)assert.equal(sha(readFileSync(file.path)),file.sha256);
for(const file of contracts.files)assert.equal(sha(readFileSync(file.path)),file.sha256);
assert.equal(sha(readFileSync('db/migrations/0137_run_supplement_quotes.sql')),
  migrated.migrationsAfter.find(value=>value.path==='0137_run_supplement_quotes.sql').sha256);
const parsedRegression=reg.invocations.map(value=>{
  const text=readFileSync(join(out,regDir,`${value.name}.stdout.log`),'utf8');
  const totals=Object.fromEntries([...text.matchAll(/^(?:#|ℹ) (tests|pass|fail|skipped|cancelled) (\d+)$/gm)]
    .map(match=>[match[1],Number(match[2])]));
  assert.equal(totals.fail,0);assert.equal(totals.skipped,0);
  return {...value,totals};
});
const summary={recordedAt:new Date().toISOString(),baseCommit:api.baseCommit,
  scope:'Immutable authenticated B1 quote and explicit consent; no adoption, billing segment, debit or UI flow',
  migration:{from:'template0',count:migrated.audit.migration_count,latest:migrated.audit.latest,sourcesStable:true},
  adopted:{api:api.invocations.map(value=>({name:value.name,exitCode:value.exitCode,tap:value.tap})),
    regression:parsedRegression.map(value=>({name:value.name,exitCode:value.exitCode,totals:value.totals})),
    sql:{directory:'sql-pg-root-final',exitCode:sql.exitCode,totals:sql.totals,sourceStable:sql.sourceStable},
    finalTypecheck:typecheck,contracts:'contracts-results.json (tool-session-only raw output limitation retained)'},
  stability:{apiRunnerExit:1,apiSourceChanges:[expectedSource],apiRuntimeChanges:[expectedRuntime],
    interpretation:'Parallel SQL test fixture changes only. All API implementation and executed quote/processing-plan dependencies remained identical; final SQL file passed dedicated complete PG run and final TypeScript check.',
    finalEntries:final.length,finalChangesFromApiAfter:finalChanges,
    finalImplementationEqualToAcceptedAfter:true,finalSqlTestCoveredByDedicatedRun:true},
  preservedNonAdopted:['sql-pg-01: ESM/CJS runner startup failure; no SQL cases executed',
    'sql-pg-02: tool timeout interrupted process; 12 emitted ok results are not added to final counts'],
  limitations:['No browser journey, production successor, additional charge, real model, supplier or production deployment is established.',
    'G03/UX-A03 and the original goal remain active; historic 15/15 and 662 desktop counters are unchanged.'],
  success:true};
writeFileSync(join(out,'sources-final.json'),JSON.stringify(final));
writeFileSync(join(out,'final-evidence.json'),JSON.stringify(summary,null,2));
process.stdout.write(JSON.stringify(summary,null,2)+'\n');
