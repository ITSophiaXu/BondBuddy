import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import {WORKPAPER_PROGRESS_LABELS,WorkpaperItemProgressSchema} from './workpaper-item-progress.js';

const ajv=new Ajv.default({strict:false,formats:{'date-time':{type:'string',validate:(value:string)=>Number.isFinite(Date.parse(value))}}});
const validate=ajv.compile(WorkpaperItemProgressSchema);
const progress={phase:'generating',started_at:'2026-11-13T13:20:00.000Z',updated_at:'2026-11-13T13:38:00.000Z',interrupted:false};

test('workpaper public progress accepts only safe known phases and bounded fields',()=>{
 for(const phase of Object.keys(WORKPAPER_PROGRESS_LABELS))assert.equal(validate({...progress,phase}),true,JSON.stringify(validate.errors));
 for(const change of [{phase:'private_checkpoint'},{started_at:'invalid'},{updated_at:null},{interrupted:'false'},{prompt:'private'},{checkpoint:{}}])
  assert.equal(validate({...progress,...change}),false);
 const {interrupted:_,...missing}=progress;assert.equal(validate(missing),false);
});
