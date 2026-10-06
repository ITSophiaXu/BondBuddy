import { PDFArray, PDFDict, PDFParser, PDFHexString, PDFName, PDFNumber, PDFObject, PDFRef, PDFStream } from 'pdf-lib';
import { MULTIPAGE_SIGNED_PDF_PROFILE_VERSION, type SignatureAssessment } from '@bondbuddy/contracts';
import { MAX_SIGNED_PDF_BYTES, SignedPdfProfileError } from './signed-pdf-profile.js';

// Reads the object graph; never rewrites the upload or verifies CMS/certificates.
// PDF.js independently checks every page and its actions before this profile runs.
const prohibited = new Set(['A','AA','OpenAction','JS','JavaScript','Launch','URI','GoToR','GoToE','SubmitForm','ImportData',
  'XFA','EmbeddedFiles','EmbeddedFile','FileAttachment','AF','RichMedia','3D','Rendition','ResetForm','Hide','Sound','Movie','OLE','DDE','Encrypt','ObjStm','XRef','XRefStm']);
const widgetKeys = new Set(['Type','Subtype','FT','T','V','F','Rect','P','AP','DR']);
const signatureKeys = new Set(['Type','Filter','SubFilter','ByteRange','Contents','Reason','Location','ContactInfo','M','Name','Prop_Build']);
function invalid(reason: string): never { throw new SignedPdfProfileError(reason); }
const key = PDFName.of;
const named = (object: PDFObject | undefined, value: string) => object instanceof PDFName && object.decodeText() === value;

// Inspect names and duplicate keys before pdf-lib normalizes dictionaries, including
// earlier revisions. Object/xref streams stay outside this bounded classic profile.
class InspectionParser extends PDFParser {
  readonly hexOffsets = new Map<PDFHexString, { start: number; end: number }>();
  private depth = 0;
  private values = 0;
  override parseObject(): PDFObject {
    if (++this.depth > 64 || ++this.values > 200000) invalid('multipage_lexical_limit');
    try { return super.parseObject(); } finally { this.depth--; }
  }
  protected override parseName(): PDFName {
    const name = super.parseName();
    if (prohibited.has(name.decodeText())) invalid('active_pdf_name');
    return name;
  }
  protected override parseHexString(): PDFHexString {
    const start = this.bytes.offset(), value = super.parseHexString();
    this.hexOffsets.set(value, { start, end: this.bytes.offset() });
    return value;
  }
  protected override parseDict(): PDFDict {
    this.bytes.assertNext(60); this.bytes.assertNext(60);
    this.skipWhitespaceAndComments();
    const entries = new Map<PDFName, PDFObject>();
    while (!this.bytes.done() && this.bytes.peek() !== 62) {
      if (entries.size >= 4096) invalid('dictionary_limit');
      const name = this.parseName();
      if (entries.has(name)) invalid('duplicate_dictionary_key');
      entries.set(name, this.parseObject());
      this.skipWhitespaceAndComments();
    }
    this.bytes.assertNext(62); this.bytes.assertNext(62);
    return PDFDict.fromMapWithContext(entries, this.context);
  }
}

