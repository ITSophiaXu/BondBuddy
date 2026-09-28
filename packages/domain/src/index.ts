import { createHash } from 'node:crypto';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { MARKETS, OFFERINGS, isMarketOffering, type Market, type Offering } from '@bondbuddy/contracts';

export * from './sse-private-applicability-taxonomy.js';
export * from './cp-tenor-evidence.js';
export * from './cp-funds-use-change-evidence.js';
export * from './scp-mc4-omission-evidence.js';
export * from './mtn-registration-evidence.js';
export * from './mtn-funds-use-evidence.js';
export * from './mtn-quarterly-update-evidence.js';

export const RULE_PACK_SCHEMA_VERSION = 'rule-pack-v1' as const;
export const RULE_SOURCE_KINDS = ['formal_rule','official_interpretation','internal_method','unverified_lead'] as const;
export const RULE_ENFORCEMENTS = ['hard_block','soft_check','research_only'] as const;
export const DOCUMENT_STAGES = ['registration','issuance'] as const;
export const RULE_PACK_STATUSES = ['draft','published','withdrawn'] as const;
export const RELEASE_CHANNELS = ['test','production'] as const;
export const CAPABILITY_DECISIONS = ['eligible_for_evaluation','not_applicable','needs_evidence','capability_not_ready'] as const;
export const COVERAGE_DISPOSITIONS = ['covered','not_applicable','uncovered'] as const;

const strict = <T extends Record<string, TSchema>>(properties:T) => Type.Object(properties,{additionalProperties:false});
const enumOf = <T extends readonly string[]>(values:T) => Type.Union(values.map(value=>Type.Literal(value)));
const safeId = Type.String({pattern:'^[a-z][a-z0-9._-]{0,127}$'});
const version = Type.String({pattern:'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'});
const date = Type.String({pattern:'^\\d{4}-\\d{2}-\\d{2}$'});
const utc = Type.String({pattern:'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$'});
const hash = Type.String({pattern:'^[a-f0-9]{64}$'});
const nonEmpty = Type.String({minLength:1,maxLength:12000});
const stringList = Type.Array(Type.String({minLength:1,maxLength:256}),{uniqueItems:true});
const nullable = <T extends TSchema>(schema:T)=>Type.Union([schema,Type.Null()]);
const sourceLocator = strict({kind:nonEmpty,value:Type.String({minLength:1,maxLength:1024})});

export const RuleSourceSchema = strict({
  source_id:safeId,
  kind:enumOf(RULE_SOURCE_KINDS),
  authority:nonEmpty,
  document_title:nonEmpty,
  source_version:version,
  official_url:nullable(Type.String({minLength:1,maxLength:2048})),
  document_hash:nullable(hash),
  clause_locator:nonEmpty,
  exact_quote:nonEmpty,
  published_on:nullable(date),
  effective_from:nullable(date),
  effective_to:nullable(date),
  legal_effective_date_basis:Type.Optional(enumOf(['explicit_text','publication_commencement','unknown','not_legal_effectivity'] as const)),
  effective_date_derivation_evidence:Type.Optional(Type.Array(sourceLocator,{maxItems:20})),
  transition_from_date:Type.Optional(nullable(date)),
  transition_until_date:Type.Optional(nullable(date)),
  transition_evidence:Type.Optional(Type.Array(sourceLocator,{maxItems:20})),
  approved_method_window:Type.Optional(Type.Union([Type.Null(),strict({
    enabled_from:date,
    enabled_until:nullable(date),
    approval_evidence_id:safeId,
    approval_evidence_sha256:hash,
  })])),
  verified_by:nullable(safeId),
  verified_at:nullable(utc),
});

export const RuleExampleSchema = strict({
  example_id:safeId,
  summary:nonEmpty,
  expected_outcome:enumOf(['issue','pass','not_applicable','needs_evidence'] as const),
  evidence_ref:nonEmpty,
});

