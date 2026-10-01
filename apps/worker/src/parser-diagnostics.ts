// Parser stderr is a diagnostic, not a verdict. The bridge fails closed on exit status, stdout shape,
// schema/version and timeout only; stderr is kept bounded and redacted next to the attempt.

export const PARSER_STDERR_CAPTURE_BYTES = 64 * 1024;
export const PARSER_STDERR_EXCERPT_CHARS = 4096;

export type ParserStderrClass =
  | 'PDF_WRONG_POINTING_OBJECT'
  | 'PDF_XREF_REPAIRED'
  | 'PDF_DUPLICATE_DICTIONARY_KEY'
  | 'PDF_FONT_DESCRIPTOR'
  | 'PYTHON_WARNING'
  | 'UNCLASSIFIED';

export type ParserStderrDiagnostic = {
  /** Total bytes the parser wrote to stderr, including bytes past the capture limit. */
  bytes: number;
  truncated: boolean;
  classes: ParserStderrClass[];
  unclassified_lines: number;
  /** Redacted and length-limited; never contains the staging path or credential-looking values. */
  excerpt: string;
};

const KNOWN: Array<[ParserStderrClass, RegExp]> = [
  ['PDF_WRONG_POINTING_OBJECT', /Ignoring wrong pointing object/i],
  ['PDF_XREF_REPAIRED', /(?:incorrect startxref|xref table not zero-indexed|Invalid parent xref|rebuild(?:ing)? xref)/i],
  ['PDF_DUPLICATE_DICTIONARY_KEY', /Multiple definitions in dictionary/i],
  ['PDF_FONT_DESCRIPTOR', /(?:FontDescriptor|FontBBox|unknown widths|Could not get FontBBox)/i],
  ['PYTHON_WARNING', /\b(?:Deprecation|User|Future|Runtime|Resource)Warning\b/],
];

export function redactParserStderr(text: string, privatePaths: string[] = []): string {
  let out = text;
  for (const path of privatePaths.filter(p => p.length > 1).sort((a, b) => b.length - a.length)) out = out.split(path).join('[path]');
  return out
    .replace(/\b(?:authorization|bearer|token|secret|password|passwd|api[_-]?key|access[_-]?key|sig|signature)\b\s*[:=]\s*\S+/gi, m => `${m.split(/[:=]/)[0]}=[redacted]`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [redacted]')
    .replace(/[A-Za-z]+:\/\/[^\s'"]+/g, '[url]')
    .replace(/(?:^|(?<=[\s'"(=:]))(?:\/[^\s'"():,]+)+/g, '[path]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[hex]')
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '[opaque]')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
}

export function classifyParserStderr(captured: Buffer, totalBytes: number, privatePaths: string[] = []): ParserStderrDiagnostic | null {
  if (totalBytes === 0) return null;
  const text = redactParserStderr(captured.toString('utf8'), privatePaths);
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const classes = new Set<ParserStderrClass>();
  let unclassified = 0;
  for (const line of lines) {
    const hit = KNOWN.find(([, pattern]) => pattern.test(line));
    if (hit) classes.add(hit[0]);
    // Python warning source lines ("  warnings.warn(...)") follow the classified line; don't count them twice.
    else if (!/^warnings\.warn\(/.test(line)) { unclassified++; classes.add('UNCLASSIFIED'); }
  }
  const truncated = totalBytes > captured.length || text.length > PARSER_STDERR_EXCERPT_CHARS;
  return {
    bytes: totalBytes,
    truncated,
    classes: [...classes].sort(),
    unclassified_lines: unclassified,
    excerpt: text.slice(0, PARSER_STDERR_EXCERPT_CHARS),
  };
}
