// Synthetic replies only; the adapter process, PostgreSQL leases/journal and prompt/result persistence are real.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Pool } from 'pg';
import { digest, type PrivateBlobs } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { savePromptSnapshot } from '@bondbuddy/api/log-ops';
import type { ReviewContext, ReviewDraft, ReviewReport } from '@bondbuddy/contracts';
import type { ProviderCallIntent } from '@bondbuddy/api/provider-results';
import { assertModelCallAllowed, configureTrialGuard, tokensSince, trialGuardConfig } from '@bondbuddy/api/trial-guard';
import { DEFAULT_DISABLED_FEATURES, runContainedModelCall, type CodexAdapterConfig } from './codex-adapter.js';
import { claimReviewAssistant, ReviewAssistantJournal, reviewAssistantSnapshot, runReviewAssistantOnce, validReviewAssistantReply } from './review-assistant.js';
import { persistParseSnapshot } from './parse-evidence-repository.js';
import type { DocumentParseRecord, DocumentParseResponse } from './document-parser.js';
import { isolatedTestDatabase } from './test-database.js';
import { loadM3RuntimeSkill } from './m3-runtime-skills.js';

const sha='a'.repeat(64);
const draft:ReviewDraft={version:0,source_material_ref:null,material_versions:[],requirements:['合成输入要求：保留原始证据。'],as_of:null};
const plainReply={content:'合成回复：请补充证据后核对计划。',cited_finding_ids:[],proposal:null};
const proposedReply={content:'合成回复：问题仍待补证，已准备计划建议，请明确采纳。',cited_finding_ids:['F1'],
  proposal:{finding_ids:['F1'],requirements:['只处理已选问题，不将修改等同复核通过。'],explanation:'合成建议，尚未执行。'}};

function report(project:string,reportId=randomUUID(),runId=randomUUID()):ReviewReport {
  return {report_id:reportId,project_id:project,run_id:runId,input_revision:1,version:1,
    source_material:{material_id:'synthetic-source',material_version:1,sha256:sha},scope:{mode:'full_review',finding_ids:[]},
    findings:[{finding_id:'F1',report_id:reportId,dimension:'financial',conclusion:'needs_evidence',severity:'P2',title:'合成证据缺口',
      description:'合成证据尚待补充。',target_refs:[],evidence_refs:[],limitations:['合成数据，不代表业务验收。'],
      repairability:{can_revise:false,reason:'缺少证据',allowed_record_ids:[]},origin_report_id:reportId,check_status:'rechecked'}],
    coverage:[],limitations:['合成测试报告'],created_at:'2026-10-02T00:00:00.000Z'};
}

function message(project='synthetic-project',source:ReviewReport|null=null,prior:string[]=[]) {
  const id=randomUUID(),content='合成提问：解释问题并建议下一步。';
  const context:ReviewContext={project_id:project,report_id:source?.report_id??null,finding_ids:source?['F1']:[],material_refs:[]};
  return {id,project_id:project,content,context,request_hash:inputManifestHash({project_id:project,content,context}),
    context_snapshot:{version:'review-assistant-context-v1' as const,project:{issuer_name:'合成发行人',market:'sse',offering:'private'},
      input:structuredClone(draft),report:source,report_sha256:source?inputManifestHash(source):null,material_refs:[],prior_message_ids:prior}};
}

test('assistant snapshot fixes source report, material versions, request content and ordered history',()=>{
  const source=report('synthetic-project'),good=message('synthetic-project',source,['earlier']);
  assert.equal(reviewAssistantSnapshot(good).report?.report_id,source.report_id);
  for(const mutate of [
    (m:typeof good)=>{m.context.project_id='foreign';},
    (m:typeof good)=>{m.content+=' changed';},
    (m:typeof good)=>{m.context_snapshot.report_sha256=sha;},
    (m:typeof good)=>{m.context_snapshot.report!.findings[0]!.description='changed';},
    (m:typeof good)=>{m.context_snapshot.prior_message_ids.push('earlier');},
    (m:typeof good)=>{m.context_snapshot.prior_message_ids=[m.id];},
    (m:typeof good)=>{(m.context_snapshot as any).material_refs=undefined;},
    (m:typeof good)=>{(m.context_snapshot.input as any).execute=true;},
  ]) {const bad=structuredClone(good);mutate(bad);assert.throws(()=>reviewAssistantSnapshot(bad),/ASSISTANT_CONTEXT_INVALID/);}
});

