import assert from 'node:assert/strict';
import test from 'node:test';
import type {SourceMaterialPin,UnifiedAuthoringInput} from '@bondbuddy/contracts';
import {checkedRunKinds} from './queue.js';
import {directDocxEligible,directDocxFlagged,enableDirectDocx} from './direct-docx-admission.js';

const sha='a'.repeat(64),pin={material_id:'source-1',material_version:1,sha256:sha};
const source={...pin,issuer_name:'任丘市建设投资集团有限公司',relation:'same_issuer',market:'sse',offering:'private',reporting_periods:[],status:'user_asserted'};
const authoring=():UnifiedAuthoringInput=>({version:'unified_v1',source_prospectuses:[source] as UnifiedAuthoringInput['source_prospectuses'],
  requirements:[],knowledge:[],knowledge_status:'authoring_reference_not_compliance_approval',
  format_policy:{version:'source-format-v1',mode:'preserve_docx',selection:'explicit',template:{kind:'material',...pin}}});
const candidate=(value=authoring())=>({kind:'update',market:'sse' as const,offering:'private' as const,
  issuerName:'任丘市建设投资集团有限公司',authoring:value,
  materials:[{...pin,role:'historical',media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}] as (SourceMaterialPin&{media_type:string})[]});

test('direct edit requires explicit same issuer editable DOCX and a valid target',()=>{
  assert.equal(directDocxEligible(candidate()),true);
  const selectedInWeb=authoring();selectedInWeb.source_prospectuses=[{...source,issuer_name:null}] as UnifiedAuthoringInput['source_prospectuses'];
  assert.equal(directDocxEligible(candidate(selectedInWeb)),true);
  assert.equal(directDocxEligible({...candidate(),issuerName:'其他发行人'}),false);
  assert.equal(directDocxEligible({...candidate(),market:'nafmii'}),false);
  assert.equal(directDocxEligible({...candidate(),materials:[{...candidate().materials[0],media_type:'application/pdf'}]}),false);
  const automatic=authoring();automatic.format_policy={version:'source-format-v1',mode:'preserve_docx',selection:'automatic',template:{kind:'material',...pin}};
  assert.equal(directDocxEligible(candidate(automatic)),false);
});

test('opt-in is closed by default and creates a new immutable policy value',()=>{
  assert.equal(directDocxFlagged({},'user-1','project-1'),false);
  assert.equal(directDocxFlagged({BB_DIRECT_DOCX_ENABLED:'1',BB_DIRECT_DOCX_ALLOW_USERS:'other'},'user-1','project-1'),false);
  assert.equal(directDocxFlagged({BB_DIRECT_DOCX_ENABLED:'1',BB_DIRECT_DOCX_ALLOW_USERS:'user-1'},'user-1','project-1'),true);
  const input=authoring();enableDirectDocx(input);
  assert.equal(input.format_policy?.version,'direct-docx-v1');
  assert.equal(input.direct_rule_list_version,'direct-docx-rules-v1');
  assert.equal(directDocxEligible(candidate(input)),false);
});

test('old claim capability excludes the new queue',()=>{
  assert.deepEqual(checkedRunKinds(),['update','review','generation','qa']);
  assert.deepEqual(checkedRunKinds(['update_direct']),['update_direct']);
});
