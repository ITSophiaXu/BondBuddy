/** Exact, bounded arithmetic for document values. Rounding happens only at display. */
export interface Rational { numerator: bigint; denominator: bigint }
export const MONEY_UNITS = { '元': 0, '千元': 3, '万元': 4, '亿元': 8 } as const;

export function decimal(value: string): Rational {
  if (value.length > 200 || !/^[+-]?\d+(?:\.\d+)?$/.test(value)) throw new Error('UPDATE_INVALID_DECIMAL');
  const [whole, fraction = ''] = value.replace(/^[+-]/, '').split('.');
  const sign = value.startsWith('-') ? -1n : 1n;
  return { numerator: sign * BigInt(whole + fraction), denominator: 10n ** BigInt(fraction.length) };
}

export function add(left: Rational, right: Rational): Rational {
  return { numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator };
}
export function subtract(left: Rational, right: Rational): Rational {
  return add(left, { numerator: -right.numerator, denominator: right.denominator });
}
export function divide(left: Rational, right: Rational): Rational {
  if (right.numerator === 0n) throw new Error('UPDATE_ZERO_DENOMINATOR');
  const sign = right.numerator < 0n ? -1n : 1n;
  return { numerator: sign * left.numerator * right.denominator,
    denominator: sign * left.denominator * right.numerator };
}
export function scale(value: Rational, multiplier: bigint): Rational {
  return { numerator: value.numerator * multiplier, denominator: value.denominator };
}
export function convert(value: Rational, from: string, to: string): Rational {
  if (from === to) return value;
  if (!Object.hasOwn(MONEY_UNITS, from) || !Object.hasOwn(MONEY_UNITS, to)) throw new Error('UPDATE_UNIT_MISMATCH');
  const power = MONEY_UNITS[from as keyof typeof MONEY_UNITS] - MONEY_UNITS[to as keyof typeof MONEY_UNITS];
  return power >= 0 ? scale(value, 10n ** BigInt(power))
    : { numerator: value.numerator, denominator: value.denominator * 10n ** BigInt(-power) };
}
export function equal(left: Rational, right: Rational): boolean {
  return left.numerator * right.denominator === right.numerator * left.denominator;
}

/** Round half away from zero. Never round a source before a ratio or unit conversion. */
export function display(value: Rational, places: number, groupThousands: boolean): string {
  if (!Number.isInteger(places) || places < 0 || places > 12 || value.denominator <= 0n) throw new Error('UPDATE_INVALID_DISPLAY');
  const factor = 10n ** BigInt(places);
  const magnitude = (value.numerator < 0n ? -value.numerator : value.numerator) * factor;
  let rounded = magnitude / value.denominator;
  if ((magnitude % value.denominator) * 2n >= value.denominator) rounded += 1n;
  const digits = rounded.toString().padStart(places + 1, '0');
  let integer = places ? digits.slice(0, -places) : digits;
  if (groupThousands) integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${value.numerator < 0n && rounded !== 0n ? '-' : ''}${integer}${places ? '.' + digits.slice(-places) : ''}`;
}