test('assistant reply cannot invent report findings, mutate accepted plans or execute runs',()=>{
  const source=report('synthetic-project');
  assert.equal(validReviewAssistantReply(proposedReply,source),true);
  assert.equal(validReviewAssistantReply(plainReply,null),true);
  for(const bad of [{...proposedReply,execute:true},{...proposedReply,cited_finding_ids:['foreign']},
    {...proposedReply,proposal:{...proposedReply.proposal,finding_ids:['foreign']}},
    {...proposedReply,proposal:{...proposedReply.proposal,source_report_id:'foreign'}},
    {...proposedReply,proposal:{...proposedReply.proposal,requirements:[' ']}},{...plainReply,content:' '},
    {...proposedReply,proposal:{...proposedReply.proposal,accepted:true}}]) assert.equal(validReviewAssistantReply(bad,source),false);
  assert.equal(validReviewAssistantReply(proposedReply,null),false);
});

function memoryBlobs() {
  const values=new Map<string,Buffer>();
  const blobs:PrivateBlobs={put:async(key,bytes)=>{values.set(key,Buffer.from(bytes));},
    get:async key=>{const b=values.get(key);if(!b)throw new Error('missing synthetic blob');return Buffer.from(b);},
    getIfExists:async key=>values.has(key)?Buffer.from(values.get(key)!):null,
    getIfExistsBounded:async(key,max)=>{const b=values.get(key);if(b&&b.length>max)throw new Error('too large');return b?Buffer.from(b):null;},
    exists:async key=>values.has(key),delete:async key=>{values.delete(key);}};
  return {blobs,values};
}

