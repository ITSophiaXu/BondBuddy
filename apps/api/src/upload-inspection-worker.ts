import { isUtf8 } from 'node:buffer';
import { closeSync, openSync, readSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { crc32 as zlibCrc32, createInflateRaw, inflateSync } from 'node:zlib';
import { fileTypeFromBuffer } from 'file-type';
import { decode as decodeJpeg } from 'jpeg-js';
import { SaxesParser } from 'saxes';
import { M1_UPLOAD_MIME_TYPES, type UploadMediaType } from '@bondbuddy/contracts';
import type { UploadRejectionReason, UploadSafetyCode, UploadStructureDetail, UploadWorkerReply } from './upload-safety.js';

type ContentSafetyCode = Exclude<UploadSafetyCode, 'DATA_UNAVAILABLE'>;
type InspectionFailure = { status: 415 | 422; code: ContentSafetyCode; message: string; reason: UploadRejectionReason; detail?: UploadStructureDetail };
type InspectionInput = { bytes: ArrayBuffer; mediaType: string } | { path: string; byteSize: number; mediaType: string };
type PdfPage = {
  getAnnotations(options: { intent: string }): Promise<Array<Record<string, unknown>>>;
  getJSActions(): Promise<Map<unknown, unknown> | null>;
  getOperatorList(): Promise<unknown>;
  cleanup(): void;
};
type PdfDocument = {
  numPages: number;
  isPureXfa: boolean;
  getJSActions(): Promise<Map<unknown, unknown> | null>;
  getPermissions(): Promise<Set<number> | null>;
  getAttachments(): Promise<Map<unknown, unknown> | null>;
  getFieldObjects(): Promise<Record<string, unknown> | null>;
  getOpenAction(): Promise<Map<string, unknown> | null>;
  getPage(pageNumber: number): Promise<PdfPage>;
};
type PdfLoadingTask = { promise: Promise<PdfDocument>; destroy(): Promise<void> };
type PdfRangeTransport = { requestDataRange(begin: number, end: number): void; onDataRange(begin: number, chunk: Uint8Array): void; abort(): void };
type PdfJsModule = {
  getDocument(options: Record<string, unknown>): PdfLoadingTask;
  PDFDataRangeTransport: new (length: number, initialData: Uint8Array | null) => PdfRangeTransport;
  AnnotationType: { WIDGET: number; FILEATTACHMENT: number };
};

const MAX_ARCHIVE_ENTRIES = 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_RATIO = 100;
const MAX_ARCHIVE_PATH_DEPTH = 32;
const MAX_XML_PART_BYTES = 16 * 1024 * 1024;
const MAX_XML_DEPTH = 256;
const MAX_ACTIVE_PART_PREFIX_BYTES = 8 * 1024;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_PNG_DECODED_BYTES = 64 * 1024 * 1024;
const [DOCX_MIME, PDF_MIME, XLSX_MIME, CSV_MIME, TEXT_MIME, PNG_MIME, JPEG_MIME] = M1_UPLOAD_MIME_TYPES;
const XLSX_EXTERNAL_LINK_PART = /^xl\/externalLinks\/externalLink[1-9][0-9]*\.xml$/;
const XLSX_EXTERNAL_LINK_RELS = /^xl\/externalLinks\/_rels\/externalLink[1-9][0-9]*\.xml\.rels$/;
const XLSX_EXTERNAL_LINK_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.externallink+xml';
const XLSX_EXTERNAL_LINK_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink';
const XLSX_EXTERNAL_LINK_PATH_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath';
const XLSX_EXTERNAL_BOOK_ELEMENTS = new Set(['externallink', 'externalbook', 'sheetnames', 'sheetname', 'definednames', 'definedname', 'sheetdataset', 'sheetdata', 'row', 'cell', 'v']);
const UNSAFE_OFFICE_MEDIA_TYPES = new Set([
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'text/ecmascript',
  'application/ecmascript',
  'application/mhtml',
  'application/x-mhtml',
  'application/mht',
  'application/x-mht',
  'application/x-mimearchive',
  'message/rfc822',
  'multipart/related',
  'application/x-shockwave-flash',
  'application/x-msdownload',
  'application/x-msdos-program'
]);

class MaterialInspectionError extends Error {
  constructor(public readonly status: 415 | 422, public readonly code: ContentSafetyCode, message: string, public readonly reason: UploadRejectionReason, public readonly detail?: UploadStructureDetail) {
    super(message);
  }
}

function reject(status: 415 | 422, code: ContentSafetyCode, message: string, reason: UploadRejectionReason, detail?: UploadStructureDetail): never {
  throw new MaterialInspectionError(status, code, message, reason, detail);
}

const mismatch = () => reject(422, 'MATERIAL_CONTENT_MISMATCH', 'Declared media type does not match content', 'content_mismatch');
const unreadable = (detail: UploadStructureDetail) => reject(422, 'MATERIAL_UNREADABLE', 'Material is corrupt or structurally unreadable', 'structure_invalid', detail);
const unsupported = (message = 'Material contains unsupported or unsafe content', reason: UploadRejectionReason = 'unsupported_content') => reject(415, 'MATERIAL_FORMAT_UNSUPPORTED', message, reason);
const encrypted = () => reject(422, 'MATERIAL_ENCRYPTED', 'Encrypted or password-protected material is not supported', 'encrypted_content');

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function utf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return unreadable('text_encoding_invalid');
  }
}

const TEXT_CHUNK_BYTES = 1024 * 1024;

// Text and CSV are verified incrementally so a spooled file never has to be held in memory.
type ChunkInspector = { feed(chunk: Buffer): void; end(): void };

async function inspectTextChunks(chunks: AsyncIterable<Buffer> | Iterable<Buffer>, csv: boolean): Promise<void> {
  const table = csv ? csvInspector() : null;
  // Validate UTF-8 without decoding (decoded strings would pile up as garbage); a sequence split
  // across chunks is carried into the next chunk.
  let carry: Buffer | null = null;
  const consume = (part: Buffer) => {
    const joined: Buffer = carry ? Buffer.concat([carry, part]) : part;
    const tail = incompleteUtf8Tail(joined);
    if (!isUtf8(joined.subarray(0, joined.length - tail))) mismatch();
    carry = tail ? Buffer.from(joined.subarray(joined.length - tail)) : null;
    table?.feed(part);
  };
  // Binary signatures are checked on the leading MiB before any text is parsed.
  const head: Buffer[] = [];
  let headBytes = 0;
  let typed = false;
  const checkType = async () => {
    typed = true;
    if (await fileTypeFromBuffer(Buffer.concat(head).subarray(0, TEXT_CHUNK_BYTES))) mismatch();
    for (const part of head.splice(0)) consume(part);
  };
  for await (const chunk of chunks) {
    if (chunk.includes(0)) mismatch();
    if (typed) {
      consume(chunk);
      continue;
    }
    head.push(Buffer.from(chunk)); // chunks may reuse one read buffer
    headBytes += chunk.length;
    if (headBytes >= TEXT_CHUNK_BYTES) await checkType();
  }
  if (!typed) await checkType();
  if (carry) mismatch();
  table?.end();
}

/** Length of a trailing, not yet complete UTF-8 sequence (0 when the chunk ends on a boundary). */
function incompleteUtf8Tail(bytes: Buffer): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const value = bytes[bytes.length - back]!;
    if ((value & 0xc0) === 0x80) continue;
    const needed = value >= 0xf0 ? 4 : value >= 0xe0 ? 3 : value >= 0xc0 ? 2 : 1;
    return needed > back ? back : 0;
  }
  return 0;
}

function* bufferChunks(bytes: Buffer): Iterable<Buffer> {
  for (let offset = 0; offset < bytes.length; offset += TEXT_CHUNK_BYTES) yield bytes.subarray(offset, Math.min(bytes.length, offset + TEXT_CHUNK_BYTES));
}

async function inspectText(bytes: Buffer, csv: boolean): Promise<void> {
  await inspectTextChunks(bufferChunks(bytes), csv);
}

