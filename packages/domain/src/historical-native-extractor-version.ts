/** Parse the version tuple embedded in native historical-recognition evidence. */
export function parseHistoricalNativeExtractorVersion(value: unknown): { algorithmVersion: string; parserVersion: string } | null {
  if (typeof value !== 'string') return null;
  const separator = value.indexOf('/');
  if (separator < 1) return null;
  const algorithmVersion = value.slice(0, separator);
  const parserVersion = value.slice(separator + 1);
  if (!['historical-native-recognition-v1', 'historical-native-recognition-v2'].includes(algorithmVersion) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(parserVersion) || parserVersion === 'unknown-parser') return null;
  return { algorithmVersion, parserVersion };
}
