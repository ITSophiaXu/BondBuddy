import { inflateRawSync } from 'node:zlib';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { digest } from './data.js';

export const WORD_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const WORD_DELIVERY_VALIDATOR_VERSION = 'ooxml-docx-v1';
export const GENERATED_WORD_DELIVERY_VERSION = 'generated-word-download-v1';

export const DOCX_LIMITS = Object.freeze({
  archiveBytes: 64 * 1024 * 1024,
  entries: 2048,
  partBytes: 32 * 1024 * 1024,
  totalUncompressedBytes: 128 * 1024 * 1024,
  xmlPartBytes: 8 * 1024 * 1024,
  totalXmlBytes: 32 * 1024 * 1024,
  compressionRatio: 200
});

const CONTENT_TYPES = '[Content_Types].xml';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MAIN_DOCUMENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const RELS_CONTENT_TYPE = 'application/vnd.openxmlformats-package.relationships+xml';

export type DocxQualityStatus = 'passed' | 'failed';
export type DocxInspection = {
  schema_version: 1;
  validator_version: string;
  quality_status: DocxQualityStatus;
  byte_size: number;
  sha256: string;
  zip: { entry_count: number; compressed_bytes: number; uncompressed_bytes: number };
  checks: {
    zip_structure: 'passed' | 'failed' | 'not_run';
    entry_integrity: 'passed' | 'failed' | 'not_run';
    xml_well_formedness: 'passed' | 'failed' | 'not_run';
    ooxml_relationships: 'passed' | 'failed' | 'not_run';
    word_document: 'passed' | 'failed' | 'not_run';
  };
  required_parts: string[];
  relationship_count: number;
  failure_codes: string[];
  validation_scope?: 'file_availability';
  content_review?: 'not_performed';
};

/** Generated Word delivery does not parse or judge content, layout or revisions.
 * `passed` here means only a bounded file candidate; Blob readback is recorded separately.
 * Keep the distinct version and not_run checks so this cannot be mistaken for OOXML review.
 */
export function inspectGeneratedWord(bytes: Buffer): DocxInspection {
  const valid = Buffer.isBuffer(bytes) && bytes.length >= 4 && bytes.length <= DOCX_LIMITS.archiveBytes
    && bytes.readUInt32LE(0) === 0x04034b50;
  return {
    schema_version: 1, validator_version: GENERATED_WORD_DELIVERY_VERSION,
    quality_status: valid ? 'passed' : 'failed', validation_scope: 'file_availability', content_review: 'not_performed',
    byte_size: Buffer.isBuffer(bytes) ? bytes.length : 0,
    sha256: digest(Buffer.isBuffer(bytes) ? bytes : Buffer.alloc(0)),
    zip: { entry_count: 0, compressed_bytes: 0, uncompressed_bytes: 0 },
    checks: { zip_structure: 'not_run', entry_integrity: 'not_run', xml_well_formedness: 'not_run', ooxml_relationships: 'not_run', word_document: 'not_run' },
    required_parts: [], relationship_count: 0, failure_codes: valid ? [] : ['WORD_FILE_UNAVAILABLE']
  };
}

type ZipEntry = {
  name: string;
  nameBytes: Buffer;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  directory: boolean;
  dataOffset: number;
  recordEnd: number;
};
type XmlNode = Record<string, unknown>;
type ParsedXml = { rootName: string; root: XmlNode };
type Relationship = { id: string; type: string; target: string; external: boolean };

class InspectionFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: false,
  removeNSPrefix: false,
  allowBooleanAttributes: false,
  ignoreDeclaration: false,
  ignorePiTags: false,
  commentPropName: '#comment'
});

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function fail(code: string): never { throw new InspectionFailure(code); }
function hasRange(bytes: Buffer, offset: number, length: number): boolean {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset + length <= bytes.length;
}
function readU16(bytes: Buffer, offset: number): number {
  if (!hasRange(bytes, offset, 2)) fail('DOCX_ZIP_INVALID');
  return bytes.readUInt16LE(offset);
}
function readU32(bytes: Buffer, offset: number): number {
  if (!hasRange(bytes, offset, 4)) fail('DOCX_ZIP_INVALID');
  return bytes.readUInt32LE(offset);
}

