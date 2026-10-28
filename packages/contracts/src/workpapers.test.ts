import test from 'node:test';
import assert from 'node:assert/strict';
import {Value} from '@sinclair/typebox/value';
import Ajv from 'ajv';
import {WorkpaperStartSchema,WORKPAPER_PRICE,WORKPAPER_LIMITS} from './workpapers.js';

const validate=new Ajv.default({strict:false}).compile(WorkpaperStartSchema);
const fields={request_id:'request',catalogue_id:'catalogue',catalogue_sha256:'a'.repeat(64),item_ids:['one'],
 source_version_id:'source',source_selection_revision:1,requirements:'',price_version:WORKPAPER_PRICE.version,expected_points:WORKPAPER_PRICE.points};
const direct={...fields,start_mode:'direct'};
const legacy={...fields,assessment_id:'assessment',assessment_hash:'b'.repeat(64)};
const check=(input:unknown,expected:boolean)=>{assert.equal(Value.Check(WorkpaperStartSchema,input),expected);assert.equal(validate(input),expected,JSON.stringify(validate.errors));};

test('direct start and a retained legacy paid request validate identically in browser and API',()=>{
 check(direct,true);check(legacy,true);
});
test('start cannot omit its mode or mix an independent assessment into a direct request',()=>{
 for(const input of [fields,{...direct,assessment_id:'assessment'},{...direct,assessment_hash:'b'.repeat(64)},
  {...legacy,start_mode:'direct'},{...fields,assessment_id:'assessment'},{...fields,assessment_hash:'b'.repeat(64)},
  {...direct,start_mode:'assessed'},{...direct,extra:true}])check(input,false);
});
test('direct start retains pinned source, catalogue, request and price bounds',()=>{
 for(const change of [{source_version_id:''},{source_selection_revision:-1},{catalogue_sha256:'invalid'},{request_id:''},
  {expected_points:-1},{expected_points:0.5},{item_ids:[]},{item_ids:['one','one']},
  {item_ids:Array.from({length:WORKPAPER_LIMITS.items+1},(_,i)=>String(i))}])check({...direct,...change},false);
});