export const RuleDefinitionSchema = strict({
  rule_id:safeId,
  version,
  title:nonEmpty,
  enabled:Type.Boolean(),
  enforcement:enumOf(RULE_ENFORCEMENTS),
  source_ref_ids:Type.Array(safeId,{minItems:1,uniqueItems:true}),
  applicability:strict({
    document_stages:Type.Array(enumOf(DOCUMENT_STAGES),{minItems:1,uniqueItems:true}),
    issuer_scopes:stringList,
    investor_scopes:stringList,
    industries:stringList,
    special_features:stringList,
  }),
  required_inputs:stringList,
  checker:strict({
    checker_id:safeId,
    checker_version:version,
    parameter_version:version,
  }),
  exceptions:stringList,
  evidence_requirements:stringList,
  outputs:strict({
    when_met:enumOf(['pass','issue','needs_evidence','needs_judgement'] as const),
    when_not_met:enumOf(['pass','issue','needs_evidence','needs_judgement'] as const),
    severity:enumOf(['info','warning','blocking'] as const),
  }),
  boundaries:Type.Array(nonEmpty,{minItems:1}),
  positive_examples:Type.Array(RuleExampleSchema,{minItems:1}),
  negative_examples:Type.Array(RuleExampleSchema,{minItems:1}),
  boundary_examples:Type.Array(RuleExampleSchema,{minItems:1}),
  owner_role:enumOf(['industry_reviewer','ai_document_engineer'] as const),
});

export const SampleCaseSchema = strict({
  case_id:safeId,
  polarity:enumOf(['positive','negative','boundary'] as const),
  evidence_ref:nonEmpty,
  result:enumOf(['passed','failed'] as const),
  reviewed_by:safeId,
  reviewed_at:utc,
});

export const ReviewAttestationSchema = strict({
  reviewer_id:safeId,
  reviewer_role:enumOf(['industry_reviewer','technical_reviewer'] as const),
  reviewed_at:utc,
  source_verified:Type.Boolean(),
  scope_verified:Type.Boolean(),
  samples_verified:Type.Boolean(),
  notes:nonEmpty,
});

export const RulePackSchema = strict({
  schema_version:Type.Literal(RULE_PACK_SCHEMA_VERSION),
  pack_id:safeId,
  version,
  supersedes_version:nullable(version),
  status:enumOf(RULE_PACK_STATUSES),
  scope:strict({
    market:enumOf(MARKETS),
    offering:enumOf(OFFERINGS),
    instruments:stringList,
    document_stages:Type.Array(enumOf(DOCUMENT_STAGES),{minItems:1,uniqueItems:true}),
    issuer_scopes:Type.Array(Type.String({minLength:1,maxLength:128}),{minItems:1,uniqueItems:true}),
  }),
  validity:strict({
    published_on:nullable(date),
    effective_from:date,
    effective_to:nullable(date),
    transition_terms:stringList,
  }),
  sources:Type.Array(RuleSourceSchema,{minItems:1}),
  rules:Type.Array(RuleDefinitionSchema,{minItems:1}),
  sample_suite:strict({
    suite_id:safeId,
    version,
    data_classification:enumOf(['synthetic','authorized_real'] as const),
    cases:Type.Array(SampleCaseSchema,{minItems:3}),
  }),
  reviews:Type.Array(ReviewAttestationSchema),
  release:nullable(strict({
    channel:enumOf(RELEASE_CHANNELS),
    content_hash:hash,
    released_by:safeId,
    released_at:utc,
    reason:nonEmpty,
  })),
  withdrawal:nullable(strict({
    withdrawn_by:safeId,
    withdrawn_at:utc,
    reason:nonEmpty,
  })),
});

export const ChapterTemplateSchema = strict({
  schema_version:Type.Literal('chapter-template-v1'),
  template_id:safeId,
  version,
  rule_pack_id:safeId,
  market:enumOf(MARKETS),
  offering:enumOf(OFFERINGS),
  document_stages:Type.Array(enumOf(DOCUMENT_STAGES),{minItems:1,uniqueItems:true}),
  chapters:Type.Array(strict({
    chapter_id:safeId,
    title:nonEmpty,
    form_refs:Type.Array(Type.String({minLength:1,maxLength:64}),{minItems:1,uniqueItems:true}),
    source_ref_ids:Type.Array(safeId,{minItems:1,uniqueItems:true}),
    required_fields:stringList,
    applicability:nonEmpty,
  }),{minItems:1}),
});

export const CoverageManifestSchema = strict({
  schema_version:Type.Literal('capability-coverage-v1'),
  manifest_id:safeId,
  version,
  rule_pack_id:safeId,
  assessed_at:utc,
  items:Type.Array(strict({
    item_id:safeId,
    area:nonEmpty,
    disposition:enumOf(COVERAGE_DISPOSITIONS),
    document_stages:Type.Array(enumOf(DOCUMENT_STAGES),{minItems:1,uniqueItems:true}),
    source_ref_ids:Type.Array(safeId,{uniqueItems:true}),
    rationale:nonEmpty,
  }),{minItems:1}),
  open_blockers:Type.Array(strict({
    blocker_id:safeId,
    description:nonEmpty,
    required_evidence:nonEmpty,
  })),
});