export async function validateMultipageSignedPdf(bytes: Buffer, expectedWidgets: number, expectedPages: number): Promise<SignatureAssessment> {
  if (bytes.length > MAX_SIGNED_PDF_BYTES || expectedPages < 2 || expectedPages > 1500 || expectedWidgets < 1 || expectedWidgets > 1500)
    invalid('multipage_profile_limit');
  const parser = new InspectionParser(bytes, 100, true);
  const context = await parser.parseDocument().catch(() => invalid('multipage_parse_profile'));
  if (context.trailerInfo.Encrypt) invalid('encrypted_pdf');
  const objects = context.enumerateIndirectObjects();
  if (objects.length > 20000) invalid('multipage_object_limit');
  const visited = new Set<PDFObject>(), widgets = new Set<PDFDict>(), signatures = new Set<PDFDict>();
  let entries = 0, latestSignedEnd = 0;
  const resolve = (object: PDFObject | undefined): PDFObject => {
    if (!object) invalid('missing_pdf_value');
    const value = object instanceof PDFRef ? context.lookup(object) : object;
    if (!value) invalid('unresolved_pdf_reference');
    return value;
  };
  const checkedForms = new Set<PDFStream>();
  const checkForm = (form: PDFStream, path = new Set<PDFStream>()) => {
    if (path.has(form) || path.size > 64) invalid('recursive_appearance');
    if (checkedForms.has(form)) return;
    const next = new Set(path).add(form);
    const resources = form.dict.lookupMaybe(key('Resources'), PDFDict);
    const xobjects = resources?.lookupMaybe(key('XObject'), PDFDict);
    if (xobjects) for (const child of xobjects.values()) {
      const stream = resolve(child);
      if (!(stream instanceof PDFStream)) invalid('appearance_resource');
      if (named(stream.dict.get(key('Subtype')), 'Form')) checkForm(stream, next);
    }
    checkedForms.add(form);
  };
  const signature = (value: PDFObject | undefined) => {
    const dict = resolve(value);
    if (!(dict instanceof PDFDict)) invalid('signature_value');
    if (signatures.has(dict)) return;
    if (dict.keys().some(k => !signatureKeys.has(k.decodeText())) || !named(dict.get(key('Type')), 'Sig') ||
      !named(dict.get(key('Filter')), 'Adobe.PPKLite') || !named(dict.get(key('SubFilter')), 'adbe.pkcs7.detached'))
      invalid('signature_dictionary');
    const contents = resolve(dict.get(key('Contents'))), range = resolve(dict.get(key('ByteRange')));
    if (!(contents instanceof PDFHexString) || !(range instanceof PDFArray) || range.size() !== 4) invalid('signature_range_shape');
    const signed = contents.asBytes();
    if (!signed.length || signed.length > 65536 || !signed.some(b => b !== 0)) invalid('signature_contents');
    const numbers = range.asArray().map(v => {
      const n = resolve(v);
      if (!(n instanceof PDFNumber) || !Number.isSafeInteger(n.asNumber()) || n.asNumber() < 0) invalid('signature_range_number');
      return n.asNumber();
    });
    const [start, gapStart, gapEnd, tail] = numbers, end = gapEnd + tail;
    if (start !== 0 || gapStart < 1 || gapEnd <= gapStart || end > bytes.length || tail < 1 ||
      gapEnd - gapStart > 131074) invalid('signature_byte_range');
    const token = parser.hexOffsets.get(contents);
    if (!token || token.start !== gapStart || token.end !== gapEnd) invalid('signature_contents_location');
    const gap = bytes.subarray(gapStart, gapEnd).toString('ascii');
    if (!/^<[0-9a-fA-F\s]+>$/.test(gap)) invalid('signature_contents_gap');
    const hex = gap.slice(1, -1).replace(/\s/g, '');
    if (hex.length % 2 || !Buffer.from(hex, 'hex').equals(Buffer.from(signed))) invalid('signature_contents_binding');
    if (!/%%EOF\s*$/.test(bytes.subarray(Math.max(0, end - 80), end).toString('ascii'))) invalid('signature_revision_end');
    latestSignedEnd = Math.max(latestSignedEnd, end);
    signatures.add(dict);
  };
  const walk = (object: PDFObject, depth = 0): void => {
    if (depth > 64 || ++entries > 200000) invalid('multipage_graph_limit');
    const value = resolve(object);
    if (visited.has(value)) return;
    visited.add(value);
    if (value instanceof PDFName) { if (prohibited.has(value.decodeText())) invalid('active_pdf_name'); return; }
    if (value instanceof PDFStream) { walk(value.dict, depth + 1); return; }
    if (value instanceof PDFArray) { for (const child of value.asArray()) walk(child, depth + 1); return; }
    if (!(value instanceof PDFDict)) return;
    if (value.keys().some(k => prohibited.has(k.decodeText()))) invalid('active_pdf_dictionary');
    if (value.has(key('FT')) && !named(value.get(key('FT')), 'Sig')) invalid('non_signature_field');
    if (named(value.get(key('Subtype')), 'Widget')) {
      if (!named(value.get(key('FT')), 'Sig') || value.keys().some(k => !widgetKeys.has(k.decodeText()))) invalid('widget_dictionary');
      signature(value.get(key('V')));
      const appearance = resolve(value.get(key('AP')));
      if (!(appearance instanceof PDFDict) || appearance.keys().some(k => k.decodeText() !== 'N') ||
        !(resolve(appearance.get(key('N'))) instanceof PDFStream)) invalid('signature_appearance');
      checkForm(resolve(appearance.get(key('N'))) as PDFStream);
      widgets.add(value);
    }
    for (const child of value.values()) walk(child, depth + 1);
  };
  // Includes unreferenced current objects, not only the visible page tree.
  for (const [, value] of objects) walk(value);
  const pageWidgets = new Set<PDFDict>();
  let widgetAppearances = 0;
  const pages = objects.map(([, value]) => value).filter((value): value is PDFDict => value instanceof PDFDict && named(value.get(key('Type')), 'Page'));
  if (pages.length !== expectedPages) invalid('multipage_document_mismatch');
  for (const page of pages) {
    const annotations = page.lookupMaybe(key('Annots'), PDFArray);
    if (!annotations) continue;
    for (const ref of annotations.asArray()) {
      const annotation = resolve(ref);
      if (annotation instanceof PDFDict && named(annotation.get(key('Subtype')), 'Widget')) {
        if (!widgets.has(annotation)) invalid('widget_page_binding');
        widgetAppearances++;
        pageWidgets.add(annotation);
      }
    }
  }
  if (widgetAppearances !== expectedWidgets || pageWidgets.size !== widgets.size || !signatures.size ||
    signatures.size > 1500 || latestSignedEnd !== bytes.length) invalid('unsigned_revision_or_widget_mismatch');
  return { status: 'signature_unverified', profile_version: MULTIPAGE_SIGNED_PDF_PROFILE_VERSION, signature_count: signatures.size };
}
