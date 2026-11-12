// Synthetic validator regressions only; never model execution or human acceptance.
// Keep this complete class in its own file so the generic 300-second per-file
// runner budget does not combine it with the other five independent classes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

for(const name of ['ExpandedAmountRegression']){
  test(`independent financial reader validates ${name} without changing a template`,()=>{
    const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
    const python=process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON??'python3';
    const result=spawnSync(python,['-B','-s','scripts/prospectus_acceptance_inspect_test.py',name,'-v'],
      {cwd:root,env:{...process.env,PYTHONPATH:resolve(root,'python'),PYTHONIOENCODING:'utf-8'},encoding:'utf8'});
    assert.equal(result.status,0,`Independent reader checks cannot skip or fail:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr,/\bOK\s*$/);
    assert.doesNotMatch(result.stderr,/\bskipped\b/i);
  });
}
