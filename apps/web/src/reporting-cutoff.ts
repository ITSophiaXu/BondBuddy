// Presentation choices from product-prototype/public/project-workspace.js:basics.
// A selected cutoff does not infer a reporting-period set or evidence status.
export const QUARTER_ENDS = [
  ['03-31', '3月末'], ['06-30', '6月末'], ['09-30', '9月末'], ['12-31', '年末']
] as const;

export function quarterCutoff(year: string, quarter: string): string | null {
  return /^\d{4}$/.test(year) && Number(year) >= 1 && QUARTER_ENDS.some(([value]) => value === quarter)
    ? `${year}-${quarter}` : null;
}

export function cutoffSelection(cutoff: string | null, currentYear = new Date().getFullYear()) {
  const year = cutoff?.match(/^(\d{4})-/)?.[1] ?? String(currentYear);
  const quarter = cutoff?.slice(5) ?? '';
  const selected = quarterCutoff(year, quarter) === cutoff && cutoff !== null;
  const years = Array.from({length: Math.max(1, currentYear - 1998)}, (_, i) => String(currentYear + 1 - i));
  if (!years.includes(year)) years.push(year);
  return { year, quarter: selected ? quarter : '', years, legacy: cutoff !== null && !selected };
}