function csvInspector(): ChunkInspector {
  type State = 'start' | 'unquoted' | 'quoted' | 'after-quote';
  let state: State = 'start';
  let prefix: number[] = [];
  let prefixOverflow = false;
  let rowCells = 0;
  let rows = 0;
  let leadingWhitespace = true;
  let pendingCodePoint: number[] = [];
  const maxRows = 1_000_000;
  const maxCellsPerRow = 100_000;
  const maxCells = 2_000_000;
  let cells = 0;
  // Cross-chunk lookahead: a quote inside a quoted field, or a CR that may be followed by LF.
  let quoteInQuoted = false;
  let skipLf = false;
  let seen = 0;
  let last = -1;
  let bomChecked = false;
  const bom: number[] = [];

  const appendCandidate = (value: number) => {
    if (prefix.length < 512) prefix.push(value);
    else prefixOverflow = true;
  };
  const append = (value: number) => {
    if (!leadingWhitespace) {
      appendCandidate(value);
      return;
    }

    pendingCodePoint.push(value);
    const lead = pendingCodePoint[0]!;
    const expectedLength = lead < 0x80 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : 4;
    if (pendingCodePoint.length < expectedLength) return;
    const character = Buffer.from(pendingCodePoint).toString('utf8');
    if (!/^\s$/u.test(character)) {
      leadingWhitespace = false;
      for (const byte of pendingCodePoint) appendCandidate(byte);
    }
    pendingCodePoint = [];
  };
  const finishField = () => {
    const normalizedPrefix = Buffer.from(prefix).toString('utf8').normalize('NFKC');
    const fieldPrefix = normalizedPrefix.trimStart();
    const first = fieldPrefix[0];
    if (first === '=' || first === '+' || first === '@') unsupported('CSV contains an active spreadsheet formula');
    if (first === '-') {
      const number = /^-(?:(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
      if (prefixOverflow || !number.test(normalizedPrefix.trim())) unsupported('CSV contains a potentially active spreadsheet formula');
    }
    rowCells++;
    cells++;
    if (rowCells > maxCellsPerRow || cells > maxCells) unsupported('CSV exceeds the inspection complexity limit');
    prefix = [];
    prefixOverflow = false;
    leadingWhitespace = true;
    pendingCodePoint = [];
  };
  const finishRow = () => {
    rows++;
    if (rows > maxRows) unsupported('CSV exceeds the inspection row limit');
    rowCells = 0;
  };
  const endLine = (value: number) => {
    finishField();
    if (value === 0x0d) skipLf = true;
    finishRow();
  };

  const step = (value: number) => {
    if (skipLf) {
      skipLf = false;
      if (value === 0x0a) return;
    }
    if (quoteInQuoted) {
      quoteInQuoted = false;
      if (value === 0x22) {
        append(value);
        return;
      }
      state = 'after-quote';
    }
    if (state === 'quoted') {
      if (value === 0x22) quoteInQuoted = true;
      else append(value);
      return;
    }

    if (state === 'after-quote') {
      if (value === 0x2c) {
        finishField();
        state = 'start';
      } else if (value === 0x0a || value === 0x0d) {
        endLine(value);
        state = 'start';
      } else unreadable('csv_quote_invalid');
      return;
    }

    if (state === 'start') {
      if (value === 0x22) state = 'quoted';
      else if (value === 0x2c) finishField();
      else if (value === 0x0a || value === 0x0d) endLine(value);
      else {
        append(value);
        state = 'unquoted';
      }
      return;
    }

    if (value === 0x2c) {
      finishField();
      state = 'start';
    } else if (value === 0x0a || value === 0x0d) {
      endLine(value);
      state = 'start';
    } else if (value === 0x22) unreadable('csv_quote_invalid');
    else append(value);
  };

  const flushBom = () => {
    bomChecked = true;
    const isBom = bom.length === 3 && bom[0] === 0xef && bom[1] === 0xbb && bom[2] === 0xbf;
    if (!isBom) for (const value of bom) step(value);
  };

  return {
    feed(chunk: Buffer) {
      for (let i = 0; i < chunk.length; i++) {
        const value = chunk[i]!;
        seen++;
        last = value;
        if (!bomChecked) {
          bom.push(value);
          if (bom.length === 3) flushBom();
          continue;
        }
        step(value);
      }
    },
    end() {
      if (!bomChecked) flushBom();
      if (quoteInQuoted) {
        quoteInQuoted = false;
        state = 'after-quote';
      }
      if (state === 'quoted') unreadable('csv_quote_invalid');
      if (state !== 'start' || prefix.length > 0 || seen === 0 || last === 0x2c) {
        finishField();
        finishRow();
      }
    }
  };
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (-(value & 1) & 0xedb88320);
  return value >>> 0;
});

function crc32(parts: readonly Buffer[]): number {
  let value = 0;
  for (const part of parts) value = zlibCrc32(part, value);
  return value >>> 0;
}

function hasCompoundFileHeader(bytes: Buffer): boolean {
  return startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
}

function hasNestedContainerHeader(bytes: Buffer): boolean {
  return hasCompoundFileHeader(bytes) || [
    [0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x50, 0x4b, 0x07, 0x08],
    [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07],
    [0x1f, 0x8b], [0x42, 0x5a, 0x68], [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
    [0x28, 0xb5, 0x2f, 0xfd], [0x04, 0x22, 0x4d, 0x18], [0x4d, 0x53, 0x43, 0x46]
  ].some(signature => startsWith(bytes, signature)) || bytes.subarray(257, 262).toString('ascii') === 'ustar';
}

const COMPOUND_MARKERS = ['EncryptionInfo', 'EncryptedPackage'].map(marker => Buffer.from(marker, 'utf16le'));

/** Scan a compound file for both encryption stream names in bounded, overlapping chunks. */
function isEncryptedOfficeCompoundSource(source: ZipSource): boolean {
  const found = COMPOUND_MARKERS.map(() => false);
  const overlap = Math.max(...COMPOUND_MARKERS.map(marker => marker.length)) - 1;
  for (let offset = 0; offset < source.size; offset += ZIP_READ_CHUNK_BYTES) {
    const start = Math.max(0, offset - overlap);
    const chunk = source.read(start, Math.min(source.size, offset + ZIP_READ_CHUNK_BYTES) - start);
    COMPOUND_MARKERS.forEach((marker, index) => { if (chunk.includes(marker)) found[index] = true; });
    if (found.every(Boolean)) return true;
  }
  return false;
}

type ZipEntry = {
  name: string;
  rawName: Buffer;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  expandedSize: number;
  localOffset: number;
  dataStart: number;
  dataEnd: number;
  recordEnd: number;
  directory: boolean;
};

function decodeZipName(rawName: Buffer, flags: number): string {
  if (flags & 0x0800) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(rawName);
    } catch {
      return unreadable('zip_name_encoding_invalid');
    }
  }
  if (rawName.some(value => value > 0x7f)) return unsupported('Office part names must use an unambiguous UTF-8 encoding');
  return rawName.toString('ascii');
}

/** OPC part names are URI paths. Compare their decoded form while retaining ZIP header bytes for consistency checks. */
function canonicalPartName(name: string, override = false): string {
  if (override && !name.startsWith('/')) unreadable('part_name_invalid');
  const path = override ? name.slice(1) : name;
  // Encoded separators and URI delimiters can give ZIP readers and OPC consumers different paths.
  if (/%(?:2f|5c|3a|3f|23|00|0[0-9a-f]|1[0-9a-f]|7f)/i.test(path)) unsupported('Office container contains an ambiguous part name');
  let decoded: string;
  try { decoded = decodeURIComponent(path); }
  catch { return unreadable('part_name_invalid'); }
  if (/%[0-9a-f]{2}/i.test(decoded)) unsupported('Office container contains an ambiguous part name');
  if (decoded.normalize('NFC') !== decoded || decoded.startsWith('/') || /[:?#\\\x00-\x1f\x7f]/.test(decoded)) {
    unsupported('Office container contains an ambiguous part name');
  }
  const directory = !override && decoded.endsWith('/');
  const segments = (directory ? decoded.slice(0, -1) : decoded).split('/');
  if (segments.length > MAX_ARCHIVE_PATH_DEPTH || segments.some(part => !part || part === '.' || part === '..')) {
    unsupported('Office container contains an unsafe part path');
  }
  return decoded;
}

function validateZipExtra(bytes: Buffer): void {
  let offset = 0;
  const end = bytes.length;
  while (offset < end) {
    if (offset + 4 > end) unreadable('zip_extra_invalid');
    const id = bytes.readUInt16LE(offset);
    const size = bytes.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + size > end) unreadable('zip_extra_invalid');
    if (id === 0x0001) unsupported('ZIP64 Office containers exceed the bounded inspection profile');
    if (id === 0x7075 || id === 0x6375) unsupported('Unicode path override fields are not accepted in Office containers');
    offset += size;
  }
  if (offset !== end) unreadable('zip_extra_invalid');
}