function inspectExtraFields(bytes: Buffer, start: number, length: number) {
  const end = start + length;
  if (!hasRange(bytes, start, length)) fail('DOCX_ZIP_INVALID');
  let offset = start;
  while (offset < end) {
    if (end - offset < 4) fail('DOCX_ZIP_INVALID');
    const tag = readU16(bytes, offset), fieldLength = readU16(bytes, offset + 2);
    offset += 4;
    if (offset + fieldLength > end) fail('DOCX_ZIP_INVALID');
    if (tag === 0x0001) fail('DOCX_ZIP64_UNSUPPORTED');
    if (tag === 0x9901) fail('DOCX_ENCRYPTED');
    offset += fieldLength;
  }
}

function safePartName(raw: Buffer): string {
  let name: string;
  try { name = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { return fail('DOCX_PART_NAME_INVALID'); }
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) fail('DOCX_PART_NAME_INVALID');
  if (name.length > 4096 || /[\u0000-\u001f\u007f]/.test(name)) fail('DOCX_PART_NAME_INVALID');
  if (/%(?:2f|5c)/i.test(name)) fail('DOCX_PART_NAME_INVALID');
  let decoded: string;
  try { decoded = decodeURIComponent(name); }
  catch { return fail('DOCX_PART_NAME_INVALID'); }
  if (decoded.includes('\\') || decoded.startsWith('/') || /^[A-Za-z]:/.test(decoded) || /[\u0000-\u001f\u007f]/.test(decoded)) fail('DOCX_PART_NAME_INVALID');
  const segments = decoded.split('/');
  const directory = decoded.endsWith('/');
  for (const segment of segments) {
    if (!segment && directory && segment === segments.at(-1)) continue;
    if (!segment || segment === '.' || segment === '..') fail('DOCX_PART_NAME_INVALID');
  }
  return name;
}

function canonicalPartName(name: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(name); }
  catch { return fail('DOCX_PART_NAME_INVALID'); }
  if (decoded.includes('\\') || decoded.startsWith('/') || /^[A-Za-z]:/.test(decoded) || /[\u0000-\u001f\u007f]/.test(decoded)) fail('DOCX_PART_NAME_INVALID');
  const directory = decoded.endsWith('/');
  const path = directory ? decoded.slice(0, -1) : decoded;
  if (!path || path.split('/').some(part => !part || part === '.' || part === '..')) fail('DOCX_PART_NAME_INVALID');
  return directory ? `${path}/` : path;
}

