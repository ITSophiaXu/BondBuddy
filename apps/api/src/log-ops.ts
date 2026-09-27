import { fileURLToPath, pathToFileURL } from 'node:url';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { Value } from '@sinclair/typebox/value';
import { Pool, type PoolClient } from 'pg';
import { ADMIN_LOG_FILTERS, ADMIN_LOG_PAGE_LIMIT, schemas, type OperatorRole } from '@bondbuddy/contracts';
import { azureBlobs, digest, missing, Problem, transaction, uid, type PrivateBlobs } from './data.js';
import { assertTestChannelReadable, testChannelEnabled } from './non-production-test.js';
import { emitInternal, internalEvent, saveSnapshotRef } from './observability.js';
import { raiseAlert, tripEvidenceGate } from './evidence-gate.js';

const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const safeCode = /^[a-z][a-z0-9_]{0,63}$/;
const iso = (value: Date | string | null | undefined) => value ? new Date(value).toISOString() : null;
const int = (value: unknown) => value === null || value === undefined ? null : Number(value);

// ---------------------------------------------------------------- scrubbing

export const SCRUB_VERSION = 'scrub_v1';
const MAX_DIAGNOSTIC_BYTES = 10 * 1024 * 1024;
const MAX_JSON_DEPTH = 1024;
const MAX_JSON_STRING_LAYERS = 4;
const sensitiveField = /^(?:setcookie|cookie|sessioncookie|authorization|proxyauthorization|apikey|xapikey|accesskey|clientsecret|secret|(?:access|refresh|bearer|id|session|auth)?token|(?:onetime)?password(?:confirmation)?|passwd|pwd|otp(?:code)?|captcha|verificationcode|验证码|校验码|动态码|短信码)$/iu;
const redacted = '[REDACTED]';
const isSensitiveField = (key: string) => sensitiveField.test(key.replace(/[_ -]/g, ''));
class DiagnosticScrubError extends Error {
  constructor() { super('Diagnostic body rejected'); this.name = 'DiagnosticScrubError'; }
}
class ScanLimitError extends DiagnosticScrubError {}
const scrubRules: Array<[RegExp, string]> = [
  [/\b(set-cookie|cookie)([ \t]*[:=][ \t]*)[^\r\n]*/gi, '$1$2[REDACTED]'],
  [/\b(authorization|proxy-authorization)([ \t]*[:=][ \t]*)[^\r\n]*/gi, '$1$2[REDACTED]'],
  [/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]'],
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, '[REDACTED_KEY]'],
  [/\b(set[_-]?cookie|session[_-]?cookie|x[_-]?api[_-]?key|one[_-]?time[_-]?password|(?:access|refresh|session|auth|bearer|id)[_-]?token)((?:[ \t]*["'][ \t]*|[ \t]*)[:=][ \t]*["']?)[^\s"',;}\]]+/gi, '$1$2[REDACTED]'],
  [/\b(api[_-]?key|access[_-]?key|secret|client[_-]?secret|token|password|passwd|pwd)((?:[ \t]*["'][ \t]*|[ \t]*)[:=][ \t]*["']?)[^\s"',;]+/gi, '$1$2[REDACTED]'],
  [/\b(otp(?:[_-]?code)?|captcha|verification[_ -]?code)((?:[ \t]*["'][ \t]*|[ \t]*)[:=][ \t]*["']?)[^\s"',;}\]]+/gi, '$1$2[REDACTED]'],
  [/(验证码|校验码|动态码|短信码|otp|captcha|verification code)((?:[ \t]*[:：=是为][ \t]*|[ \t]*))[A-Za-z0-9]{4,8}\b/gi, '$1$2[REDACTED]']
];
function applyProseRules(text: string, budget: ScanBudget): string {
  let value = text;
  for (const [pattern, replacement] of scrubRules) {
    spend(budget, value.length);
    value = value.replace(pattern, replacement);
  }
  return value;
}
type Edits = { starts: number[]; ends: number[]; values: string[]; resultLength: number };
const newEdits = (length: number): Edits => ({ starts: [], ends: [], values: [], resultLength: length });
const addEdit = (edits: Edits, start: number, end: number, value: string) => {
  edits.resultLength += value.length - (end - start);
  if (edits.resultLength > MAX_DIAGNOSTIC_BYTES) throw new DiagnosticScrubError();
  edits.starts.push(start); edits.ends.push(end); edits.values.push(value);
};
const space = (char: string) => char === ' ' || char === '\n' || char === '\r' || char === '\t';
type ScanBudget = { remaining: number };
function spend(budget: ScanBudget, units: number) {
  budget.remaining -= units;
  if (budget.remaining < 0) throw new ScanLimitError();
}

/** One syntax character, either literal or escaped by bounded JSON layers.
 * Leave invalid escapes as prose; callers reject only if they form a field. */
function syntaxAt(text: string, start: number, budget: ScanBudget): { char: string; end: number } | null {
  if (start >= text.length) return null;
  if (text[start] !== '\\') { spend(budget, 1); return { char: text[start], end: start + 1 }; }
  let end = start + 1;
  while (text[end] === '\\') end++;
  const count = end - start;
  if (text[end] === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(end + 1, end + 5))) {
    spend(budget, end + 5 - start);
    return { char: String.fromCharCode(parseInt(text.slice(end + 1, end + 5), 16)), end: end + 5 };
  }
  spend(budget, end + 1 - start);
  if (text[end] === '"' && (count === 1 || Number.isInteger(Math.log2(count + 1))))
    return { char: '"', end: end + 1 };
  return null;
}

function separatorAt(text: string, start: number, budget: ScanBudget): boolean {
  let pos = start;
  while (space(text[pos])) pos++;
  spend(budget, pos - start);
  let next = syntaxAt(text, pos, budget);
  if (next?.char === '"') {
    pos = next.end;
    const before = pos;
    while (space(text[pos])) pos++;
    spend(budget, pos - before);
    next = syntaxAt(text, pos, budget);
  }
  return next?.char === ':' || next?.char === '=';
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (++i >= value.length || value.charCodeAt(i) < 0xdc00 || value.charCodeAt(i) > 0xdfff) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/** Decode a complete quoted field followed by ':' outside a JSON candidate.
 * Invalid JSON escapes and lone surrogates are rejected before any Blob write. */
function quotedFieldAt(text: string, start: number, layer: number, budget: ScanBudget): string | null {
  if (text[start] === '\\' && text[start - 1] === '\\') return null;
  const opening = syntaxAt(text, start, budget);
  if (opening?.char === '"' && text[opening.end - 5] === 'u') {
    // Consume the complete token. A long run of spaces may still normalize
    // to a short known key; retain only the bounded normalized spelling.
    let at = opening.end, key = '', invalid = false, closed = false, tooLong = false, high = false;
    while (at < text.length) {
      const unit = syntaxAt(text, at, budget);
      if (unit?.char === '"') { at = unit.end; closed = true; break; }
      if (text[at] === '\\' && !unit) invalid = true;
      const char = unit?.char ?? text[at];
      const code = char.charCodeAt(0);
      if (high && (code < 0xdc00 || code > 0xdfff)) invalid = true;
      if (!high && code >= 0xdc00 && code <= 0xdfff) invalid = true;
      high = code >= 0xd800 && code <= 0xdbff;
      if (code < 0x20) invalid = true;
      if (char !== ' ' && char !== '_' && char !== '-') {
        if (key.length + char.length <= 64) key += char;
        else tooLong = true;
      }
      at = unit?.end ?? at + 1;
    }
    spend(budget, at - start);
    if (!closed || !separatorAt(text, at, budget)) return null;
    if (invalid || high) throw new DiagnosticScrubError();
    return tooLong ? '' : key;
  }
  let layers = 0;
  let openingEnd = start + 1;
  if (text[start] === '\\' && text[start - 1] !== '\\') {
    let quote = start + 1;
    while (text[quote] === '\\') quote++;
    const run = quote - start;
    if (text[quote] !== '"' || !Number.isInteger(Math.log2(run + 1))) return null;
    layers = Math.log2(run + 1);
    openingEnd = quote + 1;
  } else if (text[start] === '"') {
    let precedingSlashes = 0;
    while (text[start - precedingSlashes - 1] === '\\') precedingSlashes++;
    if (precedingSlashes % 2 === 1) return null;
  } else return null;
  // Only the first slash in a delimiter run starts a candidate. This and the
  // quote parity below keep repeated escaped quotes at linear work.
  let end = -1;
  const delimiter = 2 ** layers - 1;
  const period = 2 ** (layers + 1);
  for (let i = openingEnd; i < text.length; i++) {
    if (text[i] === '\\') {
      let next = i + 1;
      while (text[next] === '\\') next++;
      if (text[next] === '"') {
        if ((next - i) % period === delimiter) { end = next + 1; break; }
        i = next;
      } else if (text[next] === 'u' && text.slice(next + 1, next + 5).toLowerCase() === '0022') {
        end = next + 5;
        break;
      } else i = next - 1;
    } else if (!layers && text[i] === '"') { end = i + 1; break; }
  }
  spend(budget, (end < 0 ? text.length : end) - start);
  if (end < 0) return null;
  if (!separatorAt(text, end, budget)) return null;
  try {
    if (layer + layers > MAX_JSON_STRING_LAYERS) throw new ScanLimitError();
    let decoded = text.slice(start, end);
    for (let layer = 0; layer < layers; layer++) decoded = JSON.parse(`"${decoded}"`) as string;
    const key = JSON.parse(decoded) as string;
    if (hasUnpairedSurrogate(key)) throw new DiagnosticScrubError();
    return key;
  } catch (error) { if (error instanceof ScanLimitError) throw error;
    throw new DiagnosticScrubError(); }
}

/** Consume a loose key run once. Keep only the last 64 normalized characters
 * and word starts, so a sensitive suffix after ordinary prose is still seen
 * without rescanning an arbitrarily long run for each word. */
function bareFieldAt(text: string, start: number, budget: ScanBudget): { key: string; end: number; encoded: boolean } | null {
  if (!/[\p{L}_]/u.test(text[start] ?? '') && !(text[start] === '\\' && text[start + 1] === 'u')) return null;
  let end = start, encoded = false, invalid = false, afterSpace = false;
  let normalized = '';
  let starts = [0];
  while (end < text.length) {
    const at = end;
    let char = text[end];
    if (char === '\\') {
      const unit = syntaxAt(text, end, budget);
      if (unit === null) { invalid = true; end++; continue; }
      char = unit.char;
      end = unit.end;
      encoded = true;
      const code = char.charCodeAt(0);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = syntaxAt(text, end, budget);
        const low = next?.char.charCodeAt(0);
        if (low !== undefined && low >= 0xdc00 && low <= 0xdfff) {
          char = String.fromCodePoint(0x10000 + (code - 0xd800) * 0x400 + low - 0xdc00);
          end = next!.end;
        } else invalid = true;
      } else if (code >= 0xdc00 && code <= 0xdfff) invalid = true;
    } else { spend(budget, 1); end++; }
    if (char === ':' || char === '=') { end = at; break; }
    if (char === ' ' || char === '\t' || char === '_' || char === '-') {
      if (char === ' ' || char === '\t') afterSpace = true;
      continue;
    }
    if (!/[\p{L}\p{N}]/u.test(char)) {
      if (invalid) continue;
      if (char.length === 2 && end > at && normalized.length === 0)
        return { key: '', end, encoded };
      end = at; break;
    }
    if (afterSpace) { starts.push(normalized.length); afterSpace = false; }
    normalized += char;
    if (normalized.length > 64) {
      normalized = normalized.slice(-64);
      starts = starts.map(index => index - 1).filter(index => index >= 0);
    }
  }
  if (end === start) return null;
  if (!separatorAt(text, end, budget)) return { key: '', end, encoded };
  if (invalid) throw new DiagnosticScrubError();
  for (const index of starts) {
    const key = normalized.slice(index);
    if (isSensitiveField(key)) return { key, end, encoded };
  }
  return { key: '', end, encoded };
}

