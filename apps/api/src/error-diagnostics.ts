import { ERROR_CODES, MODEL_ADAPTER_ERROR_CODES, ERROR_CATEGORIES, ERROR_RECOVERY_OUTCOMES } from '@bondbuddy/contracts';
import { digest } from './data.js';

export type ErrorCode = typeof ERROR_CODES[number] | typeof MODEL_ADAPTER_ERROR_CODES[number];
export type ErrorCategory = typeof ERROR_CATEGORIES[number];
export type RecoveryOutcome = typeof ERROR_RECOVERY_OUTCOMES[number];
const stagePattern = /^[a-z][a-z0-9_]{0,63}$/;

/** Keep only function identifiers. Never retain source paths, arguments or raw exception text. */
export function normalizedStackFrames(stack: string | undefined): string {
  if (!stack) return '';
  const frames: string[] = [];
  for (const line of stack.split(/\r?\n/).slice(1, 17)) {
    const match = /^\s*at\s+([A-Za-z_$][\w.$<>-]{0,127})\s*(?:\(|$)/.exec(line);
    if (!match) continue;
    const frame = match[1]!.replace(/\d+/g, '#').replace(/[-]+/g, '_');
    frames.push(digest(frame));
  }
  return frames.join('\n');
}

export function truncateUtf8(value: string, limit: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= limit) return value;
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

export function errorDiagnostic(input: { code: ErrorCode; category: ErrorCategory; stage?: string | null; stack?: string; providerErrorType?: string | null; recoveryStatus?: RecoveryOutcome | null }) {
  if (!(ERROR_CODES as readonly string[]).includes(input.code) && !(MODEL_ADAPTER_ERROR_CODES as readonly string[]).includes(input.code) || !ERROR_CATEGORIES.includes(input.category) ||
      (input.stage && !stagePattern.test(input.stage)) ||
      (input.providerErrorType && !stagePattern.test(input.providerErrorType)) ||
      (input.recoveryStatus && !ERROR_RECOVERY_OUTCOMES.includes(input.recoveryStatus))) throw new Error('Invalid structured error');
  const safeStack = truncateUtf8(normalizedStackFrames(input.stack), 2048);
  const safeMessage = truncateUtf8(`Error ${input.code}`, 1024);
  return { fingerprint: digest(`${input.code}\n${input.stage ?? ''}\n${safeStack}`), safeMessage, safeStack: safeStack || null };
}
