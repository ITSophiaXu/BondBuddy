import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {Pool} from 'pg';
import {baseURL,databaseURL,instance,runtime} from './config.mjs';

if(instance!=='direct-20261125')throw Error('Use only the isolated direct DOCX instance');
const [runId,caseId]=process.argv.slice(2);
if(!/^[0-9a-f-]{36}$/.test(runId??'')||!['rq-202506','rq-202509','zq-202312','qx-202606'].includes(caseId))
  throw Error('Usage: evaluate-direct-sample.mjs <run-id> <case-id>');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const pool=new Pool({connectionString:databaseURL,connectionTimeoutMillis:5000});
let row,attempts,events,artifacts;
try{
  row=(await pool.query(`SELECT r.id,r.project_id,r.state,r.stage,r.artifact_id,r.created_at,r.updated_at,
      j.id AS job_id,j.job_type,j.state AS job_state,j.stage AS job_stage,j.error_code,
      j.checkpoint->'stages'->'word_delivery_pair' AS pair
      FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id WHERE r.id=$1`,[runId])).rows[0];
  assert.ok(row&&row.job_type==='update_direct');
  attempts=(await pool.query(`SELECT a.logical_call_id,a.status,a.model_id,x.model_provider,x.duration_ms,x.tool_attempts
    FROM bb_model_call_attempts a LEFT JOIN bb_model_call_attempt_runtime x ON x.attempt_id=a.id
    WHERE a.job_id=$1 ORDER BY a.created_at`,[row.job_id])).rows;
  events=(await pool.query(`SELECT type,state,stage,occurred_at FROM bb_run_events WHERE run_id=$1 ORDER BY occurred_at`,[runId])).rows;
  const ids=[row.artifact_id,row.pair?.clean_artifact_id].filter(Boolean);
  artifacts=ids.length?(await pool.query('SELECT id,sha256,object_key,quality_status,delivery_status FROM bb_artifact_versions WHERE id=ANY($1::text[])',[ids])).rows:[];
}finally{await pool.end();}
const claimed=events.find(e=>e.type==='run.state_changed'&&e.stage==='claimed');
const firstModel=events.find(e=>e.stage==='provider_call');
const checks=row.pair?.direct_checks??null;
const summary={caseId,runId,projectURL:`${baseURL}/#/projects/${row.project_id}`,
  state:row.state,stage:row.stage,errorCode:row.error_code,
  createdAt:row.created_at,finishedAt:['succeeded','failed','cancelled'].includes(row.state)?row.updated_at:null,
  queueSeconds:claimed?Math.round((new Date(claimed.occurred_at)-new Date(row.created_at))/1000):null,
  modelStartAt:firstModel?.occurred_at??null,
  modelAttempts:attempts.map(a=>({logicalCallId:a.logical_call_id,status:a.status,model:a.model_id,
    provider:a.model_provider,durationSeconds:a.duration_ms==null?null:Math.round(Number(a.duration_ms)/1000),toolAttempts:a.tool_attempts})),
  pages:checks?.page_check??null,financial:checks?.financial_check??null,
  formatDiagnostic:checks?.format_diagnostic??null,files:[]};
if(row.state==='succeeded'){
  assert.equal(artifacts.length,2,'both Word artifacts must exist');
  const account=JSON.parse(readFileSync(join(runtime,'test-accounts.json'),'utf8')).accounts.find(a=>a.username==='integration_user');
  assert.ok(account);
  const browser=await chromium.launch();
  try{
    const context=await browser.newContext({baseURL,acceptDownloads:true});
    const page=await context.newPage();
    await page.goto('/');
    await page.getByLabel('用户名',{exact:true}).fill(account.username);
    await page.getByLabel('密码',{exact:true}).fill(account.password);
    await page.getByRole('button',{name:'登录',exact:true}).click();
    await expect(page.getByRole('link',{name:'任务进度与结果',exact:true})).toBeVisible();
    await page.goto(summary.projectURL);
    for(const [variant,id] of [['tracked',row.artifact_id],['clean',row.pair.clean_artifact_id]]){
      const metaResponse=await context.request.get(`/api/v1/artifacts/${id}`);
      assert.equal(metaResponse.status(),200,`artifact metadata ${variant}`);
      const meta=await metaResponse.json();
      const response=await context.request.get(meta.download_url);
      assert.equal(response.status(),200,`artifact download ${variant}`);
      const bytes=await response.body(),actual=sha256(bytes);
      assert.equal(actual,meta.sha256,`download SHA ${variant}`);
      assert.equal(actual,artifacts.find(a=>a.id===id)?.sha256,`database SHA ${variant}`);
      const path=join(runtime,`direct-${caseId}-${runId}-${variant}.docx`);
      writeFileSync(path,bytes);
      summary.files.push({variant,id,sha256:actual,bytes:bytes.length,path});
    }
  }finally{await browser.close();}
}else if(row.state==='failed'){
  const browser=await chromium.launch();
  try{
    const context=await browser.newContext({baseURL});
    const page=await context.newPage();
    const account=JSON.parse(readFileSync(join(runtime,'test-accounts.json'),'utf8')).accounts.find(a=>a.username==='integration_user');
    await page.goto('/');
    await page.getByLabel('用户名',{exact:true}).fill(account.username);
    await page.getByLabel('密码',{exact:true}).fill(account.password);
    await page.getByRole('button',{name:'登录',exact:true}).click();
    const response=await context.request.get(`/api/v1/runs/${runId}/work-draft`);
    summary.workDraftStatus=response.status();
    if(response.ok()){
      const draft=await response.json();
      const file=await context.request.get(draft.download_url);
      assert.equal(file.status(),200);
      const bytes=await file.body();
      const path=join(runtime,`direct-${caseId}-${runId}-work-draft.docx`);
      writeFileSync(path,bytes);
      summary.files.push({variant:'work_draft',sha256:sha256(bytes),bytes:bytes.length,path});
      summary.pages=draft.page_check;summary.financial=draft.financial_check;
    }
  }finally{await browser.close();}
}
const output=join(runtime,`direct-${caseId}-${runId}-result.json`);
writeFileSync(output,JSON.stringify(summary,null,2));
console.log(JSON.stringify({output,...summary,files:summary.files.map(({path,...file})=>file)}));