/** Find a candidate's boundary once. An unclosed prose bracket is ordinary text
 * unless a known field occurs inside it. This scan never retries inner brackets. */
function candidateEnd(text: string, start: number, encoded: boolean, budget: ScanBudget): number {
  const stack: string[] = [];
  let quoted = false, slash = false;
  for (let i = start; i < text.length; i++) {
    spend(budget, 1);
    const char = text[i];
    if (encoded && char === '\\') {
      let next = i + 1;
      while (text[next] === '\\') next++;
      spend(budget, next - i - 1);
      if (text[next] === '"') {
        if ((next - i) % 4 === 1) quoted = !quoted;
        i = next;
        continue;
      }
      i = next - 1;
      continue;
    }
    if (quoted) {
      if (slash) slash = false;
      else if (char === '\\') slash = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{' || char === '[') {
      stack.push(char);
      if (stack.length > MAX_JSON_DEPTH) throw new DiagnosticScrubError();
    } else if (char === '}' || char === ']') {
      // A mismatched closer is malformed content inside this candidate. Ending
      // here would let later fields escape the known-key rejection scan.
      if (stack[stack.length - 1] !== (char === '}' ? '{' : '[')) continue;
      stack.pop();
      if (!stack.length) return i + 1;
    }
  }
  return text.length;
}

function plainBracketEnd(text: string, start: number, budget: ScanBudget): { end: number; closed: boolean } {
  const stack: string[] = [];
  for (let i = start; i < text.length; i++) {
    spend(budget, 1);
    const char = text[i];
    if (char === '\r' || char === '\n') return { end: i, closed: false };
    if (char === '{' || char === '[') {
      stack.push(char);
      if (stack.length > MAX_JSON_DEPTH) throw new DiagnosticScrubError();
    } else if (char === '}' || char === ']') {
      if (stack[stack.length - 1] !== (char === '}' ? '{' : '[')) continue;
      stack.pop();
      if (!stack.length) return { end: i + 1, closed: true };
    }
  }
  return { end: text.length, closed: false };
}

/** Inspect the entire bounded fragment, including fields after ordinary first fields. */
function hasKnownSensitiveKey(fragment: string, budget: ScanBudget): boolean {
  spend(budget, fragment.length);
  const words = /[\p{L}_][\p{L}\p{N}_-]*/gu;
  for (const match of fragment.matchAll(words)) {
    if (match[0].length > 64 || !isSensitiveField(match[0])) continue;
    let before = match.index - 1;
    while (before >= 0 && /\s/.test(fragment[before])) before--;
    let after = match.index + match[0].length;
    while (fragment[after] === '\\') after++;
    if (fragment[after] === '"') after++;
    while (after < fragment.length && /\s/.test(fragment[after])) after++;
    // A known key at a field boundary is suspicious even when its colon is missing.
    if (fragment[after] === ':' || fragment[before] === '{' || fragment[before] === ',' ||
        fragment[before] === '"' && fragment[after] === ':') return true;
  }
  return false;
}

/** Inspect the final decoded string layer without descending again. This sees
 * field syntax even when there is no surrounding object or array delimiter. */
function hasEmbeddedSensitiveField(text: string, layer: number, budget: ScanBudget): boolean {
  spend(budget, text.length);
  for (let i = 0; i < text.length;) {
    if (layer > MAX_JSON_STRING_LAYERS && text[i] === '\\' &&
        ['"', '{', '['].includes(syntaxAt(text, i, budget)?.char ?? '')) return true;
    if (text[i] === '"' || text[i] === '\\') {
      const key = quotedFieldAt(text, i, layer, budget);
      if (key !== null && (isSensitiveField(key) || layer > MAX_JSON_STRING_LAYERS)) return true;
      if (text[i] === '"') {
        // Inspect each complete quoted value once. A malformed enclosing
        // bracket must not hide an encoded field in a later ordinary value.
        let end = i + 1;
        while (end < text.length) {
          if (text[end] === '\\') { end += 2; continue; }
          if (text[end++] === '"') break;
        }
        if (text[end - 1] === '"') {
          try {
            const decoded = JSON.parse(text.slice(i, end)) as string;
            // A complete quoted token consumes one more encoding layer. At
            // the boundary, classify its decoded contents with this same
            // lexer; beyond it, a further quoted token is ambiguous and is
            // rejected before storage. This keeps the cursor monotone and
            // prevents the last layer from falling back to literal words.
            if (layer > MAX_JSON_STRING_LAYERS) return true;
            if (layer < MAX_JSON_STRING_LAYERS) {
              if (scrubText(decoded, layer + 1, budget) !== decoded) return true;
            } else if (hasEmbeddedSensitiveField(decoded, layer + 1, budget)) return true;
            i = end;
            continue;
          } catch (error) {
            if (error instanceof DiagnosticScrubError) throw error;
          }
        }
      }
    }
    const bare = bareFieldAt(text, i, budget);
    if (bare !== null) {
      let end = bare.end;
      if (isSensitiveField(bare.key)) {
        if (separatorAt(text, end, budget)) return true;
      }
      i = bare.end;
    } else i++;
  }
  return false;
}

/** Consume one complete JSON string token in prose. Invalid quotes remain
 * prose unless the surrounding field classifier finds sensitive evidence. */
function quotedValueAt(text: string, start: number, budget: ScanBudget): { end: number; value: string } | null {
  if (text[start] !== '"') return null;
  let precedingSlashes = 0;
  while (text[start - precedingSlashes - 1] === '\\') precedingSlashes++;
  if (precedingSlashes % 2) return null;
  let end = start + 1;
  for (; end < text.length; end++) {
    if (text[end] === '\\') { end++; continue; }
    if (text[end] === '"') break;
  }
  spend(budget, Math.min(end + 1, text.length) - start);
  if (end >= text.length) return null;
  try { return { end: end + 1, value: JSON.parse(text.slice(start, end + 1)) as string }; }
  catch { return null; }
}

/** A quoted value ends at its matching quote. Only a single unquoted scalar
 * ending at CR/LF or EOF has a provable boundary; mixed prose is rejected. */
function plainFieldValue(text: string, separator: number, budget: ScanBudget): { begin: number; end: number } {
  let at = separator;
  while (text[at] === ' ' || text[at] === '\t') { at++; spend(budget, 1); }
  let unit = syntaxAt(text, at, budget);
  if (unit?.char === '"') {
    at = unit.end;
    while (text[at] === ' ' || text[at] === '\t') { at++; spend(budget, 1); }
    unit = syntaxAt(text, at, budget);
  }
  if (unit?.char !== ':' && unit?.char !== '=') throw new DiagnosticScrubError();
  at = unit.end;
  while (text[at] === ' ' || text[at] === '\t') { at++; spend(budget, 1); }
  if (!text[at] || text[at] === '\r' || text[at] === '\n') throw new DiagnosticScrubError();
  const begin = at;
  if (text[at] === '"' || text[at] === "'") {
    const quote = text[at++];
    let closed = false;
    for (; at < text.length; at++) {
      spend(budget, 1);
      if (text[at] === '\\') {
        if (at + 1 >= text.length) throw new DiagnosticScrubError();
        at++; spend(budget, 1); continue;
      }
      if (text[at] === quote) { at++; closed = true; break; }
    }
    if (!closed) throw new DiagnosticScrubError();
    // Punctuation only separates a quoted value from ordinary prose when the
    // next token starts after whitespace (or at EOF). A glued bare suffix may
    // still be part of the secret. Check literal and encoded punctuation alike.
    let afterQuote = at;
    while (space(text[afterQuote])) { afterQuote++; spend(budget, 1); }
    const punctuation = syntaxAt(text, afterQuote, budget);
    if (punctuation && ',;，；'.includes(punctuation.char)) {
      if (punctuation.end < text.length && !space(text[punctuation.end])) throw new DiagnosticScrubError();
    } else if (at < text.length && !space(text[at])) throw new DiagnosticScrubError();
  } else {
    while (at < text.length && text[at] !== '\r' && text[at] !== '\n') {
      spend(budget, 1);
      // A second word or punctuation may be ordinary business content, or
      // may belong to the secret. Neither interpretation is safe to store.
      if (!/[A-Za-z0-9_~+\/=-]/.test(text[at])) throw new DiagnosticScrubError();
      at++;
    }
  }
  if (at === begin) throw new DiagnosticScrubError();
  return { begin, end: at };
}

function applyEdits(text: string, edits: Edits): string {
  if (!edits.starts.length) return text;
  const chunks: string[] = [];
  let previous = 0, current = '';
  for (let index = 0; index < edits.starts.length; index++) {
    current += text.slice(previous, edits.starts[index]) + edits.values[index];
    if (current.length >= 64 * 1024) { chunks.push(current); current = ''; }
    previous = edits.ends[index];
  }
  chunks.push(current, text.slice(previous));
  return chunks.join('');
}

/** Run legacy prose patterns only over untouched source ranges. Replacement
 * markers are already safe and must never be parsed as a second field value. */
function applyProseOutsideEdits(text: string, edits: Edits, budget: ScanBudget): string {
  if (!edits.starts.length) return applyProseRules(text, budget);
  const chunks: string[] = [];
  let previous = 0, length = 0;
  for (let index = 0; index < edits.starts.length; index++) {
    const prose = applyProseRules(text.slice(previous, edits.starts[index]), budget);
    const value = edits.values[index];
    length += prose.length + value.length;
    if (length > MAX_DIAGNOSTIC_BYTES) throw new DiagnosticScrubError();
    chunks.push(prose, value);
    previous = edits.ends[index];
  }
  const tail = applyProseRules(text.slice(previous), budget);
  length += tail.length;
  if (length > MAX_DIAGNOSTIC_BYTES) throw new DiagnosticScrubError();
  chunks.push(tail);
  return chunks.join('');
}

/** Validate JSON without constructing an object tree; retain only the nesting
 * stack and source intervals that actually require replacement. */
function parseCandidate(text: string, layer: number, markSensitive: () => void, budget: ScanBudget): string {
  spend(budget, text.length);
  type Frame = { kind: '{' | '['; state: number; sensitive: boolean; suppressed: boolean; valueStart: number };
  const stack: Frame[] = [];
  const edits = newEdits(text.length);
  let i = 0;
  const whitespace = () => { while (space(text[i])) i++; };
  const stringEnd = () => {
    const start = i++;
    for (; i < text.length; i++) {
      const char = text[i];
      if (char === '\\') { i++; continue; }
      if (char === '"') { i++; return start; }
      if (char < ' ') throw new DiagnosticScrubError();
    }
    throw new DiagnosticScrubError();
  };
  const valueDone = () => {
    if (!stack.length) return;
    const frame = stack[stack.length - 1];
    if (frame.kind === '{' && frame.sensitive && !frame.suppressed) {
      addEdit(edits, frame.valueStart, i, JSON.stringify(redacted));
      frame.sensitive = false;
    }
    frame.state = frame.kind === '{' ? 3 : 1;
  };
  const value = () => {
    whitespace();
    const start = i;
    const char = text[i];
    if (char === '{' || char === '[') {
      const parent = stack[stack.length - 1];
      stack.push({ kind: char, state: 0, sensitive: false,
        suppressed: !!parent && (parent.suppressed || parent.kind === '{' && parent.sensitive), valueStart: 0 });
      if (stack.length > MAX_JSON_DEPTH) throw new DiagnosticScrubError();
      i++;
    } else if (char === '"') {
      stringEnd();
      const raw = text.slice(start, i);
      let decoded: string;
      try { decoded = JSON.parse(raw) as string; } catch { throw new DiagnosticScrubError(); }
      const frame = stack[stack.length - 1];
      const inspectString = !frame?.suppressed && !(frame?.kind === '{' && frame.sensitive);
      if (inspectString && layer >= MAX_JSON_STRING_LAYERS) {
        // Every decoded value reaches the same field classifier at this last
        // layer. A field hidden behind another encoding fails closed.
        const trimmed = decoded.trimStart();
        let moreScalar = false;
        if (trimmed[0] === '"' && trimmed.endsWith('"')) {
          spend(budget, trimmed.length);
          try { moreScalar = typeof JSON.parse(trimmed) === 'string'; } catch { /* ordinary quoted prose */ }
        }
        const moreJson = moreScalar || /^\{\s*"/.test(trimmed) ||
          /^\[\s*[\[{"0-9tfn-]/.test(trimmed);
        if (moreJson || hasEmbeddedSensitiveField(decoded, layer, budget)) {
          markSensitive();
          throw new DiagnosticScrubError();
        }
      } else if (inspectString) {
        let cleaned: string;
        try { cleaned = scrubText(decoded, layer + 1, budget); }
        catch { markSensitive(); throw new DiagnosticScrubError(); }
        if (cleaned !== decoded) addEdit(edits, start, i, JSON.stringify(cleaned));
      }
      valueDone();
    } else {
      const match = /(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/y;
      match.lastIndex = i;
      const token = match.exec(text);
      if (!token) throw new DiagnosticScrubError();
      i = match.lastIndex;
      valueDone();
    }
  };
  value();
  while (stack.length) {
    whitespace();
    const frame = stack[stack.length - 1];
    if (frame.kind === '{') {
      if (frame.state === 0 || frame.state === 4) {
        if (text[i] === '}' && frame.state === 0) { i++; stack.pop(); valueDone(); continue; }
        if (text[i] !== '"') throw new DiagnosticScrubError();
        const start = stringEnd();
        let key = '';
        try { key = JSON.parse(text.slice(start, i)) as string; } catch { throw new DiagnosticScrubError(); }
        if (hasUnpairedSurrogate(key)) throw new DiagnosticScrubError();
        frame.sensitive = !frame.suppressed && isSensitiveField(key);
        if (frame.sensitive) markSensitive();
        frame.state = 1;
      } else if (frame.state === 1) {
        if (text[i++] !== ':') throw new DiagnosticScrubError();
        frame.state = 2;
      } else if (frame.state === 2) {
        whitespace(); frame.valueStart = i; value();
      } else {
        if (text[i] === ',') { i++; frame.state = 4; }
        else if (text[i] === '}') { i++; stack.pop(); valueDone(); }
        else throw new DiagnosticScrubError();
      }
    } else if (frame.state === 0 || frame.state === 2) {
      if (text[i] === ']' && frame.state === 0) { i++; stack.pop(); valueDone(); }
      else value();
    } else {
      if (text[i] === ',') { i++; frame.state = 2; }
      else if (text[i] === ']') { i++; stack.pop(); valueDone(); }
      else throw new DiagnosticScrubError();
    }
  }
  whitespace();
  if (i !== text.length) throw new DiagnosticScrubError();
  return applyEdits(text, edits);
}

function scrubText(text: string, layer: number, budget: ScanBudget): string {
  if (layer > MAX_JSON_STRING_LAYERS) throw new ScanLimitError();
  spend(budget, text.length);
  // A non-sensitive JSON string value may itself be a complete encoded JSON
  // string. Consume that entire scalar before looking for loose fields; each
  // decode advances one bounded layer, including bare key/value fragments.
  if (text[0] === '"' && text[text.length - 1] === '"') {
    try { return parseCandidate(text, layer, () => undefined, budget); }
    catch (error) { if (error instanceof ScanLimitError || error instanceof DiagnosticScrubError && layer > 0) throw error; }
  }
  const edits = newEdits(text.length);
  let openPlain = false;
  for (let start = 0; start < text.length;) {
    if (text[start] !== '{' && text[start] !== '[') {
      // An arbitrary closer cannot prove an earlier prose bracket was closed.
      // Keep scanning known fields conservatively until the input ends.
      if (text[start] === '\\' && text[start + 1] === 'u' && openPlain) throw new DiagnosticScrubError();
      const quotedKey = quotedFieldAt(text, start, layer, budget);
      if (quotedKey !== null && isSensitiveField(quotedKey)) throw new DiagnosticScrubError();
      const quotedValue = quotedValueAt(text, start, budget);
      if (quotedValue !== null && quotedKey !== null) {
        start = quotedValue.end;
        continue;
      }
      if (quotedValue !== null && quotedKey === null) {
        if (layer >= MAX_JSON_STRING_LAYERS) {
          if (hasEmbeddedSensitiveField(quotedValue.value, layer + 1, budget)) throw new DiagnosticScrubError();
        } else {
          const cleaned = scrubText(quotedValue.value, layer + 1, budget);
          if (cleaned !== quotedValue.value) addEdit(edits, start, quotedValue.end, JSON.stringify(cleaned));
        }
        start = quotedValue.end;
        continue;
      }
      const bare = bareFieldAt(text, start, budget);
      if (bare !== null) {
        let end = bare.end;
        if (isSensitiveField(bare.key)) {
          const hasSeparator = separatorAt(text, end, budget);
          // Quoted fields outside a complete JSON candidate are still structured
          // evidence. Never leave their values to the plain-text regexes.
          if (hasSeparator) {
            let before = start - 1;
            while (before >= 0 && space(text[before])) before--;
            if (layer > 0 || bare.encoded || text[end] === '\\' || syntaxAt(text, end, budget)?.char === ':' &&
                (openPlain || text[start - 1] === '"' || /[{}\[\],]/.test(text[before] ?? ''))) throw new DiagnosticScrubError();
            const field = plainFieldValue(text, end, budget);
            addEdit(edits, start, field.end, text.slice(start, field.begin) + redacted);
            start = field.end;
            continue;
          }
        }
        start = bare.end;
      } else start++;
      continue;
    }
    let probe = start + 1;
    while (space(text[probe])) probe++;
    const encoded = text[probe] === '\\' && text[probe + 1] === '"';
    const jsonEvidence = encoded || text[start] === '{' && text[probe] === '"' ||
      text[start] === '[' && /[\[{"0-9tfn-]/.test(text[probe] ?? '');
    if (!jsonEvidence) {
      const plain = plainBracketEnd(text, start, budget);
      const ordinary = text.slice(start, plain.end);
      if (hasKnownSensitiveKey(ordinary, budget) || hasEmbeddedSensitiveField(ordinary, layer, budget)) throw new DiagnosticScrubError();
      openPlain ||= !plain.closed;
      start = plain.end;
      continue;
    }
    const end = candidateEnd(text, start, encoded, budget);
    const raw = text.slice(start, end);
    const suspicious = hasKnownSensitiveKey(raw, budget);
    if (jsonEvidence) {
      let mustReject = false;
      try {
        const decoded = encoded ? JSON.parse(`"${raw}"`) as string : raw;
        const cleaned = parseCandidate(decoded, layer, () => { mustReject = true; }, budget);
        if (cleaned !== decoded) {
          mustReject = true;
          addEdit(edits, start, end, encoded ? JSON.stringify(cleaned).slice(1, -1) : cleaned);
        }
      } catch (error) { if (error instanceof ScanLimitError) throw error;
        if (suspicious || mustReject || raw.includes('\\u') || hasEmbeddedSensitiveField(raw, layer, budget))
          throw new DiagnosticScrubError(); }
    }
    start = end;
  }
  return applyProseOutsideEdits(text, edits, budget);
}

/** Bounded scrub: rejects malformed/oversized JSON before any diagnostic Blob write. */
export function scrubSecrets(text: string) {
  if (Buffer.byteLength(text, 'utf8') > MAX_DIAGNOSTIC_BYTES) throw new DiagnosticScrubError();
  const budget: ScanBudget = { remaining: text.length * 64 + 65_536 };
  const cleaned = scrubText(text, 0, budget);
  if (Buffer.byteLength(cleaned, 'utf8') > MAX_DIAGNOSTIC_BYTES) throw new DiagnosticScrubError();
  return cleaned;
}

/** Scrub, store the body in private Blob only, then register the reference row. */
export async function savePromptSnapshot(pool: Pool, blobs: PrivateBlobs, input: { owner: string; projectId: string; runId?: string; kind: 'user_prompt' | 'model_request' | 'structured_input'; version: number; body: string; inputRevision?: number; inputHash?: string; templateVersion?: string; rulePackVersion?: string; modelParametersVersion?: string; redactionVersion?: string }) {
  const scrubbed = scrubSecrets(input.body);
  const objectKey = `users/${input.owner}/projects/${input.projectId}/snapshots/${uid()}`;
  const intentId = uid();
  // This commit is the recovery address. No Blob write is allowed before it exists.
  await pool.query('INSERT INTO bb_prompt_blob_intents(id,owner_user_id,project_id,object_key) VALUES($1,$2,$3,$4)', [intentId, input.owner, input.projectId, objectKey]);
  try {
    return await transaction(pool, async client => {
      // Keep the intent locked across Blob IO and reference commit. The sweeper
      // cannot delete an in-flight write even when it passes its grace period.
      await client.query('SELECT id FROM bb_prompt_blob_intents WHERE id=$1 FOR UPDATE', [intentId]);
      await blobs.put(objectKey, Buffer.from(scrubbed, 'utf8'), 'text/plain; charset=utf-8');
      const id = await saveSnapshotRef(pool, { ...input, objectKey, sha256: digest(scrubbed), redactionVersion: input.redactionVersion ?? SCRUB_VERSION, blobs }, client);
      await client.query('UPDATE bb_prompt_blob_intents SET registered_at=now() WHERE id=$1', [intentId]);
      return id;
    });
  } catch (error) {
    // A failed compensation still leaves the committed intent for the next
    // retention run. A COMMIT whose acknowledgement was lost might have saved
    // a valid reference, so never delete without checking under the same lock.
    try {
      await transaction(pool, async client => {
        const intent = (await client.query('SELECT * FROM bb_prompt_blob_intents WHERE id=$1 FOR UPDATE', [intentId])).rows[0];
        if (!intent || intent.registered_at || intent.cleared_at) return;
        const ref = await client.query('SELECT 1 FROM bb_snapshot_refs WHERE object_key=$1', [objectKey]);
        if (ref.rowCount) {
          await client.query('UPDATE bb_prompt_blob_intents SET registered_at=now() WHERE id=$1', [intentId]);
          return;
        }
        await blobs.delete(objectKey);
        await client.query('UPDATE bb_prompt_blob_intents SET cleared_at=now() WHERE id=$1', [intentId]);
      });
    } catch {
      await pool.query('UPDATE bb_prompt_blob_intents SET cleanup_after=now() WHERE id=$1 AND registered_at IS NULL AND cleared_at IS NULL', [intentId]).catch(() => undefined);
    }
    throw error;
  }
}

// ---------------------------------------------------------------- forwarding

export type LogRecord = { delivery_key: string; outbox_id: string; event: Record<string, unknown> };
/** A sink must treat delivery_key as an idempotency key: the same key may arrive again after a crash. */
export interface LogSink { name: string; archiveEnabled?: boolean; deliver(records: LogRecord[]): Promise<void> }

export function ndjsonSizeCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BB_LOG_SINK_MAX_BYTES;
  const value = raw === undefined || raw === '' ? 64 * 1024 * 1024 : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1024 || value > 1024 ** 3) throw new Error('Invalid BB_LOG_SINK_MAX_BYTES');
  return value;
}

/** Run every file write under the same OS lock across processes. */
async function lockedNdjsonWrite(path: string, records: LogRecord[], maxBytes?: number, archive?: { sink: string; localBudget: number }): Promise<void> {
  const lock = await open(`${path}.lock`, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await lock.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('Unsafe NDJSON lock permissions');
    const child = spawn('flock', ['-x', '-F', '/proc/self/fd/3', process.execPath, fileURLToPath(new URL('./ndjson-file-sink.js', import.meta.url)), path],
      { stdio: ['pipe', 'ignore', 'pipe', lock.fd] });
    let errorText = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', chunk => { errorText = (errorText + chunk).slice(0, 4096); });
    const exited = new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => resolve(code ?? 1));
    });
    child.stdin!.on('error', () => undefined); // child failure is reported by its exit code
    child.stdin!.end(JSON.stringify({ records, maxBytes, archive }));
    if (await exited !== 0) throw new Error(`NDJSON sink refused delivery: ${errorText || 'writer failed'}`);
  } finally { await lock.close(); }
}

/** Active NDJSON and any legacy .1 segment are the key journal; new bytes obey the size cap. */
export function ndjsonFileSink(path: string, name = 'ndjson_file', maxBytes?: number,
  archive?: { localBudget: number }): LogSink {
  return { name, archiveEnabled: !!archive, async deliver(records) {
    if (!records.length && !archive) return;
    await lockedNdjsonWrite(path, records, maxBytes, archive && { sink: name, localBudget: archive.localBudget });
  } };
}

export function logArchiveOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): { localBudget: number } | undefined {
  if (env.BB_LOG_ARCHIVE_ENABLED !== '1') {
    if (env.BB_LOG_ARCHIVE_ENABLED && env.BB_LOG_ARCHIVE_ENABLED !== '0') throw new Error('Invalid BB_LOG_ARCHIVE_ENABLED');
    return undefined;
  }
  const localBudget = Number(env.BB_LOG_ARCHIVE_LOCAL_MAX_BYTES ?? 256 * 1024 * 1024);
  if (!Number.isSafeInteger(localBudget) || localBudget < ndjsonSizeCapFromEnv(env) * 2 || localBudget > 4 * 1024 ** 3 ||
    !env.DATABASE_URL || !env.AZURE_STORAGE_CONNECTION_STRING) throw new Error('Invalid log archive configuration');
  return { localBudget };
}

export type ForwardOptions = { batchSize?: number; leaseSeconds?: number; retrySeconds?: number; afterSinkAccept?: () => Promise<void> };
export async function forwardLogs(pool: Pool, sink: LogSink, options: ForwardOptions = {}) {
  const batch = options.batchSize ?? 100, lease = options.leaseSeconds ?? 60, retry = options.retrySeconds ?? 30;
  if (!safeCode.test(sink.name) || !Number.isInteger(batch) || batch < 1 || batch > 1000) throw new Error('Invalid forwarder configuration');
  const token = uid();
  const claimed = await transaction(pool, async client => (await client.query(`UPDATE bb_outbox o SET lease_token=$1,lease_until=now()+($2::integer*interval '1 second'),delivery_attempts=delivery_attempts+1
      WHERE o.id IN (SELECT id FROM bb_outbox WHERE aggregate_type='observability' AND delivered_at IS NULL
        AND (lease_until IS NULL OR lease_until<now()) AND (next_attempt_at IS NULL OR next_attempt_at<=now())
        ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $3)
      RETURNING o.id,o.aggregate_id,o.owner_user_id,o.event_type,o.payload,o.delivery_attempts,o.created_at`, [token, lease, batch])).rows);
  if (!claimed.length) return { claimed: 0, delivered: 0, failed: 0 };
  claimed.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at) || String(a.id).localeCompare(String(b.id)));
  let events: Map<string, { event: Record<string, unknown>; owner_user_id: string; kind: string }>;
  try {
    events = new Map((await pool.query('SELECT id,owner_user_id,kind,event FROM bb_observability_events WHERE id=ANY($1)', [claimed.map(r => r.aggregate_id)])).rows.map(r => [r.id, r]));
  } catch (error) {
    await tripEvidenceGate(pool, 'log_event_lookup_failed');
    throw error;
  }
  if (claimed.some(r => {
    const source = events.get(r.aggregate_id);
    return !source || source.owner_user_id !== r.owner_user_id || source.kind !== r.event_type ||
      !isDeepStrictEqual(r.payload, { event_id: r.aggregate_id, schema_version: 1 }) ||
      !Value.Check(schemas.InternalObservabilityEvent, source.event) ||
      source.event.event_id !== r.aggregate_id ||
      source.event?.user_id !== r.owner_user_id || source.event?.kind !== r.event_type;
  })) {
    // The source and the complete outbox envelope must match the immutable v1 write contract.
    await tripEvidenceGate(pool, 'log_event_missing');
    await pool.query("UPDATE bb_outbox SET lease_token=NULL,lease_until=NULL,last_delivery_error='evidence_missing',next_attempt_at=now()+($3::integer*interval '1 second') WHERE id=ANY($1) AND lease_token=$2", [claimed.map(r => r.id), token, retry]);
    return { claimed: claimed.length, delivered: 0, failed: claimed.length };
  }
  const records: LogRecord[] = claimed.map(r => ({ delivery_key: digest(`${sink.name}:${r.id}`), outbox_id: r.id, event: events.get(r.aggregate_id)!.event }));
  try {
    await sink.deliver(records);
  } catch {
    // Outage: release the lease with backoff; nothing is marked delivered, so the backlog replays.
    await pool.query("UPDATE bb_outbox SET lease_token=NULL,lease_until=NULL,last_delivery_error='sink_unavailable',next_attempt_at=now()+($3::integer*interval '1 second') WHERE id=ANY($1) AND lease_token=$2", [claimed.map(r => r.id), token, retry]);
    await raiseAlert(pool, { kind: 'log_sink_unavailable', severity: 'critical', scope: sink.name, detail: { sink: sink.name, batch: claimed.length } });
    if (sink.archiveEnabled) await tripEvidenceGate(pool, 'log_archive_unavailable');
    return { claimed: claimed.length, delivered: 0, failed: claimed.length };
  }
  await options.afterSinkAccept?.();
  const byId = new Map(claimed.map(r => [r.id, r]));
  try {
    await transaction(pool, async client => {
      for (const record of records) {
        await client.query('INSERT INTO bb_log_deliveries(outbox_id,sink,delivery_key,attempts) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [record.outbox_id, sink.name, record.delivery_key, byId.get(record.outbox_id).delivery_attempts]);
        const receipt = (await client.query(`SELECT d.outbox_id,d.sink,d.delivery_key,o.aggregate_id,e.event
          FROM bb_log_deliveries d JOIN bb_outbox o ON o.id=d.outbox_id
          JOIN bb_observability_events e ON e.id=o.aggregate_id
          WHERE d.delivery_key=$1 OR (d.outbox_id=$2 AND d.sink=$3)`, [record.delivery_key, record.outbox_id, sink.name])).rows;
        if (receipt.length !== 1 || receipt[0].outbox_id !== record.outbox_id || receipt[0].sink !== sink.name ||
          receipt[0].delivery_key !== record.delivery_key || receipt[0].aggregate_id !== byId.get(record.outbox_id).aggregate_id ||
          !isDeepStrictEqual(receipt[0].event, record.event)) throw new Error('Inconsistent log delivery receipt');
      }
      await client.query('UPDATE bb_outbox SET delivered_at=now(),lease_token=NULL,lease_until=NULL,last_delivery_error=NULL,next_attempt_at=NULL WHERE id=ANY($1) AND lease_token=$2 AND delivered_at IS NULL', [claimed.map(r => r.id), token]);
    });
  } catch (error) {
    await tripEvidenceGate(pool, 'log_receipt_not_persisted');
    throw error;
  }
  return { claimed: claimed.length, delivered: records.length, failed: 0 };
}

/** Periodic health check: stale backlog and unresolved usage conflicts raise alerts. */
export async function checkLogHealth(pool: Pool, thresholds: { maxBacklogAgeSeconds: number } = { maxBacklogAgeSeconds: 300 }) {
  const backlog = (await pool.query("SELECT count(*)::int n, COALESCE(EXTRACT(EPOCH FROM now()-min(created_at)),0)::int age FROM bb_outbox WHERE aggregate_type='observability' AND delivered_at IS NULL")).rows[0];
  const conflicts = (await pool.query("SELECT count(*)::int n FROM bb_call_usage_effective WHERE usage_status='conflict'")).rows[0].n as number;
  const alerts: string[] = [];
  if (backlog.n > 0 && backlog.age > thresholds.maxBacklogAgeSeconds) alerts.push(await raiseAlert(pool, { kind: 'log_backlog_stale', severity: 'critical', scope: 'observability', detail: { backlog: backlog.n, oldest_age_seconds: backlog.age } }));
  if (conflicts > 0) alerts.push(await raiseAlert(pool, { kind: 'usage_conflict', severity: 'warning', scope: 'usage', detail: { attempts: conflicts } }));
  return { backlog: backlog.n as number, oldest_age_seconds: backlog.age as number, usage_conflicts: conflicts, alerts };
}

// ---------------------------------------------------------------- retention

class BlobPurgeError extends Error {}
export type LogRetentionPolicy = { contentRetentionDays: number; policyVersion?: string; batchSize?: number; now?: () => Date;
  /** #6: content of a user-deleted project is purged this many days after deletion (the storage purge window). */ deletedProjectPurgeDays?: number;
  /** Test/restore-verifier scope only. The CLI never sets it. */ ownerScope?: string[] };
export function retentionPolicyFromEnv(env = process.env): LogRetentionPolicy {
  const days = Number(env.BB_LOG_CONTENT_RETENTION_DAYS ?? '180');
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('BB_LOG_CONTENT_RETENTION_DAYS must be an integer from 1 to 3650');
  return { contentRetentionDays: days, policyVersion: env.BB_LOG_RETENTION_POLICY_VERSION ?? 'log_retention_v1' };
}
/**
 * Deletes prompt snapshot and provider-result bytes that are past retention (for terminal or
 * run-less content) or belong to a closed account. Metadata rows, hashes, attempts and usage stay;
 * a tombstone records the purge. Blob delete is idempotent, so a crash before the tombstone replays.
 */
export async function purgeLogContent(pool: Pool, blobs: PrivateBlobs, policy: LogRetentionPolicy) {
  const now = policy.now?.() ?? new Date(), batch = policy.batchSize ?? 100, version = policy.policyVersion ?? 'log_retention_v1';
  if (!Number.isInteger(policy.contentRetentionDays) || policy.contentRetentionDays < 1) throw new Error('Invalid retention policy');
  const cutoff = new Date(now.getTime() - policy.contentRetentionDays * 86_400_000);
  const deletedDays = policy.deletedProjectPurgeDays;
  if (deletedDays !== undefined && (!Number.isInteger(deletedDays) || deletedDays < 0)) throw new Error('Invalid deleted-project purge window');
  const deletedCutoff = deletedDays === undefined ? null : new Date(now.getTime() - deletedDays * 86_400_000);
  const due = (await pool.query(`
    SELECT * FROM (
      SELECT 'prompt_snapshot' kind,s.id,s.owner_user_id,s.project_id,s.object_key,s.created_at,
        CASE WHEN u.status='closed' OR p.deleted_at<$4 THEN 'user_deleted' ELSE 'retention_expired' END reason
      FROM bb_snapshot_refs s JOIN bb_users u ON u.id=s.owner_user_id LEFT JOIN bb_runs r ON r.id=s.run_id
      JOIN bb_projects p ON p.owner_user_id=s.owner_user_id AND p.id=s.project_id
      WHERE (u.status='closed' OR p.deleted_at<$4 OR (s.created_at<$1 AND (r.id IS NULL OR r.state IN ('succeeded','test_completed','failed','cancelled','rejected'))))
      UNION ALL
      SELECT 'provider_result',p.id,p.owner_user_id,p.project_id,p.result_ref,p.created_at,
        CASE WHEN u.status='closed' OR pj.deleted_at<$4 THEN 'user_deleted' ELSE 'retention_expired' END
      FROM bb_provider_result_refs p JOIN bb_users u ON u.id=p.owner_user_id JOIN bb_runs r ON r.id=p.run_id
      JOIN bb_projects pj ON pj.owner_user_id=p.owner_user_id AND pj.id=p.project_id
      WHERE (u.status='closed' OR pj.deleted_at<$4 OR (p.created_at<$1 AND r.state IN ('succeeded','test_completed','failed','cancelled','rejected')))
    ) c WHERE ($3::text[] IS NULL OR c.owner_user_id=ANY($3)) AND NOT EXISTS (SELECT 1 FROM bb_log_content_tombstones t WHERE t.content_kind=c.kind AND t.content_id=c.id)
    ORDER BY created_at,id LIMIT $2`, [cutoff, batch, policy.ownerScope ?? null, deletedCutoff])).rows;
  let purged = 0, failed = 0;
  for (const row of due) {
    try {
      const deleted = await transaction(pool, async client => {
        // The prompt view holds this same lock through response completion. Deletion and
        // tombstoning must be one serialized operation, including the Blob I/O window.
        if (row.kind === 'prompt_snapshot') await client.query("SELECT pg_advisory_xact_lock(hashtext('prompt_snapshot'),hashtext($1::text))", [row.id]);
        const existing = await client.query('SELECT 1 FROM bb_log_content_tombstones WHERE content_kind=$1 AND content_id=$2', [row.kind, row.id]);
        if (existing.rowCount) return false;
        try { await blobs.delete(row.object_key); }
        catch { throw new BlobPurgeError('Private content deletion failed'); }
        const inserted = await client.query('INSERT INTO bb_log_content_tombstones(id,owner_user_id,content_kind,content_id,object_key,reason,policy_version) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id', [uid(), row.owner_user_id, row.kind, row.id, row.object_key, row.reason, version]);
        if (inserted.rowCount) await emitInternal(client, internalEvent({ kind: 'log.content_purged', owner: row.owner_user_id, projectId: row.project_id, traceId: row.id, stage: row.reason, promptSnapshotRef: row.kind === 'prompt_snapshot' ? row.id : null }));
        return !!inserted.rowCount;
      });
      if (deleted) purged++;
    } catch (error) {
      if (!(error instanceof BlobPurgeError)) throw error;
      failed++;
      await raiseAlert(pool, { kind: 'retention_purge_failed', severity: 'warning', scope: 'blob', detail: { content_kind: row.kind } });
    }
  }
  // Intents are bounded, private object addresses, never a broad prefix scan.
  // Registered objects remain governed by the retention query above.
  const orphanIds = (await pool.query(`SELECT i.id FROM bb_prompt_blob_intents i
    WHERE i.registered_at IS NULL AND i.cleared_at IS NULL AND i.cleanup_after<=$1
      AND ($3::text[] IS NULL OR i.owner_user_id=ANY($3))
    ORDER BY i.cleanup_after,i.id LIMIT $2`, [now, batch, policy.ownerScope ?? null])).rows;
  let orphanPurged = 0, orphanFailed = 0;
  for (const { id } of orphanIds) {
    try {
      const cleared = await transaction(pool, async client => {
        const intent = (await client.query('SELECT * FROM bb_prompt_blob_intents WHERE id=$1 FOR UPDATE', [id])).rows[0];
        if (!intent || intent.registered_at || intent.cleared_at || new Date(intent.cleanup_after) > now) return false;
        const ref = await client.query('SELECT 1 FROM bb_snapshot_refs WHERE object_key=$1', [intent.object_key]);
        if (ref.rowCount) {
          await client.query('UPDATE bb_prompt_blob_intents SET registered_at=now() WHERE id=$1', [id]);
          return false;
        }
        await blobs.delete(intent.object_key);
        await client.query('UPDATE bb_prompt_blob_intents SET cleared_at=now() WHERE id=$1', [id]);
        return true;
      });
      if (cleared) orphanPurged++;
    } catch {
      orphanFailed++;
      await raiseAlert(pool, { kind: 'retention_purge_failed', severity: 'warning', scope: 'blob', detail: { content_kind: 'orphan_prompt_snapshot' } });
    }
  }
  return { due: due.length, purged, failed, orphanDue: orphanIds.length, orphanPurged, orphanFailed };
}

// ---------------------------------------------------------------- operator access

export async function operatorRoles(db: Pool | PoolClient, userId: string) {
  const q = await db.query("SELECT g.role FROM bb_operator_grants g JOIN bb_users u ON u.id=g.user_id WHERE g.user_id=$1 AND g.revoked_at IS NULL AND u.status='active'", [userId]);
  return new Set(q.rows.map(r => r.role as OperatorRole));
}
export async function grantOperator(pool: Pool, input: { userId: string; role: OperatorRole; grantedBy: string; reasonCode: string }) {
  const id = uid();
  await pool.query('INSERT INTO bb_operator_grants(id,user_id,role,granted_by,reason_code) VALUES($1,$2,$3,$4,$5)', [id, input.userId, input.role, input.grantedBy, input.reasonCode]);
  return id;
}
export async function revokeOperator(pool: Pool, userId: string, role: OperatorRole) {
  await pool.query('UPDATE bb_operator_grants SET revoked_at=now() WHERE user_id=$1 AND role=$2 AND revoked_at IS NULL', [userId, role]);
}
async function audit(client: PoolClient, input: { actorId: string; role: OperatorRole; owner?: string | null; purpose: string; filter: unknown; target?: string; reason?: string }) {
  const id = uid();
  await client.query('INSERT INTO bb_log_access_audit(id,actor_id,owner_user_id,purpose,filter_hash,actor_role,target_ref,reason_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, input.actorId, input.owner ?? '*', input.purpose, digest(JSON.stringify(input.filter)), input.role, input.target ?? null, input.reason ?? null]);
  return id;
}

export type AdminFilter = { user_id?: string; project_id?: string; job_id?: string; trace_id?: string; from?: Date; to?: Date; model_id?: string; status?: string; error_code?: string; limit: number };
const invalid = () => new Problem(422, 'VALIDATION_FAILED', 'Invalid log filter');
/** Strict allow-list parsing; also the log-injection boundary for operator input. */
export function parseAdminFilter(query: Record<string, unknown>): AdminFilter {
  const result: AdminFilter = { limit: 100 };
  for (const [key, raw] of Object.entries(query ?? {})) {
    if (!(ADMIN_LOG_FILTERS as readonly string[]).includes(key) || typeof raw !== 'string' || raw.length > 128) throw invalid();
    if (['user_id', 'project_id', 'job_id', 'trace_id'].includes(key)) { if (!validId(raw)) throw invalid(); (result as any)[key] = raw; }
    else if (key === 'from' || key === 'to') { if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(raw) || Number.isNaN(Date.parse(raw))) throw invalid(); result[key] = new Date(raw); }
    else if (key === 'model_id') { if (!/^[A-Za-z0-9._-]{1,128}$/.test(raw)) throw invalid(); result.model_id = raw; }
    else if (key === 'status') { if (!safeCode.test(raw)) throw invalid(); result.status = raw; }
    else if (key === 'error_code') { if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(raw)) throw invalid(); result.error_code = raw; }
    else if (key === 'limit') { if (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw) > ADMIN_LOG_PAGE_LIMIT) throw invalid(); result.limit = Number(raw); }
  }
  if (result.from && result.to && result.from > result.to) throw invalid();
  return result;
}
const filterArgs = (f: AdminFilter) => [f.user_id ?? null, f.project_id ?? null, f.job_id ?? null, f.trace_id ?? null, f.from ?? null, f.to ?? null, f.model_id ?? null, f.status ?? null, f.error_code ?? null];

export async function adminEvents(pool: Pool, actorId: string, filter: AdminFilter) {
  return transaction(pool, async client => {
    await audit(client, { actorId, role: 'log_reader', owner: filter.user_id, purpose: 'admin_events', filter });
    const q = await client.query(`SELECT e.id,e.owner_user_id,e.project_id,e.job_id,e.run_id,e.channel,e.trace_id,e.kind,e.created_at,e.event FROM bb_observability_events e
      WHERE ($1::text IS NULL OR e.owner_user_id=$1) AND ($2::text IS NULL OR e.project_id=$2) AND ($3::text IS NULL OR e.job_id=$3) AND ($4::text IS NULL OR e.trace_id=$4)
        AND ($5::timestamptz IS NULL OR e.created_at>=$5) AND ($6::timestamptz IS NULL OR e.created_at<=$6)
        AND ($7::text IS NULL OR EXISTS (SELECT 1 FROM bb_model_call_attempts a WHERE a.job_id=e.job_id AND a.model_id=$7
             AND (e.event->>'logical_call_id' IS NULL OR (a.logical_call_id=e.event->>'logical_call_id' AND a.attempt_no=(e.event->>'attempt_no')::int))))
        AND ($8::text IS NULL OR e.event->>'status'=$8) AND ($9::text IS NULL OR e.event->'error'->>'code'=$9)
        AND ($11::boolean OR e.channel IS DISTINCT FROM 'non_production_test')
      ORDER BY e.created_at,e.id LIMIT $10`, [...filterArgs(filter), filter.limit + 1, testChannelEnabled()]);
    const rows = q.rows.slice(0, filter.limit);
    return { truncated: q.rows.length > filter.limit, items: rows.map(r => ({ event_id: r.id, kind: r.kind, occurred_at: iso(r.created_at)!, user_id: r.owner_user_id, project_id: r.project_id, job_id: r.job_id, run_id: r.run_id, channel: r.channel, trace_id: r.trace_id, actor_type: r.event.actor_type, status: r.event.status ?? null, stage: r.event.stage ?? null, error_code: r.event.error?.code ?? null, logical_call_id: r.event.logical_call_id ?? null, attempt_no: r.event.attempt_no ?? null, prompt_snapshot_ref: r.event.prompt_snapshot_ref ?? null })) };
  });
}

type UsageRow = { usage_status: string; call_status: string; attempt_no: number; input_tokens: number | null; output_tokens: number | null; cached_input_tokens: number | null; reasoning_tokens: number | null };
/** Sums measured attempts only. Unknown/pending/conflict count as unresolved and add no tokens. */
export function consumption(rows: UsageRow[]) {
  const measured = rows.filter(r => r.usage_status === 'measured');
  const sum = (field: 'input_tokens' | 'output_tokens' | 'cached_input_tokens' | 'reasoning_tokens') => {
    const values = measured.map(r => r[field]).filter((v): v is number => v !== null && v !== undefined);
    return values.length ? values.reduce((a, b) => a + Number(b), 0) : null;
  };
  return { attempts: rows.length, measured_attempts: measured.length, unresolved_attempts: rows.length - measured.length, input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'), cached_input_tokens: sum('cached_input_tokens'), reasoning_tokens: sum('reasoning_tokens') };
}
const terminal = ['succeeded', 'test_completed', 'failed', 'cancelled', 'rejected'];

export async function adminJobTimeline(pool: Pool, actorId: string, jobId: string) {
  if (!validId(jobId)) throw missing();
  return transaction(pool, async client => {
    const job = (await client.query('SELECT j.*,COALESCE(j.project_id,r.project_id) effective_project_id,r.state run_state,r.channel run_channel,r.artifact_id,r.artifact_version FROM bb_jobs j LEFT JOIN bb_runs r ON r.id=j.run_id WHERE j.id=$1', [jobId])).rows[0];
    await audit(client, { actorId, role: 'log_reader', owner: job?.owner_user_id, purpose: 'admin_job_timeline', filter: { jobId }, target: jobId });
    if (!job) throw missing();
    assertTestChannelReadable(job.run_channel ?? job.channel);
    const prompts = (await client.query(`SELECT s.*,t.id tombstone FROM bb_snapshot_refs s LEFT JOIN bb_log_content_tombstones t ON t.content_kind='prompt_snapshot' AND t.content_id=s.id
      WHERE s.owner_user_id=$1 AND ((s.run_id IS NOT NULL AND s.run_id=$2) OR s.id IN (SELECT prompt_snapshot_id FROM bb_model_call_attempts WHERE job_id=$3)) ORDER BY s.created_at,s.id`, [job.owner_user_id, job.run_id, job.id])).rows;
    const stages = job.run_id
      ? (await client.query('SELECT seq,type,state,stage,payload,occurred_at FROM bb_run_events WHERE owner_user_id=$1 AND run_id=$2 ORDER BY seq', [job.owner_user_id, job.run_id])).rows.map(r => ({ seq: r.seq, type: r.type, state: r.state, stage: r.stage, reason: r.payload?.reason ?? null, occurred_at: iso(r.occurred_at)! }))
      : (await client.query("SELECT kind,event,created_at FROM bb_observability_events WHERE owner_user_id=$1 AND job_id=$2 AND kind IN ('operation.submitted','operation.rejected','job.state_changed') ORDER BY created_at,CASE WHEN kind LIKE 'operation.%' THEN 0 ELSE 1 END,id", [job.owner_user_id, job.id])).rows.map((r, i) => ({ seq: i + 1, type: r.kind, state: r.event.status ?? 'unknown', stage: r.event.stage ?? null, reason: r.event.error?.code?.toLowerCase() ?? null, occurred_at: iso(r.created_at)! }));
    const attemptRows = (await client.query(`SELECT a.id,a.logical_call_id,a.attempt_no,a.channel,a.status,a.model_id,a.provider_request_id,a.prompt_snapshot_id,a.created_at,
        u.usage_status,u.input_tokens,u.output_tokens,u.cached_input_tokens,u.reasoning_tokens,u.correction_id,rt.duration_ms,
        COALESCE(rt.error_code,(SELECT o.error_code FROM bb_provider_call_observations o WHERE o.attempt_id=a.id ORDER BY o.observed_at DESC,o.id DESC LIMIT 1)) error_code
      FROM bb_model_call_attempts a JOIN bb_call_usage_effective u ON u.attempt_id=a.id LEFT JOIN bb_model_call_attempt_runtime rt ON rt.attempt_id=a.id
      WHERE a.owner_user_id=$1 AND a.job_id=$2 ORDER BY a.logical_call_id,a.attempt_no`, [job.owner_user_id, job.id])).rows;
    const errors = (await client.query('SELECT * FROM bb_observability_errors WHERE owner_user_id=$1 AND job_id=$2 ORDER BY created_at,id', [job.owner_user_id, job.id])).rows;
    const artifact = job.artifact_id ? (await client.query('SELECT * FROM bb_artifact_versions WHERE owner_user_id=$1 AND id=$2 AND version=$3', [job.owner_user_id, job.artifact_id, job.artifact_version])).rows[0] : null;
    const usageRows: UsageRow[] = attemptRows.map(a => ({ usage_status: a.usage_status, call_status: a.status, attempt_no: a.attempt_no, input_tokens: int(a.input_tokens), output_tokens: int(a.output_tokens), cached_input_tokens: int(a.cached_input_tokens), reasoning_tokens: int(a.reasoning_tokens) }));
    const state = job.run_state ?? job.state;
    const created = new Date(job.created_at), updated = new Date(job.updated_at);
    return {
      job: { job_id: job.id, user_id: job.owner_user_id, project_id: job.effective_project_id ?? null, run_id: job.run_id ?? null, channel: job.channel ?? 'production', operation_id: job.operation_id ?? null, request_id: job.request_id ?? null, execution_request_id: job.execution_request_id ?? null, execution_request_key_hash: job.execution_request_key_hash?.trim() ?? null, trace_id: job.trace_id ?? job.run_id ?? null, input_revision: job.input_revision ?? null, input_hash: job.input_hash?.trim() ?? null, job_type: job.job_type, subtype: job.subtype, state: job.state, stage: job.stage ?? null, attempts: job.attempts, error_code: job.error_code ?? null, created_at: created.toISOString(), updated_at: updated.toISOString(), duration_ms: terminal.includes(job.state) ? Math.max(0, updated.getTime() - created.getTime()) : null },
      prompts: prompts.map(s => ({ snapshot_id: s.id, kind: s.snapshot_kind, version: s.version, content_sha256: s.content_sha256.trim(), redaction_version: s.redaction_version, input_revision: s.input_revision, template_version: s.template_version, rule_pack_version: s.rule_pack_version, model_parameters_version: s.model_parameters_version, content_state: s.tombstone ? 'purged' : 'available', created_at: iso(s.created_at)! })),
      stages,
      attempts: attemptRows.map((a, i) => ({ attempt_id: a.id, logical_call_id: a.logical_call_id, attempt_no: a.attempt_no, channel: a.channel ?? 'production', status: a.status, model_id: a.model_id, provider_request_id: a.provider_request_id, prompt_snapshot_ref: a.prompt_snapshot_id, usage_status: a.usage_status, usage: { input_tokens: usageRows[i].input_tokens, output_tokens: usageRows[i].output_tokens, cached_input_tokens: usageRows[i].cached_input_tokens, reasoning_tokens: usageRows[i].reasoning_tokens }, corrected: !!a.correction_id, duration_ms: int(a.duration_ms), error_code: a.error_code ?? null, created_at: iso(a.created_at)! })),
      errors: errors.map(e => ({ error_id: e.id, code: e.code, category: e.category, stage: e.stage, attempt_id: e.attempt_id, retry_count: e.retry_count, fingerprint: e.fingerprint?.trim() ?? null, recovery_status: e.recovery_status, created_at: iso(e.created_at)! })),
      artifact: artifact ? { artifact_id: artifact.id, version: artifact.version, sha256: artifact.sha256.trim(), quality_status: artifact.quality_status, delivery_status: artifact.delivery_status, created_at: iso(artifact.created_at)! } : null,
      outcome: { state, error_code: job.error_code ?? errors.at(-1)?.code ?? null, artifact_available: !!artifact && artifact.quality_status === 'passed' && ['available','test_only'].includes(artifact.delivery_status) },
      consumption: { all_attempts: consumption(usageRows), completed_attempts: consumption(usageRows.filter(r => r.call_status === 'completed')) }
    };
  });
}

export async function adminMetrics(pool: Pool, actorId: string, filter: AdminFilter) {
  return transaction(pool, async client => {
    await audit(client, { actorId, role: 'log_reader', owner: filter.user_id, purpose: 'admin_metrics', filter });
    const args = filterArgs(filter);
    // Scope: jobs created in the window. status filters the job state; error_code the job or its error records.
    const scope = `WITH scoped AS (SELECT j.* FROM bb_jobs j LEFT JOIN bb_runs r ON r.id=j.run_id
      WHERE ($1::text IS NULL OR j.owner_user_id=$1) AND ($2::text IS NULL OR COALESCE(j.project_id,r.project_id)=$2) AND ($3::text IS NULL OR j.id=$3)
        AND ($4::text IS NULL OR COALESCE(j.trace_id,j.run_id)=$4) AND ($5::timestamptz IS NULL OR j.created_at>=$5) AND ($6::timestamptz IS NULL OR j.created_at<=$6)
        AND ($7::text IS NULL OR EXISTS (SELECT 1 FROM bb_model_call_attempts a WHERE a.job_id=j.id AND a.model_id=$7))
        AND ($8::text IS NULL OR j.state=$8)
        AND ($9::text IS NULL OR j.error_code=$9 OR EXISTS (SELECT 1 FROM bb_observability_errors e WHERE e.job_id=j.id AND e.code=$9)))`;
    const jobs = (await client.query(`${scope} SELECT count(*)::int total, count(*) FILTER (WHERE state='succeeded')::int succeeded, count(*) FILTER (WHERE state='failed')::int failed,
        count(*) FILTER (WHERE state='cancelled')::int cancelled, count(*) FILTER (WHERE state='rejected')::int rejected,
        avg(EXTRACT(EPOCH FROM updated_at-created_at)*1000) FILTER (WHERE state IN ('succeeded','test_completed','failed','cancelled')) avg_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM updated_at-created_at)*1000) FILTER (WHERE state IN ('succeeded','test_completed','failed','cancelled')) p95_ms FROM scoped`, args)).rows[0];
    const attempts = (await client.query(`${scope} SELECT a.id,a.model_id,a.status call_status,a.attempt_no,u.usage_status,u.input_tokens,u.output_tokens,u.cached_input_tokens,u.reasoning_tokens,rt.duration_ms
        FROM scoped j JOIN bb_model_call_attempts a ON a.job_id=j.id JOIN bb_call_usage_effective u ON u.attempt_id=a.id LEFT JOIN bb_model_call_attempt_runtime rt ON rt.attempt_id=a.id
        WHERE ($7::text IS NULL OR a.model_id=$7)`, args)).rows.map(a => ({ ...a, input_tokens: int(a.input_tokens), output_tokens: int(a.output_tokens), cached_input_tokens: int(a.cached_input_tokens), reasoning_tokens: int(a.reasoning_tokens) }));
    const errors = (await client.query(`${scope} SELECT e.code error_code,count(*)::int count FROM scoped j JOIN bb_observability_errors e ON e.job_id=j.id GROUP BY e.code ORDER BY count DESC,e.code`, args)).rows;
    const operations = (await client.query(`SELECT count(*) FILTER (WHERE status='submitted')::int submitted, count(*) FILTER (WHERE status='rejected')::int rejected FROM bb_operations o
        WHERE ($1::text IS NULL OR o.owner_user_id=$1) AND ($2::text IS NULL OR o.project_id=$2) AND ($3::text IS NULL OR o.trace_id=$3)
          AND ($4::timestamptz IS NULL OR o.created_at>=$4) AND ($5::timestamptz IS NULL OR o.created_at<=$5) AND ($6::text IS NULL OR o.error_code=$6)`, [filter.user_id ?? null, filter.project_id ?? null, filter.trace_id ?? null, filter.from ?? null, filter.to ?? null, filter.error_code ?? null])).rows[0];
    const finished = jobs.succeeded + jobs.failed + jobs.cancelled;
    const durations = attempts.map(a => a.duration_ms).filter(v => v !== null).map(Number);
    const models = new Map<string | null, typeof attempts>();
    for (const a of attempts) models.set(a.model_id, [...(models.get(a.model_id) ?? []), a]);
    return {
      window: { from: iso(filter.from), to: iso(filter.to) },
      operations: { submitted: operations.submitted, rejected: operations.rejected },
      jobs: { total: jobs.total, succeeded: jobs.succeeded, failed: jobs.failed, cancelled: jobs.cancelled, rejected: jobs.rejected, other: jobs.total - finished - jobs.rejected, success_rate: finished ? jobs.succeeded / finished : null, failure_rate: finished ? jobs.failed / finished : null, duration_ms_avg: jobs.avg_ms === null ? null : Number(jobs.avg_ms), duration_ms_p95: jobs.p95_ms === null ? null : Number(jobs.p95_ms) },
      attempts: { total: attempts.length, completed: attempts.filter(a => a.call_status === 'completed').length, failed: attempts.filter(a => a.call_status === 'failed').length, pending_reconcile: attempts.filter(a => a.call_status === 'pending_reconcile').length, confirmed_not_sent: attempts.filter(a => a.call_status === 'confirmed_not_sent').length, conflict: attempts.filter(a => a.usage_status === 'conflict').length, duration_ms_avg: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null },
      consumption: { all_attempts: consumption(attempts), completed_attempts: consumption(attempts.filter(a => a.call_status === 'completed')), retry_attempts: consumption(attempts.filter(a => a.attempt_no > 1)) },
      by_model: [...models].map(([model_id, rows]) => { const c = consumption(rows); return { model_id, attempts: rows.length, completed: rows.filter(a => a.call_status === 'completed').length, failed: rows.filter(a => a.call_status === 'failed').length, input_tokens: c.input_tokens, output_tokens: c.output_tokens, cached_input_tokens: c.cached_input_tokens, reasoning_tokens: c.reasoning_tokens }; }),
      errors
    };
  });
}

const promptAbort = () => new Problem(503, 'DATA_UNAVAILABLE', 'Prompt read aborted');

/** PostgreSQL, rather than an HTTP Promise.race, stops an active query by the route deadline. */
async function setPromptStatementTimeout(client: PoolClient, deadlineAt?: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw promptAbort();
  if (deadlineAt === undefined) return;
  const remaining = Math.ceil(deadlineAt - performance.now());
  if (remaining <= 0) throw promptAbort();
  await client.query("SELECT set_config('statement_timeout',$1,false)", [String(remaining)]);
  if (signal?.aborted) throw promptAbort();
}

/** Return a connection that arrives after the HTTP waiter has disconnected. */
function connectPrompt(pool: Pool, signal?: AbortSignal): Promise<PoolClient> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(promptAbort()); return; }
    let settled = false;
    const abort = () => { if (!settled) { settled = true; reject(promptAbort()); } };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    void pool.connect().then(client => {
      if (settled) { client.release(); return; }
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) { client.release(); reject(promptAbort()); }
      else resolve(client);
    }, error => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

function waitPromptRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(promptAbort()); return; }
    const abort = () => { clearTimeout(timer); reject(promptAbort()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** A try-lock never blocks a pool connection behind another HTTP response. */
async function acquirePromptLock(pool: Pool, snapshotId: string, signal?: AbortSignal, deadlineAt?: number): Promise<PoolClient> {
  let retryMs = 25;
  for (;;) {
    if (signal?.aborted) throw promptAbort();
    // Do not leave a cancelled prompt in pg-pool's unabortable connect queue.
    if (pool.idleCount === 0 && pool.totalCount >= (pool.options.max ?? 10)) {
      await waitPromptRetry(retryMs, signal);
      retryMs = Math.min(retryMs * 2, 250);
      continue;
    }
    const client = await connectPrompt(pool, signal);
    let locked = false;
    try {
      if (signal?.aborted) throw promptAbort();
      await setPromptStatementTimeout(client, deadlineAt, signal);
      locked = (await client.query("SELECT pg_try_advisory_lock(hashtext('prompt_snapshot'),hashtext($1::text)) locked", [snapshotId])).rows[0].locked === true;
      if (signal?.aborted) throw promptAbort();
      if (locked) return client;
      // This session carries a route-specific statement_timeout. Never lend it
      // to unrelated pool work, even though it did not acquire the lock.
      client.release(true);
    } catch (error) {
      // Destroying this session releases a lock even if the query raced the abort.
      client.release(true);
      throw error;
    }
    await waitPromptRetry(retryMs, signal);
    retryMs = Math.min(retryMs * 2, 250);
  }
}

/** The caller must hold release until the HTTP response finishes or aborts. */
export async function adminPromptView(pool: Pool, blobs: PrivateBlobs, actorId: string, snapshotId: string, reasonCode: string, signal?: AbortSignal, deadlineAt?: number) {
  if (!validId(snapshotId)) throw missing();
  if (!safeCode.test(reasonCode)) throw new Problem(422, 'VALIDATION_FAILED', 'reason_code is required');
  const client = await acquirePromptLock(pool, snapshotId, signal, deadlineAt);
  let releasePromise: Promise<void> | undefined;
  const release = () => releasePromise ??= (async () => {
    // Closing the session releases the advisory lock without queuing an unlock
    // behind a still-running query. It must never re-enter the pool with a lock.
    client.release(true);
  })();
  const abort = () => { void release(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    if (signal?.aborted) throw promptAbort();
    // Audit commits before any plaintext read. The session lock survives that commit.
    const query = async (sql: string, params?: unknown[]) => {
      await setPromptStatementTimeout(client, deadlineAt, signal);
      return client.query(sql, params);
    };
    await query('BEGIN');
    let snapshot: any, auditId: string;
    try {
      snapshot = (await query(`SELECT s.*,t.id tombstone,EXISTS (
        SELECT 1 FROM bb_model_call_attempts a
        JOIN bb_jobs j ON j.id=a.job_id AND j.owner_user_id=s.owner_user_id
        JOIN bb_runs r ON r.id=COALESCE(s.run_id,j.run_id) AND r.owner_user_id=s.owner_user_id
        WHERE a.prompt_snapshot_id=s.id AND r.channel='non_production_test'
      ) OR EXISTS (
        SELECT 1 FROM bb_runs r WHERE r.id=s.run_id AND r.owner_user_id=s.owner_user_id AND r.channel='non_production_test'
      ) AS linked_test_run FROM bb_snapshot_refs s
      LEFT JOIN bb_log_content_tombstones t ON t.content_kind='prompt_snapshot' AND t.content_id=s.id
      JOIN bb_users u ON u.id=s.owner_user_id JOIN bb_projects p ON p.id=s.project_id AND p.owner_user_id=s.owner_user_id
      WHERE s.id=$1 AND u.status='active' AND p.deleted_at IS NULL`, [snapshotId])).rows[0];
      await setPromptStatementTimeout(client, deadlineAt, signal);
      auditId = await audit(client, { actorId, role: 'prompt_viewer', owner: snapshot?.owner_user_id, purpose: 'prompt_view', filter: { snapshotId }, target: snapshotId, reason: reasonCode });
      await query('COMMIT');
    } catch (error) {
      // A deadline/cancel leaves the transaction and session unfit for reuse.
      // Do not enqueue ROLLBACK behind a stalled query on an aborted response.
      if (!signal?.aborted && !(error instanceof Error && 'code' in error && error.code === '57014')) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    if (!snapshot || snapshot.tombstone) throw missing();
    if (snapshot.linked_test_run) assertTestChannelReadable('non_production_test');
    if (signal?.aborted) throw new Problem(503, 'DATA_UNAVAILABLE', 'Prompt read aborted');
    // A Blob request may never settle after a TCP disconnect. Promise.race observes its
    // eventual result/rejection, while the abort path releases the session lock now.
    const blobRead = blobs.getIfExistsBounded(snapshot.object_key, 10 * 1024 * 1024);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Problem(503, 'DATA_UNAVAILABLE', 'Prompt read aborted'));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
    let bytes: Buffer | null;
    try { bytes = await Promise.race([blobRead, aborted]); }
    finally { if (onAbort) signal?.removeEventListener('abort', onAbort); }
    if (signal?.aborted) throw new Problem(503, 'DATA_UNAVAILABLE', 'Prompt read aborted');
    if (!bytes || digest(bytes) !== snapshot.content_sha256.trim()) throw missing();
    return { view: { snapshot_id: snapshot.id, user_id: snapshot.owner_user_id, project_id: snapshot.project_id, kind: snapshot.snapshot_kind, version: snapshot.version, content_sha256: snapshot.content_sha256.trim(), redaction_version: snapshot.redaction_version, media_type: 'text/plain; charset=utf-8' as const, body: bytes.toString('utf8'), audit_id: auditId }, release };
  } catch (error) { await release(); throw error; }
  finally { signal?.removeEventListener('abort', abort); }
}

export async function adminAlerts(pool: Pool, actorId: string) {
  return transaction(pool, async client => {
    await audit(client, { actorId, role: 'log_reader', purpose: 'admin_alerts', filter: {} });
    const q = await client.query('SELECT a.*,k.acked_at FROM bb_ops_alerts a LEFT JOIN bb_ops_alert_acks k ON k.alert_id=a.id ORDER BY a.created_at DESC,a.id LIMIT 200');
    return { items: q.rows.map(a => ({ alert_id: a.id, kind: a.kind, severity: a.severity, detail: a.detail, created_at: iso(a.created_at)!, acked_at: iso(a.acked_at) })) };
  });
}

/** Append a correction for one supplier attempt; the raw observations stay untouched. */
export async function correctUsage(pool: Pool, actorId: string, attemptId: string, input: { chosen_observation_id: string | null; usage_status: 'measured' | 'unknown'; reason_code: string }) {
  if (!validId(attemptId)) throw missing();
  if (!safeCode.test(input.reason_code) || (input.usage_status === 'measured') !== (input.chosen_observation_id !== null) || (input.chosen_observation_id !== null && !validId(input.chosen_observation_id))) throw new Problem(422, 'VALIDATION_FAILED', 'A measured correction must choose one observation; unknown must not');
  return transaction(pool, async client => {
    const a = (await client.query('SELECT a.*,j.run_id,COALESCE(j.project_id,r.project_id) project_id FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id LEFT JOIN bb_runs r ON r.id=j.run_id WHERE a.id=$1 FOR UPDATE OF a', [attemptId])).rows[0];
    await audit(client, { actorId, role: 'log_operator', owner: a?.owner_user_id, purpose: 'usage_correction', filter: input, target: attemptId, reason: input.reason_code });
    if (!a) throw missing();
    let counts: Array<number | null> = [null, null, null, null];
    if (input.chosen_observation_id) {
      const o = (await client.query("SELECT * FROM bb_usage_observations WHERE id=$1 AND attempt_id=$2 AND usage_status='measured'", [input.chosen_observation_id, attemptId])).rows[0];
      if (!o) throw new Problem(409, 'IDEMPOTENCY_CONFLICT', 'Chosen observation is not a measured observation of this attempt');
      counts = [o.input_tokens, o.output_tokens, o.cached_input_tokens, o.reasoning_tokens];
    }
    const id = uid();
    await client.query('INSERT INTO bb_usage_corrections(id,owner_user_id,attempt_id,chosen_observation_id,usage_status,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,reason_code,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [id, a.owner_user_id, attemptId, input.chosen_observation_id, input.usage_status, ...counts, input.reason_code, actorId]);
    await emitInternal(client, internalEvent({ kind: 'model.usage_corrected', owner: a.owner_user_id, actorType: 'operator', projectId: a.project_id, runId: a.run_id, jobId: a.job_id, traceId: a.run_id ?? a.job_id, logicalCallId: a.logical_call_id, attemptNo: a.attempt_no, usage: { status: input.usage_status === 'measured' ? 'reported' : 'unavailable', input_tokens: counts[0], output_tokens: counts[1], cached_input_tokens: counts[2], reasoning_tokens: counts[3], evidence_ref: input.chosen_observation_id } }));
    return { correction_id: id, attempt_id: attemptId, usage_status: input.usage_status, usage: { input_tokens: counts[0], output_tokens: counts[1], cached_input_tokens: counts[2], reasoning_tokens: counts[3] } };
  });
}

// ---------------------------------------------------------------- CLI

// node dist/log-ops.js forward|health|retention — one bounded batch per invocation (cron/systemd timer).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
    if (command === 'forward') {
      if (!process.env.BB_LOG_SINK_FILE) throw new Error('BB_LOG_SINK_FILE required');
      const archive = logArchiveOptionsFromEnv();
      const sink = ndjsonFileSink(process.env.BB_LOG_SINK_FILE, 'ndjson_file', ndjsonSizeCapFromEnv(), archive);
      if (archive) try { await sink.deliver([]); }
      catch (error) { await tripEvidenceGate(pool, 'log_archive_unavailable'); throw error; }
      process.stdout.write(`${JSON.stringify(await forwardLogs(pool, sink))}\n`);
    } else if (command === 'health') {
      process.stdout.write(`${JSON.stringify(await checkLogHealth(pool, { maxBacklogAgeSeconds: Number(process.env.BB_LOG_BACKLOG_ALERT_SECONDS ?? '300') }))}\n`);
    } else if (command === 'retention') {
      if (!process.env.AZURE_STORAGE_CONNECTION_STRING) throw new Error('AZURE_STORAGE_CONNECTION_STRING required');
      process.stdout.write(`${JSON.stringify(await purgeLogContent(pool, azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING), retentionPolicyFromEnv()))}\n`);
    } else throw new Error('usage: log-ops forward|health|retention');
  } catch (error) { process.stderr.write(`log-ops failed: ${error instanceof Error ? error.message : 'unknown'}\n`); process.exitCode = 1; }
  finally { await pool.end(); }
}