function parseZipDirectory(bytes: Buffer, report: DocxInspection): ZipEntry[] {
  if (bytes.length < 22) fail('DOCX_ZIP_INVALID');
  if (bytes.length > DOCX_LIMITS.archiveBytes) fail('DOCX_ARCHIVE_SIZE_LIMIT');
  const eocdOffset = bytes.length - 22;
  if (readU32(bytes, eocdOffset) !== 0x06054b50) fail('DOCX_ZIP_TRAILING_OR_POLYGLOT');
  if (readU16(bytes, eocdOffset + 20) !== 0) fail('DOCX_ZIP_TRAILING_OR_POLYGLOT');
  const disk = readU16(bytes, eocdOffset + 4);
  const centralDisk = readU16(bytes, eocdOffset + 6);
  const diskCount = readU16(bytes, eocdOffset + 8);
  const totalCount = readU16(bytes, eocdOffset + 10);
  const centralSize = readU32(bytes, eocdOffset + 12);
  const centralOffset = readU32(bytes, eocdOffset + 16);
  if (disk !== 0 || centralDisk !== 0 || diskCount !== totalCount || totalCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('DOCX_ZIP_UNSUPPORTED');
  if (totalCount < 1 || totalCount > DOCX_LIMITS.entries) fail('DOCX_ENTRY_COUNT_LIMIT');
  if (centralOffset + centralSize !== eocdOffset || !hasRange(bytes, centralOffset, centralSize)) fail('DOCX_ZIP_TRAILING_OR_POLYGLOT');

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  const foldedNames = new Set<string>();
  let cursor = centralOffset, totalUncompressed = 0, totalCompressed = 0;
  for (let index = 0; index < totalCount; index++) {
    if (!hasRange(bytes, cursor, 46) || readU32(bytes, cursor) !== 0x02014b50) fail('DOCX_ZIP_INVALID');
    const madeBy = readU16(bytes, cursor + 4);
    const needed = readU16(bytes, cursor + 6);
    const flags = readU16(bytes, cursor + 8);
    const method = readU16(bytes, cursor + 10);
    const crc = readU32(bytes, cursor + 16);
    const compressedSize = readU32(bytes, cursor + 20);
    const uncompressedSize = readU32(bytes, cursor + 24);
    const nameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const commentLength = readU16(bytes, cursor + 32);
    const startDisk = readU16(bytes, cursor + 34);
    const externalAttributes = readU32(bytes, cursor + 38);
    const localOffset = readU32(bytes, cursor + 42);
    const headerLength = 46 + nameLength + extraLength + commentLength;
    if (!hasRange(bytes, cursor, headerLength) || cursor + headerLength > eocdOffset || commentLength !== 0) fail('DOCX_ZIP_INVALID');
    if (startDisk !== 0 || localOffset === 0xffffffff || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) fail('DOCX_ZIP64_UNSUPPORTED');
    if (needed > 20) fail('DOCX_ZIP_UNSUPPORTED');
    if (flags & (0x0001 | 0x0040 | 0x2000)) fail('DOCX_ENCRYPTED');
    const allowedFlags = 0x0006 | 0x0008 | 0x0800;
    if ((flags & ~allowedFlags) !== 0) fail('DOCX_ZIP_UNSUPPORTED');
    if (method !== 0 && method !== 8) fail('DOCX_ZIP_UNSUPPORTED');
    if (compressedSize === 0 && uncompressedSize !== 0) fail('DOCX_COMPRESSION_RATIO_LIMIT');
    if (compressedSize > 0 && uncompressedSize > compressedSize * DOCX_LIMITS.compressionRatio) fail('DOCX_COMPRESSION_RATIO_LIMIT');
    if (uncompressedSize > DOCX_LIMITS.partBytes) fail('DOCX_PART_SIZE_LIMIT');
    totalUncompressed += uncompressedSize;
    totalCompressed += compressedSize;
    if (totalUncompressed > DOCX_LIMITS.totalUncompressedBytes) fail('DOCX_TOTAL_SIZE_LIMIT');

    const nameStart = cursor + 46;
    const nameBytes = Buffer.from(bytes.subarray(nameStart, nameStart + nameLength));
    const name = safePartName(nameBytes);
    const canonical = canonicalPartName(name);
    const folded = canonical.toLocaleLowerCase('en-US');
    if (names.has(canonical) || foldedNames.has(folded)) fail('DOCX_DUPLICATE_PART');
    names.add(canonical); foldedNames.add(folded);
    inspectExtraFields(bytes, nameStart + nameLength, extraLength);

    if (madeBy >>> 8 === 3) {
      const unixMode = externalAttributes >>> 16;
      const fileType = unixMode & 0o170000;
      if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) fail('DOCX_UNSAFE_PART_TYPE');
      if (fileType === 0o040000 && (uncompressedSize !== 0 || compressedSize !== 0)) fail('DOCX_ZIP_INVALID');
    }
    const directory = name.endsWith('/');
    if (directory && (uncompressedSize !== 0 || compressedSize !== 0)) fail('DOCX_ZIP_INVALID');
    entries.push({ name: canonical, nameBytes, flags, method, crc32: crc, compressedSize, uncompressedSize, localOffset, directory, dataOffset: 0, recordEnd: 0 });
    cursor += headerLength;
  }
  if (cursor !== centralOffset + centralSize) fail('DOCX_ZIP_INVALID');

  report.zip.entry_count = entries.length;
  report.zip.compressed_bytes = totalCompressed;
  report.zip.uncompressed_bytes = totalUncompressed;
  const localOrder = [...entries].sort((left, right) => left.localOffset - right.localOffset);
  let expectedOffset = 0;
  for (const entry of localOrder) {
    if (entry.localOffset !== expectedOffset || !hasRange(bytes, entry.localOffset, 30) || readU32(bytes, entry.localOffset) !== 0x04034b50) fail('DOCX_ZIP_TRAILING_OR_POLYGLOT');
    const localNeeded = readU16(bytes, entry.localOffset + 4);
    const localFlags = readU16(bytes, entry.localOffset + 6);
    const localMethod = readU16(bytes, entry.localOffset + 8);
    const localCrc = readU32(bytes, entry.localOffset + 14);
    const localCompressed = readU32(bytes, entry.localOffset + 18);
    const localUncompressed = readU32(bytes, entry.localOffset + 22);
    const localNameLength = readU16(bytes, entry.localOffset + 26);
    const localExtraLength = readU16(bytes, entry.localOffset + 28);
    const localHeaderLength = 30 + localNameLength + localExtraLength;
    if (localNeeded > 20 || localFlags !== entry.flags || localMethod !== entry.method || localNameLength !== entry.nameBytes.length || !hasRange(bytes, entry.localOffset, localHeaderLength)) fail('DOCX_ZIP_INVALID');
    const localName = bytes.subarray(entry.localOffset + 30, entry.localOffset + 30 + localNameLength);
    if (!localName.equals(entry.nameBytes)) fail('DOCX_ZIP_INVALID');
    inspectExtraFields(bytes, entry.localOffset + 30 + localNameLength, localExtraLength);
    const hasDescriptor = (entry.flags & 0x0008) !== 0;
    if (hasDescriptor) {
      if ((localCrc !== 0 && localCrc !== entry.crc32) || (localCompressed !== 0 && localCompressed !== entry.compressedSize) || (localUncompressed !== 0 && localUncompressed !== entry.uncompressedSize)) fail('DOCX_ZIP_INVALID');
    } else if (localCrc !== entry.crc32 || localCompressed !== entry.compressedSize || localUncompressed !== entry.uncompressedSize) {
      fail('DOCX_ZIP_INVALID');
    }
    entry.dataOffset = entry.localOffset + localHeaderLength;
    let recordEnd = entry.dataOffset + entry.compressedSize;
    if (recordEnd > centralOffset || !hasRange(bytes, entry.dataOffset, entry.compressedSize)) fail('DOCX_ZIP_INVALID');
    if (hasDescriptor) {
      let descriptor = recordEnd;
      if (readU32(bytes, descriptor) === 0x08074b50) descriptor += 4;
      if (!hasRange(bytes, descriptor, 12) || readU32(bytes, descriptor) !== entry.crc32 || readU32(bytes, descriptor + 4) !== entry.compressedSize || readU32(bytes, descriptor + 8) !== entry.uncompressedSize) fail('DOCX_ZIP_INVALID');
      recordEnd = descriptor + 12;
    }
    entry.recordEnd = recordEnd;
    expectedOffset = recordEnd;
  }
  if (expectedOffset !== centralOffset) fail('DOCX_ZIP_TRAILING_OR_POLYGLOT');
  report.checks.zip_structure = 'passed';
  return entries;
}