// Random access to an Office container. The spooled file is read through the ZIP central
// directory entry by entry, so only headers and one bounded part are ever held in memory.
type ZipSource = { size: number; read(offset: number, length: number): Buffer; close(): void };
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
const ZIP_READ_CHUNK_BYTES = 1024 * 1024;

function bufferSource(bytes: Buffer): ZipSource {
  return {
    size: bytes.length,
    read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > bytes.length) unreadable('zip_read_out_of_bounds');
      return bytes.subarray(offset, offset + length);
    },
    close() { /* nothing to release */ }
  };
}

function fileSource(path: string, byteSize: number): ZipSource {
  const fd = openSync(path, 'r');
  return {
    size: byteSize,
    read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > byteSize) unreadable('zip_read_out_of_bounds');
      const buffer = Buffer.allocUnsafe(length);
      let done = 0;
      while (done < length) {
        const count = readSync(fd, buffer, done, length - done, offset + done);
        if (count === 0) unreadable('zip_read_incomplete');
        done += count;
      }
      return buffer;
    },
    close() { closeSync(fd); }
  };
}

function parseZip(source: ZipSource): ZipEntry[] {
  const size = source.size;
  if (size < 22) unreadable('zip_eocd_missing');
  const tailStart = Math.max(0, size - 65_557);
  const tail = source.read(tailStart, size - tailStart);
  let eocd = -1;
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (tail.readUInt32LE(offset) === 0x06054b50 && tailStart + offset + 22 + tail.readUInt16LE(offset + 20) === size) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) unreadable('zip_eocd_missing');

  const disk = tail.readUInt16LE(eocd + 4);
  const centralDisk = tail.readUInt16LE(eocd + 6);
  const entriesOnDisk = tail.readUInt16LE(eocd + 8);
  const entryCount = tail.readUInt16LE(eocd + 10);
  const centralSize = tail.readUInt32LE(eocd + 12);
  const centralOffset = tail.readUInt32LE(eocd + 16);
  const eocdOffset = tailStart + eocd;
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) unsupported('Multi-disk ZIP containers are not supported');
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) unsupported('ZIP64 Office containers exceed the bounded inspection profile');
  if (entryCount < 1 || entryCount > MAX_ARCHIVE_ENTRIES) unsupported('Office container has too many entries', 'archive_entry_limit');
  if (centralOffset + centralSize !== eocdOffset || centralOffset > size || centralSize > size) unreadable('zip_central_bounds_invalid');
  if (centralSize > MAX_CENTRAL_DIRECTORY_BYTES) unsupported('Office container directory exceeds the inspection limit');
  const central = source.read(centralOffset, centralSize);

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  const centralEnd = centralSize;
  let cursor = 0;
  let expandedTotal = 0;
  let compressedTotal = 0;

  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > centralEnd || central.readUInt32LE(cursor) !== 0x02014b50) unreadable('zip_central_record_invalid');
    const madeBy = central.readUInt16LE(cursor + 4);
    const flags = central.readUInt16LE(cursor + 8);
    const method = central.readUInt16LE(cursor + 10);
    const crc = central.readUInt32LE(cursor + 16);
    const compressedSize = central.readUInt32LE(cursor + 20);
    const expandedSize = central.readUInt32LE(cursor + 24);
    const nameLength = central.readUInt16LE(cursor + 28);
    const extraLength = central.readUInt16LE(cursor + 30);
    const commentLength = central.readUInt16LE(cursor + 32);
    const diskStart = central.readUInt16LE(cursor + 34);
    const externalAttributes = central.readUInt32LE(cursor + 38);
    const localOffset = central.readUInt32LE(cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (nameLength < 1 || nameLength > 512 || recordEnd > centralEnd) unreadable('zip_central_name_invalid');
    if (diskStart !== 0) unsupported('Multi-disk ZIP containers are not supported');
    if (compressedSize === 0xffffffff || expandedSize === 0xffffffff || localOffset === 0xffffffff) unsupported('ZIP64 Office containers exceed the bounded inspection profile');
    if (flags & (0x0001 | 0x0040 | 0x2000)) encrypted();
    if (flags & ~0x080e) unsupported('Office container uses unsupported ZIP flags');
    if (method !== 0 && method !== 8) unsupported('Office container uses an unsupported compression method');
    if (method === 0 && (flags & 0x0006)) unsupported('Stored ZIP entries cannot use deflate options');

    const rawName = Buffer.from(central.subarray(cursor + 46, cursor + 46 + nameLength));
    const name = canonicalPartName(decodeZipName(rawName, flags));
    const directory = name.endsWith('/');
    const foldedName = name.toLocaleLowerCase('en-US');
    if (names.has(foldedName)) unsupported('Office container contains duplicate part names');
    names.add(foldedName);

    const platform = madeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    if (platform === 3 && (unixMode & 0xf000) === 0xa000) unsupported('Office container contains a symbolic link');
    if (directory && expandedSize !== 0) unreadable('zip_directory_invalid');
    if (expandedSize > MAX_ARCHIVE_ENTRY_BYTES || expandedTotal + expandedSize > MAX_ARCHIVE_EXPANDED_BYTES) {
      unsupported('Office container exceeds the expanded-size inspection limit', 'archive_expanded_limit');
    }
    if (expandedSize > 1024 && (compressedSize === 0 || expandedSize / compressedSize > MAX_ARCHIVE_RATIO)) {
      unsupported('Office container exceeds the compression-ratio inspection limit', 'archive_ratio');
    }
    expandedTotal += expandedSize;
    compressedTotal += compressedSize;
    validateZipExtra(central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength));

    if (localOffset + 30 > centralOffset) unreadable('zip_local_bounds_invalid');
    const local = source.read(localOffset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50) unreadable('zip_local_signature_invalid');
    const localFlags = local.readUInt16LE(6);
    const localMethod = local.readUInt16LE(8);
    const localCrc = local.readUInt32LE(14);
    const localCompressed = local.readUInt32LE(18);
    const localExpanded = local.readUInt32LE(22);
    const localNameLength = local.readUInt16LE(26);
    const localExtraLength = local.readUInt16LE(28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (localFlags !== flags || localMethod !== method || localNameLength !== nameLength || dataEnd > centralOffset) unreadable('zip_central_local_mismatch');
    const localVariable = source.read(localOffset + 30, localNameLength + localExtraLength);
    if (!localVariable.subarray(0, localNameLength).equals(rawName)) unreadable('zip_central_local_mismatch');
    validateZipExtra(localVariable.subarray(localNameLength));
    if (!(flags & 0x0008) && (localCrc !== crc || localCompressed !== compressedSize || localExpanded !== expandedSize)) unreadable('zip_central_local_mismatch');
    if ((flags & 0x0008) && (localCrc !== 0 && localCrc !== crc || localCompressed !== 0 && localCompressed !== compressedSize || localExpanded !== 0 && localExpanded !== expandedSize)) unreadable('zip_central_local_mismatch');

    let finalRecordEnd = dataEnd;
    if (flags & 0x0008) {
      const available = source.read(dataEnd, Math.min(16, centralOffset - dataEnd));
      let descriptor = 0;
      if (descriptor + 4 <= available.length && available.readUInt32LE(descriptor) === 0x08074b50) descriptor += 4;
      if (descriptor + 12 > available.length || available.readUInt32LE(descriptor) !== crc || available.readUInt32LE(descriptor + 4) !== compressedSize || available.readUInt32LE(descriptor + 8) !== expandedSize) unreadable('zip_data_descriptor_mismatch');
      finalRecordEnd = dataEnd + descriptor + 12;
    }

    entries.push({ name, rawName, flags, method, crc, compressedSize, expandedSize, localOffset, dataStart, dataEnd, recordEnd: finalRecordEnd, directory });
    cursor = recordEnd;
  }

  if (cursor !== centralEnd) unreadable('zip_central_bounds_invalid');
  if (expandedTotal > 64 * 1024 && compressedTotal > 0 && expandedTotal / compressedTotal > MAX_ARCHIVE_RATIO) {
    unsupported('Office container exceeds the aggregate compression-ratio inspection limit', 'archive_ratio');
  }

  const localRecords = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  if (localRecords[0]?.localOffset !== 0) unsupported('Self-extracting ZIP containers are not supported');
  for (let index = 1; index < localRecords.length; index++) {
    if (localRecords[index - 1]!.recordEnd !== localRecords[index]!.localOffset) unreadable('zip_record_gap');
  }
  if (localRecords.at(-1)?.recordEnd !== centralOffset) unreadable('zip_record_gap');
  return entries;
}

