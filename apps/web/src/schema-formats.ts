import { FormatRegistry } from '@sinclair/typebox';

// TypeBox requires an explicit validator for formats present in public schemas.
// Keep the schema intact, including timezone and calendar checks.
export function isDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, y, m, d, h, min, s, zone, zh, zm] = match;
  const year = Number(y), month = Number(m), day = Number(d), second = Number(s);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(h) > 23 || Number(min) > 59 || second > 60 || Number(zh ?? 0) > 23 || Number(zm ?? 0) > 59) return false;
  if (second === 60) {
    const offset = /^[+-]/.test(zone) ? (zone[0] === '+' ? 1 : -1) * (Number(zh) * 60 + Number(zm)) : 0;
    return ((Number(h) * 60 + Number(min) - offset) % 1440 + 1440) % 1440 === 1439;
  }
  return true;
}

if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', isDateTime);
