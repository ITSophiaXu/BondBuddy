/** A deliberately small PDF 1.x profile for one filled Sig on one page.
 * This parser checks the object bytes and cross-reference table. PDF.js separately checks the
 * rendered page. Neither parser validates CMS, certificates, or signer identity.
 */
import { SIGNED_PDF_PROFILE_VERSION, type SignatureAssessment } from '@bondbuddy/contracts';

export const MAX_SIGNED_PDF_BYTES = 16 * 1024 * 1024;
const MAX_OBJECTS = 64;
const MAX_DEPTH = 16;
const MAX_STRING_BYTES = 64 * 1024;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const white = /[\x00\x09\x0a\x0c\x0d\x20]/;
const delimiter = /[\x00\x09\x0a\x0c\x0d\x20()<>\[\]{}\/%]/;
const forbidden = new Set(['A', 'AA', 'OpenAction', 'JS', 'JavaScript', 'Launch', 'URI', 'GoToR', 'GoToE',
  'SubmitForm', 'ImportData', 'XFA', 'EmbeddedFiles', 'EmbeddedFile', 'FileAttachment', 'AF', 'RichMedia',
  '3D', 'Rendition', 'ResetForm', 'Hide', 'Sound', 'Movie', 'OLE', 'DDE', 'ObjStm', 'XRef', 'Encrypt', 'Prev', 'XRefStm']);

export class SignedPdfProfileError extends Error {}
function invalid(reason: string): never { throw new SignedPdfProfileError(reason); }
type PdfValue =
  | { kind: 'number'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'ref'; id: number }
  | { kind: 'array'; value: PdfValue[] }
  | { kind: 'dict'; value: Map<string, PdfValue> }
  | { kind: 'hex'; start: number; end: number; length: number }
  | { kind: 'string'; length: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' };
type PdfObject = { id: number; value: PdfValue; stream: { start: number; end: number } | null; end: number };

class Reader {
  constructor(readonly source: string, public pos: number) {}
  skip(): void {
    while (this.pos < this.source.length) {
      if (white.test(this.source[this.pos])) { this.pos++; continue; }
      if (this.source[this.pos] === '%') {
        while (this.pos < this.source.length && this.source[this.pos] !== '\n' && this.source[this.pos] !== '\r') this.pos++;
        continue;
      }
      return;
    }
  }
  token(value: string): boolean {
    this.skip();
    if (!this.source.startsWith(value, this.pos)) return false;
    const next = this.source[this.pos + value.length];
    if (/[A-Za-z]/.test(value[value.length - 1]) && next && !delimiter.test(next)) return false;
    this.pos += value.length;
    return true;
  }
  require(value: string): void { if (!this.token(value)) invalid(`expected_${value}`); }
  number(): number {
    this.skip();
    const match = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)/.exec(this.source.slice(this.pos, this.pos + 32));
    if (!match || (this.source[this.pos + match[0].length] && !delimiter.test(this.source[this.pos + match[0].length]))) invalid('number_invalid');
    this.pos += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) invalid('number_invalid');
    return value;
  }
  name(): string {
    this.skip();
    if (this.source[this.pos++] !== '/') invalid('name_missing');
    let value = '';
    while (this.pos < this.source.length && !delimiter.test(this.source[this.pos])) {
      let char = this.source[this.pos++];
      if (char === '#') {
        const hex = this.source.slice(this.pos, this.pos + 2);
        if (!/^[a-fA-F0-9]{2}$/.test(hex)) invalid('name_escape_invalid');
        char = String.fromCharCode(parseInt(hex, 16));
        this.pos += 2;
      }
      value += char;
      if (value.length > 128) invalid('name_limit');
    }
    if (!value || forbidden.has(value)) invalid('active_or_unsupported_name');
    return value;
  }
  value(depth = 0): PdfValue {
    if (depth > MAX_DEPTH) invalid('object_depth_limit');
    this.skip();
    if (this.source.startsWith('<<', this.pos)) {
      this.pos += 2;
      const value = new Map<string, PdfValue>();
      while (true) {
        this.skip();
        if (this.source.startsWith('>>', this.pos)) { this.pos += 2; break; }
        if (this.pos >= this.source.length || value.size >= 64) invalid('dictionary_limit');
        const key = this.name();
        if (value.has(key)) invalid('duplicate_dictionary_key');
        value.set(key, this.value(depth + 1));
      }
      return { kind: 'dict', value };
    }
    if (this.source[this.pos] === '[') {
      this.pos++;
      const value: PdfValue[] = [];
      while (true) {
        this.skip();
        if (this.source[this.pos] === ']') { this.pos++; break; }
        if (this.pos >= this.source.length || value.length >= 4096) invalid('array_limit');
        value.push(this.value(depth + 1));
      }
      return { kind: 'array', value };
    }
    if (this.source[this.pos] === '/') return { kind: 'name', value: this.name() };
    if (this.source[this.pos] === '<') {
      const start = this.pos++;
      let digits = 0;
      while (this.pos < this.source.length && this.source[this.pos] !== '>') {
        const char = this.source[this.pos++];
        if (white.test(char)) continue;
        if (!/[a-fA-F0-9]/.test(char)) invalid('hex_invalid');
        digits++;
        if (digits > MAX_STRING_BYTES * 2) invalid('hex_limit');
      }
      if (this.source[this.pos++] !== '>' || digits % 2 !== 0) invalid('hex_invalid');
      return { kind: 'hex', start, end: this.pos, length: digits / 2 };
    }
    if (this.source[this.pos] === '(') {
      this.pos++;
      const start = this.pos;
      let nesting = 1;
      while (this.pos < this.source.length && nesting > 0) {
        const char = this.source[this.pos++];
        if (char === '\\') { this.pos++; continue; }
        if (char === '(') nesting++;
        if (char === ')') nesting--;
        if (this.pos - start > MAX_STRING_BYTES || nesting > MAX_DEPTH) invalid('string_limit');
      }
      if (nesting !== 0) invalid('string_unterminated');
      return { kind: 'string', length: this.pos - start - 1 };
    }
    if (this.token('true')) return { kind: 'boolean', value: true };
    if (this.token('false')) return { kind: 'boolean', value: false };
    if (this.token('null')) return { kind: 'null' };
    const first = this.number();
    if (Number.isSafeInteger(first) && first >= 0) {
      const afterFirst = this.pos;
      try {
        const generation = this.number();
        if (generation === 0 && this.token('R')) return { kind: 'ref', id: first };
      } catch { /* The first number is still a valid value. */ }
      this.pos = afterFirst;
    }
    return { kind: 'number', value: first };
  }
}