type ExpandedPart = { head: Buffer; whole: Buffer | null; length: number; crc: number };
const PART_HEAD_BYTES = Math.max(MAX_ACTIVE_PART_PREFIX_BYTES, 262);

/** Inflate one entry in bounded chunks. Only the head is kept unless `keepWhole` (XML parts). */
async function expandEntry(source: ZipSource, entry: ZipEntry, keepWhole: boolean): Promise<ExpandedPart> {
  const kept: Buffer[] = [];
  let head = Buffer.alloc(0);
  let length = 0;
  let crc = 0;
  const accept = (chunk: Buffer) => {
    length += chunk.length;
    // Never expand past the declared size: a lying header cannot turn into a zip bomb.
    if (length > entry.expandedSize) unreadable('zip_expanded_size_mismatch');
    crc = zlibCrc32(chunk, crc);
    if (head.length < PART_HEAD_BYTES) head = Buffer.concat([head, chunk.subarray(0, PART_HEAD_BYTES - head.length)]);
    if (keepWhole) kept.push(Buffer.from(chunk));
  };
  const compressed = async function* () {
    for (let offset = entry.dataStart; offset < entry.dataEnd; offset += ZIP_READ_CHUNK_BYTES) {
      yield source.read(offset, Math.min(ZIP_READ_CHUNK_BYTES, entry.dataEnd - offset));
    }
  };
  if (entry.method === 0) {
    for await (const chunk of compressed()) accept(chunk);
  } else {
    const inflate = createInflateRaw({ chunkSize: 64 * 1024 });
    const feed = (async () => {
      try {
        for await (const chunk of compressed()) {
          if (!inflate.write(chunk)) {
            await new Promise<void>(resolve => {
              const resume = () => { inflate.off('drain', resume); inflate.off('close', resume); resolve(); };
              inflate.on('drain', resume);
              inflate.on('close', resume);
            });
          }
          if (inflate.destroyed) return;
        }
        inflate.end();
      } catch (error) {
        inflate.destroy(error as Error);
      }
    })();
    try {
      for await (const chunk of inflate) accept(chunk as Buffer);
    } catch (error) {
      inflate.destroy();
      if (error instanceof MaterialInspectionError) throw error;
      unreadable('zip_inflate_error');
    } finally {
      await feed;
    }
  }
  if (length !== entry.expandedSize || crc >>> 0 !== entry.crc) unreadable('zip_crc_mismatch');
  return { head, whole: keepWhole ? Buffer.concat(kept, length) : null, length, crc: crc >>> 0 };
}

type Relationship = { id?: string; type: string; target: string; external: boolean };
type ContentTypes = { defaults: Map<string, string>; overrides: Map<string, string> };
type OfficeState = {
  files: Set<string>;
  contentTypes: ContentTypes | null;
  relationships: Map<string, Relationship[]>;
  externalBookRelationshipIds: Map<string, string>;
  workbookExternalReferenceIds: Set<string>;
  payloadHazards: Map<string, 'active' | 'markup'>;
  rootDocumentTarget: string | null;
  mainPartRoot: string | null;
};

function xmlText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    try { return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2)); }
    catch { return unreadable('xml_encoding_invalid'); }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    if ((bytes.length - 2) % 2) unreadable('xml_encoding_invalid');
    const swapped = Buffer.from(bytes.subarray(2));
    for (let i = 0; i < swapped.length; i += 2) [swapped[i], swapped[i + 1]] = [swapped[i + 1]!, swapped[i]!];
    try { return new TextDecoder('utf-16le', { fatal: true }).decode(swapped); }
    catch { return unreadable('xml_encoding_invalid'); }
  }
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0 && bytes[3] === 0x3f) {
    if (bytes.length % 2) unreadable('xml_encoding_invalid');
    const swapped = Buffer.from(bytes);
    for (let i = 0; i < swapped.length; i += 2) [swapped[i], swapped[i + 1]] = [swapped[i + 1]!, swapped[i]!];
    try { return new TextDecoder('utf-16le', { fatal: true }).decode(swapped); }
    catch { return unreadable('xml_encoding_invalid'); }
  }
  if (bytes.length >= 4 && bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] === 0x3f && bytes[3] === 0) {
    if (bytes.length % 2) unreadable('xml_encoding_invalid');
    try { return new TextDecoder('utf-16le', { fatal: true }).decode(Buffer.from(bytes).swap16()); }
    catch { return unreadable('xml_encoding_invalid'); }
  }
  return utf8(bytes);
}

function localName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1).toLowerCase();
}

function attribute(attributes: Record<string, unknown>, wanted: string): string | undefined {
  for (const [name, rawValue] of Object.entries(attributes)) {
    if (localName(name) === wanted.toLowerCase() && typeof rawValue === 'string') return rawValue;
  }
  return undefined;
}

function unsafeSpreadsheetFormula(value: string, files: ReadonlySet<string>): boolean {
  if (/\b(?:HYPERLINK|IMAGE|WEBSERVICE|RTD|DDE(?:AUTO)?|CALL|REGISTER\.ID|FILTERXML|IMPORTXML|IMPORTHTML|IMPORTFEED|STOCKHISTORY|CUBE(?:MEMBER|SET|VALUE|RANKEDMEMBER))\s*\(/i.test(value) ||
      /\bDDE(?:AUTO)?\b/i.test(value) || /\|/.test(value)) return true;
  // OOXML formula indexes are package-local references. The formula is never evaluated here;
  // its parser output keeps any cached value explicitly unverified.
  let unknownLink = false;
  const withoutKnownLinks = value.replace(/\[([^\]\r\n]+)\]/g, (_match, index: string) => {
    if (!/^[1-9][0-9]*$/.test(index) || !files.has(`xl/externalLinks/externalLink${index}.xml`)) unknownLink = true;
    return '';
  });
  return unknownLink || /[\[\]]/.test(withoutKnownLinks);
}

function unsafeWordInstruction(value: string): boolean {
  return /\b(?:DDE(?:AUTO)?|INCLUDETEXT|INCLUDEPICTURE|DATABASE|LINK)\b/i.test(value) ||
    /\bHYPERLINK\b.*(?:https?:|file:|\\\\)/i.test(value);
}

function unsafeOfficeContentType(type: string): boolean {
  const mediaType = type.split(';', 1)[0]!.trim().toLowerCase();
  return UNSAFE_OFFICE_MEDIA_TYPES.has(mediaType) ||
    /(?:macro(?:enabled|sheet|project)|vbaproject|activex|oleobject|embedded\.package)/i.test(mediaType);
}

function officePayloadTextPrefix(bytes: Buffer): string {
  const limit = Math.min(bytes.length, MAX_ACTIVE_PART_PREFIX_BYTES);
  let end = limit;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    end -= (end - 2) % 2;
    try { return new TextDecoder('utf-16le', { fatal: false }).decode(bytes.subarray(2, end)); }
    catch { return ''; }
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    end -= (end - 2) % 2;
    try { return new TextDecoder('utf-16be', { fatal: false }).decode(bytes.subarray(2, end)); }
    catch { return ''; }
  }
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0 && bytes[3] !== 0) {
    end -= end % 2;
    try { return new TextDecoder('utf-16be', { fatal: false }).decode(bytes.subarray(0, end)); }
    catch { return ''; }
  }
  if (bytes.length >= 4 && bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] !== 0 && bytes[3] === 0) {
    end -= end % 2;
    try { return new TextDecoder('utf-16le', { fatal: false }).decode(bytes.subarray(0, end)); }
    catch { return ''; }
  }
  return bytes.subarray(0, end).toString('utf8');
}