export type RuleSource=Static<typeof RuleSourceSchema>;
export type RuleDefinition=Static<typeof RuleDefinitionSchema>;
export type RulePack=Static<typeof RulePackSchema>;
export type ReviewAttestation=Static<typeof ReviewAttestationSchema>;
export type ChapterTemplate=Static<typeof ChapterTemplateSchema>;
export type CoverageManifest=Static<typeof CoverageManifestSchema>;

export type ValidationProblem={path:string;code:string;message:string};

function problem(path:string,code:string,message:string):ValidationProblem{return {path,code,message};}

function isValidCalendarDate(value:string):boolean {
  if(!Value.Check(date,value))return false;
  const [yearText,monthText,dayText]=value.split('-');
  const year=Number(yearText),month=Number(monthText),day=Number(dayText);
  if(month<1 || month>12)return false;
  const leapYear=year%4===0 && (year%100!==0 || year%400===0);
  const daysInMonth=[31,leapYear?29:28,31,30,31,30,31,31,30,31,30,31][month-1]!;
  return day>=1 && day<=daysInMonth;
}

function canonical(value:unknown):string {
  if(value===null || typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  const record=value as Record<string,unknown>;
  return `{${Object.keys(record).sort().map(key=>`${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

export function rulePackContentHash(pack:RulePack):string {
  const content={
    schema_version:pack.schema_version,pack_id:pack.pack_id,version:pack.version,supersedes_version:pack.supersedes_version,
    scope:pack.scope,validity:pack.validity,sources:pack.sources,rules:pack.rules,sample_suite:pack.sample_suite,
  };
  return createHash('sha256').update(canonical(content)).digest('hex');
}

export function validateRulePack(value:unknown):{ok:true;value:RulePack}|{ok:false;problems:ValidationProblem[]} {
  if(!Value.Check(RulePackSchema,value)){
    const problems=[...Value.Errors(RulePackSchema,value)].map(error=>problem(error.path||'/', 'SCHEMA_INVALID', error.message));
    return {ok:false,problems};
  }
  const pack=value as RulePack;
  const problems:ValidationProblem[]=[];
  if(!isMarketOffering(pack.scope.market as Market,pack.scope.offering as Offering))problems.push(problem('/scope/offering','MARKET_OFFERING_INVALID','Offering is not valid for the selected market'));
  if(pack.validity.effective_to && pack.validity.effective_to<pack.validity.effective_from)problems.push(problem('/validity/effective_to','VALIDITY_RANGE_INVALID','effective_to precedes effective_from'));
  const sourceIds=new Set<string>();
  pack.sources.forEach((source,index)=>{
    if(sourceIds.has(source.source_id))problems.push(problem(`/sources/${index}/source_id`,'DUPLICATE_SOURCE_ID','source_id must be unique'));
    sourceIds.add(source.source_id);
    const verified=source.verified_by!==null && source.verified_at!==null;
    if(source.official_url!==null && !/^https:\/\//.test(source.official_url))problems.push(problem(`/sources/${index}/official_url`,'SOURCE_URL_INVALID','Official source URL must use HTTPS'));
    if(source.kind==='unverified_lead' && verified)problems.push(problem(`/sources/${index}`,'UNVERIFIED_SOURCE_MARKED_VERIFIED','Unverified leads cannot carry verified status'));
    if(source.kind!=='unverified_lead' && !verified)problems.push(problem(`/sources/${index}`,'SOURCE_VERIFICATION_INCOMPLETE','Verified source kind requires verifier and time'));
    if(source.kind!=='unverified_lead' && source.official_url===null && source.document_hash===null)problems.push(problem(`/sources/${index}`,'SOURCE_ORIGINAL_MISSING','Verified source requires an official URL or immutable document hash'));
    if(source.kind==='formal_rule' && source.effective_from===null)problems.push(problem(`/sources/${index}/effective_from`,'SOURCE_LEGAL_EFFECTIVE_DATE_MISSING','Binding rules require an explicitly supported legal effective date'));
    if(source.kind==='formal_rule' && source.legal_effective_date_basis!==undefined
      && !['explicit_text','publication_commencement'].includes(source.legal_effective_date_basis))problems.push(problem(`/sources/${index}/legal_effective_date_basis`,'SOURCE_LEGAL_DATE_BASIS_INVALID','Binding rules require an explicit or text-derived legal effective date'));
    if(source.kind==='formal_rule' && source.effective_from!==null && source.legal_effective_date_basis!==undefined
      && (source.effective_date_derivation_evidence?.length??0)===0)problems.push(problem(`/sources/${index}/effective_date_derivation_evidence`,'SOURCE_LEGAL_DATE_EVIDENCE_MISSING','A legal effective date needs an exact source locator'));
    if(source.legal_effective_date_basis==='publication_commencement'
      && (source.effective_from===null || source.effective_from!==source.published_on || (source.effective_date_derivation_evidence?.length??0)===0))problems.push(problem(`/sources/${index}/legal_effective_date_basis`,'SOURCE_PUBLICATION_DATE_DERIVATION_INVALID','Publication commencement needs matching official publication date and source text evidence'));
    if(source.kind==='internal_method' && source.effective_from!==null)problems.push(problem(`/sources/${index}/effective_from`,'INTERNAL_METHOD_HAS_LEGAL_DATE','Internal methods use a separate approved enablement window, not a legal effective date'));
    if(source.kind==='internal_method' && source.approved_method_window && source.approved_method_window.enabled_until
      && source.approved_method_window.enabled_until<source.approved_method_window.enabled_from)problems.push(problem(`/sources/${index}/approved_method_window`,'METHOD_WINDOW_INVALID','Approved method window ends before it starts'));
    if(source.kind!=='internal_method' && source.approved_method_window)problems.push(problem(`/sources/${index}/approved_method_window`,'METHOD_WINDOW_KIND_INVALID','Only internal methods can carry an approved method window'));
    if(source.kind==='official_interpretation' && source.effective_from===null && source.legal_effective_date_basis!==undefined
      && !['unknown','not_legal_effectivity'].includes(source.legal_effective_date_basis))problems.push(problem(`/sources/${index}/legal_effective_date_basis`,'SOURCE_LEGAL_DATE_CONFLICT','A null legal effective date cannot claim a known legal-date basis'));
    if(source.kind==='official_interpretation' && source.effective_from!==null
      && source.legal_effective_date_basis!==undefined && ['unknown','not_legal_effectivity'].includes(source.legal_effective_date_basis))problems.push(problem(`/sources/${index}/legal_effective_date_basis`,'SOURCE_LEGAL_DATE_CONFLICT','A known legal effective date conflicts with its date basis'));
    if(source.transition_from_date && source.transition_until_date && source.transition_until_date<source.transition_from_date)problems.push(problem(`/sources/${index}/transition_until_date`,'SOURCE_TRANSITION_RANGE_INVALID','Transition period ends before it starts'));
    if((source.transition_from_date || source.transition_until_date) && (source.transition_evidence?.length??0)===0)problems.push(problem(`/sources/${index}/transition_evidence`,'SOURCE_TRANSITION_EVIDENCE_MISSING','Transition dates require exact source locators'));
    if(source.effective_from && source.effective_to && source.effective_to<source.effective_from)problems.push(problem(`/sources/${index}/effective_to`,'SOURCE_VALIDITY_RANGE_INVALID','Source effective_to precedes effective_from'));
  });
  const ruleIds=new Set<string>();
  pack.rules.forEach((rule,index)=>{
    if(ruleIds.has(rule.rule_id))problems.push(problem(`/rules/${index}/rule_id`,'DUPLICATE_RULE_ID','rule_id must be unique'));
    ruleIds.add(rule.rule_id);
    for(const sourceId of rule.source_ref_ids)if(!sourceIds.has(sourceId))problems.push(problem(`/rules/${index}/source_ref_ids`,'SOURCE_REFERENCE_MISSING',`Unknown source ${sourceId}`));
    const sources=rule.source_ref_ids.map(id=>pack.sources.find(source=>source.source_id===id)).filter((item):item is RuleSource=>Boolean(item));
    if(rule.enforcement==='hard_block' && sources.some(source=>source.kind!=='formal_rule'))problems.push(problem(`/rules/${index}/enforcement`,'HARD_BLOCK_SOURCE_INVALID','Hard blocks require formal rule sources only'));
    if(sources.some(source=>source.kind==='unverified_lead') && (rule.enabled || rule.enforcement!=='research_only'))problems.push(problem(`/rules/${index}`,'UNVERIFIED_RULE_ENABLED','Unverified leads must remain disabled research-only rules'));
    if(rule.outputs.severity==='blocking' && rule.enforcement!=='hard_block')problems.push(problem(`/rules/${index}/outputs/severity`,'BLOCKING_OUTPUT_INVALID','Blocking severity requires hard_block enforcement'));
  });
  const caseIds=new Set<string>();
  for(const [index,testCase] of pack.sample_suite.cases.entries()){
    if(caseIds.has(testCase.case_id))problems.push(problem(`/sample_suite/cases/${index}/case_id`,'DUPLICATE_SAMPLE_ID','case_id must be unique'));
    caseIds.add(testCase.case_id);
  }
  if(pack.status==='draft' && (pack.release!==null || pack.withdrawal!==null || pack.reviews.length))problems.push(problem('/status','DRAFT_HAS_RELEASE_METADATA','Draft cannot carry reviews, release, or withdrawal metadata'));
  if(pack.status==='published' && (pack.release===null || pack.withdrawal!==null))problems.push(problem('/status','PUBLISHED_METADATA_INVALID','Published pack requires release and no withdrawal'));
  if(pack.status==='published' && pack.validity.published_on===null)problems.push(problem('/validity/published_on','PUBLISHED_DATE_MISSING','Published pack requires its publication date'));
  if(pack.status==='withdrawn' && (pack.release===null || pack.withdrawal===null))problems.push(problem('/status','WITHDRAWAL_METADATA_INVALID','Withdrawn pack requires release and withdrawal metadata'));
  if(pack.release && pack.release.content_hash!==rulePackContentHash(pack))problems.push(problem('/release/content_hash','CONTENT_HASH_MISMATCH','Release hash does not match immutable rule content'));
  return problems.length?{ok:false,problems}:{ok:true,value:pack};
}

export function validateRulePackCompanions(packValue:unknown,templateValue:unknown,coverageValue:unknown):{ok:true;pack:RulePack;template:ChapterTemplate;coverage:CoverageManifest}|{ok:false;problems:ValidationProblem[]} {
  const validatedPack=validateRulePack(packValue);
  if(!validatedPack.ok)return validatedPack;
  const problems:ValidationProblem[]=[];
  if(!Value.Check(ChapterTemplateSchema,templateValue))problems.push(...[...Value.Errors(ChapterTemplateSchema,templateValue)].map(error=>problem(`/template${error.path||'/'}`,'SCHEMA_INVALID',error.message)));
  if(!Value.Check(CoverageManifestSchema,coverageValue))problems.push(...[...Value.Errors(CoverageManifestSchema,coverageValue)].map(error=>problem(`/coverage${error.path||'/'}`,'SCHEMA_INVALID',error.message)));
  if(problems.length)return {ok:false,problems};
  const pack=validatedPack.value,template=templateValue as ChapterTemplate,coverage=coverageValue as CoverageManifest;
  const sourceIds=new Set(pack.sources.map(source=>source.source_id));
  if(template.rule_pack_id!==pack.pack_id)problems.push(problem('/template/rule_pack_id','PACK_REFERENCE_MISMATCH','Template must reference the same rule pack'));
  if(coverage.rule_pack_id!==pack.pack_id)problems.push(problem('/coverage/rule_pack_id','PACK_REFERENCE_MISMATCH','Coverage manifest must reference the same rule pack'));
  if(template.market!==pack.scope.market || template.offering!==pack.scope.offering)problems.push(problem('/template','TEMPLATE_SCOPE_MISMATCH','Template market and offering must match the rule pack'));
  if(template.document_stages.some(stage=>!pack.scope.document_stages.includes(stage)))problems.push(problem('/template/document_stages','TEMPLATE_STAGE_MISMATCH','Template stages must be within the rule pack scope'));
  const chapterIds=new Set<string>();
  template.chapters.forEach((chapter,index)=>{
    if(chapterIds.has(chapter.chapter_id))problems.push(problem(`/template/chapters/${index}/chapter_id`,'DUPLICATE_CHAPTER_ID','chapter_id must be unique'));
    chapterIds.add(chapter.chapter_id);
    chapter.source_ref_ids.forEach(sourceId=>{if(!sourceIds.has(sourceId))problems.push(problem(`/template/chapters/${index}/source_ref_ids`,'SOURCE_REFERENCE_MISSING',`Unknown source ${sourceId}`));});
  });
  const itemIds=new Set<string>();
  coverage.items.forEach((item,index)=>{
    if(itemIds.has(item.item_id))problems.push(problem(`/coverage/items/${index}/item_id`,'DUPLICATE_COVERAGE_ID','item_id must be unique'));
    itemIds.add(item.item_id);
    item.source_ref_ids.forEach(sourceId=>{if(!sourceIds.has(sourceId))problems.push(problem(`/coverage/items/${index}/source_ref_ids`,'SOURCE_REFERENCE_MISSING',`Unknown source ${sourceId}`));});
    if(item.disposition==='covered' && item.source_ref_ids.length===0)problems.push(problem(`/coverage/items/${index}/source_ref_ids`,'COVERED_SOURCE_MISSING','Covered items require at least one pack source'));
  });
  return problems.length?{ok:false,problems}:{ok:true,pack,template,coverage};
}

function requireValid(pack:unknown):RulePack {
  const validated=validateRulePack(pack);
  if(!validated.ok){const error=new Error(validated.problems.map(item=>`${item.code}:${item.path}`).join(','));error.name='RulePackValidationError';throw error;}
  return validated.value;
}

function reviewRole(reviews:ReviewAttestation[],role:ReviewAttestation['reviewer_role']):ReviewAttestation|undefined {
  return reviews.find(review=>review.reviewer_role===role && review.source_verified && review.scope_verified && review.samples_verified);
}

export function publishRulePack(draft:RulePack,input:{channel:'test'|'production';reviews:ReviewAttestation[];released_by:string;released_at:string;reason:string}):RulePack {
  const valid=requireValid(draft);
  if(valid.status!=='draft')throw new Error('RULE_PACK_NOT_DRAFT');
  if(!Value.Check(safeId,input.released_by) || !Value.Check(utc,input.released_at) || !input.reason.trim())throw new Error('INVALID_RELEASE_METADATA');
  const releaseDate=input.released_at.slice(0,10);
  if(valid.validity.effective_to!==null && valid.validity.effective_to<releaseDate)throw new Error('RULE_PACK_EXPIRED_BEFORE_RELEASE');
  if(valid.sources.some(source=>source.effective_to!==null && source.effective_to<releaseDate))throw new Error('RULE_SOURCE_EXPIRED_BEFORE_RELEASE');
  if(input.reviews.some(review=>review.reviewed_at>input.released_at) || valid.sample_suite.cases.some(testCase=>testCase.reviewed_at>input.released_at))throw new Error('RULE_PACK_EVIDENCE_AFTER_RELEASE');
  if(valid.sources.some(source=>source.kind==='unverified_lead') || valid.rules.some(rule=>!rule.enabled || rule.enforcement==='research_only'))throw new Error('RULE_PACK_HAS_UNPUBLISHABLE_RULES');
  if(input.channel==='production' && valid.sources.some(source=>source.effective_from===null
    || (source.kind==='formal_rule' && (!source.legal_effective_date_basis || (source.effective_date_derivation_evidence?.length??0)===0))
    || (source.kind==='internal_method' && source.effective_from!==null)
    || (source.kind==='official_interpretation' && !source.legal_effective_date_basis)
    || (source.kind==='official_interpretation' && (source.effective_date_derivation_evidence?.length??0)===0)
    || (source.legal_effective_date_basis!==undefined && ['unknown','not_legal_effectivity'].includes(source.legal_effective_date_basis))))
    throw new Error('RULE_SOURCE_APPLICABILITY_NOT_APPROVED');
  if(valid.sample_suite.cases.some(testCase=>testCase.result!=='passed'))throw new Error('RULE_PACK_SAMPLE_FAILURE');
  for(const polarity of ['positive','negative','boundary'] as const)if(!valid.sample_suite.cases.some(testCase=>testCase.polarity===polarity))throw new Error(`RULE_PACK_SAMPLE_${polarity.toUpperCase()}_MISSING`);
  const industryReview=reviewRole(input.reviews,'industry_reviewer'),technicalReview=reviewRole(input.reviews,'technical_reviewer');
  if(!industryReview || !technicalReview)throw new Error('RULE_PACK_REVIEWS_INCOMPLETE');
  if(industryReview.reviewer_id===technicalReview.reviewer_id)throw new Error('RULE_PACK_REVIEWERS_NOT_SEPARATE');
  if(input.channel==='production' && valid.sample_suite.data_classification!=='authorized_real')throw new Error('PRODUCTION_REQUIRES_AUTHORIZED_REAL_SAMPLES');
  const published:RulePack={...valid,status:'published',validity:{...valid.validity,published_on:releaseDate},reviews:input.reviews,release:{channel:input.channel,content_hash:'0'.repeat(64),released_by:input.released_by,released_at:input.released_at,reason:input.reason},withdrawal:null};
  published.release!.content_hash=rulePackContentHash(published);
  return requireValid(published);
}

export function publishRulePackBundle(draft:RulePack,template:ChapterTemplate,coverage:CoverageManifest,input:{channel:'test'|'production';reviews:ReviewAttestation[];released_by:string;released_at:string;reason:string}):RulePack {
  const validated=validateRulePackCompanions(draft,template,coverage);
  if(!validated.ok){const error=new Error(validated.problems.map(item=>`${item.code}:${item.path}`).join(','));error.name='RulePackCompanionValidationError';throw error;}
  if(coverage.open_blockers.length || coverage.items.some(item=>item.disposition==='uncovered'))throw new Error('RULE_PACK_COVERAGE_INCOMPLETE');
  return publishRulePack(draft,input);
}

export function withdrawRulePack(pack:RulePack,input:{withdrawn_by:string;withdrawn_at:string;reason:string}):RulePack {
  const valid=requireValid(pack);
  if(valid.status!=='published')throw new Error('RULE_PACK_NOT_PUBLISHED');
  if(!Value.Check(safeId,input.withdrawn_by)||!Value.Check(utc,input.withdrawn_at)||!input.reason.trim())throw new Error('INVALID_WITHDRAWAL_METADATA');
  return requireValid({...valid,status:'withdrawn',withdrawal:input});
}

export type RuleContext={market:Market;offering:Offering;document_stage:'registration'|'issuance'|'unknown';issuer_scope:string;instrument?:string|null;investor_scope?:string|null;industry?:string|null;special_features?:string[]|null;as_of:string};
export type CapabilityDecision={decision:typeof CAPABILITY_DECISIONS[number];pack_id:string;pack_version:string;content_hash:string|null;applicable_rule_ids:string[];reason_codes:string[]};

export function evaluateRulePackCapability(pack:RulePack,context:RuleContext):CapabilityDecision {
  const valid=requireValid(pack);
  const base={pack_id:valid.pack_id,pack_version:valid.version,content_hash:valid.release?.content_hash??null,applicable_rule_ids:[] as string[],reason_codes:[] as string[]};
  if(!isValidCalendarDate(context.as_of))return {...base,decision:'needs_evidence',reason_codes:['as_of_date_invalid']};
  if(!isMarketOffering(context.market,context.offering))return {...base,decision:'not_applicable',reason_codes:['market_or_offering_invalid']};
  if(valid.status!=='published' || valid.release?.channel!=='production')return {...base,decision:'capability_not_ready',reason_codes:['pack_not_production_published']};
  if(context.as_of<valid.validity.effective_from || (valid.validity.effective_to!==null && context.as_of>valid.validity.effective_to))return {...base,decision:'capability_not_ready',reason_codes:['pack_not_effective_on_date']};
  if(context.market!==valid.scope.market || context.offering!==valid.scope.offering)return {...base,decision:'not_applicable',reason_codes:['market_or_offering_mismatch']};
  if(context.document_stage==='unknown')return {...base,decision:'needs_evidence',reason_codes:['document_stage_unknown']};
  if(!valid.scope.document_stages.includes(context.document_stage))return {...base,decision:'not_applicable',reason_codes:['document_stage_mismatch']};
  if(!valid.scope.issuer_scopes.includes(context.issuer_scope))return {...base,decision:'not_applicable',reason_codes:['issuer_scope_mismatch']};
  if(valid.scope.instruments.length){
    const instrument=context.instrument?.trim();
    if(!instrument)return {...base,decision:'needs_evidence',reason_codes:['instrument_unknown']};
    if(!valid.scope.instruments.includes(instrument))return {...base,decision:'not_applicable',reason_codes:['instrument_mismatch']};
  }
  const sourceById=new Map(valid.sources.map(source=>[source.source_id,source]));
  const unknownApplicability=valid.rules.some(rule=>rule.enabled && rule.source_ref_ids.some(id=>{
    const source=sourceById.get(id);
    return source?.effective_from===null
      || (source?.kind==='formal_rule' && (!source.legal_effective_date_basis || (source.effective_date_derivation_evidence?.length??0)===0))
      || (source?.kind==='official_interpretation' && !source.legal_effective_date_basis)
      || (source?.kind==='official_interpretation' && (source.effective_date_derivation_evidence?.length??0)===0)
      || (source?.legal_effective_date_basis!==undefined && ['unknown','not_legal_effectivity'].includes(source.legal_effective_date_basis));
  }));
  if(unknownApplicability)return {...base,decision:'needs_evidence',reason_codes:['rule_source_effectivity_unknown']};
  const inactiveSource=valid.rules.some(rule=>rule.enabled && rule.source_ref_ids.some(id=>{
    const source=sourceById.get(id);
    return !source || (source.effective_from!==null && context.as_of<source.effective_from) || (source.effective_to!==null && context.as_of>source.effective_to);
  }));
  if(inactiveSource)return {...base,decision:'capability_not_ready',reason_codes:['rule_source_not_effective_on_date']};
  const needsInvestor=valid.rules.some(rule=>rule.enabled && rule.applicability.investor_scopes.length>0) && !context.investor_scope;
  const needsIndustry=valid.rules.some(rule=>rule.enabled && rule.applicability.industries.length>0) && !context.industry;
  const needsFeatures=valid.rules.some(rule=>rule.enabled && rule.applicability.special_features.length>0) && context.special_features==null;
  if(needsInvestor||needsIndustry||needsFeatures)return {...base,decision:'needs_evidence',reason_codes:[...(needsInvestor?['investor_scope_unknown']:[]),...(needsIndustry?['industry_unknown']:[]),...(needsFeatures?['special_features_unknown']:[])]};
  const features=context.special_features??[];
  const applicable=valid.rules.filter(rule=>rule.enabled && rule.applicability.document_stages.includes(context.document_stage) &&
    (!rule.applicability.issuer_scopes.length || rule.applicability.issuer_scopes.includes(context.issuer_scope)) &&
    (!rule.applicability.investor_scopes.length || rule.applicability.investor_scopes.includes(context.investor_scope!)) &&
    (!rule.applicability.industries.length || rule.applicability.industries.includes(context.industry!)) &&
    (!rule.applicability.special_features.length || rule.applicability.special_features.every(feature=>features.includes(feature))));
  if(!applicable.length)return {...base,decision:'capability_not_ready',reason_codes:['no_applicable_published_rules']};
  return {...base,decision:'eligible_for_evaluation',applicable_rule_ids:applicable.map(rule=>rule.rule_id),reason_codes:[]};
}

export type RollbackEvent={schema_version:1;action:'rule_pack.rollback';pack_id:string;from_version:string;from_content_hash:string;to_version:string;to_content_hash:string;actor_id:string;occurred_at:string;reason:string};

export function createRulePackRollbackEvent(current:RulePack,target:RulePack,input:{actor_id:string;occurred_at:string;reason:string}):RollbackEvent {
  const from=requireValid(current),to=requireValid(target);
  if(from.pack_id!==to.pack_id || from.status!=='published' || to.status!=='published' || from.release?.channel!=='production' || to.release?.channel!=='production')throw new Error('ROLLBACK_TARGET_INVALID');
  if(from.version===to.version || from.release.content_hash===to.release.content_hash)throw new Error('ROLLBACK_TARGET_SAME_RELEASE');
  if(to.release.released_at>=from.release.released_at)throw new Error('ROLLBACK_TARGET_NOT_OLDER');
  if(!Value.Check(safeId,input.actor_id)||!Value.Check(utc,input.occurred_at)||!input.reason.trim())throw new Error('INVALID_ROLLBACK_METADATA');
  if(input.occurred_at<to.validity.effective_from+'T00:00:00Z' || (to.validity.effective_to && input.occurred_at>to.validity.effective_to+'T23:59:59Z'))throw new Error('ROLLBACK_TARGET_NOT_EFFECTIVE');
  return {schema_version:1,action:'rule_pack.rollback',pack_id:from.pack_id,from_version:from.version,from_content_hash:from.release.content_hash,to_version:to.version,to_content_hash:to.release.content_hash,actor_id:input.actor_id,occurred_at:input.occurred_at,reason:input.reason};
}

export { nafmiiMtnChapterTemplate, nafmiiMtnCoverageManifest, nafmiiMtnDraftRulePack } from './nafmii-mtn.js';
export { nafmiiCpChapterTemplate, nafmiiCpCoverageManifest, nafmiiCpDraftRulePack } from './nafmii-cp.js';
export { nafmiiScpChapterTemplate, nafmiiScpCoverageManifest, nafmiiScpDraftRulePack } from './nafmii-scp.js';