function isXmlPart(name: string): boolean { return name.toLowerCase().endsWith('.xml') || name.toLowerCase().endsWith('.rels'); }

function parseXmlPart(name: string, bytes: Buffer): ParsedXml {
  let xml: string;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return fail('DOCX_XML_ENCODING_INVALID'); }
  if (xml.startsWith('\uFEFF')) xml = xml.slice(1);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) fail('DOCX_XML_DTD_FORBIDDEN');
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validation !== true) fail('DOCX_XML_MALFORMED');
  const parsed = xmlParser.parse(xml) as XmlNode;
  const rootNames = Object.keys(parsed).filter(key => key !== '?xml' && key !== '#comment' && !key.startsWith('?'));
  if (rootNames.length !== 1) fail('DOCX_XML_MALFORMED');
  const rootName = rootNames[0]!;
  const root = parsed[rootName];
  if (!root || typeof root !== 'object' || Array.isArray(root)) fail('DOCX_XML_MALFORMED');
  if (Object.prototype.hasOwnProperty.call(root, '#text') && String((root as XmlNode)['#text']).trim()) fail('DOCX_XML_MALFORMED');
  return { rootName, root: root as XmlNode };
}

function attrs(node: XmlNode): Record<string, string> {
  return Object.fromEntries(Object.entries(node).filter(([key, value]) => key.startsWith('@_') && typeof value === 'string').map(([key, value]) => [key.slice(2), value as string]));
}
function elements(node: XmlNode, name: string): XmlNode[] {
  const value = node[name];
  if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as XmlNode[];
  return value && typeof value === 'object' && !Array.isArray(value) ? [value as XmlNode] : [];
}
function rootNamespace(rootName: string, node: XmlNode, namespace: string): boolean {
  const attributes = attrs(node);
  const prefix = rootName.includes(':') ? rootName.slice(0, rootName.indexOf(':')) : '';
  return attributes[prefix ? `xmlns:${prefix}` : 'xmlns'] === namespace;
}
function localName(qname: string): string { return qname.includes(':') ? qname.slice(qname.indexOf(':') + 1) : qname; }
function namespaceScope(node:XmlNode,inherited:Map<string,string>):Map<string,string>{
  const scope=new Map(inherited);
  for(const [key,value] of Object.entries(node)){
    if(typeof value!=='string'||!key.startsWith('@_xmlns'))continue;
    scope.set(key==='@_xmlns'?'':key.slice('@_xmlns:'.length),value);
  }
  return scope;
}
function elementNamespace(qname:string,scope:Map<string,string>):string|undefined{
  const colon=qname.indexOf(':');
  return scope.get(colon<0?'':qname.slice(0,colon));
}
function assertDirectChildrenNamespace(xml:ParsedXml,allowedNames:string[],namespace:string,errorCode:string){
  const allowed=new Set(allowedNames),scope=namespaceScope(xml.root,new Map([['xml','http://www.w3.org/XML/1998/namespace']]));
  for(const child of expandedChildren(xml.root)){
    const childScope=namespaceScope(child.value,scope);
    if(!allowed.has(localName(child.name))||elementNamespace(child.name,childScope)!==namespace)fail(errorCode);
  }
}
function expandedChildren(node: XmlNode): Array<{ name: string; value: XmlNode }> {
  const result: Array<{ name: string; value: XmlNode }> = [];
  for (const [name, raw] of Object.entries(node)) {
    if (name.startsWith('@_') || name.startsWith('#') || name.startsWith('?')) continue;
    const list = Array.isArray(raw) ? raw : [raw];
    for (const value of list) if (value && typeof value === 'object' && !Array.isArray(value)) result.push({ name, value: value as XmlNode });
  }
  return result;
}

