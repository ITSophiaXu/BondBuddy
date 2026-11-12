import {test} from './local-prelaunch-helpers';
import {exerciseLegacyRecovery} from './local-prelaunch-legacy-billing-helpers';

test.skip(process.env.BB_E2E_LOCAL_PRELAUNCH!=='1'||process.env.BB_E2E_REAL_MODEL!=='1','Explicit local full stack and real model opt-in required.');
test.setTimeout(1800000);
test.use({viewport:{width:1440,height:1000}});

test('legacy policy 1 point pauses before model and current payment resumes same run with locked price',async({page,audit})=>{
  await exerciseLegacyRecovery(page,audit,'before_model');
});

test('legacy policy model-completed credit pause resumes original measured attempt and price without new model or double charge',async({page,audit})=>{
  await exerciseLegacyRecovery(page,audit,'after_model');
});