function dict(value: PdfValue): Map<string, PdfValue> { if (value.kind !== 'dict') invalid('dictionary_required'); return value.value; }
function field(value: PdfValue, key: string): PdfValue { const found = dict(value).get(key); if (!found) invalid(`missing_${key}`); return found; }
function keys(value: PdfValue, allowed: readonly string[]): void {
  for (const key of dict(value).keys()) if (!allowed.includes(key)) invalid('dictionary_key_outside_profile');
}
function number(value: PdfValue): number { if (value.kind !== 'number' || !Number.isSafeInteger(value.value) || value.value < 0) invalid('integer_required'); return value.value; }
function name(value: PdfValue, expected: string): void { if (value.kind !== 'name' || value.value !== expected) invalid('name_mismatch'); }
function array(value: PdfValue, length: number): PdfValue[] { if (value.kind !== 'array' || value.value.length !== length) invalid('array_shape'); return value.value; }
function ref(value: PdfValue): number { if (value.kind !== 'ref') invalid('reference_required'); return value.id; }
function emptyDict(value: PdfValue): void { if (dict(value).size !== 0) invalid('resources_outside_profile'); }
function trivia(source: string, start: number, end: number): void { const reader = new Reader(source.slice(start, end), 0); reader.skip(); if (reader.pos !== end - start) invalid('hidden_or_unindexed_bytes'); }
function objectAt(source: string, offset: number, expectedId: number): PdfObject {
  const reader = new Reader(source, offset);
  const id = reader.number(), generation = reader.number();
  if (id !== expectedId || generation !== 0) invalid('xref_object_mismatch');
  reader.require('obj');
  const value = reader.value();
  let stream: PdfObject['stream'] = null;
  if (reader.token('stream')) {
    const length = number(field(value, 'Length'));
    if (length > MAX_STREAM_BYTES) invalid('stream_limit');
    if (source.startsWith('\r\n', reader.pos)) reader.pos += 2;
    else if (source[reader.pos] === '\n' || source[reader.pos] === '\r') reader.pos++;
    else invalid('stream_line_ending');
    stream = { start: reader.pos, end: reader.pos + length };
    if (stream.end > source.length) invalid('stream_bounds');
    reader.pos = stream.end;
    if (source.startsWith('\r\n', reader.pos)) reader.pos += 2;
    else if (source[reader.pos] === '\n' || source[reader.pos] === '\r') reader.pos++;
    reader.require('endstream');
  }
  reader.require('endobj');
  return { id, value, stream, end: reader.pos };
}

