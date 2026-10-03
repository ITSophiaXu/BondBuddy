// All entities, document contents and model replies are SYNTHETIC. PostgreSQL, private Azure Blob,
// upload inspection, Python parse, contained CLI process/journal and run-local tool server,
// Word writers, promotion and downloads are real. This is not a model-provider or professional acceptance.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import { Value } from '@sinclair/typebox/value';
import { createServer } from '@bondbuddy/api';
import { azureBlobs, digest } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { executableRevisionFinding, isReviewReport, schemas, type ReviewMaterialPin, type ReviewReport } from '@bondbuddy/contracts';
import { DEFAULT_DISABLED_FEATURES, type CodexAdapterConfig } from './codex-adapter.js';
import { runDocumentParser } from './document-parser.js';
import { runMaterialParseOnce } from './material-parse-job.js';
import { inputLockStage, materialsReadyStage, runPipelineOnce, type RunPipelineDependencies, type RunStage } from './run-pipeline.js';
import { modelGenerationRouter } from './model-generation-router.js';
import { loadReviewInput } from './review-input.js';
import { reviewModelStage } from './review-model-stage.js';
import { historicalWordDeliveryStage } from './historical-word-stage.js';
import { unifiedModelGenerationStage } from './unified-model-stage.js';
import { reviewRevisionCliStage, REVIEW_REVISION_CLI_CHECKPOINT, REVIEW_REVISION_CLI_METHOD } from './review-revision-cli-stage.js';
import { runReviewAssistantOnce } from './review-assistant.js';
import { isolatedTestDatabase } from './test-database.js';

const database=await isolatedTestDatabase(undefined,'m3-review-pipeline');
const connection=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const python=process.env.BONDBUDDY_TEST_PYTHON??process.env.BB_PYTHON;
const repo=resolve(fileURLToPath(import.meta.url),'../../../..');
const run=promisify(execFile);
const docx='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const fake=fileURLToPath(new URL('../test-fixtures/codex/review-pipeline.mjs',import.meta.url));
const cliRevision=process.env.BB_TEST_M3_CLI_REVISION==='1';

