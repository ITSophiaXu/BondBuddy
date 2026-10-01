import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyUpdateDetails } from '@bondbuddy/contracts';
import { quarterCutoff, cutoffSelection } from './reporting-cutoff.js';
import { updateFormFields } from './update-form.js';

test('quarter controls map the selected year to four exact quarter ends', () => {
  for (const year of ['2024','2025','2026']) for (const quarter of ['03-31','06-30','09-30','12-31']) {
    assert.equal(quarterCutoff(year,quarter),`${year}-${quarter}`);
    assert.equal(cutoffSelection(`${year}-${quarter}`,2026).quarter,quarter);
  }
  assert.equal(quarterCutoff('2026','06-31'),null);
  assert.equal(quarterCutoff('0000','03-31'),null);
  assert.equal(quarterCutoff('','03-31'),null);
});

test('unselected and legacy dates are not silently coerced or turned into reporting periods', () => {
  assert.equal(cutoffSelection(null,2026).quarter,'');
  const old=cutoffSelection('1997-04-20',2026);
  assert.equal(old.year,'1997');assert.equal(old.quarter,'');assert.equal(old.legacy,true);assert.ok(old.years.includes('1997'));
  assert.equal(cutoffSelection('2026-06-30',2026).legacy,false);
});

test('latest report period is the only period control in project basics', () => {
  const details={...emptyUpdateDetails(),reporting_cutoff:'2026-09-30'};
  const html=updateFormFields({name:'合成项目',kind:'update',issuer_name:null,market:null,offering:null,update_details:details});
  assert.match(html,/name="reporting_year"/);
  assert.match(html,/name="reporting_quarter" value="09-30" checked/);
  assert.doesNotMatch(html,/type="date"|target_years|target_interim|name="has_historical"/);
});
