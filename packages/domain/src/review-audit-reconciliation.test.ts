import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUDIT_RECONCILIATION_KNOWLEDGE as pack } from './audit-reconciliation-knowledge.js';
import { reviewAuditReconciliation } from './review-audit-reconciliation.js';
import type { ReviewFinancialObservation } from './review-financial-checks.js';
import { referenceFor, reviewContentHash } from './review-evidence.js';
import { reviewFixture } from './review-test-fixtures.js';

// All financial evidence below is synthetic; no professional acceptance is implied.
type Rule = typeof pack.rules[number];
type Term = NonNullable<Rule['terms']>[number];
const rule = (item: number) => pack.rules.find(r => r.source_item === item)!;
function fixture() {
  const f=reviewFixture();
  const observation=(id: string,metric: string,value: string,options: Partial<ReviewFinancialObservation> & {label?:string} = {}): ReviewFinancialObservation => {
    const source_kind=options.source_kind ?? 'audit';
    const period=options.period ?? {start:'2025-01-01',end:'2025-12-31',as_of:null};
    const {label:overrideLabel,...rest}=options;
    const source=source_kind === 'disclosure';
    const quote=`合成甲公司 ${options.accounting_scope ?? 'consolidated'} ${options.basis ?? 'original'} ${period.start ?? ''} ${period.end ?? ''} ${period.as_of ?? ''} ${options.currency ?? 'CNY'} ${options.unit ?? '万元'} ${overrideLabel ?? metric} ${options.value_literal ?? value}`;
    const ref=referenceFor(f.addRecord(id,quote,source,{material_id:source ? f.ctx.source_material.material_id : 'synthetic-audit',
      material_sha256:source ? f.ctx.source_material.sha256 : reviewContentHash('synthetic-audit'),
      parse_snapshot_id:source ? 'synthetic-disclosure-snapshot' : 'synthetic-audit-snapshot',
      parse_response_sha256:reviewContentHash(source ? 'synthetic-disclosure-snapshot' : 'synthetic-audit-snapshot')}));
    return {observation_id:id,source_kind,entity_id:'synthetic-issuer',metric,accounting_scope:'consolidated',basis:'original',context_verification:'trusted_structured',
      period,currency:'CNY',unit:'万元',value,value_literal:options.value_literal ?? value,value_refs:[ref],
      context_refs:{entity:[ref],period:[ref],accounting_scope:[ref],currency:[ref],unit:[ref],basis:[ref]},...rest};
  };
  const build=(r: Rule,value: string,terms: string[],options: Partial<ReviewFinancialObservation> = {}) => {
    const target=observation('d',r.result_metric,value,{source_kind:'disclosure',label:r.result_aliases?.[0],...options});
    const operands=r.terms!.map((term,i) => observation(`a${i}`,term.metric,terms[i]!,{label:term.aliases?.[0]}));
    return {target,operands,observations:[target,...operands]};
  };
  return {...f,observation,build};
}
function coverage(result: ReturnType<typeof reviewAuditReconciliation>,r: Rule,id='d') {
  return result.coverage.find(c => c.check_id === `audit-reconciliation:${r.id}:${id}`)!;
}
function finding(result: ReturnType<typeof reviewAuditReconciliation>,r: Rule,id='d') {
  const ids=new Set(coverage(result,r,id).finding_ids);return result.findings.find(f => ids.has(f.finding_id));
}
function repin(f: ReturnType<typeof fixture>,o: ReviewFinancialObservation,change: Record<string, unknown>) {
  Object.assign(f.records.find(r => r.record_id === o.value_refs[0]!.record_id)!,change);
  const ref=referenceFor(f.records.find(r => r.record_id === o.value_refs[0]!.record_id)!);
  o.value_refs=[ref];o.context_refs={entity:[ref],period:[ref],accounting_scope:[ref],currency:[ref],unit:[ref],basis:[ref]};
}
test('all 40 internal rules retain explicit uncovered coverage and source hash without fabricated regulatory refs',()=>{
  const f=fixture(),result=reviewAuditReconciliation([],f.ctx);
  assert.equal(result.coverage.length,40);assert(result.coverage.every(c => c.outcome === 'uncovered' && c.rule_refs.length === 0));
  assert(result.limitations.some(l => l.includes(pack.version) && l.includes(pack.source_sha256) && l.includes('internal_method')));
});
test('CLI audit selection executes only requested methods and keeps contextual operands outside differential targets',()=>{
  const f=fixture(),r=rule(1),input=f.build(r,'300.00',['100.00','200.00']);
  assert.deepEqual(reviewAuditReconciliation(input.observations,f.ctx,[]).coverage,[]);
  const selected=reviewAuditReconciliation(input.observations,f.ctx,[r.id],['d']);
  assert.equal(selected.coverage.length,1);assert.equal(selected.coverage[0]!.outcome,'pass');
  const noTarget=reviewAuditReconciliation(input.observations,f.ctx,[r.id],[]);
  assert.equal(noTarget.coverage.length,1);assert.equal(noTarget.coverage[0]!.outcome,'uncovered');
  assert.throws(()=>reviewAuditReconciliation(input.observations,f.ctx,['unknown']));
  assert.throws(()=>reviewAuditReconciliation(input.observations,f.ctx,[r.id,r.id]));
});
test('synthetic missing digit yields exact repairable fixed formula with only disclosure targets',()=>{
  const f=fixture(),r=rule(1),input=f.build(r,'30.00',['100.00','200.00']);
  const result=reviewAuditReconciliation(input.observations,f.ctx),item=finding(result,r)!;
  assert.equal(coverage(result,r).outcome,'issue');assert.equal(item.conclusion,'error');assert.equal(item.suggested_change,'300.00');
  assert.deepEqual(item.repairability.allowed_record_ids,['d']);assert.equal(item.calculation?.expression,`audit-reconciliation:${pack.version}:${r.id}`);
  assert.deepEqual(item.calculation?.operands,['a0','a1']);assert.equal(item.calculation?.unit,'万元');assert(item.calculation?.rounding.includes('+a0 +a1'));
});
test('subtraction distinguishes a negative signed amount from subtracting an expense',()=>{
  const f=fixture(),r=rule(19),input=f.build(r,'85.00',['100.00','-5.00','10.00']);
  let result=reviewAuditReconciliation(input.observations,f.ctx);assert.equal(coverage(result,r).outcome,'pass');
  input.target.value='105.00';input.target.value_literal='105.00';repin(f,input.target,{literal_quote:'合成甲公司 consolidated original 2025-01-01 2025-12-31 CNY 万元 利润总额 105.00'});
  result=reviewAuditReconciliation(input.observations,f.ctx);assert.equal(finding(result,r)?.suggested_change,'85.00');
  assert(finding(result,r)?.calculation?.rounding.includes('+a0 +a1 -a2'));
});
test('strict aliases and original evidence support exact same-currency unit conversion',()=>{
  const f=fixture(),r=rule(21),input=f.build(r,'150.00',['200.00','50.00']);
  input.operands[0]!.unit='元';input.operands[0]!.value='2000000.00';input.operands[0]!.value_literal='2,000,000.00';
  repin(f,input.operands[0]!,{literal_quote:`合成甲公司 consolidated original 2025-01-01 2025-12-31 CNY 元 ${r.terms![0]!.aliases![0]} 2,000,000.00`});
  assert.equal(coverage(reviewAuditReconciliation(input.observations,f.ctx),r).outcome,'pass');
});
test('each context mismatch prevents formulas even when displayed amounts would sum',()=>{
  const changes:Partial<ReviewFinancialObservation>[]=[{entity_id:'synthetic-other'},{currency:'USD'},{accounting_scope:'parent'},{basis:'restated'},
    {period:{start:'2024-01-01',end:'2024-12-31',as_of:null}}];
  for(const change of changes){const f=fixture(),r=rule(1),input=f.build(r,'300.00',['100.00','200.00']);Object.assign(input.operands[1]!,change);
    const result=reviewAuditReconciliation(input.observations,f.ctx);assert.equal(coverage(result,r).outcome,'needs_evidence');assert(!finding(result,r)?.repairability.can_revise);}
});
test('missing zero, dash and incomplete inventory never silently supply a zero operand',()=>{
  for(const kind of ['missing','dash']){const f=fixture(),r=rule(1),input=f.build(r,'100.00',['100.00','0.00']);
    if(kind==='missing')input.observations.pop();else {input.operands[1]!.value_literal='—';repin(f,input.operands[1]!,{literal_quote:'所有者权益合计 —'});}
    const result=reviewAuditReconciliation(input.observations,f.ctx);assert.equal(coverage(result,r).outcome,'needs_evidence');assert(!finding(result,r)?.suggested_change);}
  const f=fixture(),r=rule(1),input=f.build(r,'100.00',['100.00','0.00']);assert.equal(coverage(reviewAuditReconciliation(input.observations,f.ctx),r).outcome,'pass');
});
test('identical duplicate observations and conflicting values both require evidence rather than choosing one',()=>{
  for(const value of ['100.00','999.00']){const f=fixture(),r=rule(1),input=f.build(r,'300.00',['100.00','200.00']);
    input.observations.push(f.observation('duplicate',r.terms![0]!.metric,value,{label:r.terms![0]!.aliases?.[0]}));
    const result=reviewAuditReconciliation(input.observations,f.ctx);assert.equal(coverage(result,r).outcome,'needs_evidence');assert(finding(result,r)?.limitations.some(l => l.includes('duplicate_or_conflict')));}
});
test('operand evidence cannot mix financial materials, versions, snapshots or parse responses',()=>{
  for(const change of [{material_id:'other-audit'},{material_version:2},{parse_snapshot_id:'other-snapshot'},{parse_response_sha256:reviewContentHash('other-response')}]){
    const f=fixture(),r=rule(1),input=f.build(r,'300.00',['100.00','200.00']);repin(f,input.operands[1]!,change);
    const result=reviewAuditReconciliation(input.observations,f.ctx);assert.equal(coverage(result,r).outcome,'needs_evidence');assert(finding(result,r)?.limitations.includes('audit_formula_source_inventory_mixed'));
  }
});
test('OCR uncertainty and fabricated quotation cannot create a deterministic pass',()=>{
  for(const kind of ['uncertainty','quote']){const f=fixture(),r=rule(1),input=f.build(r,'300.00',['100.00','200.00']);
    if(kind==='uncertainty')repin(f,input.operands[0]!,{uncertainty:['synthetic-ocr-digit']});else input.operands[0]!.value_refs[0]!.quote='invented literal';
    const result=reviewAuditReconciliation(input.observations,f.ctx);assert.equal(coverage(result,r).outcome,'needs_evidence');assert(!finding(result,r)?.repairability.can_revise);}
});
test('model metric cannot relabel a value from an unrelated source row',()=>{
  const f=fixture(),r=rule(1),input=f.build(r,'300.00',['100.00','200.00']);
  repin(f,input.operands[0]!,{literal_quote:'合成甲公司 consolidated original 2025-01-01 2025-12-31 CNY 万元 其他科目 100.00'});
  const result=reviewAuditReconciliation(input.observations,f.ctx);assert.equal(coverage(result,r).outcome,'needs_evidence');
  assert(finding(result,r)?.limitations.some(l => l.startsWith('audit_operand_metric_not_in_value_source')));
});
test('longer parent-profit name does not substantiate the total net-profit suffix',()=>{
  const f=fixture(),r=rule(20),input=f.build(r,'90.00',['100.00','10.00']);
  repin(f,input.target,{literal_quote:'合成甲公司 consolidated original 2025-01-01 2025-12-31 CNY 万元 归属于母公司所有者的净利润 90.00'});
  const result=reviewAuditReconciliation(input.observations,f.ctx);assert.equal(coverage(result,r).outcome,'needs_evidence');
  assert(finding(result,r)?.limitations.includes('audit_result_metric_not_in_value_source'));
});
test('metric next to another value cannot be used to label that later value',()=>{
  const f=fixture(),r=rule(1),input=f.build(r,'300.00',['100.00','200.00']);
  repin(f,input.operands[0]!,{literal_quote:'负债合计 999.00 所有者权益合计 100.00'});
  assert.equal(coverage(reviewAuditReconciliation(input.observations,f.ctx),r).outcome,'needs_evidence');
});
test('numeric substrings and model-truncated number-only quotes do not establish metrics',()=>{
  for(const kind of ['substring','truncated']){const f=fixture(),r=rule(1),input=f.build(r,'300.00',['100.00','200.00']);
    if(kind==='substring')repin(f,input.operands[0]!,{literal_quote:'负债合计 100.001'});else input.operands[0]!.value_refs[0]!.quote='100.00';
    assert.equal(coverage(reviewAuditReconciliation(input.observations,f.ctx),r).outcome,'needs_evidence');}
});
test('accumulated source display rounding yields manual without any numeric repair suggestion',()=>{
  const f=fixture(),r=rule(1),input=f.build(r,'300.01',['100.0','200.0']);
  const result=reviewAuditReconciliation(input.observations,f.ctx),item=finding(result,r)!;
  assert.equal(coverage(result,r).outcome,'manual');assert(item.limitations.includes('audit_source_rounding_ambiguous'));assert(!item.suggested_change);assert(!item.repairability.can_revise);
});
test('single disclosure inventory may identify internal arithmetic but cannot authorize overwriting audit facts',()=>{
  const f=fixture(),r=rule(1),input=f.build(r,'30.00',['100.00','200.00']);
  for(const [i,term] of r.terms!.entries())input.observations[i+1]=f.observation(`disclosed-${i}`,term.metric,['100.00','200.00'][i]!,{source_kind:'disclosure',label:term.aliases?.[0]});
  const result=reviewAuditReconciliation(input.observations,f.ctx),item=finding(result,r)!;
  assert.equal(coverage(result,r).outcome,'manual');assert.equal(item.calculation?.expected,'300.00');assert(!item.suggested_change);assert(!item.repairability.can_revise);
});
test('an audit term plus disclosure term does not form a single independent inventory',()=>{
  const f=fixture(),r=rule(1),input=f.build(r,'300.00',['100.00','200.00']),term=r.terms![1]!;
  input.observations[2]=f.observation('mixed',term.metric,'200.00',{source_kind:'disclosure',label:term.aliases?.[0]});
  assert.equal(coverage(reviewAuditReconciliation(input.observations,f.ctx),r).outcome,'needs_evidence');
});
test('conditional and manual rules retain applicability conditions and caveats without invented suggestions',()=>{
  for(const r of pack.rules.filter(r => r.category !== 'deterministic')){const f=fixture(),target=f.observation('d',r.result_metric,'123.00',{source_kind:'disclosure',label:r.result_aliases?.[0]});
    const result=reviewAuditReconciliation([target],f.ctx),item=finding(result,r)!;
    assert.equal(coverage(result,r).outcome,'manual');assert(item.description.includes(r.caveat));assert(r.conditions.every(c => item.description.includes(c)));assert(!item.suggested_change);assert(!item.calculation);
  }
});
test('consolidated parent/minority profit relation is manual for parent scope',()=>{
  const f=fixture(),r=rule(23),input=f.build(r,'300.00',['100.00','200.00'],{accounting_scope:'parent'});
  const result=reviewAuditReconciliation(input.observations,f.ctx);assert.equal(coverage(result,r).outcome,'manual');assert(!finding(result,r)?.suggested_change);
});
function cashFixture() {
  const f=fixture(),r=rule(27),target=f.observation('d',r.result_metric,'120.00',{source_kind:'disclosure',label:r.result_aliases?.[0],period:{start:null,end:null,as_of:'2025-12-31'}});
  const operands=r.terms!.map((term: Term,i) => f.observation(`a${i}`,term.metric,i===0?'100.00':'20.00',{label:term.aliases?.[0],
    period:term.period_role === 'opening' ? {start:null,end:null,as_of:'2024-12-31'} : {start:'2025-01-01',end:'2025-12-31',as_of:null}}));
  return {...f,r,target,operands,observations:[target,...operands]};
}
test('cash opening plus exact intervening flow agrees only with aligned closing date',()=>{
  const f=cashFixture();assert.equal(coverage(reviewAuditReconciliation(f.observations,f.ctx),f.r).outcome,'pass');
});
test('cash bridge selects aligned audit inventory when prospectus repeats opening and flow amounts',()=>{
  const f=cashFixture();
  for(const [i,term] of f.r.terms!.entries())f.observations.push(f.observation(`disclosure-cash-${i}`,term.metric,i===0?'100.00':'20.00',
    {source_kind:'disclosure',label:term.aliases?.[0],period:{...f.operands[i]!.period}}));
  assert.equal(coverage(reviewAuditReconciliation(f.observations,f.ctx),f.r).outcome,'pass');
});
test('cash balance does not combine unrelated dates, truncated interim flow or duration result',()=>{
  for(const kind of ['opening','flow','result']){const f=cashFixture();
    if(kind==='opening')f.operands[0]!.period.as_of='2024-12-30';
    if(kind==='flow')f.operands[1]!.period.start='2025-07-01';
    if(kind==='result')f.target.period={start:'2025-01-01',end:'2025-12-31',as_of:null};
    assert.equal(coverage(reviewAuditReconciliation(f.observations,f.ctx),f.r).outcome,'needs_evidence');
  }
});
test('repeated observation IDs are rejected instead of reusing a signed operand',()=>{
  const f=fixture(),r=rule(1),input=f.build(r,'300.00',['100.00','200.00']);
  assert.throws(()=>reviewAuditReconciliation([...input.observations,input.operands[0]!],f.ctx),/DUPLICATE_ID/);
});
test('unresolved context markers never become comparable facts merely because citations exist',()=>{
  for(const field of ['entity_id','accounting_scope','basis','currency'] as const){
    for(const value of ['unknown','未知','不详','未提供']){const f=fixture(),r=rule(1),input=f.build(r,'30.00',['100.00','200.00']);
      input.observations.forEach(o => {o[field]=value;});
      const result=reviewAuditReconciliation(input.observations,f.ctx);assert.equal(coverage(result,r).outcome,'needs_evidence');assert(!finding(result,r)?.suggested_change);
    }
  }
});
test('narrow Chinese consolidated scope aliases support the parent/minority relation',()=>{
  for(const accounting_scope of ['合并','合并报表']){const f=fixture(),r=rule(23),input=f.build(r,'300.00',['100.00','200.00']);
    input.observations.forEach(o => {o.accounting_scope=accounting_scope;});
    assert.equal(coverage(reviewAuditReconciliation(input.observations,f.ctx),r).outcome,'pass');
  }
});
function tableFixture(format: 'docx_block'|'xlsx_cell'|'csv_cell' = 'xlsx_cell') {
  const f=fixture(),r=rule(1),input=f.build(r,'30.00',['100.00','200.00']);
  const locator=(row: number,column: number) => format === 'docx_block' ? {stable_ref:`t1r${row}c${column}`,path:[{table:1,row,column},{paragraph:1}]}
    : format === 'xlsx_cell' ? {sheet:'Synthetic',cell:`${String.fromCharCode(64+column)}${row}`} : {row,column};
  const labels=[];
  for(const [i,o] of input.observations.entries()){
    const row=i===0 ? 2 : i+1;
    repin(f,o,{literal_quote:o.value_literal,locator_type:format,locator:locator(row,2)});
    const pinned=f.records.find(record => record.record_id === o.observation_id)!;
    const label=f.addRecord(`label-${i}`,i===0 ? r.result_aliases![0]! : r.terms![i-1]!.aliases![0]!,i===0,
      {material_id:pinned.material_id,material_version:pinned.material_version,material_sha256:pinned.material_sha256,
        parse_snapshot_id:pinned.parse_snapshot_id,parse_response_sha256:pinned.parse_response_sha256,locator_type:format,locator:locator(row,1)});
    labels.push(label);
    const period=f.addRecord(`period-${i}`,'2025年度',i===0,
      {material_id:pinned.material_id,material_version:pinned.material_version,material_sha256:pinned.material_sha256,
        parse_snapshot_id:pinned.parse_snapshot_id,parse_response_sha256:pinned.parse_response_sha256,locator_type:format,locator:locator(1,2)});
    o.context_refs.period=[referenceFor(period)];
  }
  return {...f,...input,r,labels};
}
test('trusted DOCX/XLSX/CSV row labels substantiate numeric cells and are retained as evidence',()=>{
  for(const format of ['docx_block','xlsx_cell','csv_cell'] as const){const f=tableFixture(format),result=reviewAuditReconciliation(f.observations,f.ctx),item=finding(result,f.r)!;
    assert.equal(coverage(result,f.r).outcome,'issue');assert.equal(item.suggested_change,'300.00');
    assert.deepEqual(item.repairability.allowed_record_ids,['d']);assert(f.labels.every(label => item.evidence_refs.some(ref => ref.record_id === label.record_id)));
  }
});
test('cell metric labels from another row, snapshot, owner or uncertain OCR cannot support a value',()=>{
  for(const kind of ['row','snapshot','owner','uncertain']){const f=tableFixture(),label=f.labels[1]!;
    if(kind==='row')label.locator={sheet:'Synthetic',cell:'A20'};
    if(kind==='snapshot')label.parse_snapshot_id='wrong-snapshot';
    if(kind==='owner')label.owner_user_id='another-user';
    if(kind==='uncertain')label.uncertainty=['synthetic-ocr-label'];
    const result=reviewAuditReconciliation(f.observations,f.ctx);assert.equal(coverage(result,f.r).outcome,'needs_evidence');assert(!finding(result,f.r)?.suggested_change);
  }
});
test('numeric cell period must bind to its own column rather than adjacent reporting-year headers',()=>{
  const f=tableFixture(),o=f.operands[0]!,ref=o.context_refs.period[0]!;
  const record=f.records.find(record => record.record_id === ref.record_id)!;record.locator={sheet:'Synthetic',cell:'C1'};
  o.context_refs.period=[referenceFor(record)];
  assert.equal(coverage(reviewAuditReconciliation(f.observations,f.ctx),f.r).outcome,'needs_evidence');
});
test('ordinary prospectus components do not compete with the complete independent audited inventory',()=>{
  const f=fixture(),r=rule(1),input=f.build(r,'110.00',['80.00','30.00']);
  for(const [i,term] of r.terms!.entries())input.observations.push(f.observation(`disclosure-component-${i}`,term.metric,['80.00','30.00'][i]!,{source_kind:'disclosure',label:term.aliases?.[0]}));
  const result=reviewAuditReconciliation(input.observations,f.ctx);assert.equal(coverage(result,r).outcome,'pass');assert(!finding(result,r));
  input.target.value='11.00';input.target.value_literal='11.00';repin(f,input.target,{literal_quote:'资产总计 11.00'});
  const changed=reviewAuditReconciliation(input.observations,f.ctx);assert.equal(finding(changed,r)?.suggested_change,'110.00');
});
test('explicit audited result disagreement with its own formula is a source conflict without repair',()=>{
  for(const observed of ['100.00','11.00']){const f=fixture(),r=rule(1),input=f.build(r,observed,['80.00','30.00']);
    input.observations.push(f.observation('audited-total',r.result_metric,'100.00',{label:r.result_aliases?.[0]}));
    const result=reviewAuditReconciliation(input.observations,f.ctx),item=finding(result,r)!;
    assert.equal(coverage(result,r).outcome,'issue');assert.equal(item.conclusion,'conflict');assert(!item.suggested_change);assert(!item.repairability.can_revise);
    assert(item.evidence_refs.some(ref => ref.record_id === 'audited-total'));assert.equal(item.calculation?.expected,'110.00');
  }
});
test('audited result agreeing with the formula supports correcting a disclosure digit',()=>{
  const f=fixture(),r=rule(1),input=f.build(r,'11.00',['80.00','30.00']);input.observations.push(f.observation('audited-total',r.result_metric,'110.00',{label:r.result_aliases?.[0]}));
  assert.equal(finding(reviewAuditReconciliation(input.observations,f.ctx),r)?.suggested_change,'110.00');
});
test('additional complete or partial independent inventories cannot hide conflicting source values',()=>{
  for(const complete of [false,true]){const f=fixture(),r=rule(1),input=f.build(r,'110.00',['80.00','30.00']);
    const extra=f.observation('extra-liability',r.terms![0]!.metric,'99.00',{label:r.terms![0]!.aliases?.[0]});repin(f,extra,{material_id:'synthetic-audit-2',material_sha256:reviewContentHash('synthetic-audit-2')});input.observations.push(extra);
    if(complete){const equity=f.observation('extra-equity',r.terms![1]!.metric,'30.00',{label:r.terms![1]!.aliases?.[0]});repin(f,equity,{material_id:'synthetic-audit-2',material_sha256:reviewContentHash('synthetic-audit-2')});input.observations.push(equity);}
    const result=reviewAuditReconciliation(input.observations,f.ctx);assert.equal(finding(result,r)?.conclusion,'conflict');assert(!finding(result,r)?.suggested_change);
  }
});
test('equal complete financial inventories corroborate without mixing formula operands across pins',()=>{
  const f=fixture(),r=rule(1),input=f.build(r,'110.00',['80.00','30.00']);
  for(const [i,term] of r.terms!.entries()){const o=f.observation(`extra-${i}`,term.metric,['80.00','30.00'][i]!,{label:term.aliases?.[0]});repin(f,o,{material_id:'synthetic-audit-2',material_sha256:reviewContentHash('synthetic-audit-2')});input.observations.push(o);}
  assert.equal(coverage(reviewAuditReconciliation(input.observations,f.ctx),r).outcome,'pass');
});
test('negative contra-account and cash-outflow displays require manual sign interpretation',()=>{
  for(const item of [9,10,12,13,14,15,25]){const f=fixture(),r=rule(item),values=r.terms!.map((term,i) => i===0?'90.00':term.coefficient===-1?'-10.00':'0.00');
    const input=f.build(r,'80.00',values),result=reviewAuditReconciliation(input.observations,f.ctx),findingItem=finding(result,r)!;
    assert.equal(coverage(result,r).outcome,'manual');assert(findingItem.limitations.includes('audit_contra_account_sign_convention_unresolved'));assert(!findingItem.suggested_change);assert(!findingItem.calculation);
  }
});
test('signed income tax refunds remain valid signed expenses rather than contra balances',()=>{
  const f=fixture(),r=rule(20),input=f.build(r,'100.00',['90.00','-10.00']);assert.equal(coverage(reviewAuditReconciliation(input.observations,f.ctx),r).outcome,'pass');
});
function assetsWithTwoIdentities(observed: string,values=['80.00','30.00','50.00','70.00']) {
  const f=fixture(),identity=rule(1),classification=rule(4),input=f.build(identity,observed,values.slice(0,2));
  classification.terms!.forEach((term,i) => input.observations.push(f.observation(`classification-${i}`,term.metric,values[i+2]!,{label:term.aliases?.[0]})));
  return {...f,...input,identity,classification};
}
test('competing independently audited formulas cannot offer two numeric repairs for one disclosed fact',()=>{
  const f=assetsWithTwoIdentities('10.00'),result=reviewAuditReconciliation(f.observations,f.ctx);
  for(const r of [f.identity,f.classification]){const item=finding(result,r)!;
    assert.equal(coverage(result,r).outcome,'issue');assert.equal(item.conclusion,'conflict');assert(!item.suggested_change);assert(!item.repairability.can_revise);
    assert(item.description.includes('110.00') && item.description.includes('120.00'));assert(item.description.includes('+a0 +a1') && item.description.includes('+classification-0 +classification-1'));
    assert(['a0','a1','classification-0','classification-1'].every(id => item.evidence_refs.some(ref => ref.record_id === id)));
  }
});
test('a previously passing identity is marked conflict when another independent identity disagrees',()=>{
  const f=assetsWithTwoIdentities('110.00'),result=reviewAuditReconciliation(f.observations,f.ctx);
  for(const r of [f.identity,f.classification]){assert.equal(coverage(result,r).outcome,'issue');assert.equal(finding(result,r)?.conclusion,'conflict');assert(!finding(result,r)?.suggested_change);}
  assert(result.coverage.filter(c => c.check_id.endsWith(':d')).every(c => c.outcome !== 'pass'));
});
test('different formula centers within cumulative source rounding remain manual across all affected checks',()=>{
  const f=assetsWithTwoIdentities('110.00',['80.0','30.0','50.0','60.01']),result=reviewAuditReconciliation(f.observations,f.ctx);
  for(const r of [f.identity,f.classification]){assert.equal(coverage(result,r).outcome,'manual');assert.equal(finding(result,r)?.conclusion,'manual');assert(!finding(result,r)?.suggested_change);}
});
test('matching independently audited identities retain their pass and repair conclusions',()=>{
  for(const observed of ['110.00','11.00']){const f=assetsWithTwoIdentities(observed,['80.00','30.00','50.00','60.00']),result=reviewAuditReconciliation(f.observations,f.ctx);
    for(const r of [f.identity,f.classification])assert.equal(coverage(result,r).outcome,observed==='110.00' ? 'pass' : 'issue');
    if(observed==='11.00')assert([f.identity,f.classification].every(r => finding(result,r)?.suggested_change === '110.00'));
  }
});
