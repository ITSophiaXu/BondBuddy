import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {emptyUpdateDetails, SOURCE_PROSPECTUS_REQUIRED_FIELD_ERROR} from '@bondbuddy/contracts';
import {createServer} from './server.js';
import {isolatedTestDatabase} from './test-database.js';
import {inputManifestHash} from './production-rule-pin.js';

const connection = await isolatedTestDatabase(undefined, 'required-source');
test('source-free new input and legacy quote/execute are rejected without runs or reservations', {skip:!connection}, async () => {
  const pool = new Pool({connectionString:connection}), owner = randomUUID(), origin = 'http://bondbuddy.test';
  const app = createServer({pool,enablePaidAuthoring:true,enableSyntheticQueue:true,allowedOrigin:origin,principal:async () => ({userId:owner,csrfVerified:true})});
  const send = (url:string,payload:unknown) => app.inject({method:'POST',url,headers:{origin},payload:payload as any});
  const rejected = (response:Awaited<ReturnType<typeof send>>) => {
    assert.equal(response.statusCode,422,response.body);
    assert.deepEqual(response.json().field_errors,[SOURCE_PROSPECTUS_REQUIRED_FIELD_ERROR]);
  };
  try {
    await pool.query('INSERT INTO bb_users(id,phone_e164) VALUES($1,$2)',[owner,'+8613999911005']);
    const created = await send('/api/v1/projects',{name:'Synthetic required reference',kind:'update',issuer_name:'Synthetic issuer',market:null,offering:null,
      update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1'}});
    assert.equal(created.statusCode,201,created.body);
    const p = created.json(), path = `/api/v1/projects/${p.project_id}`;
    rejected(await send(path+'/input-revisions',{draft_revision:p.draft_revision,material_versions:[],requirement_message_ids:[]}));
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_input_revisions WHERE project_id=$1',[p.project_id])).rows[0].n,0);

    // Persist a synthetic pre-change snapshot to exercise admission of old inputs.
    const manifest = {draft_revision:p.draft_revision,name:p.name,kind:p.kind,issuer_name:p.issuer_name,market:p.market,offering:p.offering,
      update_details:p.update_details,materials:[],requirement_message_ids:[],prospectus_selection:{revision:0,version_id:null},
      authoring:{version:'unified_v1',source_prospectuses:[],requirements:[],knowledge:[],knowledge_status:'authoring_reference_not_compliance_approval'}};
    const hash = inputManifestHash(manifest);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,$3,$4,$5,'[]','[]')`,[p.project_id,owner,p.draft_revision,hash,manifest]);
    await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1',[p.project_id]);
    rejected(await send(path+'/credit-quote',{input_revision:1,input_hash:hash}));
    rejected(await send('/api/v1/runs/execute',{execution_request_id:randomUUID(),project_id:p.project_id,input_revision:1,input_hash:hash,
      task_kind:'update',input_manifest_ref:hash,storage_origin:'cloud',workspace_id:p.project_id}));
    for (const table of ['bb_runs','bb_credit_reservations','bb_credit_quotes'])
      assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE owner_user_id=$1`,[owner])).rows[0].n,0);
  } finally { await app.close(); await pool.end(); }
});
