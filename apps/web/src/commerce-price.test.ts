import test from 'node:test';
import assert from 'node:assert/strict';
import {commerceMetadata} from '@bondbuddy/contracts';
import {scopeStatus,scopeStatusLabel,displayPrice,includedPrice} from './commerce-price.js';

test('a zero pending scope is never presented as a free executable result',()=>{
  assert.equal(scopeStatus({quote_status:'pending_scope'}),'pending_scope');
  assert.equal(displayPrice({...commerceMetadata(0),quote_status:'pending_scope'}),'范围报价待确认');
  assert.equal(includedPrice({...commerceMetadata(0),quote_status:'pending_scope'}),false);
});
test('only an explicitly ready zero price confirms original-scope or purchased coverage',()=>{
  const included={...commerceMetadata(0),quote_status:'ready' as const};
  assert.equal(includedPrice(included),true);
  assert.equal(displayPrice(included),'原范围包含／已购覆盖');
  assert.equal(scopeStatusLabel(included),'原范围包含／已购覆盖');
  assert.equal(includedPrice(commerceMetadata(0)),false);
  assert.equal(includedPrice({...included,amount_fen:1000}),false);
  for(const status of ['unavailable','declined','expired'] as const){
    assert.equal(includedPrice({...included,quote_status:status}),false);
    assert.notEqual(displayPrice({...included,quote_status:status}),'原范围包含／已购覆盖');
  }
});
test('ready scope expiration is checked independently of its server status, including malformed expiry',()=>{
  const now=Date.parse('2026-10-28T04:00:00Z');
  assert.equal(scopeStatus({quote_status:'ready',scope_expires_at:'2026-10-28T04:00:00Z'},now),'expired');
  assert.equal(scopeStatus({quote_status:'ready',scope_expires_at:'invalid'},now),'expired');
  assert.equal(scopeStatus({quote_status:'ready',scope_expires_at:'2026-10-28T04:01:00Z'},now),'ready');
  assert.equal(scopeStatus({quote_status:'ready'},now),'ready');
});
test('closed scope states retain distinct labels and cannot be reclassified by expiration',()=>{
  for(const [status,label] of [['unavailable','暂无法承接'],['declined','已拒绝报价'],['expired','报价已过期']]){
    assert.equal(scopeStatus({quote_status:status,scope_expires_at:'2020-01-01T00:00:00Z'}),status);
    assert.equal(scopeStatusLabel({quote_status:status}),label);
  }
});
test('already admitted price receipts keep their amount after scope expiry and historical points keep their unit',()=>{
  const receipt={...commerceMetadata(12340),quote_status:'ready' as const,scope_expires_at:'2020-01-01T00:00:00Z'};
  assert.equal(scopeStatus(receipt),'expired');
  assert.equal(displayPrice(receipt),'¥123.40');
  const included={...receipt,amount_fen:0};
  assert.equal(scopeStatusLabel(included),'报价已过期');
  assert.equal(displayPrice(included),'原范围包含／已购覆盖');
  assert.equal(displayPrice(undefined,4500),'4,500 积分');
});