function parse(source: string): { objects: Map<number, PdfObject>; root: number } {
  if (!/^%PDF-1\.[4-7](?:\r\n|\n|\r)/.test(source)) invalid('pdf_header');
  const end = /startxref\s+([0-9]+)\s+%%EOF\s*$/.exec(source);
  if (!end || end.index < 1) invalid('pdf_trailer');
  const xrefAt = Number(end[1]);
  if (!Number.isSafeInteger(xrefAt) || xrefAt <= 0 || xrefAt >= end.index) invalid('xref_offset');
  const reader = new Reader(source, xrefAt);
  reader.require('xref');
  const entries = new Map<number, number>();
  const seen = new Set<number>();
  while (true) {
    reader.skip();
    if (reader.token('trailer')) break;
    const first = reader.number(), count = reader.number();
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || first < 0 || count < 1 || first + count > MAX_OBJECTS + 1) invalid('xref_limit');
    for (let index = 0; index < count; index++) {
      reader.skip();
      const match = /^(\d{10})\s(\d{5})\s([nf])(?:\s|\r|\n)/.exec(source.slice(reader.pos, reader.pos + 32));
      if (!match) invalid('xref_entry');
      reader.pos += match[0].length;
      const id = first + index;
      if (seen.has(id)) invalid('xref_duplicate');
      seen.add(id);
      if (match[3] === 'n') {
        if (match[2] !== '00000') invalid('xref_generation');
        entries.set(id, Number(match[1]));
      } else if (id !== 0 || match[1] !== '0000000000') invalid('xref_free_entry');
    }
  }
  const trailer = reader.value();
  keys(trailer, ['Size', 'Root']);
  const size = number(field(trailer, 'Size'));
  if (size !== seen.size || !seen.has(0) || [...seen].some(id => id >= size) || entries.size !== 6) invalid('xref_profile_shape');
  const root = ref(field(trailer, 'Root'));
  reader.require('startxref');
  if (reader.number() !== xrefAt) invalid('xref_offset_mismatch');
  reader.skip();
  if (reader.pos !== source.length) invalid('trailing_bytes');
  const ordered = [...entries].sort((a, b) => a[1] - b[1]);
  const headerEnd = source.search(/[\r\n]/) + 1;
  let cursor = headerEnd;
  const objects = new Map<number, PdfObject>();
  for (const [id, offset] of ordered) {
    if (offset < cursor || offset >= xrefAt) invalid('xref_order');
    trivia(source, cursor, offset);
    const object = objectAt(source, offset, id);
    if (object.end > xrefAt) invalid('object_bounds');
    objects.set(id, object);
    cursor = object.end;
  }
  trivia(source, cursor, xrefAt);
  return { objects, root };
}

