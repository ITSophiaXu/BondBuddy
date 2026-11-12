import {test,expect} from '@playwright/test';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {checkRealSampleDeliveryNotes} from './local-prelaunch-real-sample-summary';
import {preserveRealSampleDownload,retainedRealSampleDownload,sha256} from './local-prelaunch-real-sample-helpers';

// Pure synthetic boundaries only: no page, service, customer files, credentials or model calls.
test('public delivery notes retain business limits without claiming comprehensive review',()=>{
  const notes=Object.freeze(['已更新财务表格至合成报告期。合并与母公司口径分别列示。',
    '主要财务指标表的本期列尚未补齐，请补齐后核对。缺少附注，未补造数据。',
    '保留操作风险提示。计算依据为合成金额 1,234.56 万元，待人工核实。未进行页面视觉检查。']);
  const result=checkRealSampleDeliveryNotes(notes);
  expect(result).toMatchObject({status:'passed',scope:'bounded-internal-execution-details-only',
    businessCompleteness:'manual_review_required',factualAccuracy:'manual_review_required',rawSummaryIncluded:false,findings:[]});
  expect(result.summarySha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.inspectedCharacters).toBe(notes.join('').length);
  expect(notes[1]).toContain('尚未补齐');
});

for(const [name,text,code] of [
  ['input manifest','本次读取 input.json 后处理。','internal_file'],
  ['operation log','已保存 output/operations.json。','internal_file'],
  ['private work log','详情见scratch/工作记录.md。','internal_path'],
  ['Windows path','文件在 C:\\private\\result。','internal_path'],
  ['node identity','修改位置 node_id=synthetic-node。','internal_identifier'],
  ['input hash','输入哈希 '+ 'a'.repeat(64),'internal_identifier'],
  ['SHA-256','SHA-256: '+ 'b'.repeat(64),'internal_identifier'],
  ['unnamed hash','文件标识 '+ 'c'.repeat(64),'internal_identifier'],
  ['apply command','调用工具 apply 后保存。','tool_command'],
  ['Python command','python -B -m synthetic.module','tool_command'],
  ['capability code','WORD_EDIT_TABLE_UNSUPPORTED，尚未处理。','tool_capability_code'],
  ['wildcard capability','WORD_EDIT_*_UNSUPPORTED','tool_capability_code'],
] as const)test(`public delivery notes reject ${name} without disclosing or removing content`,()=>{
  const confidential='SYNTHETIC_CUSTOMER_TEXT_DO_NOT_LOG session=synthetic-cookie-value';
  const notes=Object.freeze([`业务限制仍需核对。${text} ${confidential}`]),original=[...notes];
  const result=checkRealSampleDeliveryNotes(notes);
  expect(result.status).toBe('failed');expect(result.findings.some(f=>f.code===code)).toBe(true);
  expect(notes).toEqual(original);
  const evidence=JSON.stringify(result);
  for(const fragment of [text,confidential,'synthetic-cookie-value','业务限制仍需核对'])expect(evidence).not.toContain(fragment);
  expect(result.findings.every(f=>f.itemIndex===0&&Number.isInteger(f.offset))).toBe(true);
});

test('missing, malformed and oversized notes cannot pass by omission or truncation',()=>{
  for(const notes of [undefined,null,[],['  ','\n']])expect(checkRealSampleDeliveryNotes(notes).findings[0].code).toBe('missing_summary');
  for(const notes of ['text',{},[null],['text',42]])expect(checkRealSampleDeliveryNotes(notes).findings[0].code).toBe('invalid_summary_shape');
  for(const notes of [Array(65).fill('业务说明'),['文'.repeat(12001)],Array(5).fill('文'.repeat(10000))]){
    const result=checkRealSampleDeliveryNotes(notes);
    expect(result).toMatchObject({status:'failed',inspectedCharacters:0,summarySha256:null});
    expect(result.findings[0].code).toBe('summary_limit_exceeded');
  }
});

test('finding output is bounded and repeated checks do not mutate saved summaries',()=>{
  const notes=Object.freeze(Array(64).fill('input.json scratch/private node_id apply WORD_EDIT_TEST_UNSUPPORTED'));
  const first=checkRealSampleDeliveryNotes(notes),second=checkRealSampleDeliveryNotes(notes);
  expect(first).toEqual(second);expect(first.status).toBe('failed');
  expect(first.findings).toHaveLength(first.limits.maxFindings);expect(first.findingsTruncated).toBe(true);
});

test('download evidence is reused only for the same bytes and never overwritten by a changed artifact',()=>{
  const root=mkdtempSync(join(tmpdir(),'bb-synthetic-evidence-'));
  try{
    const path=join(root,'tracked.docx'),first=Buffer.from('synthetic original Word evidence'),changed=Buffer.from('synthetic changed Word evidence');
    expect(retainedRealSampleDownload(path,sha256(first))).toBeUndefined();
    expect(preserveRealSampleDownload(path,first,sha256(first))).toBe('saved');
    expect(preserveRealSampleDownload(path,first,sha256(first))).toBe('reused');
    expect(retainedRealSampleDownload(path,sha256(first))).toEqual(first);
    expect(()=>retainedRealSampleDownload(path,sha256(changed))).toThrow('file preserved');
    expect(()=>preserveRealSampleDownload(path,changed,sha256(changed))).toThrow('file preserved');
    expect(readFileSync(path)).toEqual(first);
    const other=join(root,'clean.docx');
    expect(()=>preserveRealSampleDownload(other,changed,sha256(first))).toThrow('evidence not written');
    expect(existsSync(other)).toBe(false);
  }finally{
    const relativeRoot=relative(resolve(tmpdir()),resolve(root));
    expect(relativeRoot).not.toMatch(/^\.\./);expect(relativeRoot).not.toBe('');
    rmSync(root,{recursive:true,force:true});
  }
});