function validateRelationshipReferences(xml: ParsedXml, relationships: Relationship[]) {
  const knownIds = new Set(relationships.map(rel => rel.id));
  const xmlNamespace = 'http://www.w3.org/XML/1998/namespace';
  const walk = (qname: string, node: XmlNode, inherited: Map<string,string>) => {
    const scope = new Map(inherited);
    for (const [key, value] of Object.entries(node)) {
      if (typeof value !== 'string' || !key.startsWith('@_xmlns')) continue;
      const prefix = key === '@_xmlns' ? '' : key.slice('@_xmlns:'.length);
      if (prefix === 'xmlns' || (prefix === 'xml' && value !== xmlNamespace) || value === 'http://www.w3.org/2000/xmlns/') fail('DOCX_XML_NAMESPACE_INVALID');
      scope.set(prefix, value);
    }
    const elementColon = qname.indexOf(':');
    if (elementColon >= 0 && !scope.get(qname.slice(0, elementColon))) fail('DOCX_XML_NAMESPACE_INVALID');
    for (const [key, value] of Object.entries(node)) {
      if (!key.startsWith('@_') || typeof value !== 'string') continue;
      const attribute = key.slice(2), colon = attribute.indexOf(':');
      if (colon < 0) continue;
      const prefix = attribute.slice(0, colon), local = attribute.slice(colon + 1);
      if (prefix === 'xmlns') continue;
      const namespace = prefix === 'xml' ? xmlNamespace : scope.get(prefix);
      if (!namespace) fail('DOCX_XML_NAMESPACE_INVALID');
      if (namespace === OFFICE_REL_NS && ['id','embed','link'].includes(local) && !knownIds.has(value)) fail('DOCX_RELATIONSHIP_REFERENCE_MISSING');
    }
    for (const child of expandedChildren(node)) walk(child.name, child.value, scope);
  };
  walk(xml.rootName, xml.root, new Map([['xml', xmlNamespace]]));
}

function validateWordDocument(doc: ParsedXml, report: DocxInspection) {
  const rootScope=namespaceScope(doc.root,new Map());
  if(localName(doc.rootName)!=='document'||elementNamespace(doc.rootName,rootScope)!==WORD_NS)fail('DOCX_WORD_DOCUMENT_INVALID');
  const bodies=expandedChildren(doc.root).filter(child=>localName(child.name)==='body');
  if(bodies.length!==1)fail('DOCX_WORD_DOCUMENT_INVALID');
  const body=bodies[0]!;
  const bodyScope=namespaceScope(body.value,rootScope);
  if(elementNamespace(body.name,bodyScope)!==WORD_NS)fail('DOCX_WORD_DOCUMENT_INVALID');
  const hasWordBlock=expandedChildren(body.value).some(child=>{
    if(localName(child.name)!=='p'&&localName(child.name)!=='tbl')return false;
    return elementNamespace(child.name,namespaceScope(child.value,bodyScope))===WORD_NS;
  });
  if(!hasWordBlock)fail('DOCX_WORD_DOCUMENT_EMPTY');

  report.checks.word_document = 'passed';
}

function relationshipPartFor(sourcePart: string): string {
  const separator = sourcePart.lastIndexOf('/');
  const directory = separator >= 0 ? sourcePart.slice(0, separator + 1) : '';
  const basename = sourcePart.slice(separator + 1);
  return `${directory}_rels/${basename}.rels`;
}

function relationshipSource(name: string): string | null {
  if (name === '_rels/.rels') return null;
  const match = /^(.*\/)?_rels\/([^/]+)\.rels$/.exec(name);
  if (!match) return fail('DOCX_RELATIONSHIP_PART_INVALID');
  return `${match[1] ?? ''}${match[2]}`;
}