export function validateSignedPdfProfile(bytes: Buffer): SignatureAssessment {
  if (bytes.length < 100 || bytes.length > MAX_SIGNED_PDF_BYTES) invalid('signed_pdf_size_limit');
  const source = bytes.toString('latin1');
  const { objects, root } = parse(source);
  const get = (id: number): PdfObject => { const found = objects.get(id); if (!found) invalid('unresolved_reference'); return found; };
  const catalog = get(root);
  keys(catalog.value, ['Type', 'Pages', 'AcroForm']);
  name(field(catalog.value, 'Type'), 'Catalog');
  const pagesId = ref(field(catalog.value, 'Pages'));
  const acro = field(catalog.value, 'AcroForm');
  keys(acro, ['Fields', 'SigFlags']);
  if (number(field(acro, 'SigFlags')) !== 3) invalid('sig_flags');
  const widgetId = ref(array(field(acro, 'Fields'), 1)[0]);
  const pages = get(pagesId);
  keys(pages.value, ['Type', 'Kids', 'Count']);
  name(field(pages.value, 'Type'), 'Pages');
  if (number(field(pages.value, 'Count')) !== 1) invalid('page_count');
  const pageId = ref(array(field(pages.value, 'Kids'), 1)[0]);
  const page = get(pageId);
  keys(page.value, ['Type', 'Parent', 'MediaBox', 'Resources', 'Contents', 'Annots']);
  name(field(page.value, 'Type'), 'Page');
  if (ref(field(page.value, 'Parent')) !== pagesId) invalid('page_parent');
  for (const value of array(field(page.value, 'MediaBox'), 4)) number(value);
  emptyDict(field(page.value, 'Resources'));
  if (ref(array(field(page.value, 'Annots'), 1)[0]) !== widgetId) invalid('widget_page_link');
  const contentId = ref(field(page.value, 'Contents'));
  const content = get(contentId);
  keys(content.value, ['Length']);
  if (!content.stream || number(field(content.value, 'Length')) !== content.stream.end - content.stream.start) invalid('page_stream');
  const widget = get(widgetId);
  keys(widget.value, ['Type', 'Subtype', 'FT', 'T', 'Rect', 'P', 'F', 'V', 'AP']);
  name(field(widget.value, 'Type'), 'Annot');
  name(field(widget.value, 'Subtype'), 'Widget');
  name(field(widget.value, 'FT'), 'Sig');
  if (field(widget.value, 'T').kind !== 'string' || (field(widget.value, 'T') as { length: number }).length < 1) invalid('field_name');
  for (const value of array(field(widget.value, 'Rect'), 4)) number(value);
  if (ref(field(widget.value, 'P')) !== pageId || number(field(widget.value, 'F')) !== 4) invalid('widget_link_or_flags');
  const signature = field(widget.value, 'V');
  keys(signature, ['Type', 'Filter', 'SubFilter', 'ByteRange', 'Contents']);
  name(field(signature, 'Type'), 'Sig');
  name(field(signature, 'Filter'), 'Adobe.PPKLite');
  name(field(signature, 'SubFilter'), 'adbe.pkcs7.detached');
  const contents = field(signature, 'Contents');
  if (contents.kind !== 'hex' || contents.length < 1 || contents.length > MAX_STRING_BYTES) invalid('signature_contents');
  if (/^0+$/.test(source.slice(contents.start + 1, contents.end - 1).replace(/[\x00\x09\x0a\x0c\x0d\x20]/g, ''))) invalid('signature_contents_blank');
  const ranges = array(field(signature, 'ByteRange'), 4).map(number);
  if (ranges[0] !== 0 || ranges[1] !== contents.start || ranges[2] !== contents.end || ranges[3] !== bytes.length - contents.end) invalid('signature_byte_range');
  const appearance = field(widget.value, 'AP');
  keys(appearance, ['N']);
  const appearanceId = ref(field(appearance, 'N'));
  const form = get(appearanceId);
  keys(form.value, ['Type', 'Subtype', 'BBox', 'Resources', 'Length']);
  name(field(form.value, 'Type'), 'XObject');
  name(field(form.value, 'Subtype'), 'Form');
  for (const value of array(field(form.value, 'BBox'), 4)) number(value);
  emptyDict(field(form.value, 'Resources'));
  if (!form.stream || number(field(form.value, 'Length')) !== form.stream.end - form.stream.start) invalid('appearance_stream');
  const expected = new Set([root, pagesId, pageId, contentId, widgetId, appearanceId]);
  if (expected.size !== 6 || [...objects.keys()].some(id => !expected.has(id))) invalid('hidden_object');
  return { status: 'signature_unverified', profile_version: SIGNED_PDF_PROFILE_VERSION, signature_count: 1 };
}