function officePayloadHazard(bytes: Buffer, totalLength = bytes.length): 'active' | 'markup' | undefined {
  const text = officePayloadTextPrefix(bytes);
  const header = text.replace(/^\uFEFF/, '');
  const headerStart = header.trimStart();
  if (/^(?:MIME-Version\s*:|From\s*:|Content-Type\s*:\s*(?:multipart\/related|text\/html|application\/x-mimearchive)\b)/i.test(headerStart) &&
      /(?:^|\r?\n)Content-Type\s*:\s*(?:multipart\/related|text\/html|application\/x-mimearchive)\b/i.test(headerStart)) {
    return 'active';
  }

  let cursor = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let preambleCount = 0;
  while (preambleCount++ < 32) {
    while (/[\t\n\r ]/.test(text[cursor] ?? '')) cursor++;
    if (text.startsWith('<!--', cursor)) {
      const end = text.indexOf('-->', cursor + 4);
      if (end < 0) return 'markup';
      cursor = end + 3;
      continue;
    }
    if (text.startsWith('<?', cursor)) {
      const end = text.indexOf('?>', cursor + 2);
      if (end < 0) return 'markup';
      cursor = end + 2;
      continue;
    }
    break;
  }

  const prefix = text.slice(cursor).trimStart();
  if (!prefix) {
    if (totalLength > MAX_ACTIVE_PART_PREFIX_BYTES) return 'markup';
    return undefined;
  }
  if (/^<!doctype\s+(?:html|(?:[\w.-]+:)?svg)\b/i.test(prefix)) return 'active';
  if (/^<(?:(?:[\w.-]+):)?(?:svg|html|script|iframe|object|embed|frameset|foreignobject)\b/i.test(prefix)) return 'active';
  if (prefix.startsWith('<')) return 'markup';
  return undefined;
}

function parsePackageXml(name: string, bytes: Buffer, state: OfficeState): void {
  if (bytes.length > MAX_XML_PART_BYTES) unsupported('Office XML part exceeds the inspection limit', 'xml_part_limit');
  const text = xmlText(bytes);
  let root = '';
  let depth = 0;
  const externalLinkPart = XLSX_EXTERNAL_LINK_PART.test(name);
  let externalBookCount = 0;
  let directExternalBookCount = 0;
  let externalBookRelationshipId: string | null = null;
  let extensionDepth: number | null = null;
  const xmlElements: string[] = [];
  let capture: { kind: 'formula' | 'instruction'; depth: number; value: string } | null = null;
  const relationships: Relationship[] = [];
  const contentTypes: ContentTypes = { defaults: new Map(), overrides: new Map() };
  const parser = new SaxesParser({ xmlns: false });
  parser.on('doctype', () => unsupported('Office XML document types are not supported'));
  parser.on('processinginstruction', () => unsupported('Office XML processing instructions are not supported'));
  parser.on('error', () => unreadable('xml_parse_error'));
  parser.on('opentag', tag => {
    const thisDepth = depth;
    if (thisDepth >= MAX_XML_DEPTH) unsupported('Office XML nesting exceeds the inspection limit');
    if (thisDepth === 0) root = tag.name;
    const local = localName(tag.name);
    const parent = xmlElements.at(-1);
    const attrs = tag.attributes as Record<string, unknown>;
    for (const [attrName, rawValue] of Object.entries(attrs)) {
      if (/^on[a-z]+$/i.test(attrName) && typeof rawValue === 'string') unsupported('Office XML contains an active event attribute');
      if ((localName(attrName) === 'href' || localName(attrName) === 'src') && typeof rawValue === 'string' && rawValue && !rawValue.startsWith('#')) {
        unsupported('Office XML contains a direct external or embedded reference');
      }
    }
    if (local === 'script' || local === 'altchunk') unsupported('Office XML contains active or externally loaded content');
    if (externalLinkPart && (local === 'ddelink' || local === 'olelink')) unsupported('Office external link contains DDE or OLE content');
    if (externalLinkPart && extensionDepth === null) {
      const mcElement = tag.name === 'mc:AlternateContent' || tag.name === 'mc:Choice' || tag.name === 'mc:Fallback';
      const alternate = tag.name === 'mc:AlternateContent' && (parent === 'externalLink' || parent === 'externalBook');
      const branch = (tag.name === 'mc:Choice' || tag.name === 'mc:Fallback') && parent === 'mc:AlternateContent';
      const extensionList = local === 'extlst' && (parent === 'externalLink' || parent === 'externalBook');
      const extension = local === 'ext' && parent?.toLowerCase() === 'extlst';
      if (mcElement && !alternate && !branch || !mcElement && !extensionList && !extension && !XLSX_EXTERNAL_BOOK_ELEMENTS.has(local)) unreadable('external_link_invalid');
      if (extension) extensionDepth = thisDepth;
    }
    if (externalLinkPart && (parent === 'externalLink' || parent === 'mc:Choice' || parent === 'mc:Fallback') && extensionDepth === null && local === 'externalbook') {
      externalBookCount++;
      if (parent === 'externalLink' && ++directExternalBookCount > 1) unreadable('external_link_invalid');
      const relationshipId = attribute(attrs, 'Id');
      if (!relationshipId || externalBookRelationshipId !== null && externalBookRelationshipId !== relationshipId) return unreadable('external_link_invalid');
      externalBookRelationshipId = relationshipId;
      state.externalBookRelationshipIds.set(name, relationshipId);
    }
    if (externalLinkPart && thisDepth === 1 && local !== 'externalbook' && local !== 'extlst' && tag.name !== 'mc:AlternateContent') unreadable('external_link_invalid');
    if (name === 'xl/workbook.xml' && local === 'externalreference') {
      const relationshipId = attribute(attrs, 'Id');
      if (!relationshipId || state.workbookExternalReferenceIds.has(relationshipId)) return unreadable('external_link_invalid');
      state.workbookExternalReferenceIds.add(relationshipId);
    }
    if (local === 'relationship') {
      const id = attribute(attrs, 'Id');
      const targetMode = attribute(attrs, 'TargetMode');
      const target = attribute(attrs, 'Target');
      const type = attribute(attrs, 'Type');
      if (!target || !type) return unreadable('relationship_invalid');
      const normalizedMode = targetMode?.toLowerCase();
      if (normalizedMode && normalizedMode !== 'external' && normalizedMode !== 'internal') unreadable('relationship_invalid');
      if (/(?:oleobject|package|vbaproject|activex|attachedtemplate|afchunk)$/i.test(type)) {
        unsupported('Office relationships contain external or active content');
      }
      relationships.push({ id, type, target, external: normalizedMode === 'external' });
    }
    if (name === '[Content_Types].xml' && local === 'default') {
      const ext = attribute(attrs, 'Extension')?.toLowerCase();
      const type = attribute(attrs, 'ContentType')?.toLowerCase();
      if (!ext || !type || contentTypes.defaults.has(ext)) return unreadable('content_types_invalid');
      if (unsafeOfficeContentType(type)) unsupported('Office package declares macro or embedded active content');
      contentTypes.defaults.set(ext, type);
    }
    if (name === '[Content_Types].xml' && local === 'override') {
      const partName = attribute(attrs, 'PartName');
      const type = attribute(attrs, 'ContentType')?.toLowerCase();
      if (!partName || !type) return unreadable('part_name_invalid');
      const normalized = canonicalPartName(partName, true);
      if (contentTypes.overrides.has(normalized)) unreadable('content_types_invalid');
      if (unsafeOfficeContentType(type)) unsupported('Office package declares macro or embedded active content');
      contentTypes.overrides.set(normalized, type);
    }
    if ((local === 'f' || local === 'instrtext') && capture === null) {
      capture = { kind: local === 'f' ? 'formula' : 'instruction', depth: thisDepth, value: '' };
    }
    if (local === 'fldsimple') {
      const instruction = attribute(attrs, 'instr');
      if (instruction && unsafeWordInstruction(instruction)) unsupported('Word fields contain an external or active instruction');
    }
    xmlElements.push(tag.name);
    depth++;
  });
  const appendCapturedText = (value: string) => {
    if (!capture) return;
    if (capture.value.length + value.length > 16_384) unsupported('Office active-content field exceeds the inspection limit');
    capture.value += value;
  };
  parser.on('text', appendCapturedText);
  parser.on('cdata', appendCapturedText);
  parser.on('closetag', tag => {
    depth--;
    if (extensionDepth === depth) extensionDepth = null;
    xmlElements.pop();
    if (capture && capture.depth === depth && localName(tag.name) === (capture.kind === 'formula' ? 'f' : 'instrtext')) {
      if (capture.kind === 'formula' && unsafeSpreadsheetFormula(capture.value, state.files)) unsupported('Spreadsheet formula contains an external or active function');
      if (capture.kind === 'instruction' && unsafeWordInstruction(capture.value)) unsupported('Word fields contain an external or active instruction');
      capture = null;
    }
  });
  try {
    parser.write(text).close();
  } catch (error) {
    if (error instanceof MaterialInspectionError) throw error;
    unreadable('xml_parse_error');
  }
  if (!root || depth !== 0 || capture) unreadable('xml_parse_error');
  if (externalLinkPart && (localName(root) !== 'externallink' || externalBookCount < 1)) unreadable('external_link_invalid');

  if (name === '[Content_Types].xml') {
    if (localName(root) !== 'types') unreadable('xml_root_unexpected');
    state.contentTypes = contentTypes;
  }
  if (name.endsWith('.rels')) {
    if (localName(root) !== 'relationships') unreadable('xml_root_unexpected');
    state.relationships.set(name, relationships);
    if (name === '_rels/.rels') {
      const officeDocument = relationships.filter(item => /\/officedocument$/i.test(item.type));
      if (officeDocument.length !== 1) unreadable('relationship_invalid');
      if (officeDocument[0]!.external) unsupported('Office relationships contain external content');
      state.rootDocumentTarget = resolveRelationshipTarget('', officeDocument[0]!.target);
    }
  }
  if (name === 'word/document.xml') {
    if (localName(root) !== 'document') unreadable('xml_root_unexpected');
    state.mainPartRoot = 'word';
  } else if (name === 'xl/workbook.xml') {
    if (localName(root) !== 'workbook') unreadable('xml_root_unexpected');
    state.mainPartRoot = 'xl';
  } else if (name === 'ppt/presentation.xml') {
    if (localName(root) !== 'presentation') unreadable('xml_root_unexpected');
    state.mainPartRoot = 'ppt';
  }
}

