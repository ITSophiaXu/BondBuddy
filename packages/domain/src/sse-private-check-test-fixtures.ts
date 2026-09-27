/** Synthetic engineering inputs, never approved issuer facts. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { RulePack } from './index.js';
import { evaluateSsePrivateDraftChecks, type CheckEvidence, type SsePrivateCheckInput } from './sse-private-checks.js';
export const pack = JSON.parse(readFileSync(new URL('../../../knowledge/exchange-bonds/drafts/sse-private/rule-pack.json',import.meta.url),'utf8')) as RulePack;
export const e = <T>(value:T): CheckEvidence<T> => ({value,status:'verified',anchors:['synthetic:v4:test:paragraph-1']});
export const input = (): SsePrivateCheckInput => JSON.parse(readFileSync(new URL('../examples/sse-private-check-input-v4.json',import.meta.url),'utf8'));
export const result = (data: SsePrivateCheckInput) => evaluateSsePrivateDraftChecks(pack,data);
export const check = (data:SsePrivateCheckInput,code:string) => {const row=result(data).findings.find(f=>f.code===code);assert.ok(row,code);return row;};
export const absent = (data:SsePrivateCheckInput,code:string) => assert.ok(!result(data).findings.some(f=>f.code===code),code);
