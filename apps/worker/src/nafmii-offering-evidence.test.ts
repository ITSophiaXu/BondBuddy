import assert from 'node:assert/strict';
import test from 'node:test';
import { nafmiiOfferingEvidence as classify } from './nafmii-offering-evidence.js';

test('#11 DFI unified documents remain DFI with one or multiple covered tools', () => {
  for (const tools of ['MTN', 'SCP', 'MTN、CP及SCP']) {
    assert.equal(classify(`本次DFI统一注册文件覆盖${tools}。`), 'dfi');
    assert.equal(classify(`本次储架发行统一注册，拟发行工具包括${tools}。`), 'dfi');
  }
  assert.equal(classify('本次注册覆盖SCP。'), null);
});
test('#11 a concrete tranche retains its tool under a DFI arrangement', () => {
  assert.equal(classify('本期发行工具为MTN中期票据，采用DFI储架发行安排。'), 'mtn');
  assert.equal(classify('本期债券为超短期融资券SCP，属于DFI统一注册额度内发行。'), 'scp');
  assert.equal(classify('本期发行工具为MTN或CP，尚未确定。'), null);
  assert.equal(classify('本期发行工具为CP或SCP。'), null);
  assert.equal(classify('根据《DFI储架发行通知》，本期发行工具为MTN。'), null);
  assert.equal(classify('本次不是DFI统一注册文件。'), null);
});