function normalizeInternalTarget(target: string, sourcePart: string | null): string {
  if (!target || target.includes('\\') || /%(?:2f|5c)/i.test(target) || target.includes('?') || target.includes('#')) fail('DOCX_RELATIONSHIP_TARGET_INVALID');
  let decoded: string;
  try { decoded = decodeURIComponent(target); }
  catch { return fail('DOCX_RELATIONSHIP_TARGET_INVALID'); }
  if (decoded.includes('\\') || decoded.includes('\0')) fail('DOCX_RELATIONSHIP_TARGET_INVALID');
  const absolute = decoded.startsWith('/');
  const relativeTarget=absolute?decoded.slice(1):decoded;
  if(!relativeTarget||relativeTarget.startsWith('/')||relativeTarget.endsWith('/')||relativeTarget.split('/').some(segment=>!segment))fail('DOCX_RELATIONSHIP_TARGET_INVALID');
  const stack = absolute || !sourcePart ? [] : sourcePart.split('/').slice(0, -1);
  for (const segment of relativeTarget.split('/')) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (!stack.length) fail('DOCX_RELATIONSHIP_TARGET_INVALID');
      stack.pop();
    } else {
      if (/[\u0000-\u001f\u007f]/.test(segment)) fail('DOCX_RELATIONSHIP_TARGET_INVALID');
      stack.push(segment);
    }
  }
  if (!stack.length) fail('DOCX_RELATIONSHIP_TARGET_INVALID');
  return stack.join('/');
}

