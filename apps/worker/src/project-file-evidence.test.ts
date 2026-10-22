import test from 'node:test';
import assert from 'node:assert/strict';
import {Value} from '@sinclair/typebox/value';
import {ProjectFileCheckResultSchema} from '@bondbuddy/contracts';
import {verifiedFileCheck,verifiedFileLinks} from './project-file-evidence.js';
import type {ProjectFileText} from '@bondbuddy/contracts';
const snapshot=(texts:string[],coverage:'complete'|'partial'='complete'):ProjectFileText=>({version:'project-file-text-v1',sha256:'a'.repeat(64),format:'docx',spans:texts.map((text,i)=>({id:'p'+i,text,location:'row '+i,sha256:'b'.repeat(64)})),warnings:[],coverage});
test('fabricated source anchors are manual, never automatic edits',()=>{
 const result=verifiedFileCheck('v1',snapshot(['2025 100']),snapshot(['2025 90']),{checked_span_ids:['p0'],findings:[{kind:'conflict',target_span_id:'p0',original:'90',replacement:'100',source_span_id:'p0',source_quote:'invented',reason:'amount'}],links:[]});
 assert.equal(result.status,'manual');assert.equal(result.findings[0].replacement,null);
});
test('incomplete coverage or missing evidence cannot report a clean file',()=>{
 for(const p of [{findings:[],links:[],checked_span_ids:[]},{findings:[],links:[],checked_span_ids:['p0']}]){
   const result=verifiedFileCheck('v',snapshot(['100']),snapshot(['100']),p);assert.equal(result.status,'manual');
   assert.ok(Value.Check(ProjectFileCheckResultSchema,{version:'project-file-check-v1',files:[result]}));
 }
});
test('links preserve row, period, unit and exact version, repeated text requires an unambiguous span',()=>{
 const source=snapshot(['2024 100亿元','2025 100万元']),target=snapshot(['2025 100万元']);
 const p={source_span_id:'p1',source_quote:'100万元',target_span_id:'p0',target_quote:'100万元',field:'资产',period:'2025',unit:'万元'};
 const links=verifiedFileLinks(source,target,[p,{...p,source_span_id:'p0'}]);assert.equal(links.length,1);assert.equal(links[0].source_location,'row 1');assert.equal(links[0].period,'2025');
 assert.equal(verifiedFileLinks(snapshot(['100 100']),target,[{...p,source_span_id:'p0',source_quote:'100'}]).length,0);
 const checked=verifiedFileCheck('v',source,target,{checked_span_ids:['p0'],findings:[],links:[p]});assert.equal(checked.status,'consistent');
});

test('overlapping replacements remain manual instead of an order-dependent bulk edit',()=>{
 const result=verifiedFileCheck('v',snapshot(['发行规模120万元']),snapshot(['发行规模100万元']),{checked_span_ids:['p0'],links:[],findings:
   ['发行规模100万元','100万元'].map(original=>({kind:'conflict',target_span_id:'p0',original,replacement:'120万元',source_span_id:'p0',source_quote:'120万元',reason:'发行规模变化'}))});
 assert.equal(result.status,'manual');assert.ok(result.findings.every(f=>f.kind==='manual'&&f.replacement===null));
});