const database=await isolatedTestDatabase(undefined,'review-assistant');
test('assistant real PG journal, real contained synthetic process, replay and owner boundaries',{skip:!database,timeout:120000},async t=>{
  const pool=new Pool({connectionString:database});
  const root=await mkdtemp(join(tmpdir(),'bb-review-assistant-'));
  const fake=join(root,'synthetic-assistant.mjs');
  await writeFile(fake,`// SYNTHETIC provider stand-in: consumes stdin and emits Codex JSON events, no network.
import { appendFileSync } from 'node:fs';
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const [marker,reply,usage]=process.argv.slice(2);
appendFileSync(marker,'sent\\n');
const out=value=>process.stdout.write(JSON.stringify(value)+'\\n');
out({type:'thread.started',thread_id:'synthetic-thread'});
out({type:'turn.started'});
out({type:'item.completed',item:{id:'reply',type:'agent_message',text:reply}});
out({type:'turn.completed',...(usage==='missing'?{}:{usage:JSON.parse(usage)})});
`);
  const measured={input_tokens:83,cached_input_tokens:41,output_tokens:17,reasoning_output_tokens:3};
  async function fixture(ctx:TestContext,withReport=false) {
    const owner=randomUUID(),project=randomUUID(),marker=join(root,`${project}.sent`),{blobs,values}=memoryBlobs();
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`assistant_${owner.replaceAll('-','').slice(0,16)}`]);
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering) VALUES($1,$2,'Synthetic assistant','review','合成发行人','sse','private')",[project,owner]);
    ctx.after(()=>pool.query('UPDATE bb_projects SET archived_at=now() WHERE id=$1',[project]).then(()=>{}));
    const source=withReport?report(project):null;
    if(source) {
      await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,1,$2,1,$3,'{}','[]','[]')`,[project,owner,sha]);
      await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
        VALUES($1,$2,$3,1,$4,$5,'review',$4,'paused')`,[source.run_id,owner,project,sha,randomUUID()]);
      await pool.query(`INSERT INTO bb_review_reports(id,owner_user_id,project_id,run_id,version,content_sha256,report) VALUES($1,$2,$3,$4,1,$5,$6)`,
        [source.report_id,owner,project,source.run_id,inputManifestHash(source),source]);
    }
    const queue=async(options:{source?:ReviewReport|null;prior?:string[];mutate?:(m:ReturnType<typeof message>)=>void;status?:'queued'|'completed';createdAt?:string}={})=>{
      const m=message(project,options.source===undefined?source:options.source,options.prior);options.mutate?.(m);
      await pool.query(`INSERT INTO bb_review_messages(id,owner_user_id,project_id,submission_request_id,request_hash,role,content,context,context_snapshot,reply_status,created_at)
        VALUES($1,$2,$3,$4,$5,'user',$6,$7,$8,$9,COALESCE($10::timestamptz,now()))`,[m.id,owner,project,randomUUID(),m.request_hash,m.content,m.context,m.context_snapshot,options.status??'queued',options.createdAt??null]);
      return m;
    };
    const config=(reply:unknown=source?proposedReply:plainReply,usage:unknown=measured):CodexAdapterConfig=>({
      command:[process.execPath,fake,marker,JSON.stringify(reply),usage==='missing'?'missing':JSON.stringify(usage)],
      model_id:'deepseek-flash',model_provider:'deepseek',base_url:'https://api.deepseek.com',wire_api:'responses',
      model_config_version:'synthetic-assistant-test',reasoning_effort:null,credential:{kind:'env',name:'BB_SYNTHETIC_ASSISTANT_KEY'},
      work_root:join(root,'work'),timeout_ms:5000,kill_grace_ms:100,max_output_bytes:1024*1024,max_schema_reasks:0,
      disabled_features:DEFAULT_DISABLED_FEATURES,path_env:process.env.PATH??''});
    const sends=async()=>{try{return (await readFile(marker,'utf8')).trim().split('\n').filter(Boolean).length;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 0;throw error;}};
    const row=async(id:string)=>(await pool.query('SELECT * FROM bb_review_messages WHERE id=$1',[id])).rows[0];
    const attempt=async(id:string)=>(await pool.query('SELECT * FROM bb_review_assistant_attempts WHERE message_id=$1 ORDER BY attempt_no DESC LIMIT 1',[id])).rows[0];
    const replies=async(id:string)=>(await pool.query("SELECT * FROM bb_review_messages WHERE reply_to=$1 AND role='assistant'",[id])).rows;
    const expire=async(id:string)=>{await pool.query("UPDATE bb_review_messages SET lease_until=now()-interval '1 second' WHERE id=$1",[id]);};
    return {owner,project,source,queue,config,sends,row,attempt,replies,expire,blobs,values};
  }
  const killSwitch=async(state:'engaged'|'released')=>{await pool.query(`INSERT INTO bb_trial_kill_switch_events(id,state,reason_code,actor_id)
    VALUES($1,$2,'synthetic_assistant_guard','synthetic-operator')`,[randomUUID(),state]);};
  const evidenceGate=async(state:'paused'|'open')=>{await pool.query(`INSERT INTO bb_evidence_gate_events(id,state,reason_code,actor_type)
    VALUES($1,$2,'synthetic_assistant_guard','system')`,[randomUUID(),state]);};
  const deny=async(owner:string)=>{await pool.query(`INSERT INTO bb_trial_overrides(id,user_id,effect,reason_code,actor_id)
    VALUES($1,$2,'deny','synthetic_assistant_guard','synthetic-operator')`,[randomUUID(),owner]);};
  try {
    await t.test('closed evidence gate, operator kill switch and account deny prevent new sends without fabricated usage',async ctx=>{
      for(const gate of ['evidence','kill','deny'] as const) {
        const f=await fixture(ctx),m=await f.queue();
        try {
          if(gate==='evidence')await evidenceGate('paused');else if(gate==='kill')await killSwitch('engaged');else await deny(f.owner);
          assert.equal(await runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config()}),'failed');
          assert.equal((await f.row(m.id)).error,gate==='evidence'?'DATA_UNAVAILABLE':gate==='kill'?'MODEL_CALLS_SUSPENDED':'TRIAL_ACCESS_DENIED');
          assert.equal(await f.sends(),0);assert.equal(await f.attempt(m.id),undefined);assert.equal((await f.replies(m.id)).length,0);
          assert.equal(Number((await pool.query("SELECT count(*) n FROM bb_observability_events WHERE owner_user_id=$1 AND kind='model.usage_observed'",[f.owner])).rows[0].n),0);
        } finally {if(gate==='evidence')await evidenceGate('open');if(gate==='kill')await killSwitch('released');}
      }
    });

    await t.test('runtime evidence outage preserves unknown usage and pauses subsequent model sends',async ctx=>{
      const f=await fixture(ctx),first=await f.queue();let injected=false;
      // Only one runtime UPDATE fails. Rollback, pause/alert writes and all other queries use real PostgreSQL.
      const faultPool=new Proxy(pool,{get(target,key){
        if(key==='connect')return async()=>{
          const client=await target.connect();
          return new Proxy(client,{get(target,key){
            if(key==='query')return(...args:unknown[])=>{
              if(!injected&&typeof args[0]==='string'&&args[0].startsWith('UPDATE bb_review_assistant_attempts SET runtime=')) {
                injected=true;throw Object.assign(new Error('synthetic runtime evidence outage'),{code:'08006'});
              }
              return Reflect.apply(target.query,target,args);
            };
            const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
          }});
        };
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }});
      try {
        assert.equal(await runReviewAssistantOnce({pool:faultPool,blobs:f.blobs,config:f.config()}),'unknown');
        assert.equal(injected,true);assert.equal(await f.sends(),1);
        const saved=await f.attempt(first.id);
        assert.equal(saved.status,'pending_reconcile');assert.equal(saved.usage_status,'unknown');
        assert.equal(saved.runtime,null);assert.equal(saved.observation,null);assert.ok(saved.result_ref);
        for(const key of ['input_tokens','cached_input_tokens','output_tokens','reasoning_tokens','total_tokens','internal_cost'])assert.equal(saved[key],null);
        assert.equal((await f.replies(first.id)).length,0);
        const gate=(await pool.query('SELECT state,reason_code FROM bb_evidence_gate_events ORDER BY seq DESC LIMIT 1')).rows[0];
        assert.deepEqual(gate,{state:'paused',reason_code:'assistant_runtime_not_persisted'});
        const next=await f.queue();assert.equal(await runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config()}),'failed');
        assert.equal((await f.row(next.id)).error,'DATA_UNAVAILABLE');assert.equal(await f.attempt(next.id),undefined);assert.equal(await f.sends(),1);
      } finally {await evidenceGate('open');}
    });

    await t.test('assistant observations share the platform token guard while unknown usage remains unknown and no billing occurs',async ctx=>{
      const before=trialGuardConfig();configureTrialGuard({...before,enabled:true,model_tokens_per_user_per_day:100,unknown_usage_tokens_per_attempt:100});
      try {
        for(const usage of [measured,'missing']) {
          const f=await fixture(ctx),first=await f.queue();
          assert.equal(await runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config(plainReply,usage)}),usage==='missing'?'unknown':'completed');
          const observed=await f.attempt(first.id);
          assert.equal(observed.usage_status,usage==='missing'?'unknown':'measured');assert.equal(observed.internal_cost,null);
          if(usage==='missing'){assert.equal(observed.input_tokens,null);assert.equal(observed.output_tokens,null);assert.equal(observed.total_tokens,null);}
          assert.equal(await tokensSince(pool,trialGuardConfig(),f.owner,new Date(0)),100,'shared platform budget includes assistant attempts');
          const client=await pool.connect();
          try {await assert.rejects(assertModelCallAllowed(client,trialGuardConfig(),f.owner),{code:'TRIAL_QUOTA_EXCEEDED'});}finally{client.release();}
          const next=await f.queue();assert.equal(await runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config()}),'failed');
          assert.equal((await f.row(next.id)).error,'TRIAL_QUOTA_EXCEEDED');assert.equal(await f.attempt(next.id),undefined);assert.equal(await f.sends(),1);
          assert.equal(Number((await pool.query("SELECT count(*) n FROM bb_outbox WHERE owner_user_id=$1 AND event_type ~ '(billing|charge|settlement|reservation)'",[f.owner])).rows[0].n),0);
        }
      } finally {configureTrialGuard(before);}
    });

    await t.test('closed new-call gates still permit exact completed-result recovery without another send',async ctx=>{
      const f=await fixture(ctx),m=await f.queue();
      await assert.rejects(runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config(),afterCall:async()=>{throw new Error('SYNTHETIC_CRASH');}}),/SYNTHETIC_CRASH/);
      const first=await f.attempt(m.id);await f.expire(m.id);
      try {
        await evidenceGate('paused');await killSwitch('engaged');await deny(f.owner);
        assert.equal(await runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config()}),'completed');
        assert.equal(await f.sends(),1);assert.equal((await f.attempt(m.id)).id,first.id);assert.equal((await f.replies(m.id))[0].content,plainReply.content);
      } finally {await evidenceGate('open');await killSwitch('released');}
    });

    await t.test('concurrent workers claim once with same-millisecond history; prompt snapshot, measured usage and proposal are durable without plan/task/billing writes',async ctx=>{
      const f=await fixture(ctx,true),prior=await f.queue({status:'completed',createdAt:'2026-10-02T00:00:00.123100Z'}),
        m=await f.queue({prior:[prior.id],createdAt:'2026-10-02T00:00:00.123900Z'});
      const outcomes=await Promise.all([runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config()}),runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config()})]);
      assert.deepEqual(outcomes.sort(),['completed','idle']);assert.equal(await f.sends(),1);
      const user=await f.row(m.id),replies=await f.replies(m.id),attempt=await f.attempt(m.id);
      assert.equal(user.reply_status,'completed');assert.equal(user.lease_token,null);assert.equal(replies.length,1);
      assert.equal(replies[0].proposal.source_report_id,f.source!.report_id);assert.deepEqual(replies[0].proposal.finding_ids,['F1']);
      assert.deepEqual(user.context_snapshot,m.context_snapshot);assert.deepEqual(replies[0].context,m.context);
      assert.equal(attempt.status,'completed');assert.equal(attempt.usage_status,'measured');assert.equal(Number(attempt.total_tokens),100);
      assert.equal(Number(attempt.input_tokens),83);assert.equal(Number(attempt.cached_input_tokens),41);assert.equal(Number(attempt.reasoning_tokens),3);
      assert.equal(attempt.internal_cost,null);assert.equal(attempt.pricing_status,'unknown');assert.equal(attempt.runtime.model_provider,'deepseek');
      assert.equal(attempt.runtime.error_code,null);assert.equal(attempt.observation.error_code,null);
      assert.deepEqual(JSON.parse((await f.blobs.get(attempt.result_ref)).toString('utf8')),proposedReply);
      assert.equal(digest(await f.blobs.get(attempt.result_ref)),String(attempt.result_sha256).trim());
      const snap=(await pool.query('SELECT * FROM bb_snapshot_refs WHERE id=$1',[user.prompt_snapshot_id])).rows[0];
      const prompt=(await f.blobs.get(snap.object_key)).toString('utf8');
      const skill=loadM3RuntimeSkill('m3-project-assistant');
      assert.ok(prompt.includes(skill.content));assert.ok(prompt.includes(skill.sha256));
      assert.ok(snap.template_version.endsWith(skill.sha256.slice(0,16)));
      assert.equal(snap.run_id,null);assert.equal(digest(prompt),String(snap.content_sha256).trim());assert.ok(prompt.includes(prior.id));
      assert.ok(prompt.includes('普通发送不会修改'));assert.ok(prompt.includes(draft.requirements[0]!));
      const events=(await pool.query('SELECT event FROM bb_observability_events WHERE owner_user_id=$1 AND kind LIKE $2',[f.owner,'model.%'])).rows;
      assert.deepEqual(events.map(row=>row.event.kind).sort(),['model.call_finished','model.call_started','model.usage_observed']);
      for(const row of events){assert.equal(row.event.message_id,m.id);assert.equal(row.event.run_id,null);assert.equal(row.event.job_id,null);}
      assert.equal((await pool.query('SELECT report FROM bb_review_reports WHERE id=$1',[f.source!.report_id])).rows[0].report.findings[0].conclusion,'needs_evidence');
      for(const table of ['bb_review_revision_plans','bb_review_executions','bb_jobs'])assert.equal(Number((await pool.query(`SELECT count(*) n FROM ${table} WHERE owner_user_id=$1`,[f.owner])).rows[0].n),0);
      assert.equal(Number((await pool.query('SELECT count(*) n FROM bb_runs WHERE owner_user_id=$1',[f.owner])).rows[0].n),1,'only the preexisting report run');
      assert.equal(Number((await pool.query("SELECT count(*) n FROM bb_outbox WHERE owner_user_id=$1 AND event_type ~ '(billing|charge|settlement|reservation)'",[f.owner])).rows[0].n),0);
      await assert.rejects(pool.query("UPDATE bb_review_messages SET content='changed' WHERE id=$1",[m.id]),/immutable/);
      await assert.rejects(pool.query("UPDATE bb_review_messages SET context_snapshot='{}' WHERE id=$1",[m.id]),/immutable/);
      await assert.rejects(pool.query('UPDATE bb_review_assistant_attempts SET input_tokens=84 WHERE id=$1',[attempt.id]),/immutable/);
      assert.equal(await runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config()}),'idle');assert.equal(await f.sends(),1);
    });

    await t.test('existing assistant prompt snapshots replay byte-for-byte without injecting a newer skill',async ctx=>{
      const f=await fixture(ctx),m=await f.queue(),body='SYNTHETIC legacy assistant prompt without runtime skill';
      const snapshotId=await savePromptSnapshot(pool,f.blobs,{owner:f.owner,projectId:f.project,kind:'model_request',version:1,body,templateVersion:'review-assistant-v1'});
      await pool.query('UPDATE bb_review_messages SET prompt_snapshot_id=$2 WHERE id=$1',[m.id,snapshotId]);
      const model:typeof runContainedModelCall=async(input,journal,config)=>{
        assert.equal(input.prompt,body);assert.equal(input.prompt_snapshot_ref,snapshotId);
        return runContainedModelCall(input,journal,config);
      };
      assert.equal(await runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config(),model}),'completed');
      assert.equal((await f.row(m.id)).prompt_snapshot_id,snapshotId);assert.equal(await f.sends(),1);
      assert.equal(Number((await pool.query('SELECT count(*) n FROM bb_snapshot_refs WHERE owner_user_id=$1 AND project_id=$2',[f.owner,f.project])).rows[0].n),1);
    });

    await t.test('same-millisecond history created after Send remains invalid before any model call',async ctx=>{
      const f=await fixture(ctx),later=await f.queue({status:'completed',createdAt:'2026-10-02T00:00:00.123950Z'}),
        m=await f.queue({prior:[later.id],createdAt:'2026-10-02T00:00:00.123900Z'});
      assert.equal(await runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config()}),'failed');
      assert.equal((await f.row(m.id)).error,'ASSISTANT_CONTEXT_INVALID');assert.equal(await f.attempt(m.id),undefined);
      assert.equal((await f.replies(m.id)).length,0);assert.equal(await f.sends(),0);
    });

    await t.test('large attachment bodies reserve every report reference before optional text and disclose omissions',async ctx=>{
      const f=await fixture(ctx);
      const parsed=async(texts:string[])=>{
        const materialId=randomUUID(),uploadId=randomUUID(),requestId=randomUUID(),bytes=Buffer.from(texts.join('\n')),hash=digest(bytes);
        const objectKey=`users/${f.owner}/projects/${f.project}/${materialId}.txt`;
        await f.blobs.put(objectKey,bytes,'text/plain');
        await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
          VALUES($1,$2,$3,'synthetic.txt','text/plain',$4,$5,'audit',$6,now()+interval '1 hour','completed')`,[uploadId,f.owner,f.project,bytes.length,hash,`${objectKey}/upload`]);
        await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
          VALUES($1,1,$2,$3,$4,'audit','synthetic.txt','text/plain',$5,$6,$7,'persisted')`,[materialId,f.owner,f.project,uploadId,bytes.length,hash,objectKey]);
        const records:DocumentParseRecord[]=texts.map((text,i)=>({record_id:`record-${i}`,material_id:materialId,material_version:1,content_hash:hash,
          locator_type:'text_line',locator:{line:i+1,stable_ref:`text:l${String(i+1).padStart(6,'0')}`},literal_quote:text,context:'',
          extraction_method:'native_text',extractor_version:'synthetic-budget-1',confidence:null,uncertainty:[],formatting:{}}));
        const response:DocumentParseResponse={schema_version:'document-parse-response-v1',request_id:requestId,parser_version:'synthetic-budget-1',status:'parsed',
          material:{material_id:materialId,material_version:1,media_type:'text/plain',sha256:hash},records,warnings:[],document:{page_count:null,encoding:'utf-8'},error:null};
        const stored=await persistParseSnapshot({pool},{ownerUserId:f.owner,projectId:f.project,materialId,materialVersion:1,requestId},{mediaType:'text/plain',sha256:hash},response);
        const refs=records.map(record=>({material_id:materialId,material_version:1,material_sha256:hash,
          parse_snapshot_id:stored.snapshotId,parse_response_sha256:stored.responseSha256,record_id:record.record_id,record_sha256:inputManifestHash(record),
          locator_type:record.locator_type,locator:record.locator,quote:record.literal_quote.slice(0,80),extraction_method:record.extraction_method,uncertainty:[]}));
        return {pin:{material_id:materialId,material_version:1,sha256:hash},records,refs};
      };
      const main=await parsed(['synthetic main report evidence',...Array.from({length:40},()=> 'synthetic appendix '.repeat(550))]);
      const audit=await parsed(Array.from({length:12},()=> 'synthetic audit evidence '.repeat(600)));
      const source=report(f.project);source.source_material=main.pin;source.findings[0]!.target_refs=[main.refs[0]!];source.findings[0]!.evidence_refs=audit.refs;
      await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,1,$2,1,$3,'{}','[]','[]')`,[f.project,f.owner,sha]);
      await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
        VALUES($1,$2,$3,1,$4,$5,'review',$4,'paused')`,[source.run_id,f.owner,f.project,sha,randomUUID()]);
      await pool.query(`INSERT INTO bb_review_reports(id,owner_user_id,project_id,run_id,version,content_sha256,report) VALUES($1,$2,$3,$4,1,$5,$6)`,
        [source.report_id,f.owner,f.project,source.run_id,inputManifestHash(source),source]);
      const m=await f.queue({source,mutate:m=>{
        m.context.material_refs=[main.pin];Object.assign(m.context_snapshot,{material_refs:[main.pin]});
        m.request_hash=inputManifestHash({project_id:f.project,content:m.content,context:m.context});
      }});
      assert.equal(await runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config()}),'completed');assert.equal(await f.sends(),1);
      const user=await f.row(m.id),snap=(await pool.query('SELECT object_key FROM bb_snapshot_refs WHERE id=$1',[user.prompt_snapshot_id])).rows[0];
      const prompt=(await f.blobs.get(snap.object_key)).toString('utf8');
      const payload=JSON.parse(prompt.match(/<<BB-DATA-[a-f0-9]+ ref=review-context\n([\s\S]+)\nBB-DATA-[a-f0-9]+>>/)![1]!);
      const mainBody=payload.material_evidence.find((item:any)=>item.material_ref.material_id===main.pin.material_id);
      const auditBody=payload.material_evidence.find((item:any)=>item.material_ref.material_id===audit.pin.material_id);
      assert.equal(mainBody.status,'partial');assert.ok(mainBody.omitted_record_count>0);assert.ok(mainBody.limitations.some((text:string)=>text.includes('未提供')));
      assert.equal(mainBody.records[0].record_sha256,main.refs[0]!.record_sha256);
      assert.equal(auditBody.status,'available');assert.equal(auditBody.scope,'report_references');assert.equal(auditBody.records.length,audit.records.length);
      assert.deepEqual(auditBody.records.map((record:any)=>record.literal_quote),audit.records.map(record=>record.literal_quote));
      assert.deepEqual(auditBody.records.map((record:any)=>record.record_sha256),audit.refs.map(ref=>ref.record_sha256));
    });

    await t.test('crash after durable intent is unknown after lease recovery and never resends',async ctx=>{
      const f=await fixture(ctx),m=await f.queue();
      const crash:typeof runContainedModelCall=(input,journal,config)=>runContainedModelCall(input,{...journal,
        latestAttempt:journal.latestAttempt.bind(journal),readCompleted:journal.readCompleted.bind(journal),
        storeResult:journal.storeResult.bind(journal),recordRuntime:journal.recordRuntime.bind(journal),recordObservation:journal.recordObservation.bind(journal),
        recordIntent:async intent=>{await journal.recordIntent(intent);throw new Error('SYNTHETIC_CRASH');}},config);
      await assert.rejects(runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config(),model:crash}),/SYNTHETIC_CRASH/);
      assert.equal((await f.attempt(m.id)).status,'pending_reconcile');assert.equal(await f.sends(),0);
      await f.expire(m.id);
      assert.equal(await runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config()}),'unknown');
      const stored=await f.attempt(m.id);assert.equal(stored.observation.error_code,'MODEL_PRIOR_ATTEMPT_UNRESOLVED');
      assert.equal(stored.usage_status,'unknown');assert.equal(stored.input_tokens,null);assert.equal(stored.total_tokens,null);
      assert.equal((await f.row(m.id)).reply_status,'unknown');assert.equal((await f.replies(m.id)).length,0);assert.equal(await f.sends(),0);
      assert.equal(await runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config()}),'idle');
    });

    await t.test('crash after completed result reuses exact stored response once and cannot silently accept a conflicting reply',async ctx=>{
      const f=await fixture(ctx),m=await f.queue();
      await assert.rejects(runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config(),afterCall:async()=>{throw new Error('SYNTHETIC_CRASH');}}),/SYNTHETIC_CRASH/);
      const first=await f.attempt(m.id);assert.equal(first.status,'completed');assert.equal(await f.sends(),1);assert.equal((await f.replies(m.id)).length,0);
      await f.expire(m.id);
      assert.equal(await runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config({...plainReply,content:'This must never be sent'})}),'completed');
      assert.equal(await f.sends(),1);assert.equal((await f.replies(m.id))[0].content,plainReply.content);
      assert.equal((await f.attempt(m.id)).id,first.id);
      const second=await f.queue();
      await assert.rejects(runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config(),afterCall:async()=>{throw new Error('SYNTHETIC_CRASH');}}),/SYNTHETIC_CRASH/);
      await pool.query(`INSERT INTO bb_review_messages(id,owner_user_id,project_id,submission_request_id,request_hash,role,content,context,context_snapshot,reply_status,reply_to)
        VALUES($1,$2,$3,$4,$5,'assistant','Conflicting synthetic reply',$6,$7,'completed',$8)`,
      [randomUUID(),f.owner,f.project,randomUUID(),sha,second.context,second.context_snapshot,second.id]);
      await f.expire(second.id);
      assert.equal(await runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config()}),'lost');
      assert.equal((await f.row(second.id)).reply_status,'running');assert.equal(await f.sends(),2);
    });

    await t.test('missing and partial usage keep observed response but remain unknown without fabricated zero or automatic retry',async ctx=>{
      const f=await fixture(ctx);
      for(const usage of ['missing',{input_tokens:83},{input_tokens:83,cached_input_tokens:84,output_tokens:17}]) {
        const m=await f.queue();
        assert.equal(await runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config(plainReply,usage)}),'unknown');
        const a=await f.attempt(m.id);assert.equal(a.status,'pending_reconcile');assert.equal(a.error_code,'MODEL_USAGE_PENDING');
        assert.equal(a.usage_status,usage==='missing'?'unknown':'pending');assert.equal(a.total_tokens,null);assert.equal(a.internal_cost,null);
        assert.equal(a.input_tokens,usage==='missing'?null:'83');assert.ok(a.result_ref);assert.equal((await f.replies(m.id)).length,0);
        assert.equal(await runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config()}),'idle');
      }
      assert.equal(await f.sends(),3);
    });

    await t.test('foreign report, history, source material and altered report hash fail before model send',async ctx=>{
      const f=await fixture(ctx),foreign=await fixture(ctx,true),old=await foreign.queue({status:'completed'});
      const scenarios=[
        {source:foreign.source},
        {prior:[old.id]},
        {mutate:(m:ReturnType<typeof message>)=>{m.context_snapshot.input.source_material_ref={material_id:'foreign-material',material_version:1,sha256:sha};}},
        {mutate:(m:ReturnType<typeof message>)=>{m.context_snapshot.report_sha256=sha;}},
      ];
      for(const options of scenarios){const m=await f.queue(options);assert.equal(await runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config()}),'failed');
        assert.equal((await f.row(m.id)).error,'ASSISTANT_CONTEXT_INVALID');assert.equal(await f.attempt(m.id),undefined);}
      assert.equal(await f.sends(),0);
    });

    await t.test('invalid provider proposal is audited with actual usage and never changes plan',async ctx=>{
      const f=await fixture(ctx,true),m=await f.queue();
      assert.equal(await runReviewAssistantOnce({pool,blobs:f.blobs,config:f.config({...proposedReply,proposal:{...proposedReply.proposal,finding_ids:['foreign']}})}),'failed');
      const a=await f.attempt(m.id);assert.equal(a.error_code,'MODEL_OUTPUT_SCHEMA_INVALID');assert.equal(a.usage_status,'measured');assert.equal(Number(a.total_tokens),100);
      assert.equal((await f.replies(m.id)).length,0);assert.equal(a.result_ref,null);
    });

    await t.test('stale lease and foreign identity cannot write journal; archived/deleted projects are not claimed',async ctx=>{
      const f=await fixture(ctx),m=await f.queue(),lease=await claimReviewAssistant(pool);
      assert.equal(lease?.id,m.id);assert.equal(await claimReviewAssistant(pool),null);
      const row=lease!;row.prompt_snapshot_id=randomUUID();
      const journal=new ReviewAssistantJournal({pool,blobs:f.blobs,lease:row,validateResult:()=>true});
      const intent:ProviderCallIntent={owner_user_id:f.owner,project_id:f.project,job_id:m.id,run_id:m.id,trace_id:m.id,logical_call_id:'review-assistant-v1',
        call_id:randomUUID(),attempt_no:1,model_id:'deepseek-flash',model_config_version:'synthetic-assistant-test',prompt_snapshot_ref:row.prompt_snapshot_id};
      await assert.rejects(journal.recordIntent({...intent,owner_user_id:'foreign-owner'}),/ASSISTANT_ATTEMPT_SCOPE_MISMATCH/);
      await f.expire(m.id);const next=await claimReviewAssistant(pool);assert.notEqual(next!.lease_token,row.lease_token);
      await assert.rejects(journal.recordIntent(intent),/ASSISTANT_LEASE_LOST/);assert.equal(await f.attempt(m.id),undefined);
      await pool.query('UPDATE bb_projects SET archived_at=now() WHERE id=$1',[f.project]);await f.expire(m.id);
      assert.equal(await claimReviewAssistant(pool),null);
      await pool.query('UPDATE bb_projects SET archived_at=NULL,deleted_at=now() WHERE id=$1',[f.project]);assert.equal(await claimReviewAssistant(pool),null);
    });
  } finally {await pool.end();await rm(root,{recursive:true,force:true});}
});
