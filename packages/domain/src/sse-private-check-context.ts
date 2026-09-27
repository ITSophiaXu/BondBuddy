import type { CheckEvidence, SsePrivateFinding } from './sse-private-checks.js';
import * as arithmetic from './update-arithmetic.js';

/** Internal seam only. The caller verifies owner, material/version and review provenance. */
export interface CheckContext {
  add(code: string, outcome: SsePrivateFinding['outcome'], message: string, ...evidence: (CheckEvidence<unknown> | undefined)[]): void;
  read<T>(key: string, item: CheckEvidence<T> | undefined, valid: (value: unknown) => value is T): T | undefined;
  bool(key: string, item: CheckEvidence<boolean> | undefined): boolean | undefined;
  day(key: string, item: CheckEvidence<string> | undefined): string | undefined;
  expect(key: string, item: CheckEvidence<boolean> | undefined, expected: boolean, message: string): void;
}
export const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 12000;
export const decimal = (v: unknown): v is string => typeof v === 'string' && /^-?(?:0|[1-9]\d{0,19})(?:\.\d{1,12})?$/.test(v);
export const nonnegative = (v: unknown): v is string => decimal(v) && arithmetic.decimal(v).numerator >= 0n;
export const stringSet = (v: unknown): v is readonly string[] => Array.isArray(v) && v.length <= 1000
  && v.every(nonempty) && new Set(v).size === v.length;
export const enumOf = <T extends string>(values: readonly T[]) => (v: unknown): v is T => typeof v === 'string' && (values as readonly string[]).includes(v);
export const places = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 6;
export const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;

export interface TextComparison {
  key: CheckEvidence<string>;
  current: CheckEvidence<string>;
  /** One occurrence at a time; the adapter enumerates every chapter/document occurrence. */
  disclosed: CheckEvidence<string>;
}
export function compareText(ctx: CheckContext, prefix: string, pair: TextComparison | undefined): void {
  const key = ctx.read(`${prefix}_key`, pair?.key, nonempty);
  const current = ctx.read(`${prefix}_current`, pair?.current, nonempty);
  const disclosed = ctx.read(`${prefix}_disclosed`, pair?.disclosed, nonempty);
  if (key !== undefined && current !== undefined && disclosed !== undefined) ctx.add(`${prefix}_match`, current === disclosed ? 'pass' : 'issue',
    `${key}：逐处对照本期有依据的标准值；文字不同先报告差异，不自行认定语义相同。`, pair?.key, pair?.current, pair?.disclosed);
}
export function sameBasis(ctx: CheckContext, prefix: string, item: CheckEvidence<boolean> | undefined): boolean {
  if (ctx.bool(`${prefix}_basis`, item) === true) return true;
  ctx.add(`${prefix}_basis_unconfirmed`, 'needs_judgement', '主体、合并/母公司、币种单位、期间及重述口径未确认一致，不能混算。', item);
  return false;
}
