import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const require=createRequire(import.meta.url),ts=require('typescript');
const source='apps/api/src/run-billing-segments.pg.test.ts',target='apps/api/dist/run-billing-segments.pg.test.js';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const input=readFileSync(source,'utf8'),before=readFileSync(target);
const result=ts.transpileModule(input,{fileName:source,reportDiagnostics:true,
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}});
const errors=(result.diagnostics??[]).filter(value=>value.category===ts.DiagnosticCategory.Error);
assert.equal(errors.length,0);writeFileSync(target,result.outputText);
const record={completedAt:new Date().toISOString(),source,sourceSha256:sha(Buffer.from(input)),target,
  previousTargetSha256:sha(before),targetSha256:sha(Buffer.from(result.outputText)),diagnosticErrors:0,
  reason:'Only the corrected functional test is emitted while unrelated regression processes are running. No production module is rewritten. Final complete-source noEmit typecheck is separate.'};
writeFileSync('.local/billing-segments-20261027/recompile-functional.json',JSON.stringify(record,null,2));
process.stdout.write(JSON.stringify(record)+'\n');