function parseRelationships(name: string, xml: ParsedXml, parts: Set<string>): Relationship[] {
  if (xml.rootName !== 'Relationships' || !rootNamespace(xml.rootName, xml.root, PACKAGE_REL_NS)) fail('DOCX_RELATIONSHIPS_INVALID');
  assertDirectChildrenNamespace(xml,['Relationship'],PACKAGE_REL_NS,'DOCX_RELATIONSHIPS_INVALID');
  const source = relationshipSource(name);
  if (source && !parts.has(source)) fail('DOCX_RELATIONSHIP_SOURCE_MISSING');
  const seen = new Set<string>();
  const results: Relationship[] = [];
  for (const item of elements(xml.root, 'Relationship')) {
    const attr = attrs(item), id = attr.Id, type = attr.Type, target = attr.Target, targetMode = attr.TargetMode;
    if (!id || !/^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/.test(id) || seen.has(id) || !type || !/^https?:\/\//.test(type) || !target) fail('DOCX_RELATIONSHIPS_INVALID');
    seen.add(id);
    const external = targetMode === 'External';
    if (targetMode !== undefined && targetMode !== 'External' && targetMode !== 'Internal') fail('DOCX_RELATIONSHIPS_INVALID');
    if (external) {
      if (!type.endsWith('/hyperlink')) fail('DOCX_EXTERNAL_RELATIONSHIP_FORBIDDEN');
      let url: URL;
      try { url = new URL(target); }
      catch { return fail('DOCX_RELATIONSHIP_TARGET_INVALID'); }
      if (!['http:','https:','mailto:'].includes(url.protocol) || url.username || url.password || target.length > 2048) fail('DOCX_RELATIONSHIP_TARGET_INVALID');
    } else {
      const resolved = normalizeInternalTarget(target, source);
      if (!parts.has(resolved)) fail('DOCX_RELATIONSHIP_TARGET_MISSING');
    }
    results.push({ id, type, target, external });
  }
  return results;
}

function validateContentTypes(xml: ParsedXml, entries: ZipEntry[]) {
  if (xml.rootName !== 'Types' || !rootNamespace(xml.rootName, xml.root, CONTENT_TYPES_NS)) fail('DOCX_CONTENT_TYPES_INVALID');
  assertDirectChildrenNamespace(xml,['Default','Override'],CONTENT_TYPES_NS,'DOCX_CONTENT_TYPES_INVALID');
  const defaults = new Map<string,string>(), overrides = new Map<string,string>();
  for (const item of elements(xml.root, 'Default')) {
    const attr = attrs(item), extension = attr.Extension?.toLowerCase(), type = attr.ContentType;
    if (!extension || !/^[a-z0-9]+$/.test(extension) || !type || defaults.has(extension)) fail('DOCX_CONTENT_TYPES_INVALID');
    if (/macroEnabled|vbaProject/i.test(type)) fail('DOCX_MACROS_FORBIDDEN');
    defaults.set(extension, type);
  }
  for (const item of elements(xml.root, 'Override')) {
    const attr = attrs(item), partName = attr.PartName, type = attr.ContentType;
    if (!partName?.startsWith('/') || !type) fail('DOCX_CONTENT_TYPES_INVALID');
    const canonical = canonicalPartName(partName.slice(1)), folded = canonical.toLowerCase();
    if (overrides.has(folded)) fail('DOCX_CONTENT_TYPES_INVALID');
    if (/macroEnabled|vbaProject/i.test(type)) fail('DOCX_MACROS_FORBIDDEN');
    overrides.set(folded, type);
  }
  if (defaults.get('rels') !== RELS_CONTENT_TYPE || overrides.get('word/document.xml') !== MAIN_DOCUMENT_TYPE) fail('DOCX_REQUIRED_CONTENT_TYPE_MISSING');
  for (const entry of entries) {
    if (entry.directory || entry.name === CONTENT_TYPES) continue;
    const canonical = canonicalPartName(entry.name).toLowerCase();
    const extension = entry.name.slice(entry.name.lastIndexOf('/') + 1).split('.').at(-1)?.toLowerCase() ?? '';
    const contentType = overrides.get(canonical) ?? defaults.get(extension);
    if (!contentType) fail('DOCX_PART_CONTENT_TYPE_MISSING');
    if (/macroEnabled|vbaProject/i.test(contentType)) fail('DOCX_MACROS_FORBIDDEN');
    if (entry.name.toLowerCase() === 'word/vbaproject.bin' || entry.name.toLowerCase().endsWith('/vbaproject.bin')) fail('DOCX_MACROS_FORBIDDEN');
    if (entry.name.endsWith('.rels') && contentType !== RELS_CONTENT_TYPE) fail('DOCX_CONTENT_TYPES_INVALID');
    if (overrides.has(canonical) && !entries.some(candidate => !candidate.directory && canonicalPartName(candidate.name).toLowerCase() === canonical)) fail('DOCX_CONTENT_TYPE_TARGET_MISSING');
  }
  for (const override of overrides.keys()) {
    if (!entries.some(entry => !entry.directory && canonicalPartName(entry.name).toLowerCase() === override)) fail('DOCX_CONTENT_TYPE_TARGET_MISSING');
  }
}

/** Bounded Office ZIP reader shared by the catalogue importer. Does not execute workbook content. */
export function readBoundedOfficeParts(bytes:Buffer):Map<string,Buffer> {
  const report=inspectGeneratedWord(bytes),entries=parseZipDirectory(bytes,report),parts=new Map<string,Buffer>();
  let total=0;
  for(const entry of entries){
    if(entry.directory||!isXmlPart(entry.name))continue;
    if(entry.uncompressedSize>DOCX_LIMITS.xmlPartBytes||(total+=entry.uncompressedSize)>DOCX_LIMITS.totalXmlBytes)fail('DOCX_XML_SIZE_LIMIT');
    const compressed=bytes.subarray(entry.dataOffset,entry.dataOffset+entry.compressedSize);
    let content:Buffer;
    if(entry.method===0)content=Buffer.from(compressed);
    else {
      const result=inflateRawSync(compressed,{maxOutputLength:Math.max(1,entry.uncompressedSize+1),info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
      if(result.engine.bytesWritten!==compressed.length)fail('DOCX_DEFLATE_TRAILING_DATA');content=result.buffer;
    }
    if(content.length!==entry.uncompressedSize||crc32(content)!==entry.crc32)fail('DOCX_CRC_MISMATCH');
    parts.set(entry.name,content);
  }
  return parts;
}

function unpackAndValidate(bytes: Buffer, report: DocxInspection) {
  const entries = parseZipDirectory(bytes, report);
  const parts = new Set(entries.filter(entry => !entry.directory).map(entry => canonicalPartName(entry.name)));
  for (const required of [CONTENT_TYPES, '_rels/.rels', 'word/document.xml']) if (!parts.has(required)) fail('DOCX_REQUIRED_PART_MISSING');
  const xmlParts = new Map<string, ParsedXml>();
  let totalXml = 0;
  for (const entry of entries) {
    if (entry.directory) continue;
    const isXml = isXmlPart(entry.name);
    if (isXml && (entry.uncompressedSize > DOCX_LIMITS.xmlPartBytes || totalXml + entry.uncompressedSize > DOCX_LIMITS.totalXmlBytes)) fail('DOCX_XML_SIZE_LIMIT');
    if (isXml) totalXml += entry.uncompressedSize;
    const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    let content: Buffer;
    try {
      if(entry.method===0) content=Buffer.from(compressed);
      else {
        const result=inflateRawSync(compressed,{maxOutputLength:Math.max(1,entry.uncompressedSize+1),info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
        if(result.engine.bytesWritten!==compressed.length)fail('DOCX_DEFLATE_TRAILING_DATA');
        content=result.buffer;
      }
    } catch(error) {
      if(error instanceof InspectionFailure)throw error;
      fail('DOCX_DECOMPRESSION_FAILED');
    }
    if (content.length !== entry.uncompressedSize) fail('DOCX_ZIP_SIZE_MISMATCH');
    if (crc32(content) !== entry.crc32) fail('DOCX_CRC_MISMATCH');
    if (isXml) xmlParts.set(entry.name, parseXmlPart(entry.name, content));
  }
  report.checks.entry_integrity = 'passed';
  report.checks.xml_well_formedness = 'passed';

  const types = xmlParts.get(CONTENT_TYPES), rootRels = xmlParts.get('_rels/.rels'), document = xmlParts.get('word/document.xml');
  if (!types || !rootRels || !document) fail('DOCX_REQUIRED_PART_MISSING');
  validateContentTypes(types, entries);
  const relationParts = [...xmlParts.entries()].filter(([name]) => name.endsWith('.rels'));
  const relationMap = new Map<string,Relationship[]>();
  let count = 0;
  for (const [name, xml] of relationParts) {
    const rels = parseRelationships(name, xml, parts);
    relationMap.set(name, rels); count += rels.length;
  }
  const rootOfficeDocuments = (relationMap.get('_rels/.rels') ?? []).filter(rel => rel.type.endsWith('/officeDocument') && !rel.external);
  if (rootOfficeDocuments.length !== 1 || normalizeInternalTarget(rootOfficeDocuments[0]!.target, null) !== 'word/document.xml') fail('DOCX_OFFICE_DOCUMENT_RELATIONSHIP_INVALID');
  for (const [name, xml] of xmlParts) {
    if (name === CONTENT_TYPES || name.endsWith('.rels')) continue;
    validateRelationshipReferences(xml, relationMap.get(relationshipPartFor(name)) ?? []);
  }
  validateWordDocument(document, report);
  report.checks.ooxml_relationships = 'passed';
  report.relationship_count = count;
  report.required_parts = [CONTENT_TYPES, '_rels/.rels', 'word/document.xml'];
}

export function inspectDocx(bytes: Buffer): DocxInspection {
  const report: DocxInspection = {
    schema_version: 1,
    validator_version: WORD_DELIVERY_VALIDATOR_VERSION,
    quality_status: 'failed',
    byte_size: Buffer.isBuffer(bytes) ? bytes.length : 0,
    sha256: Buffer.isBuffer(bytes) ? digest(bytes) : digest(Buffer.alloc(0)),
    zip: { entry_count: 0, compressed_bytes: 0, uncompressed_bytes: 0 },
    checks: { zip_structure: 'not_run', entry_integrity: 'not_run', xml_well_formedness: 'not_run', ooxml_relationships: 'not_run', word_document: 'not_run' },
    required_parts: [],
    relationship_count: 0,
    failure_codes: []
  };
  if (!Buffer.isBuffer(bytes)) {
    report.failure_codes = ['DOCX_INPUT_INVALID'];
    return report;
  }
  try {
    unpackAndValidate(bytes, report);
    report.quality_status = 'passed';
  } catch (error) {
    const code = error instanceof InspectionFailure ? error.code : 'DOCX_INSPECTION_FAILED';
    report.failure_codes = [code];
    if (code.startsWith('DOCX_ZIP') || code.startsWith('DOCX_PART') || code.startsWith('DOCX_ARCHIVE') || code.startsWith('DOCX_ENTRY') || code.startsWith('DOCX_TOTAL') || code.startsWith('DOCX_COMPRESSION') || code.startsWith('DOCX_UNSAFE')) report.checks.zip_structure = 'failed';
    if (code.includes('CRC') || code.includes('DECOMPRESSION') || code.includes('SIZE_MISMATCH') || code.includes('DEFLATE_TRAILING')) report.checks.entry_integrity = 'failed';
    if (code.startsWith('DOCX_XML')) report.checks.xml_well_formedness = 'failed';
    if (code.startsWith('DOCX_RELATIONSHIP') || code.startsWith('DOCX_OFFICE_DOCUMENT') || code.startsWith('DOCX_CONTENT_TYPE')) report.checks.ooxml_relationships = 'failed';
    if (code.startsWith('DOCX_WORD')) report.checks.word_document = 'failed';
  }
  return report;
}
