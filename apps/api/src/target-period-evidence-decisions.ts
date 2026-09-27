import { createHash, randomUUID } from 'node:crypto';
import { Pool as PgPool } from 'pg';
import { M1_MATERIAL_PARTITIONS, validTargetPeriodEvidenceDecision,
  type TargetPeriodEvidenceDecisionRequest, type TargetPeriodEvidenceDecisionResponse } from '@bondbuddy/contracts';
import { readOcrPeriodEvidence } from './ocr.js';
import type { PrivateBlobs } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';

type Row = Record<string, unknown>;
type Queryable = {query(sql:string,values?:unknown[]):Promise<{rows:Row[]}>};
type Db = { connect():Promise<{query(sql:string,values?:unknown[]):Promise<{rows:Row[]}>;release():void|Promise<void>}> };
type Principal = { userId: string };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
function fail(code: string): Error { const e = new Error(code); e.name = 'TargetPeriodEvidenceDecisionError'; return e; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  const out = JSON.stringify(value); if (out === undefined) throw fail('TARGET_PERIOD_DECISION_INVALID'); return out;
}
function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function parsed(value: unknown): unknown { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { throw fail('TARGET_PERIOD_DECISION_LOCK_INVALID'); } }
function same(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
function periodKey(p: Record<string, unknown>): string { return canonical({ start:p.start??null,end:p.end??null,period_kind:p.period_kind??null,scope:p.scope??null }); }
export function ocrPeriodUncertaintyRequiresConfirmation(uncertainty: readonly string[]): boolean {
  const suspect=/date|period|scope|consolidat|parent|issuer|entity|日期|期间|口径|合并|母公司|报告期|主体|发行人/i;
  return uncertainty.some(item=>suspect.test(item));
}

function validateRequest(principal: Principal, ownerUserId: string, projectId: string, input: TargetPeriodEvidenceDecisionRequest): void {
  if (!principal || !ID.test(principal.userId) || !ID.test(ownerUserId) || !ID.test(projectId) || principal.userId === ownerUserId ||
      !input || !ID.test(input.request_id) || !Number.isSafeInteger(input.input_revision) || input.input_revision < 1 ||
      !SHA.test(input.input_hash) || !Number.isSafeInteger(input.source_profile_version) || input.source_profile_version < 1 ||
      !Array.isArray(input.periods) || input.periods.length < 1 || input.periods.length > 30) throw fail('TARGET_PERIOD_DECISION_INVALID');
  if(!validTargetPeriodEvidenceDecision(input))throw fail('TARGET_PERIOD_DECISION_EVIDENCE_INCOMPLETE');
  const seen = new Set<string>();
  for (const p of input.periods) {
    const key = periodKey(p as unknown as Record<string, unknown>);
    if (seen.has(key) || !['confirmed','needs_confirmation','conflict'].includes(p.outcome) ||
        !p.reason.trim() || p.reason.trim().length > 2048 || !Array.isArray(p.evidence)) throw fail('TARGET_PERIOD_DECISION_INVALID');
    seen.add(key);
    const anchors = new Set<string>();
    const evidenceIdentities = new Set<string>();
    for (const ref of p.evidence) {
      if (!ID.test(ref.material_id) || !ID.test(ref.parse_snapshot_id) || !ID.test(ref.record_id) ||
          !Number.isSafeInteger(ref.material_version) || ref.material_version < 1 || !SHA.test(ref.material_sha256) ||
          !SHA.test(ref.response_sha256) || !SHA.test(ref.record_sha256) || !ref.parser_version.trim() ||
          (ref.evidence_method==='ocr'&&(!Number.isSafeInteger(ref.page)||!ref.page_image_sha256||!Array.isArray(ref.ocr_uncertainty))) ||
          (ref.evidence_method==='native_text'&&(ref.page!==undefined||ref.page_image_sha256!==undefined||ref.ocr_uncertainty!==undefined)) ||
          !['table_header','entity','scope','period_end'].includes(ref.anchor_kind)) throw fail('TARGET_PERIOD_DECISION_EVIDENCE_INVALID');
      anchors.add(ref.anchor_kind);
      evidenceIdentities.add(`${ref.material_id}\0${ref.material_version}\0${ref.parse_snapshot_id}\0${ref.parser_version}\0${ref.response_sha256}`);
    }
    if (p.outcome === 'confirmed' && ['table_header','entity','scope','period_end'].some(k => !anchors.has(k)))
      throw fail('TARGET_PERIOD_DECISION_EVIDENCE_INCOMPLETE');
    if (p.outcome === 'confirmed' && evidenceIdentities.size !== 1) throw fail('TARGET_PERIOD_DECISION_EVIDENCE_SCOPE_AMBIGUOUS');
  }
}

function response(row: Row, replayed: boolean): TargetPeriodEvidenceDecisionResponse {
  return { decision_id:String(row.id), owner_user_id:String(row.owner_user_id), project_id:String(row.project_id),
    input_revision:Number(row.input_revision), input_hash:String(row.input_hash).trim(),
    locked_materials:parsed(row.locked_materials) as TargetPeriodEvidenceDecisionResponse['locked_materials'],
    source_profile_material_id:String(row.source_profile_material_id), source_profile_material_version:Number(row.source_profile_material_version),
    source_profile_version:Number(row.source_profile_version), source_profile_sha256:String(row.source_profile_sha256).trim(),
    periods:parsed(row.periods) as TargetPeriodEvidenceDecisionResponse['periods'],
    reviewer_user_id:String(row.reviewer_user_id), reviewer_grant_id:String(row.reviewer_grant_id),
    authority:'target_financial_period_reviewer', reviewed_at:new Date(String(row.reviewed_at)).toISOString(), replayed };
}

async function assertAnchors(client: Queryable, owner: string, projectId: string,
  locked: readonly {material_id:string;material_version:number;material_sha256:string}[], periods: TargetPeriodEvidenceDecisionRequest['periods'],blobs?:PrivateBlobs): Promise<void> {
  const lock = new Map(locked.map(x => [`${x.material_id}\0${x.material_version}`,x]));
  for (const period of periods) for (const ref of period.evidence) {
    const material = lock.get(`${ref.material_id}\0${ref.material_version}`);
    if (!material || material.material_sha256 !== ref.material_sha256) throw fail('TARGET_PERIOD_DECISION_EVIDENCE_NOT_LOCKED');
    if(ref.evidence_method==='ocr'){
      if(!blobs||!Number.isSafeInteger(ref.page)||!ref.page_image_sha256)throw fail('TARGET_PERIOD_DECISION_EVIDENCE_INVALID');
      let evidence;
      try{evidence=await readOcrPeriodEvidence(client as unknown as PgPool,blobs,{owner,projectId,materialId:ref.material_id,
        version:ref.material_version,snapshotId:ref.parse_snapshot_id,resultSha256:ref.response_sha256,recordId:ref.record_id,
        page:ref.page!,pageImageSha256:ref.page_image_sha256});}catch{throw fail('TARGET_PERIOD_DECISION_EVIDENCE_STALE');}
      if(evidence.processorVersion!==ref.parser_version||evidence.recordSha256!==ref.record_sha256||evidence.materialSha256!==ref.material_sha256)
        throw fail('TARGET_PERIOD_DECISION_EVIDENCE_STALE');
      if(canonical(evidence.uncertainty)!==canonical(ref.ocr_uncertainty))throw fail('TARGET_PERIOD_DECISION_EVIDENCE_STALE');
      if(period.outcome==='confirmed'&&ocrPeriodUncertaintyRequiresConfirmation(evidence.uncertainty))
        throw fail('TARGET_PERIOD_DECISION_EVIDENCE_INCOMPLETE');
      continue;
    }
    const result = await client.query(`SELECT m.role,m.deleted_at,s.response_sha256,s.parser_version,s.response_status,
        e.record_sha256,e.literal_quote,e.locator,e.context,e.uncertainty
      FROM bb_material_versions m
      JOIN bb_parse_snapshots s ON s.owner_user_id=m.owner_user_id AND s.project_id=m.project_id
        AND s.material_id=m.id AND s.material_version=m.version
      JOIN bb_parse_evidence e ON e.owner_user_id=s.owner_user_id AND e.project_id=s.project_id
        AND e.material_id=s.material_id AND e.material_version=s.material_version AND e.snapshot_id=s.id
      WHERE m.owner_user_id=$1 AND m.project_id=$2 AND m.id=$3 AND m.version=$4
        AND trim(m.sha256)=$5 AND s.id=$6 AND s.parser_version=$7 AND trim(s.response_sha256)=$8
        AND e.extractor_version=s.parser_version AND e.extraction_method=$11
        AND s.id=(SELECT s2.id FROM bb_parse_snapshots s2 WHERE s2.owner_user_id=s.owner_user_id
          AND s2.project_id=s.project_id AND s2.material_id=s.material_id AND s2.material_version=s.material_version
          ORDER BY s2.created_at DESC,s2.id DESC LIMIT 1)
        AND e.record_id=$9 AND trim(e.record_sha256)=$10 FOR SHARE OF m,s,e`,
      [owner,projectId,ref.material_id,ref.material_version,ref.material_sha256,ref.parse_snapshot_id,
        ref.parser_version,ref.response_sha256,ref.record_id,ref.record_sha256,ref.evidence_method]);
    const row=result.rows[0];
    const financialRoles=new Set<string>(M1_MATERIAL_PARTITIONS.find(p=>p.label==='财务与审计')?.roles.map(r=>r.code)??[]);
    if (!row || row.deleted_at !== null || !financialRoles.has(String(row.role)) ||
        !['parsed','needs_confirmation'].includes(String(row.response_status)))
      throw fail('TARGET_PERIOD_DECISION_EVIDENCE_STALE');
    // Anchors must point to actual parse output. Semantic adequacy remains the reviewer's decision.
    const uncertainty=parsed(row.uncertainty);
    if (typeof row.literal_quote !== 'string' || !row.literal_quote.trim() || !record(row.locator) ||
        typeof row.context !== 'string' || !Array.isArray(uncertainty)) throw fail('TARGET_PERIOD_DECISION_EVIDENCE_INVALID');
    if(period.outcome==='confirmed'&&uncertainty.length!==0)throw fail('TARGET_PERIOD_DECISION_EVIDENCE_INCOMPLETE');
  }
}

/** Append one complete per-revision period review, authorized by an exact current grant. */
export async function appendTargetPeriodEvidenceDecision(db: Db, principal: Principal,
  projectId: string, input: TargetPeriodEvidenceDecisionRequest, newId: () => string = randomUUID,blobs?:PrivateBlobs): Promise<TargetPeriodEvidenceDecisionResponse> {
  if(!ID.test(projectId))throw fail('TARGET_PERIOD_DECISION_INVALID');
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const grant=(await client.query(`SELECT g.id,g.scope_owner_user_id FROM bb_target_period_reviewer_grants g
      JOIN bb_users u ON u.id=g.user_id AND u.status='active'
      JOIN bb_projects p ON p.owner_user_id=g.scope_owner_user_id AND p.id=g.scope_project_id AND p.deleted_at IS NULL
      WHERE g.user_id=$1 AND g.scope_project_id=$2 AND g.revoked_at IS NULL
      FOR SHARE OF g,u,p`,[principal.userId,projectId])).rows[0];
    if(!grant)throw fail('TARGET_PERIOD_REVIEWER_FORBIDDEN');
    const ownerUserId=String(grant.scope_owner_user_id);
    validateRequest(principal,ownerUserId,projectId,input);
    const lockedInput=(await client.query(`SELECT i.input_hash,i.manifest,i.material_versions,i.draft_revision,p.latest_input_revision,p.draft_revision AS current_draft_revision
      FROM bb_input_revisions i JOIN bb_projects p ON p.owner_user_id=i.owner_user_id AND p.id=i.project_id
      WHERE i.owner_user_id=$1 AND i.project_id=$2 AND i.revision=$3 AND p.deleted_at IS NULL FOR SHARE OF i,p`,
      [ownerUserId,projectId,input.input_revision])).rows[0];
    if(!lockedInput)throw fail('TARGET_PERIOD_DECISION_NOT_FOUND');
    if(Number(lockedInput.latest_input_revision)!==input.input_revision || Number(lockedInput.draft_revision)!==Number(lockedInput.current_draft_revision) ||
       Number(lockedInput.draft_revision)!==Number((parsed(lockedInput.manifest) as any).draft_revision) ||
       String(lockedInput.input_hash).trim()!==input.input_hash)throw fail('TARGET_PERIOD_DECISION_STALE_INPUT');
    const manifest=parsed(lockedInput.manifest) as Record<string,unknown>;
    if(manifest.manifest_schema==='production_rule_pin_v1'&&inputManifestHash(manifest)!==String(lockedInput.input_hash).trim())
      throw fail('TARGET_PERIOD_DECISION_STALE_INPUT');
    const target=record(manifest.update_details)?manifest.update_details.target_reporting_periods:null;
    if(!Array.isArray(target)||target.length!==input.periods.length ||
       !same([...target].map(x=>periodKey(x as Record<string,unknown>)).sort(),input.periods.map(x=>periodKey(x as unknown as Record<string,unknown>)).sort()))
      throw fail('TARGET_PERIOD_DECISION_TARGET_MISMATCH');
    const inputMaterials=parsed(lockedInput.material_versions);
    if(!Array.isArray(inputMaterials))throw fail('TARGET_PERIOD_DECISION_LOCK_INVALID');
    const manifestMaterials=Array.isArray(manifest.materials)?manifest.materials:[];
    const toKey=(item:Record<string,unknown>)=>`${String(item.material_id)}\0${Number(item.material_version)}`;
    const isValidMaterial=(item:unknown):item is Record<string,unknown>=>record(item)&&ID.test(String(item.material_id))&&
      Number.isSafeInteger(item.material_version)&&Number(item.material_version)>0&&typeof item.role==='string'&&
      /^[a-f0-9]{64}$/.test(String(item.sha256).trim().toLowerCase());
    const lockKeys=inputMaterials.filter(record).map(toKey),manifestKeys=manifestMaterials.filter(record).map(toKey);
    if(inputMaterials.some(item=>!record(item)||!ID.test(String(item.material_id))||!Number.isSafeInteger(item.material_version)||Number(item.material_version)<1)||
       !Array.isArray(manifest.materials)||manifestMaterials.length!==manifest.materials.length||manifestMaterials.some(item=>!isValidMaterial(item))||
       lockKeys.length!==inputMaterials.length||manifestKeys.length!==manifestMaterials.length||
       new Set(lockKeys).size!==lockKeys.length||new Set(manifestKeys).size!==manifestKeys.length||
       !same([...lockKeys].sort(),[...manifestKeys].sort()))throw fail('TARGET_PERIOD_DECISION_MATERIAL_MANIFEST_MISMATCH');
    const lockedMaterials=[] as {material_id:string;material_version:number;material_sha256:string}[];
    const historicalMaterials: {material_id:string;material_version:number}[]=[];
    for(const item of inputMaterials){
      if(!record(item)||typeof item.material_id!=='string'||!Number.isSafeInteger(item.material_version))throw fail('TARGET_PERIOD_DECISION_LOCK_INVALID');
      const material=(await client.query(`SELECT role,sha256,deleted_at FROM bb_material_versions
        WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 FOR SHARE`,
        [ownerUserId,projectId,item.material_id,item.material_version])).rows[0];
      if(!material||material.deleted_at!==null)throw fail('TARGET_PERIOD_DECISION_STALE_MATERIAL_SET');
      const pinned=manifestMaterials.find((it:any)=>it.material_id===item.material_id&&Number(it.material_version)===Number(item.material_version));
      if(!pinned||String(material.role)!==String(pinned.role)||String(material.sha256).trim().toLowerCase()!==String(pinned.sha256).trim().toLowerCase())
        throw fail('TARGET_PERIOD_DECISION_MATERIAL_MANIFEST_MISMATCH');
      lockedMaterials.push({material_id:item.material_id,material_version:Number(item.material_version),material_sha256:String(material.sha256).trim().toLowerCase()});
      if(material.role==='historical')historicalMaterials.push({material_id:item.material_id,material_version:Number(item.material_version)});
    }
    lockedMaterials.sort((a,b)=>a.material_id.localeCompare(b.material_id)||a.material_version-b.material_version);
    if(historicalMaterials.length!==1)throw fail('TARGET_PERIOD_DECISION_HISTORICAL_SELECTION_INVALID');
    const historicalMaterial=(await client.query(`SELECT material_id,material_version,profile_version,recognition FROM bb_historical_profiles
      WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4
      ORDER BY profile_version DESC LIMIT 1 FOR SHARE`,
      [ownerUserId,projectId,historicalMaterials[0]!.material_id,historicalMaterials[0]!.material_version])).rows[0];
    if(!historicalMaterial||Number(historicalMaterial.profile_version)!==input.source_profile_version)throw fail('TARGET_PERIOD_DECISION_SOURCE_PROFILE_STALE');
    const sourceProfileHash=hash(parsed(historicalMaterial.recognition));
    await assertAnchors(client,ownerUserId,projectId,lockedMaterials,input.periods,blobs);
    const requestHash=hash({ownerUserId,projectId,inputRevision:input.input_revision,inputHash:input.input_hash,
      sourceProfileMaterialId:String(historicalMaterial.material_id),sourceProfileMaterialVersion:Number(historicalMaterial.material_version),
      sourceProfileVersion:input.source_profile_version,sourceProfileHash,lockedMaterials,periods:input.periods,reviewer:principal.userId,grantId:String(grant.id)});
    const prior=(await client.query(`SELECT * FROM bb_target_period_evidence_decisions
      WHERE owner_user_id=$1 AND project_id=$2 AND request_id=$3`,[ownerUserId,projectId,input.request_id])).rows[0];
    if(prior){
      if(String(prior.request_hash).trim()!==requestHash)throw fail('TARGET_PERIOD_DECISION_REPLAY_CONFLICT');
      await client.query('COMMIT'); return response(prior,true);
    }
    const id=newId();
    const row=(await client.query(`INSERT INTO bb_target_period_evidence_decisions
      (id,request_id,request_hash,owner_user_id,project_id,input_revision,input_hash,locked_materials,source_profile_material_id,source_profile_material_version,source_profile_version,source_profile_sha256,periods,reviewer_user_id,reviewer_grant_id,authority)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13::jsonb,$14,$15,'target_financial_period_reviewer') RETURNING *`,
      [id,input.request_id,requestHash,ownerUserId,projectId,input.input_revision,input.input_hash,JSON.stringify(lockedMaterials),
        String(historicalMaterial.material_id),Number(historicalMaterial.material_version),input.source_profile_version,sourceProfileHash,
        JSON.stringify(input.periods),principal.userId,String(grant.id)])).rows[0]!;
    await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'target_period_evidence_decision',$3,'target_period_evidence_decision.appended',$4::jsonb)`,
      [newId(),ownerUserId,id,JSON.stringify({project_id:projectId,input_revision:input.input_revision,input_hash:input.input_hash,
        reviewer_user_id:principal.userId,reviewer_grant_id:String(grant.id),period_count:input.periods.length})]);
    await client.query('COMMIT'); return response(row,false);
  }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}
  finally{await client.release();}
}

export async function withdrawTargetPeriodEvidenceDecision(db: Db, principal: Principal, projectId: string,
  input: {request_id:string;decision_id:string;reason:string}, newId:()=>string=randomUUID): Promise<{
    withdrawal_id:string;decision_id:string;reviewer_user_id:string;reviewer_grant_id:string;
    authority:'target_financial_period_reviewer';reason:string;withdrawn_at:string;replayed:boolean;
  }> {
  if(!principal||!ID.test(principal.userId)||!ID.test(projectId)||!input||!ID.test(input.request_id)||!ID.test(input.decision_id)||
     typeof input.reason!=='string'||!input.reason.trim()||input.reason.trim().length>2048)throw fail('TARGET_PERIOD_DECISION_INVALID');
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    const project=(await client.query('SELECT 1 FROM bb_projects WHERE id=$1 AND deleted_at IS NULL FOR SHARE',[projectId])).rows[0];
    if(!project)throw fail('TARGET_PERIOD_DECISION_NOT_FOUND');
    const grant=(await client.query(`SELECT g.id,g.scope_owner_user_id FROM bb_target_period_reviewer_grants g
      JOIN bb_users u ON u.id=g.user_id AND u.status='active'
      WHERE g.user_id=$1 AND g.scope_project_id=$2 AND g.revoked_at IS NULL FOR SHARE OF g,u`,[principal.userId,projectId])).rows[0];
    if(!grant)throw fail('TARGET_PERIOD_REVIEWER_FORBIDDEN');
    const owner=String(grant.scope_owner_user_id);
    const decision=(await client.query(`SELECT id FROM bb_target_period_evidence_decisions
      WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 FOR SHARE`,[input.decision_id,owner,projectId])).rows[0];
    if(!decision)throw fail('TARGET_PERIOD_DECISION_NOT_FOUND');
    const requestHash=hash({owner,projectId,decisionId:input.decision_id,reviewer:principal.userId,grantId:String(grant.id),reason:input.reason.trim()});
    const prior=(await client.query(`SELECT * FROM bb_target_period_evidence_decision_withdrawals
      WHERE owner_user_id=$1 AND project_id=$2 AND request_id=$3`,[owner,projectId,input.request_id])).rows[0];
    if(prior){if(String(prior.request_hash).trim()!==requestHash)throw fail('TARGET_PERIOD_DECISION_REPLAY_CONFLICT');
      await client.query('COMMIT');return {withdrawal_id:String(prior.id),decision_id:String(prior.decision_id),reviewer_user_id:String(prior.reviewer_user_id),
        reviewer_grant_id:String(prior.reviewer_grant_id),authority:'target_financial_period_reviewer',reason:String(prior.reason),
        withdrawn_at:new Date(String(prior.withdrawn_at)).toISOString(),replayed:true};}
    const row=(await client.query(`INSERT INTO bb_target_period_evidence_decision_withdrawals
      (id,request_id,request_hash,decision_id,owner_user_id,project_id,reviewer_user_id,reviewer_grant_id,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[newId(),input.request_id,requestHash,input.decision_id,owner,projectId,
      principal.userId,String(grant.id),input.reason.trim()])).rows[0]!;
    await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'target_period_evidence_decision',$3,'target_period_evidence_decision.withdrawn',$4::jsonb)`,
      [newId(),owner,input.decision_id,JSON.stringify({project_id:projectId,reviewer_user_id:principal.userId,reviewer_grant_id:String(grant.id),reason:input.reason.trim()})]);
    await client.query('COMMIT');return {withdrawal_id:String(row.id),decision_id:String(row.decision_id),reviewer_user_id:String(row.reviewer_user_id),
      reviewer_grant_id:String(row.reviewer_grant_id),authority:'target_financial_period_reviewer',reason:String(row.reason),
      withdrawn_at:new Date(String(row.withdrawn_at)).toISOString(),replayed:false};
  }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}
  finally{await client.release();}
}

/** Grant administration is deliberately a database-owner CLI operation, not a user HTTP capability. */
export async function changeTargetPeriodReviewerGrant(db: Db, input: {
  action:'grant'|'revoke'; reviewerUserId:string; actorUserId:string; reasonCode:string; authorizationBasis:string;
  ownerUserId:string; projectId:string; reason?:string;
}, newId:()=>string=randomUUID): Promise<string> {
  if(!['grant','revoke'].includes(input.action)||!ID.test(input.reviewerUserId)||!ID.test(input.actorUserId)||
     input.reviewerUserId===input.actorUserId||!ID.test(input.ownerUserId)||!ID.test(input.projectId)||
     input.reviewerUserId===input.ownerUserId||!/^[a-z][a-z0-9_]{0,63}$/.test(input.reasonCode)||
     !input.authorizationBasis.trim()||input.authorizationBasis.trim().length>2048||
     (input.action==='revoke'&&(!input.reason||!input.reason.trim()||input.reason.trim().length>2048)))
    throw fail('TARGET_PERIOD_GRANT_INVALID');
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    const admin=await client.query(`SELECT 1 FROM pg_class c JOIN pg_roles table_owner ON table_owner.oid=c.relowner
      JOIN pg_roles actor ON actor.rolname=current_user WHERE c.oid='bb_target_period_reviewer_grants'::regclass
      AND (actor.rolsuper OR actor.rolname=table_owner.rolname)`);
    if(!admin.rows.length)throw fail('TARGET_PERIOD_GRANT_ADMIN_REQUIRED');
    const actor=(await client.query("SELECT 1 FROM bb_users WHERE id=$1 AND status='active' FOR SHARE",[input.actorUserId])).rows[0];
    if(!actor)throw fail('TARGET_PERIOD_GRANT_ACTOR_NOT_ACTIVE');
    const project=await client.query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE',
      [input.ownerUserId,input.projectId]);
    if(!project.rows.length)throw fail('TARGET_PERIOD_DECISION_NOT_FOUND');
    if(input.action==='grant'){
      const reviewer=await client.query("SELECT 1 FROM bb_users WHERE id=$1 AND status='active' FOR SHARE",[input.reviewerUserId]);
      if(!reviewer.rows.length)throw fail('TARGET_PERIOD_GRANT_REVIEWER_NOT_ACTIVE');
    }
    let grantId:string,event:string;
    if(input.action==='grant'){
      const active=await client.query(`SELECT id FROM bb_target_period_reviewer_grants WHERE user_id=$1 AND scope_owner_user_id=$2
        AND scope_project_id=$3 AND revoked_at IS NULL`,[input.reviewerUserId,input.ownerUserId,input.projectId]);
      if(active.rows.length)throw fail('TARGET_PERIOD_GRANT_ALREADY_ACTIVE');
      grantId=newId();
      await client.query(`INSERT INTO bb_target_period_reviewer_grants(id,user_id,granted_by,reason_code,authorization_basis,scope_owner_user_id,scope_project_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[grantId,input.reviewerUserId,input.actorUserId,input.reasonCode,input.authorizationBasis.trim(),input.ownerUserId,input.projectId]);
      event='target_period_reviewer.granted';
    }else{
      const result=await client.query(`UPDATE bb_target_period_reviewer_grants SET revoked_at=now(),revoked_by=$4,revocation_reason=$5
        WHERE user_id=$1 AND scope_owner_user_id=$2 AND scope_project_id=$3 AND revoked_at IS NULL RETURNING id`,
        [input.reviewerUserId,input.ownerUserId,input.projectId,input.actorUserId,input.reason!.trim()]);
      if(result.rows.length!==1)throw fail('TARGET_PERIOD_GRANT_NOT_ACTIVE');
      grantId=String(result.rows[0]!.id);event='target_period_reviewer.revoked';
    }
    await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'target_period_reviewer_grant',$3,$4,$5::jsonb)`,[newId(),input.ownerUserId,grantId,event,JSON.stringify({
      reviewer_user_id:input.reviewerUserId,actor_user_id:input.actorUserId,project_id:input.projectId,reason_code:input.reasonCode,
      authorization_basis:input.authorizationBasis.trim(),...(input.reason?{reason:input.reason.trim()}:{})})]);
    await client.query('COMMIT');return grantId;
  }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}
  finally{await client.release();}
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [action,reviewerUserId,actorUserId,reasonCode,authorizationBasis,ownerUserId,projectId,reason]=process.argv.slice(2);
  if(!process.env.DATABASE_URL||!['grant','revoke'].includes(action??'')||!reviewerUserId||!actorUserId||!reasonCode||
     !authorizationBasis||!ownerUserId||!projectId||(action==='revoke'&&!reason))
    throw new Error('Usage: target-period-evidence-decisions grant|revoke REVIEWER ACTOR REASON_CODE BASIS OWNER PROJECT [REVOCATION_REASON] (DATABASE_URL required)');
  const pool=new PgPool({connectionString:process.env.DATABASE_URL});
  try{process.stdout.write(`${await changeTargetPeriodReviewerGrant(pool,{action:action as 'grant'|'revoke',reviewerUserId,actorUserId,
    reasonCode,authorizationBasis,ownerUserId,projectId,...(reason?{reason}:{})})}\n`);}
  finally{await pool.end();}
}
