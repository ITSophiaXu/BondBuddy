/** Lossless field-name deduplication, not summarisation or relevance filtering. */
export function promptTable<T extends Record<string, unknown>>(records: readonly T[]) {
  const columns = records.length ? Object.keys(records[0]!) : [];
  if (records.some(record => Object.keys(record).length !== columns.length ||
    columns.some(key => !Object.hasOwn(record, key)))) throw new Error('UPDATE_PROMPT_TABLE_SHAPE');
  return { columns, rows: records.map(record => columns.map(key => record[key])) };
}

/** All rules, source quotes, locators, applicability, exceptions and unknown states remain. */
export function historicalRulePrompt(guidance: Record<string, unknown>): Record<string, unknown> {
  const result = { ...guidance };
  for (const key of ['rules', 'sources']) {
    const rows = result[key];
    if (Array.isArray(rows) && rows.length) result[key] = promptTable(rows);
  }
  const coverage = result.coverage;
  if (coverage && typeof coverage === 'object' && !Array.isArray(coverage)) {
    const value = coverage as Record<string, unknown>;
    if (Array.isArray(value.items) && value.items.length)
      result.coverage = { ...value, items: promptTable(value.items) };
  }
  return result;
}