test('M3 real upload/parse → synthetic contained CLI with explicit tools → report/comments downloads → accepted plan revision pair → immutable history',
  {skip:!database||!connection||!python,timeout:cliRevision?240000:180000},async()=>{
    if(cliRevision)assert.equal(process.platform,'linux','BB_TEST_M3_CLI_REVISION requires the worker image and real native sandbox');
    const pool=new Pool({connectionString:database});
    const root=await mkdtemp(join(tmpdir(),'bb-m3-pipeline-')),marker=join(root,'synthetic-calls.jsonl');
    const container=`bb-m3-${randomUUID().replaceAll('-','')}`,blobs=azureBlobs(connection!,container);
    const owner=randomUUID();let active=owner;
    const origin='http://bondbuddy.test',app=createServer({pool,blobs,allowedOrigin:origin,
      principal:async()=>({userId:active,csrfVerified:true}),enableRunRuntime:true});
    const beforeWord=process.env.BONDBUDDY_WORD_PYTHON,beforeSearch=process.env.BB_REVIEW_WEB_SEARCH_ENABLED;
    process.env.BONDBUDDY_WORD_PYTHON=python;process.env.BB_REVIEW_WEB_SEARCH_ENABLED='0';
    const config:CodexAdapterConfig={command:[process.execPath,fake,`--m3-marker=${marker}`],model_id:'deepseek-flash',model_provider:'deepseek',
      base_url:'https://api.deepseek.com',wire_api:'responses',model_config_version:'synthetic-m3-integration',reasoning_effort:null,
      credential:{kind:'env',name:'BB_SYNTHETIC_M3_KEY'},work_root:join(root,'contained'),timeout_ms:cliRevision?60000:5000,kill_grace_ms:200,
      max_output_bytes:1024*1024,max_schema_reasks:0,disabled_features:DEFAULT_DISABLED_FEATURES,path_env:process.env.PATH??''};
    const send=(method:string,url:string,payload?:unknown,headers:Record<string,string>={})=>app.inject({method:method as any,url,headers:{origin,...headers},payload:payload as any});
    const calls=async()=>{try{return (await readFile(marker,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}};
    const inspect=async(bytes:Buffer,name:string)=>{
      const path=join(root,`${name}.docx`);await writeFile(path,bytes);
      const result=await run(python!,['-c',`import json,sys,zipfile
from lxml import etree
w='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
with zipfile.ZipFile(sys.argv[1]) as z:
 r=etree.fromstring(z.read('word/document.xml'))
 text='\\n'.join(''.join(p.itertext()) for p in r.iter(w+'p'))
 visible='\\n'.join(''.join(n.text or '' for n in p.iter(w+'t')) for p in r.iter(w+'p'))
 comments=etree.fromstring(z.read('word/comments.xml')) if 'word/comments.xml' in z.namelist() else None
 print(json.dumps({'text':text,'visible':visible,'insertions':len(list(r.iter(w+'ins'))),'deletions':len(list(r.iter(w+'del'))),'comment_count':len(comments) if comments is not None else 0,'comments':''.join(comments.itertext()) if comments is not None else ''},ensure_ascii=True))`,path]);
      return JSON.parse(result.stdout);
    };
    try {
      await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`m3_${owner.replaceAll('-','').slice(0,16)}`]);
      const created=await send('POST','/api/v1/projects',{kind:'review',name:'Synthetic M3 integration',issuer_name:'合成甲公司',market:'sse',offering:'private'});
      assert.equal(created.statusCode,201,created.body);const project=created.json().project_id;
      const sourcePath=join(root,'source.docx'),auditPath=join(root,'audit.docx'),pendingPath=join(root,'pending.docx');
      await run(python!,['-c',`import sys
from docx import Document
context='合成甲公司 合并 原始报表 2025-01-01至2025-12-31 CNY 万元 '
for path,revenue,profit in [(sys.argv[1],'100.00','10.00'),(sys.argv[2],'120.00','15.00')]:
 d=Document()
 d.add_paragraph(context+'营业收入'+revenue+'。')
 d.add_paragraph(context+'净利润'+profit+'。')
 d.add_paragraph('合成条款：其余内容保持原样。')
 d.save(path)
d=Document()
d.add_paragraph('合成待解析附件：后续补证的内容333.00万元。')
d.save(sys.argv[3])`,sourcePath,auditPath,pendingPath]);
      const sourceBytes=await readFile(sourcePath),auditBytes=await readFile(auditPath);
      const parseOnce=()=>runMaterialParseOnce({pool,material:{pool,blobs:{getPrivate:key=>blobs.getIfExists(key)},
        parser:request=>runDocumentParser(request,{pythonExecutable:python,repoRoot:repo})}});
      const upload=async(bytes:Buffer,role:string,parse=true):Promise<ReviewMaterialPin>=>{
        const declaration={byte_size:bytes.length,sha256:digest(bytes)};
        const opened=await send('POST',`/api/v1/projects/${project}/materials/uploads`,{...declaration,filename:`synthetic-${role}.docx`,media_type:docx,role});
        assert.equal(opened.statusCode,201,opened.body);
        assert.equal((await send('PUT',opened.json().upload_url,bytes,{'content-type':'application/octet-stream'})).statusCode,204);
        const completed=await send('POST',`/api/v1/projects/${project}/materials/uploads/${opened.json().upload_id}/complete`,declaration);
        assert.equal(completed.statusCode,200,completed.body);
        if(parse)assert.equal(await parseOnce(),'succeeded');
        return {material_id:completed.json().material_id,material_version:completed.json().material_version,sha256:declaration.sha256};
      };
      const source=await upload(sourceBytes,'historical'),audit=await upload(auditBytes,'audit');
      const pending=await upload(await readFile(pendingPath),'audit',false);
      const pendingMessage=await send('POST',`/api/v1/projects/${project}/review-messages`,{submission_request_id:randomUUID(),content:'合成问题：解释附件。',
        context:{project_id:project,report_id:null,finding_ids:[],material_refs:[pending]}});
      assert.equal(pendingMessage.statusCode,200,pendingMessage.body);
      await assert.rejects(runReviewAssistantOnce({pool,blobs,config,afterCall:async()=>{throw new Error('SYNTHETIC_CRASH');}}),/SYNTHETIC_CRASH/);
      assert.equal(await parseOnce(),'succeeded');
      await pool.query("UPDATE bb_review_messages SET lease_until=now()-interval '1 second' WHERE id=$1",[pendingMessage.json().message.message_id]);
      assert.equal(await runReviewAssistantOnce({pool,blobs,config}),'completed');
      const pendingCall=(await calls()).filter(call=>call.operation==='assistant');assert.equal(pendingCall.length,1);
      assert.equal(pendingCall[0].material_evidence[0].status,'unparsed');assert.deepEqual(pendingCall[0].material_evidence[0].records,[]);
      const input={source_material_ref:source,material_versions:[source,audit],requirements:['合成原始要求：复核财务金额，先不修改原稿。'],as_of:'2026-10-02'};
      const saved=await send('PUT',`/api/v1/projects/${project}/review-draft`,{kind:'input',expected_version:0,input});
      assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().draft.version,1);
      const request={execution_request_id:randomUUID(),operation:'full_review',expected_input_version:1,source_report_id:null,expected_plan_version:null,finding_ids:[]};
      const starts=await Promise.all([send('POST',`/api/v1/projects/${project}/review-executions`,request),send('POST',`/api/v1/projects/${project}/review-executions`,request)]);
      for(const response of starts)assert.equal(response.statusCode,200,response.body);
      const reviewRun=starts[0].json();assert.equal(reviewRun.run_id,starts[1].json().run_id);
      const overlap=await send('POST',`/api/v1/projects/${project}/review-executions`,{...request,execution_request_id:randomUUID()});
      assert.equal(overlap.statusCode,409,overlap.body);
      const nextInput={...input,requirements:['合成下一版要求：保留未选问题。']};
      const next=await send('PUT',`/api/v1/projects/${project}/review-draft`,{kind:'input',expected_version:1,input:nextInput});assert.equal(next.statusCode,200,next.body);
      const router=modelGenerationRouter({reviewStage:reviewModelStage({loadInput:loadReviewInput,config}),
        ...(cliRevision?{revisionStage:reviewRevisionCliStage({config})}:{})});
      const execute=(model:RunStage,afterStage?:RunPipelineDependencies['afterStage'])=>runPipelineOnce({pool,blobs,leaseSeconds:60,
        stages:[inputLockStage,materialsReadyStage,model,historicalWordDeliveryStage()],afterStage,onUnexpectedError:error=>assert.fail(JSON.stringify(error))});
      await assert.rejects(execute(router,async stage=>{if(stage==='word_promoted')throw new Error('SYNTHETIC_CRASH');}),/SYNTHETIC_CRASH/);
      const savedReports=async()=> (await pool.query('SELECT id,content_sha256,report FROM bb_review_reports WHERE owner_user_id=$1 AND run_id=$2',[owner,reviewRun.run_id])).rows;
      const promotedFiles=async()=>{
        const rows=(await pool.query(`SELECT id,version,sha256,object_key,quality_status,delivery_status FROM bb_artifact_versions
          WHERE owner_user_id=$1 AND run_id=$2 ORDER BY id,version`,[owner,reviewRun.run_id])).rows;
        for(const row of rows){
          const bytes=await blobs.getIfExists(row.object_key);assert.ok(bytes,'promoted Word remains present in private storage');
          assert.equal(digest(bytes),row.sha256.trim());assert.equal(row.quality_status,'passed');assert.equal(row.delivery_status,'available');
        }
        return rows;
      };
      const modelAttempts=async()=> (await pool.query(`SELECT a.id,a.logical_call_id,a.attempt_no,a.status FROM bb_model_call_attempts a
        JOIN bb_jobs j ON j.owner_user_id=a.owner_user_id AND j.id=a.job_id WHERE j.owner_user_id=$1 AND j.run_id=$2 ORDER BY a.id`,[owner,reviewRun.run_id])).rows;
      const beforeReplayReports=await savedReports(),beforeReplayFiles=await promotedFiles(),beforeReplayAttempts=await modelAttempts(),beforeReplayCalls=await calls();
      assert.equal(beforeReplayReports.length,1);assert.equal(beforeReplayFiles.length,2);assert.equal(beforeReplayAttempts.length,1,'one CLI turn replaces extraction batches');
      const completion=(await pool.query('SELECT checkpoint,state FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2',[owner,reviewRun.run_id])).rows[0];
      assert.equal(completion.state,'running');assert.equal(completion.checkpoint.stages.review_completion.completed_at,beforeReplayReports[0].report.created_at);
      assert.equal(Number((await pool.query('SELECT count(*) n FROM bb_review_artifacts WHERE owner_user_id=$1 AND run_id=$2',[owner,reviewRun.run_id])).rows[0].n),0);
      assert.equal((await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE owner_user_id=$1 AND run_id=$2 AND state='running'",[owner,reviewRun.run_id])).rowCount,1);
      assert.equal(await execute(router),'succeeded');
      assert.deepEqual(await savedReports(),beforeReplayReports,'recovery reuses the immutable report and its completion timestamp');
      assert.deepEqual(await promotedFiles(),beforeReplayFiles,'reconstructed report and comment Word files retain their actual byte hashes');
      assert.deepEqual(await modelAttempts(),beforeReplayAttempts,'recovery does not create a second model attempt');assert.deepEqual(await calls(),beforeReplayCalls);
      const artifactMappings=(await pool.query(`SELECT kind,count(*)::int count FROM bb_review_artifacts WHERE owner_user_id=$1 AND run_id=$2
        GROUP BY kind ORDER BY kind`,[owner,reviewRun.run_id])).rows;
      assert.deepEqual(artifactMappings,[{kind:'comments',count:1},{kind:'report',count:1}]);
      const replayCheckpoint=(await pool.query('SELECT checkpoint,state FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2',[owner,reviewRun.run_id])).rows[0];
      assert.equal(replayCheckpoint.state,'succeeded');assert.deepEqual(replayCheckpoint.checkpoint.stages.review_completion,completion.checkpoint.stages.review_completion);
      const workspaceResponse=await send('GET',`/api/v1/projects/${project}/review-workspace`);assert.equal(workspaceResponse.statusCode,200,workspaceResponse.body);
      const workspace=workspaceResponse.json(),report=workspace.selected_report as ReviewReport;assert(isReviewReport(report));
      assert.equal(report.run_id,reviewRun.run_id);assert.equal(report.input_revision,1);assert.equal(report.scope.mode,'full_review');
      const repairable=report.findings.filter(executableRevisionFinding);assert.equal(repairable.length,2,JSON.stringify(report.findings));
      const selected=repairable.find(f=>f.calculation?.observed==='100.00')!,excluded=repairable.find(f=>f.calculation?.observed==='10.00')!;
      assert(selected);assert(excluded);assert.equal(selected.calculation?.expected,'120.00');
      assert.ok(selected.target_refs[0]!.parse_snapshot_id);assert.equal(selected.target_refs[0]!.material_sha256,source.sha256);
      assert.equal(selected.evidence_refs[0]!.material_id,audit.material_id);assert.ok(selected.repairability.allowed_record_ids.length);
      assert.equal(report.coverage.filter(c=>c.dimension==='public'&&c.outcome==='uncovered').length,4);
      assert.ok(report.limitations.some(text=>text.includes('未覆盖')));assert.deepEqual(workspace.artifacts.map((a:any)=>a.kind).sort(),['comments','report']);
      const originalHash=inputManifestHash(report);
      const download=async(id:string)=>{const metadata=await send('GET',`/api/v1/artifacts/${id}`);assert.equal(metadata.statusCode,200,metadata.body);
        assert.equal(Value.Check(schemas.ArtifactResponse,metadata.json()),true,JSON.stringify([...Value.Errors(schemas.ArtifactResponse,metadata.json())]));
        const bytes=await send('GET',metadata.json().download_url);assert.equal(bytes.statusCode,200,bytes.body);assert.equal(digest(bytes.rawPayload),metadata.json().sha256);
        return {bytes:bytes.rawPayload,metadata:metadata.json()};};
      const comments=await download(workspace.artifacts.find((a:any)=>a.kind==='comments').artifact_id),reportFile=await download(workspace.artifacts.find((a:any)=>a.kind==='report').artifact_id);
      const sourceView=await inspect(sourceBytes,'source-inspected'),commentView=await inspect(comments.bytes,'comments-downloaded'),reportView=await inspect(reportFile.bytes,'report-downloaded');
      assert.equal(commentView.visible,sourceView.visible);assert.equal(commentView.insertions,0);assert.equal(commentView.deletions,0);
      assert.ok(commentView.comment_count>=2);assert.ok(commentView.comments.includes(selected.finding_id));assert.ok(reportView.visible.includes('募集书复核报告'));
      const reviewCalls=(await calls()).filter(call=>call.operation==='review');assert.equal(reviewCalls.length,1);
      for(const call of reviewCalls){assert.deepEqual(call.requirements,input.requirements);assert.equal(call.tool_receipts,1,'CLI explicitly requested the financial check');assert(call.knowledge_read_complete);}
      const evidenceMessage=await send('POST',`/api/v1/projects/${project}/review-messages`,{submission_request_id:randomUUID(),content:'合成问题：结合所选问题解释审计附件原文。',
        context:{project_id:project,report_id:report.report_id,finding_ids:[selected.finding_id],material_refs:[audit]}});
      assert.equal(evidenceMessage.statusCode,200,evidenceMessage.body);assert.equal(await runReviewAssistantOnce({pool,blobs,config}),'completed');
      const evidenceCall=(await calls()).filter(call=>call.operation==='assistant').at(-1);
      const sourceEvidence=evidenceCall.material_evidence.find((item:any)=>item.material_ref.material_id===source.material_id);
      const auditEvidence=evidenceCall.material_evidence.find((item:any)=>item.material_ref.material_id===audit.material_id);
      assert.equal(sourceEvidence.scope,'report_references');assert.equal(sourceEvidence.parse_snapshot_id,selected.target_refs[0]!.parse_snapshot_id);
      assert.equal(sourceEvidence.records[0].record_sha256,selected.target_refs[0]!.record_sha256);assert.ok(sourceEvidence.records[0].literal_quote.includes('营业收入100.00'));
      assert.equal(auditEvidence.scope,'attachment');assert.equal(auditEvidence.status,'available');assert.equal(auditEvidence.material_ref.sha256,audit.sha256);
      assert.ok(auditEvidence.records.some((record:any)=>record.literal_quote.includes('营业收入120.00')));
      assert.equal(await runReviewAssistantOnce({pool,blobs,config}),'idle');
      const planRequirements=['合成明确采纳：仅将营业收入改为120.00万元。'];
      const accepted=await send('PUT',`/api/v1/projects/${project}/revision-plan`,{expected_version:0,source_report_id:report.report_id,
        finding_ids:[selected.finding_id],excluded_findings:[{finding_id:excluded.finding_id,reason:'本轮明确保留，后续补证。'}],requirements:planRequirements});
      assert.equal(accepted.statusCode,200,accepted.body);const plan=accepted.json();
      assert.equal(Number((await pool.query('SELECT count(*) n FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2',[owner,project])).rows[0].n),1,'accepting a plan does not execute');
      const revisionRequest={execution_request_id:randomUUID(),operation:'revision',expected_input_version:2,source_report_id:report.report_id,expected_plan_version:1,finding_ids:[selected.finding_id]};
      const revisionStart=await send('POST',`/api/v1/projects/${project}/review-executions`,revisionRequest);assert.equal(revisionStart.statusCode,200,revisionStart.body);
      const revisionRun=revisionStart.json();
      const latestInput={...nextInput,requirements:['合成运行中追加：只能下轮生效。']};
      assert.equal((await send('PUT',`/api/v1/projects/${project}/review-draft`,{kind:'input',expected_version:2,input:latestInput})).statusCode,200);
      if(cliRevision){
        await assert.rejects(execute(router,async stage=>{if(stage==='word_promoted')throw new Error('SYNTHETIC_CRASH');}),/SYNTHETIC_CRASH/);
        const beforeRevisionReplay=await calls();
        assert.equal(beforeRevisionReplay.filter(call=>call.operation==='revision').length,1);
        const job=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2',[owner,revisionRun.run_id])).rows[0];
        assert.equal(job.checkpoint.stages[REVIEW_REVISION_CLI_CHECKPOINT].version,REVIEW_REVISION_CLI_METHOD);
        assert.equal(job.checkpoint.stages.model_generation.execution_mode,REVIEW_REVISION_CLI_METHOD);
        assert.equal((await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE owner_user_id=$1 AND run_id=$2 AND state='running'",[owner,revisionRun.run_id])).rowCount,1);
        assert.equal(await execute(router),'succeeded');
        assert.deepEqual(await calls(),beforeRevisionReplay,'new file revision recovery reuses its durable model result and artifacts');
      }else assert.equal(await execute(unifiedModelGenerationStage({config})),'succeeded');
      const revisionRow=(await send('GET',`/api/v1/runs/${revisionRun.run_id}`)).json();assert.equal(revisionRow.state,'succeeded');
      const revisionFile=await download(revisionRow.artifact_id),summary=revisionFile.metadata.word_delivery;
      assert.equal(summary.review_passed,false);assert.equal(summary.revision_handling.review_passed,false);
      assert.equal(summary.revision_handling.source_report.report_id,report.report_id);assert.equal(summary.revision_handling.accepted_plan.sha256,plan.sha256);
      assert.equal(summary.revision_handling.items.find((item:any)=>item.finding_id===selected.finding_id).status,'modified');
      assert.equal(summary.revision_handling.items.find((item:any)=>item.finding_id===excluded.finding_id).status,'not_modified');
      const clean=await download(summary.clean_artifact_id),baseline=await download(summary.baseline_artifact_id);
      const trackedView=await inspect(revisionFile.bytes,'tracked-downloaded'),cleanView=await inspect(clean.bytes,'clean-downloaded'),baselineView=await inspect(baseline.bytes,'baseline-downloaded');
      assert.ok(trackedView.insertions>0);assert.ok(trackedView.deletions>0);assert.equal(cleanView.insertions,0);assert.equal(cleanView.deletions,0);
      assert.ok(cleanView.visible.includes('营业收入120.00'));assert.ok(cleanView.visible.includes('净利润10.00'));assert.ok(cleanView.visible.includes('其余内容保持原样'));
      assert.equal(baselineView.visible,sourceView.visible);
      const revisionCalls=(await calls()).filter(call=>call.operation==='revision');assert.equal(revisionCalls.length,1);
      assert.deepEqual(revisionCalls[0].requirements,[...nextInput.requirements,...planRequirements]);assert.equal(revisionCalls[0].source_report.sha256,originalHash);
      if(cliRevision){
        assert.equal(revisionCalls[0].method,REVIEW_REVISION_CLI_METHOD);assert.equal(revisionCalls[0].native_writer,true);
        const locked=(await pool.query('SELECT input_hash FROM bb_runs WHERE id=$1 AND owner_user_id=$2',[revisionRun.run_id,owner])).rows[0];
        assert.equal(revisionCalls[0].workspace_input_hash,locked.input_hash.trim());
        // Execution identity belongs to the durable checkpoint; the public artifact
        // DTO intentionally exposes only delivery metadata and revision handling.
        const delivery=(await pool.query("SELECT checkpoint#>'{stages,word_delivery_pair}' AS pair FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2",[owner,revisionRun.run_id])).rows[0].pair;
        assert.equal(delivery.method,REVIEW_REVISION_CLI_METHOD);
        for(const key of ['revision_artifact_id','clean_artifact_id','baseline_artifact_id'])assert.equal(delivery[key],summary[key]);
      }
      const afterRevision=(await send('GET',`/api/v1/projects/${project}/review-workspace`)).json();
      assert.equal(inputManifestHash(afterRevision.selected_report),originalHash);assert.deepEqual(afterRevision.artifacts.map((a:any)=>a.kind).sort(),['baseline','clean','revision']);
      assert.equal(afterRevision.artifact_run.run_id,revisionRun.run_id);
      const explicit=(await send('GET',`/api/v1/projects/${project}/review-workspace?report_id=${report.report_id}`)).json();
      assert.deepEqual(explicit.artifacts.map((a:any)=>a.kind).sort(),['comments','report']);
      const history=(await send('GET',`/api/v1/projects/${project}/review-history`)).json().items;
      assert.equal(history.length,2);assert.equal(history[0].operation,'revision');assert.equal(history[0].source_report_id,report.report_id);
      assert.deepEqual(history[0].input.requirements,nextInput.requirements);assert.deepEqual(history[0].plan.requirements,planRequirements);
      assert.deepEqual(history[1].input.requirements,input.requirements);assert.equal(history[1].report_id,report.report_id);
      let differentialInputVersion=3,revisionSource:ReviewMaterialPin|undefined;
      if(cliRevision){
        // Feed the exact downloaded clean artifact back through the normal upload /
        // parse boundary, so differential review tests the new document version.
        revisionSource=await upload(clean.bytes,'historical');assert.equal(revisionSource.sha256,clean.metadata.sha256);
        const revisedInput={...latestInput,source_material_ref:revisionSource,material_versions:[revisionSource,audit]};
        const revised=await send('PUT',`/api/v1/projects/${project}/review-draft`,{kind:'input',expected_version:3,input:revisedInput});
        assert.equal(revised.statusCode,200,revised.body);differentialInputVersion=revised.json().draft.version;
      }
      const differential=await send('POST',`/api/v1/projects/${project}/review-executions`,{execution_request_id:randomUUID(),operation:'differential_review',
        expected_input_version:differentialInputVersion,source_report_id:report.report_id,expected_plan_version:null,finding_ids:[selected.finding_id]});
      assert.equal(differential.statusCode,200,differential.body);assert.equal(await execute(router),'succeeded');
      const afterDiff=(await send('GET',`/api/v1/projects/${project}/review-workspace`)).json().selected_report as ReviewReport;
      assert.equal(afterDiff.scope.mode,'differential_review');assert.deepEqual(afterDiff.scope.finding_ids,[selected.finding_id]);
      if(cliRevision){
        assert.deepEqual(afterDiff.source_material,revisionSource);
        const selectedCoverage=afterDiff.coverage.find(c=>c.check_id===`scope:${selected.finding_id}`);
        assert(selectedCoverage,'differential review must explicitly account for the selected finding');
        assert.equal(selectedCoverage.outcome,'uncovered',
          'changed source text without an exact current anchor must remain explicitly uncovered');
      }
      assert.equal(afterDiff.findings.find(f=>f.finding_id===excluded.finding_id)?.check_status,'carried_forward');
      assert.equal(afterDiff.findings.find(f=>f.finding_id===excluded.finding_id)?.origin_report_id,report.report_id);
      assert.equal(inputManifestHash((await pool.query('SELECT report FROM bb_review_reports WHERE id=$1',[report.report_id])).rows[0].report),originalHash);
      const attemptRows=(await pool.query(`SELECT a.status,a.usage_status,u.input_tokens,u.output_tokens FROM bb_model_call_attempts a
        JOIN bb_usage_observations u ON u.attempt_id=a.id AND u.owner_user_id=a.owner_user_id AND u.usage_status='measured'
        WHERE a.owner_user_id=$1`,[owner])).rows;
      assert.equal(attemptRows.length,(await calls()).filter(call=>call.operation!=='assistant').length);assert.ok(attemptRows.every(row=>row.status==='completed'&&row.usage_status==='measured'));
      assert.ok(attemptRows.every(row=>Number(row.input_tokens)===150&&Number(row.output_tokens)===50));
      const accounting=(await pool.query("SELECT event_type FROM bb_outbox WHERE owner_user_id=$1 AND event_type ~ '(billing|charge|settlement|reservation)'",[owner])).rows;
      assert.deepEqual(accounting,[]);
      active=randomUUID();
      for(const url of [`/api/v1/projects/${project}/review-workspace`,`/api/v1/projects/${project}/review-history`,`/api/v1/artifacts/${revisionRow.artifact_id}`])
        assert.equal((await send('GET',url)).statusCode,404,url);
      active=owner;
      assert.equal(await execute(router),'idle');
    } finally {
      if(beforeWord===undefined)delete process.env.BONDBUDDY_WORD_PYTHON;else process.env.BONDBUDDY_WORD_PYTHON=beforeWord;
      if(beforeSearch===undefined)delete process.env.BB_REVIEW_WEB_SEARCH_ENABLED;else process.env.BB_REVIEW_WEB_SEARCH_ENABLED=beforeSearch;
      await app.close();await pool.end();await BlobServiceClient.fromConnectionString(connection!).getContainerClient(container).deleteIfExists();
      await rm(root,{recursive:true,force:true});
    }
  });
