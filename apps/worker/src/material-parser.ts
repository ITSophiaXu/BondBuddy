import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DOCUMENT_PARSER_MEDIA_TYPES,
  runDocumentParser,
  validateDocumentParseResponse,
  type DocumentParseRequest,
  type DocumentParseResponse,
} from './document-parser.js';

export interface MaterialParserPool {
  query(sql: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Private object store adapter. It must never grant public access to material bytes. */
export interface MaterialParserBlobStore {
  getPrivate(objectKey: string): Promise<Uint8Array | null>;
}

export interface AuthorizedMaterialParseInput {
  /** Trusted worker identity, never copied from an HTTP request body. */
  ownerUserId: string;
  projectId: string;
  materialId: string;
  version: number;
  requestId: string;
  options?: { max_pages?: number };
}

export type AuthorizedMaterialParser = (
  request: DocumentParseRequest,
) => Promise<DocumentParseResponse>;

export interface MaterialParserDependencies {
  pool: MaterialParserPool;
  blobs: MaterialParserBlobStore;
  /** Defaults to the worker's versioned Python parser bridge. */
  parser?: AuthorizedMaterialParser;
  /** Test seam only; production uses the OS private temporary directory. */
  tempRoot?: string;
}

type MaterialRow = {
  owner_user_id: string;
  project_id: string;
  id: string;
  version: number;
  media_type: string;
  byte_size: number;
  sha256: string;
  object_key: string;
};

function bridgeError(code: string): Error {
  const error = new Error(code);
  error.name = 'MaterialParserError';
  return error;
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function supportedMediaType(value: string): value is typeof DOCUMENT_PARSER_MEDIA_TYPES[number] {
  return (DOCUMENT_PARSER_MEDIA_TYPES as readonly string[]).includes(value);
}

function validateInput(input: AuthorizedMaterialParseInput): void {
  if (!safeIdentifier(input.ownerUserId) || !safeIdentifier(input.projectId) || !safeIdentifier(input.materialId) ||
      !safeIdentifier(input.requestId) || !Number.isSafeInteger(input.version) || input.version < 1 ||
      (input.options?.max_pages !== undefined && (!Number.isSafeInteger(input.options.max_pages) ||
        input.options.max_pages < 1 || input.options.max_pages > 1500))) {
    throw bridgeError('INVALID_MATERIAL_PARSE_REQUEST');
  }
}

function parseRow(value: Record<string, unknown>, input: AuthorizedMaterialParseInput): MaterialRow {
  const row = value as unknown as MaterialRow;
  const version = Number(row.version);
  const byteSize = Number(row.byte_size);
  const hash = typeof row.sha256 === 'string' ? row.sha256.trim().toLowerCase() : '';
  if (row.owner_user_id !== input.ownerUserId || row.project_id !== input.projectId || row.id !== input.materialId ||
      version !== input.version || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > 100 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(hash) || typeof row.media_type !== 'string' ||
      typeof row.object_key !== 'string' || row.object_key.length === 0) {
    throw bridgeError('INVALID_MATERIAL_METADATA');
  }
  return { ...row, version, byte_size: byteSize, sha256: hash };
}

function containsPrivateReference(value: unknown, references: string[]): boolean {
  if (typeof value === 'string') return references.some((reference) => value.includes(reference));
  if (Array.isArray(value)) return value.some((item) => containsPrivateReference(item, references));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(([key, child]) =>
      references.some((reference) => key.includes(reference)) || containsPrivateReference(child, references));
  }
  return false;
}

/**
 * Resolves and parses one immutable, owner-authorized material version. This is an
 * internal worker capability and must not be called directly from an HTTP route.
 */
export async function parseAuthorizedMaterial(
  dependencies: MaterialParserDependencies,
  input: AuthorizedMaterialParseInput,
): Promise<DocumentParseResponse> {
  validateInput(input);

  let result: { rows: Record<string, unknown>[] };
  try {
    result = await dependencies.pool.query(
      `SELECT owner_user_id, project_id, id, version, media_type, byte_size, sha256, object_key
         FROM bb_material_versions
        WHERE owner_user_id = $1 AND project_id = $2 AND id = $3 AND version = $4
          AND deleted_at IS NULL`,
      [input.ownerUserId, input.projectId, input.materialId, input.version],
    );
  } catch {
    throw bridgeError('MATERIAL_LOOKUP_FAILED');
  }
  if (result.rows.length === 0) throw bridgeError('NOT_FOUND');
  if (result.rows.length !== 1) throw bridgeError('INVALID_MATERIAL_METADATA');

  const row = parseRow(result.rows[0]!, input);
  if (!supportedMediaType(row.media_type)) throw bridgeError('UNSUPPORTED_MEDIA_TYPE');

  let storedBytes: Uint8Array | null;
  try {
    storedBytes = await dependencies.blobs.getPrivate(row.object_key);
  } catch {
    throw bridgeError('MATERIAL_BYTES_UNAVAILABLE');
  }
  if (storedBytes === null) throw bridgeError('MATERIAL_BYTES_UNAVAILABLE');
  const bytes = Buffer.from(storedBytes);
  if (bytes.byteLength !== row.byte_size || createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
    throw bridgeError('MATERIAL_INTEGRITY_MISMATCH');
  }

  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(dependencies.tempRoot ?? tmpdir(), 'bb-material-'));
    const authorizedPath = join(directory, 'source');
    await writeFile(authorizedPath, bytes, { flag: 'wx', mode: 0o600 });
    const request: DocumentParseRequest = {
      schema_version: 'document-parse-request-v1',
      request_id: input.requestId,
      material: {
        material_id: row.id,
        material_version: row.version,
        media_type: row.media_type,
        sha256: row.sha256,
        authorized_local_path: authorizedPath,
      },
      options: input.options ?? {},
    };
    let response: DocumentParseResponse;
    try {
      response = validateDocumentParseResponse(await (dependencies.parser ?? runDocumentParser)(request), request);
    } catch {
      throw bridgeError('MATERIAL_PARSE_FAILED');
    }
    if (containsPrivateReference(response, [row.object_key, authorizedPath, directory])) {
      throw bridgeError('PARSER_RESULT_CONTAINS_PRIVATE_REFERENCE');
    }
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'MaterialParserError') throw error;
    throw bridgeError('MATERIAL_PARSE_FAILED');
  } finally {
    if (directory !== undefined) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        throw bridgeError('MATERIAL_TEMP_CLEANUP_FAILED');
      }
    }
  }
}
