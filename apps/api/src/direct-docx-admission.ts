import type { PoolClient } from 'pg';
import { isMarketOffering, sameFormatTemplate, type Market, type Offering, type SourceMaterialPin, type UnifiedAuthoringInput } from '@bondbuddy/contracts';

const DOCX='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const RULE_LIST_VERSION='direct-docx-rules-v1' as const;
const groupPattern=/^[a-z][a-z0-9-]{0,31}$/;

function includesId(raw:string|undefined,id:string):boolean {
  return !!raw?.split(',').some(value=>value.trim()===id);
}

/** This is an opt-in pilot; absent or invalid configuration is always off. */
export function directDocxFlagged(env:NodeJS.ProcessEnv,userId:string,projectId:string):boolean {
  return env.BB_DIRECT_DOCX_ENABLED==='1' &&
    (includesId(env.BB_DIRECT_DOCX_ALLOW_USERS,userId)||includesId(env.BB_DIRECT_DOCX_ALLOW_PROJECTS,projectId));
}

export async function directDocxWorkerAvailable(db:PoolClient,env:NodeJS.ProcessEnv):Promise<boolean> {
  const group=env.BB_DIRECT_DOCX_WORKER_GROUP;
  if(!group||!groupPattern.test(group))return false;
  const seconds=Number(env.BB_DIRECT_DOCX_HEARTBEAT_MAX_AGE_SECONDS??30);
  if(!Number.isSafeInteger(seconds)||seconds<5||seconds>300)return false;
  const q=await db.query(`SELECT 1 FROM bb_worker_heartbeats
    WHERE stopped_at IS NULL AND split_part(worker_id,'_',1)=$1
      AND last_seen_at>now()-make_interval(secs=>$2)
      AND 'run'=ANY(kinds) AND 'update_direct'=ANY(run_kinds) LIMIT 1`,[group,seconds]);
  return q.rowCount===1;
}

export function directDocxEligible(input:{kind:string;market:Market|null;offering:Offering|null;issuerName:string|null;
  authoring:UnifiedAuthoringInput;materials:readonly (SourceMaterialPin&{media_type?:string})[]}):boolean {
  const {authoring}=input,policy=authoring.format_policy;
  if(input.kind!=='update'||!input.market||!input.offering||!isMarketOffering(input.market,input.offering)||!input.issuerName ||
      authoring.previous_output || policy?.version!=='source-format-v1'||policy.mode!=='preserve_docx'||
      policy.selection!=='explicit'||policy.template?.kind!=='material')return false;
  const source=authoring.source_prospectuses.find(item=>sameFormatTemplate(item,policy.template));
  const material=input.materials.find(item=>sameFormatTemplate(item,policy.template));
  return !!source && !!material && material.media_type===DOCX && source.relation==='same_issuer' &&
    (!source.issuer_name?.trim() || source.issuer_name.trim()===input.issuerName.trim());
}

export function enableDirectDocx(authoring:UnifiedAuthoringInput):void {
  const policy=authoring.format_policy;
  if(!policy||policy.version!=='source-format-v1'||policy.mode!=='preserve_docx'||policy.selection!=='explicit'||policy.template?.kind!=='material')
    throw new Error('Direct DOCX requires an explicit locked material');
  authoring.format_policy={version:'direct-docx-v1',mode:'preserve_docx',selection:'explicit',template:policy.template};
  authoring.direct_rule_list_version=RULE_LIST_VERSION;
  authoring.knowledge=[];
}