function relationshipSource(name: string): string | null {
  if (name === '_rels/.rels') return '';
  const match = /^(.*)\/_rels\/([^/]+)\.rels$/.exec(name);
  return match ? `${match[1]}/${match[2]}` : null;
}

function resolveRelationshipTarget(source: string, target: string): string | null {
  if (target.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.includes('\\') || /%(?:2e|2f|5c)/i.test(target)) {
    unsupported('Office relationships contain an external or ambiguous target');
  }
  const targetPath = target.split('#', 1)[0]!.split('?', 1)[0]!;
  const path = targetPath.startsWith('/') ? targetPath.slice(1) : `${source ? source.slice(0, Math.max(0, source.lastIndexOf('/') + 1)) : ''}${targetPath}`;
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) unreadable('relationship_invalid');
      segments.pop();
    } else segments.push(segment);
  }
  if (!segments.length) unreadable('relationship_invalid');
  return canonicalPartName(segments.join('/'));
}

const DOCX_HYPERLINK_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';

function safeExternalHyperlink(target: string): boolean {
  // Relationship targets are never fetched during inspection. Restrict the exception to printable,
  // absolute browser/mail links so URL parser normalization cannot turn an ambiguous target safe.
  if (target.length > 2048 || /[\p{C}\p{Z}\\<>"']/u.test(target) ||
      /%(?![0-9a-f]{2})|%(?:0[0-9a-f]|1[0-9a-f]|5c|7f)/i.test(target)) return false;
  if (/^mailto:/i.test(target)) {
    // Existing Word files can carry an EAI local part as an IRI. Only letters, numbers, marks
    // and the observed Chinese enumeration comma are accepted beyond the ASCII mail alphabet.
    const match = /^mailto:([a-z0-9.!$%&*+/=_`{|}~\-\p{L}\p{N}\p{M}\u3001]+)@([a-z0-9.-]+)$/iu.exec(target);
    if (!match) return false;
    const labels = match[2]!.split('.');
    return labels.length >= 2 && /^[a-z]{2,}$/i.test(labels.at(-1)!) &&
      labels.every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
  }
  const authority = /^https?:\/\/([^/?#]+)/i.exec(target)?.[1];
  if (!/^[\x21-\x7e]+$/.test(target) || !authority || !/^[a-z0-9.-]+$/i.test(authority)) return false;
  try {
    const url = new URL(target);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname === authority.toLowerCase() &&
      !url.username && !url.password && !url.port && url.hostname.split('.').length >= 2 &&
      /^[a-z]{2,}$/i.test(url.hostname.split('.').at(-1)!) &&
      url.hostname.split('.').every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
  } catch { return false; }
}

function verifyOfficeRelationships(state: OfficeState, declared: string): void {
  const referencedLinks = new Set<string>();
  for (const [relsPath, relationships] of state.relationships) {
    const source = relationshipSource(relsPath);
    if (source === null) return unreadable('relationship_invalid');
    const externalLinkRels = XLSX_EXTERNAL_LINK_RELS.test(relsPath);
    if (externalLinkRels && (declared !== XLSX_MIME || !state.files.has(source) || relationships.length !== 1)) {
      unsupported('Office external link relationships are not a workbook reference');
    }
    for (const relationship of relationships) {
      if (externalLinkRels) {
        if (!relationship.external || relationship.type !== XLSX_EXTERNAL_LINK_PATH_RELATIONSHIP ||
            relationship.id !== state.externalBookRelationshipIds.get(source) ||
            relationship.target.length > 2048 || /[\x00-\x1f\x7f]/.test(relationship.target)) {
          unsupported('Office external link relationships are not a workbook reference');
        }
        // The target is opaque metadata. It is never resolved, opened, or fetched.
        continue;
      }
      if (/\/externallink(?:path)?$/i.test(relationship.type)) {
        if (declared !== XLSX_MIME || source !== 'xl/workbook.xml' || relationship.external ||
            relationship.type !== XLSX_EXTERNAL_LINK_RELATIONSHIP) {
          unsupported('Office relationships contain external content');
        }
        const linkPart = resolveRelationshipTarget(source, relationship.target);
        if (!linkPart || !XLSX_EXTERNAL_LINK_PART.test(linkPart) || !state.files.has(linkPart) ||
            officePartContentType(state, linkPart) !== XLSX_EXTERNAL_LINK_CONTENT_TYPE ||
            !relationship.id || !state.workbookExternalReferenceIds.has(relationship.id) || referencedLinks.has(linkPart)) {
          return unsupported('Office relationships contain an invalid workbook reference');
        }
        referencedLinks.add(linkPart);
      }
      if (relationship.external) {
        if (declared !== DOCX_MIME || !/^word\/.*\.xml$/.test(source) || !state.files.has(source) ||
            relationship.type !== DOCX_HYPERLINK_RELATIONSHIP || !safeExternalHyperlink(relationship.target)) {
          unsupported('Office relationships contain external content');
        }
        continue;
      }
      const target = resolveRelationshipTarget(source, relationship.target);
      if (target) {
        if (!state.files.has(target)) unreadable('relationship_invalid');
        const contentType = officePartContentType(state, target);
        if (contentType && unsafeOfficeContentType(contentType)) {
          unsupported('Office relationship references an active or unsafe content type');
        }
        const hazard = state.payloadHazards.get(target);
        if (hazard === 'active' || (hazard === 'markup' &&
            (/\/image$/i.test(relationship.type) ||
             contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/octet-stream'))) {
          unsupported('Office relationship references active or markup content under a non-active package type');
        }
      }
    }
  }
  if (state.workbookExternalReferenceIds.size !== referencedLinks.size ||
      [...state.files].some(name => XLSX_EXTERNAL_LINK_PART.test(name) && !referencedLinks.has(name))) unreadable('external_link_invalid');
}

function officePartContentType(state: OfficeState, part: string): string | undefined {
  const override = state.contentTypes?.overrides.get(part);
  if (override) return override;
  const extension = part.slice(part.lastIndexOf('.') + 1).toLowerCase();
  return state.contentTypes?.defaults.get(extension);
}

async function inspectOffice(source: ZipSource, declared: string): Promise<void> {
  const signature = source.read(0, Math.min(source.size, 512));
  if (hasCompoundFileHeader(signature)) {
    if (isEncryptedOfficeCompoundSource(source)) encrypted();
    unsupported('Legacy or compound Office files are not accepted; upload readable DOCX or XLSX');
  }
  if (!startsWith(signature, [0x50, 0x4b, 0x03, 0x04])) mismatch();

  const entries = parseZip(source);
  const state: OfficeState = { files: new Set(), contentTypes: null, relationships: new Map(), externalBookRelationshipIds: new Map(), workbookExternalReferenceIds: new Set(), payloadHazards: new Map(), rootDocumentTarget: null, mainPartRoot: null };
  for (const entry of entries) if (!entry.directory) state.files.add(entry.name);
  for (const name of state.files) {
    if (/(?:^|\/)externallinks(?:\/|$)/i.test(name) &&
        (declared !== XLSX_MIME || !XLSX_EXTERNAL_LINK_PART.test(name) && !XLSX_EXTERNAL_LINK_RELS.test(name))) {
      unsupported('Office package contains unsupported external-link content');
    }
    if (/(?:^|\/)(?:embeddings?|activex|customui)(?:\/|$)/i.test(name) ||
        /(?:^|\/)vbaProject\.bin$/i.test(name) || /(?:^|\/)macroSheets?(?:\/|$)/i.test(name) ||
        /(?:^|\/)connections\.xml$/i.test(name) || /(?:^|\/)queryTables\//i.test(name) ||
        /\.(?:svg|html?|xhtml|mht|mhtml)$/i.test(name) ||
        /\.(?:zipx?|7z|rar|gz|gzip|tgz|bz2|bzip2|xz|txz|tar|cab)$/i.test(name)) {
      unsupported('Office package contains embedded, macro, externally loaded, or nested-container content');
    }
  }

  for (const entry of entries) {
    if (entry.directory) {
      // A DEFLATE stream for an empty directory still has compressed bytes.
      // Validate its stream, expanded length and CRC exactly like a file entry.
      await expandEntry(source, entry, false);
      continue;
    }
    const xmlPart = /\.(?:xml|rels|vml)$/i.test(entry.name);
    const expanded = await expandEntry(source, entry, xmlPart);
    if (hasNestedContainerHeader(expanded.head)) {
      unsupported('Nested archive or compound-file content is not accepted');
    }
    const payloadHazard = officePayloadHazard(expanded.head, expanded.length);
    if (payloadHazard) state.payloadHazards.set(entry.name, payloadHazard);
    if (xmlPart) {
      parsePackageXml(entry.name, expanded.whole!, state);
    }
  }

  if (!state.files.has('[Content_Types].xml') || !state.files.has('_rels/.rels') || !state.contentTypes || !state.rootDocumentTarget) {
    if (state.files.has('ppt/presentation.xml') || state.mainPartRoot === 'ppt') unsupported('PPTX is not one of the seven supported material formats');
    unsupported('ZIP content is not a supported DOCX or XLSX package');
  }
  if (state.files.has('ppt/presentation.xml') || state.rootDocumentTarget === 'ppt/presentation.xml' || state.mainPartRoot === 'ppt') {
    unsupported('PPTX is not one of the seven supported material formats');
  }

  const expectedPart = declared === DOCX_MIME
    ? 'word/document.xml'
    : 'xl/workbook.xml';
  const expectedRoot = expectedPart === 'word/document.xml' ? 'word' : 'xl';
  const expectedContentType = expectedPart === 'word/document.xml'
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
  if (state.rootDocumentTarget !== expectedPart || !state.files.has(expectedPart) || state.mainPartRoot !== expectedRoot) {
    mismatch();
  }
  if (officePartContentType(state, expectedPart) !== expectedContentType) unreadable('content_types_invalid');
  for (const name of state.files) {
    if (name === '[Content_Types].xml') continue;
    if (!officePartContentType(state, name)) unreadable('content_types_invalid');
    if (XLSX_EXTERNAL_LINK_PART.test(name)) {
      const rels = name.replace('xl/externalLinks/', 'xl/externalLinks/_rels/') + '.rels';
      if (officePartContentType(state, name) !== XLSX_EXTERNAL_LINK_CONTENT_TYPE || !state.files.has(rels)) unreadable('external_link_invalid');
    }
  }
  verifyOfficeRelationships(state, declared);
}

const ACTIVE_PDF_TOKENS = ['/Launch', '/EmbeddedFile', '/EmbeddedFiles', '/RichMedia', '/SubmitForm', '/ImportData', '/GoToR', '/XFA'].map(token => Buffer.from(token, 'ascii'));
const PDF_RANGE_CHUNK_BYTES = 64 * 1024;
const activePdfToken = (bytes: Buffer) => ACTIVE_PDF_TOKENS.some(token => bytes.includes(token));

async function inspectPdf(bytes: Buffer): Promise<void> {
  if (!bytes.subarray(0, 8).toString('ascii').startsWith('%PDF-')) mismatch();
  if (activePdfToken(bytes)) unsupported('PDF contains an active action or embedded file');
  await inspectPdfDocument({ data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), disableRange: true });
}

/** PDF from a spooled file: tokens are scanned in chunks and pdf.js reads only the byte ranges it needs. */
async function inspectPdfFile(path: string, byteSize: number): Promise<void> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(TEXT_CHUNK_BYTES);
    const overlap = Math.max(...ACTIVE_PDF_TOKENS.map(token => token.length)) - 1;
    let tail = Buffer.alloc(0);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      if (position === 0 && !buffer.subarray(0, Math.min(8, bytesRead)).toString('ascii').startsWith('%PDF-')) mismatch();
      const chunk = buffer.subarray(0, bytesRead);
      // Search the chunk in place plus a small seam window, so no chunk-sized copies are made.
      const seam = Buffer.concat([tail, chunk.subarray(0, overlap)]);
      if (activePdfToken(chunk) || activePdfToken(seam)) unsupported('PDF contains an active action or embedded file');
      tail = Buffer.from(chunk.length >= overlap ? chunk.subarray(chunk.length - overlap) : Buffer.concat([tail, chunk]).subarray(-overlap));
      position += bytesRead;
    }
    if (position !== byteSize) unreadable('file_size_mismatch');
    const pdfjs = await import(import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJsModule;
    const transport = new pdfjs.PDFDataRangeTransport(byteSize, null);
    transport.requestDataRange = (begin: number, end: number) => {
      const chunk = new Uint8Array(end - begin);
      handle.read(chunk, 0, chunk.length, begin).then(
        ({ bytesRead }) => transport.onDataRange(begin, bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead)),
        () => transport.abort()
      );
    };
    await inspectPdfDocument({ range: transport, length: byteSize, rangeChunkSize: PDF_RANGE_CHUNK_BYTES, disableRange: false });
  } finally {
    await handle.close();
  }
}

async function inspectPdfDocument(source: Record<string, unknown>): Promise<void> {
  let loading: PdfLoadingTask | undefined;
  try {
    const pdfjs = await import(import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJsModule;
    loading = pdfjs.getDocument({
      ...source,
      verbosity: 0,
      stopAtErrors: true,
      enableXfa: false,
      useSystemFonts: false,
      disableFontFace: true,
      disableAutoFetch: true,
      disableStream: true,
      maxImageSize: MAX_IMAGE_PIXELS
    });
    const document = await loading.promise;
    if (await document.getPermissions() !== null) encrypted();
    if (!Number.isInteger(document.numPages) || document.numPages < 1) unreadable('pdf_structure_invalid');
    if (document.numPages > 1500) unsupported('PDF exceeds the 1,500-page inspection limit');
    if (document.isPureXfa) unsupported('PDF XFA forms are not supported');

    const javascript = await document.getJSActions();
    if (javascript && javascript.size > 0) unsupported('PDF contains JavaScript actions');
    const attachments = await document.getAttachments();
    if (attachments && attachments.size > 0) unsupported('PDF contains embedded files');
    const fields = await document.getFieldObjects();
    if (fields && Object.keys(fields).length > 0) unsupported('PDF contains interactive form fields');
    const openAction = await document.getOpenAction();
    if (openAction && (openAction.has('url') || openAction.has('unsafeUrl') || openAction.has('action'))) {
      unsupported('PDF contains an active document-open action');
    }

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const annotations = await page.getAnnotations({ intent: 'display' });
      if (annotations.some((item: Record<string, unknown>) => Boolean(item.url || item.unsafeUrl || item.action))) {
        unsupported('PDF contains an external or active annotation');
      }
      if (annotations.some((item: Record<string, unknown>) => item.annotationType === pdfjs.AnnotationType.WIDGET || item.annotationType === pdfjs.AnnotationType.FILEATTACHMENT)) {
        unsupported('PDF contains interactive fields or file annotations');
      }
      const pageActions = await page.getJSActions();
      if (pageActions && pageActions.size > 0) unsupported('PDF page contains JavaScript actions');
      await page.getOperatorList();
      page.cleanup();
      // Decoded page images are garbage now; with --expose-gc free them before the next page.
      (globalThis as { gc?: () => void }).gc?.();
    }
  } catch (error) {
    if (error instanceof MaterialInspectionError) throw error;
    if (error && typeof error === 'object' && 'name' in error && error.name === 'PasswordException') encrypted();
    unreadable('pdf_structure_invalid');
  } finally {
    if (loading) {
      try { await loading.destroy(); } catch { /* The inspection result remains fail-closed. */ }
    }
  }
}

function pngChunkCrc(bytes: Buffer, typeStart: number, length: number): number {
  return crc32([bytes.subarray(typeStart, typeStart + 4), bytes.subarray(typeStart + 4, typeStart + 4 + length)]);
}

function inspectPng(bytes: Buffer): void {
  if (!startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) mismatch();
  let cursor = 8;
  let chunkCount = 0;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let seenPalette = false;
  let seenIdat = false;
  let idatEnded = false;
  let seenIend = false;
  let idatBytes = 0;
  const idat: Buffer[] = [];

  while (cursor < bytes.length) {
    if (++chunkCount > 4096 || cursor + 12 > bytes.length) unreadable('png_structure_invalid');
    const length = bytes.readUInt32BE(cursor);
    const typeStart = cursor + 4;
    const type = bytes.toString('ascii', typeStart, typeStart + 4);
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.length || !/^[A-Za-z]{4}$/.test(type)) unreadable('png_structure_invalid');
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    if (pngChunkCrc(bytes, typeStart, length) !== expectedCrc) unreadable('png_crc_mismatch');

    if (chunkCount === 1 && type !== 'IHDR') unreadable('png_structure_invalid');
    if (type === 'IHDR') {
      if (chunkCount !== 1 || length !== 13) unreadable('png_structure_invalid');
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8]!;
      colorType = bytes[dataStart + 9]!;
      const compression = bytes[dataStart + 10]!;
      const filter = bytes[dataStart + 11]!;
      const interlace = bytes[dataStart + 12]!;
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) unsupported('PNG dimensions exceed the image inspection limit');
      if (!depths[colorType]?.includes(bitDepth) || compression !== 0 || filter !== 0) unreadable('png_structure_invalid');
      if (interlace !== 0) unsupported('Interlaced PNG exceeds the supported inspection profile');
    } else if (type === 'PLTE') {
      if (seenIdat || seenPalette || length === 0 || length > 768 || length % 3 !== 0 || colorType === 0 || colorType === 4) unreadable('png_structure_invalid');
      seenPalette = true;
    } else if (type === 'IDAT') {
      if (idatEnded || seenIend) unreadable('png_structure_invalid');
      if (colorType === 3 && !seenPalette) unreadable('png_structure_invalid');
      seenIdat = true;
      idatBytes += length;
      idat.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      if (length !== 0 || !seenIdat || seenIend) unreadable('png_structure_invalid');
      seenIend = true;
      cursor = chunkEnd;
      break;
    } else {
      if (seenIdat) idatEnded = true;
      if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') unsupported('Animated PNG content is not accepted');
      if (type[0] === type[0]!.toUpperCase()) unsupported('PNG contains an unsupported critical chunk');
    }
    cursor = chunkEnd;
  }

  if (!seenIend || cursor !== bytes.length || !seenIdat || idatBytes === 0) unreadable('png_structure_invalid');
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const rowBytes = Math.ceil(width * channels[colorType]! * bitDepth / 8);
  const decodedBytes = (rowBytes + 1) * height;
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes > MAX_PNG_DECODED_BYTES) unsupported('PNG expanded image exceeds the inspection limit');
  let scanlines: Buffer;
  try { scanlines = inflateSync(Buffer.concat(idat), { maxOutputLength: decodedBytes + 1 }); }
  catch { return unreadable('png_structure_invalid'); }
  if (scanlines.length !== decodedBytes) unreadable('png_structure_invalid');
  for (let row = 0; row < height; row++) if (scanlines[row * (rowBytes + 1)]! > 4) unreadable('png_structure_invalid');
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  if (!startsWith(bytes, [0xff, 0xd8])) mismatch();
  let cursor = 2;
  let dimensions: { width: number; height: number } | null = null;
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (cursor < bytes.length) {
    if (bytes[cursor] !== 0xff) unreadable('jpeg_structure_invalid');
    while (bytes[cursor] === 0xff) cursor++;
    if (cursor >= bytes.length) unreadable('jpeg_structure_invalid');
    const marker = bytes[cursor++]!;
    if (marker === 0xd9) break;
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (cursor + 2 > bytes.length) unreadable('jpeg_structure_invalid');
    const length = bytes.readUInt16BE(cursor);
    if (length < 2 || cursor + length > bytes.length) unreadable('jpeg_structure_invalid');
    if (frameMarkers.has(marker)) {
      if (length < 8 || dimensions) unreadable('jpeg_structure_invalid');
      const height = bytes.readUInt16BE(cursor + 3);
      const width = bytes.readUInt16BE(cursor + 5);
      const components = bytes[cursor + 7]!;
      if (!width || !height || components < 1 || components > 4) unreadable('jpeg_structure_invalid');
      if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) unsupported('JPEG dimensions exceed the image inspection limit');
      dimensions = { width, height };
    }
    if (marker === 0xda) break;
    cursor += length;
  }
  if (!dimensions) return unreadable('jpeg_structure_invalid');
  return dimensions;
}

function inspectJpeg(bytes: Buffer): void {
  const dimensions = jpegDimensions(bytes);
  try {
    const decoded = decodeJpeg(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      tolerantDecoding: false,
      maxResolutionInMP: MAX_IMAGE_PIXELS / 1_000_000,
      maxMemoryUsageInMB: 96
    });
    if (decoded.width !== dimensions.width || decoded.height !== dimensions.height || decoded.data.length !== decoded.width * decoded.height * 4) unreadable('jpeg_structure_invalid');
  } catch (error) {
    if (error instanceof MaterialInspectionError) throw error;
    unreadable('jpeg_structure_invalid');
  }
}

async function inspectContent(bytes: Buffer, declared: string): Promise<void> {
  if (!(M1_UPLOAD_MIME_TYPES as readonly string[]).includes(declared)) unsupported('Declared format is outside the seven supported material MIME types');
  switch (declared) {
    case PDF_MIME:
      await inspectPdf(bytes);
      return;
    case DOCX_MIME:
    case XLSX_MIME:
      await inspectOffice(bufferSource(bytes), declared);
      return;
    case TEXT_MIME:
      await inspectText(bytes, false);
      return;
    case CSV_MIME:
      await inspectText(bytes, true);
      return;
    case PNG_MIME: {
      const detected = await fileTypeFromBuffer(bytes);
      if (detected?.mime !== PNG_MIME) mismatch();
      inspectPng(bytes);
      return;
    }
    case JPEG_MIME: {
      const detected = await fileTypeFromBuffer(bytes);
      if (detected?.mime !== JPEG_MIME) mismatch();
      inspectJpeg(bytes);
      return;
    }
    default:
      unsupported('Declared format is outside the seven supported material MIME types');
  }
}

async function inspectFile(path: string, byteSize: number, declared: string): Promise<void> {
  if (declared === TEXT_MIME || declared === CSV_MIME) {
    // One reused read buffer: no per-chunk allocations for the GC to catch up with.
    const handle = await open(path, 'r');
    let seen = 0;
    try {
      const buffer = Buffer.allocUnsafe(TEXT_CHUNK_BYTES);
      const chunks = async function* () {
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) return;
          seen += bytesRead;
          yield buffer.subarray(0, bytesRead);
        }
      };
      await inspectTextChunks(chunks(), declared === CSV_MIME);
    } finally {
      await handle.close();
    }
    if (seen !== byteSize) unreadable('file_size_mismatch');
    return;
  }
  if (declared === PDF_MIME) return inspectPdfFile(path, byteSize);
  if (declared === DOCX_MIME || declared === XLSX_MIME) {
    const source = fileSource(path, byteSize);
    try { await inspectOffice(source, declared); } finally { source.close(); }
    return;
  }
  // Image formats need random access; the one whole-file copy (bounded by the image limits) lives only in this worker.
  const bytes = await readFile(path);
  if (bytes.length !== byteSize) unreadable('file_size_mismatch');
  await inspectContent(bytes, declared);
}

async function run(): Promise<void> {
  const input = workerData as InspectionInput;
  try {
    if ('path' in input) await inspectFile(input.path, input.byteSize, input.mediaType);
    else await inspectContent(Buffer.from(input.bytes), input.mediaType);
    parentPort?.postMessage({ ok: true } satisfies UploadWorkerReply);
  } catch (error) {
    const failure: InspectionFailure = error instanceof MaterialInspectionError
      ? { status: error.status, code: error.code, message: error.message, reason: error.reason, ...(error.detail ? { detail: error.detail } : {}) }
      : { status: 422, code: 'MATERIAL_UNREADABLE', message: 'Material is corrupt or structurally unreadable', reason: 'inspection_worker_failed' };
    parentPort?.postMessage({ ok: false, ...failure } satisfies UploadWorkerReply);
  } finally {
    parentPort?.close();
  }
}

void run();
