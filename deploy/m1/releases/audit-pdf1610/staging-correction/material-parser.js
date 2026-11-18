import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createParseStaging } from './parse-staging.js';
import { DOCUMENT_PARSER_MEDIA_TYPES, DOCUMENT_PARSER_STREAM_MAX_OUTPUT_BYTES, runDocumentParserToFile, runDocumentParser, validateDocumentParseResponse, } from './document-parser.js';
import { lookupParseCache, saveParseCache, } from './parse-cache.js';
/**
 * #17 parse capacity on the M1 production worker profile (384M container, 160 MiB V8 heap). Large
 * PDF/TXT evidence uses bounded NDJSON spooled to disk; DOCX/XLSX/CSV retain the bounded JSON bridge.
 * Inputs above a per-type or protocol budget fail with MATERIAL_TOO_LARGE instead of being retried.
 */
export const M1_PARSE_BYTE_LIMITS = {
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 100 * 1024 * 1024,
    'application/pdf': 100 * 1024 * 1024,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 20 * 1024 * 1024,
    'text/csv': 2 * 1024 * 1024,
    'text/plain': 20 * 1024 * 1024,
};
export const M1_PARSE_OUTPUT_BUDGET_BYTES = 16 * 1024 * 1024;
/** Bounded disk-spooled NDJSON budget; full PDF evidence is not buffered in either process. */
export const M1_PARSE_STREAM_OUTPUT_BUDGET_BYTES = DOCUMENT_PARSER_STREAM_MAX_OUTPUT_BYTES;
function envBytes(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '')
        return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1024 || value > 256 * 1024 * 1024)
        throw bridgeError('INVALID_MATERIAL_PARSE_CAPACITY');
    return value;
}
function bridgeError(code) {
    const error = new Error(code);
    error.name = 'MaterialParserError';
    return error;
}
function safeIdentifier(value) {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
function supportedMediaType(value) {
    return DOCUMENT_PARSER_MEDIA_TYPES.includes(value);
}
function validateInput(input) {
    if (!safeIdentifier(input.ownerUserId) || !safeIdentifier(input.projectId) || !safeIdentifier(input.materialId) ||
        !safeIdentifier(input.requestId) || !Number.isSafeInteger(input.version) || input.version < 1 ||
        (input.requiredRole !== undefined && !['historical', 'audit'].includes(input.requiredRole)) ||
        (input.options?.max_pages !== undefined && (!Number.isSafeInteger(input.options.max_pages) ||
            input.options.max_pages < 1 || input.options.max_pages > 1500))) {
        throw bridgeError('INVALID_MATERIAL_PARSE_REQUEST');
    }
}
function parseRow(value, input) {
    const row = value;
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
function containsPrivateReference(value, references) {
    if (typeof value === 'string')
        return references.some((reference) => value.includes(reference));
    if (Array.isArray(value))
        return value.some((item) => containsPrivateReference(item, references));
    if (typeof value === 'object' && value !== null) {
        return Object.entries(value).some(([key, child]) => references.some((reference) => key.includes(reference)) || containsPrivateReference(child, references));
    }
    return false;
}
/** Copies the private object to the staging file and verifies its immutable size and SHA-256. */
async function stageMaterial(blobs, row, path) {
    let digest;
    try {
        if (blobs.readToFile)
            digest = await blobs.readToFile(row.object_key, path, row.byte_size);
        else {
            const stored = await blobs.getPrivate(row.object_key);
            if (stored === null)
                digest = null;
            else {
                const bytes = Buffer.from(stored);
                digest = { byteSize: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
                if (digest.byteSize === row.byte_size && digest.sha256 === row.sha256)
                    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
            }
        }
    }
    catch (error) {
        // A bounded read that overflows means the stored object grew: an integrity failure, not an outage.
        if (error instanceof Error && 'status' in error && error.status === 413)
            throw bridgeError('MATERIAL_INTEGRITY_MISMATCH');
        throw bridgeError('MATERIAL_BYTES_UNAVAILABLE');
    }
    if (digest === null)
        throw bridgeError('MATERIAL_BYTES_UNAVAILABLE');
    if (digest.byteSize !== row.byte_size || digest.sha256 !== row.sha256)
        throw bridgeError('MATERIAL_INTEGRITY_MISMATCH');
}
async function lookupMaterial(dependencies, input) {
    let result;
    try {
        result = await dependencies.pool.query(`SELECT owner_user_id, project_id, id, version, media_type, byte_size, sha256, object_key, role
         FROM bb_material_versions
        WHERE owner_user_id = $1 AND project_id = $2 AND id = $3 AND version = $4
          AND ($5::text IS NULL OR (role = $5 AND media_type IN (
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/pdf'
          )))
          AND deleted_at IS NULL`, [input.ownerUserId, input.projectId, input.materialId, input.version, input.requiredRole ?? null]);
    }
    catch {
        throw bridgeError('MATERIAL_LOOKUP_FAILED');
    }
    if (result.rows.length === 0)
        throw bridgeError('NOT_FOUND');
    if (result.rows.length !== 1)
        throw bridgeError('INVALID_MATERIAL_METADATA');
    const row = parseRow(result.rows[0], input);
    if (input.requiredRole !== undefined && row.role !== input.requiredRole)
        throw bridgeError('MATERIAL_ROLE_MISMATCH');
    if (input.requiredRole === 'historical' && row.media_type !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' && row.media_type !== 'application/pdf')
        throw bridgeError('UNSUPPORTED_MEDIA_TYPE');
    if (!supportedMediaType(row.media_type))
        throw bridgeError('UNSUPPORTED_MEDIA_TYPE');
    if (row.byte_size > (dependencies.byteLimits?.[row.media_type] ?? M1_PARSE_BYTE_LIMITS[row.media_type]))
        throw bridgeError('MATERIAL_PARSE_SIZE_LIMIT');
    return row;
}
function requestFor(row, input) {
    return {
        schema_version: 'document-parse-request-v1', request_id: input.requestId,
        material: { material_id: row.id, material_version: row.version, media_type: row.media_type,
            sha256: row.sha256, authorized_local_path: '/private/bondbuddy-cache-lookup' },
        options: input.options ?? {},
    };
}
/** Default PDF/TXT bridge: stream parser rows to a disk spool so neither runtime retains the full JSON response. */
export async function parseAuthorizedMaterialToStream(dependencies, input) {
    validateInput(input);
    if (dependencies.parser !== undefined)
        return null;
    const row = await lookupMaterial(dependencies, input);
    if (row.media_type !== 'application/pdf' && row.media_type !== 'text/plain')
        return null;
    let directory;
    let cleanup;
    try {
        const stagingRoot = dependencies.tempRoot ?? process.env.BB_PARSE_STAGING_DIR;
        if (stagingRoot) {
            ({ directory, cleanup } = await createParseStaging(stagingRoot));
        }
        else {
            directory = await mkdtemp(join(tmpdir(), 'bb-material-'));
            cleanup = () => rm(directory, { recursive: true, force: true });
        }
        const request = requestFor(row, input);
        const authorizedPath = join(directory, 'source');
        await stageMaterial(dependencies.blobs, row, authorizedPath);
        request.material.authorized_local_path = authorizedPath;
        if (row.media_type === 'application/pdf')
            await dependencies.onStagedPdf?.(authorizedPath);
        const stream = await runDocumentParserToFile(request, join(directory, 'records.ndjson'), {
            maxOutputBytes: envBytes('BB_PARSE_STREAM_MAX_OUTPUT_BYTES', M1_PARSE_STREAM_OUTPUT_BUDGET_BYTES),
        });
        return { row, request, stream, directory, cleanup: cleanup };
    }
    catch (error) {
        if (cleanup)
            try {
                await cleanup();
            }
            catch { /* preserve parse error */ }
        if (error instanceof Error && error.name === 'MaterialParserError')
            throw error;
        if (error instanceof Error && error.message.startsWith('PARSE_STAGING_'))
            throw bridgeError('MATERIAL_BYTES_UNAVAILABLE');
        if (error instanceof Error && error.message === 'DOCUMENT_PARSER_OUTPUT_LIMIT')
            throw bridgeError('MATERIAL_PARSE_OUTPUT_LIMIT');
        if (error instanceof Error && error.message === 'DOCUMENT_PARSER_MEMORY_LIMIT')
            throw bridgeError('MATERIAL_PARSE_MEMORY_LIMIT');
        if (error instanceof Error && error.message === 'DOCUMENT_PARSER_TEXT_LIMIT')
            throw bridgeError('MATERIAL_PARSE_SIZE_LIMIT');
        if (error instanceof Error && error.message === 'DOCUMENT_PARSER_TIMEOUT')
            throw bridgeError('MATERIAL_PARSE_TIMEOUT');
        throw bridgeError('MATERIAL_PARSE_FAILED');
    }
}
/**
 * Resolves and parses one immutable, owner-authorized material version. This is an
 * internal worker capability and must not be called directly from an HTTP route.
 */
export async function parseAuthorizedMaterial(dependencies, input) {
    validateInput(input);
    const row = await lookupMaterial(dependencies, input);
    const request = requestFor(row, input);
    const cacheLookupPath = request.material.authorized_local_path;
    const cacheable = dependencies.parseCache !== undefined && input.options?.max_pages === undefined;
    const cacheContext = cacheable ? {
        ownerUserId: input.ownerUserId,
        request,
        versions: dependencies.parseCache.versions,
    } : undefined;
    let directory;
    let cleanup;
    try {
        const stagingRoot = dependencies.tempRoot ?? process.env.BB_PARSE_STAGING_DIR;
        if (stagingRoot) {
            ({ directory, cleanup } = await createParseStaging(stagingRoot));
        }
        else {
            directory = await mkdtemp(join(tmpdir(), 'bb-material-'));
            cleanup = () => rm(directory, { recursive: true, force: true });
        }
        // openpyxl requires the OOXML workbook suffix when given a path. Derive it from the
        // trusted media type, never from the uploaded filename or object key.
        const authorizedPath = join(directory, row.media_type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            ? 'source.xlsx' : 'source');
        await stageMaterial(dependencies.blobs, row, authorizedPath);
        if (row.media_type === 'application/pdf')
            await dependencies.onStagedPdf?.(authorizedPath);
        // Bytes are verified before a cache hit is trusted, as before streaming.
        if (cacheContext !== undefined) {
            try {
                const cached = await lookupParseCache(dependencies.parseCache.dependencies, cacheContext);
                if (cached !== null) {
                    if (containsPrivateReference(cached, [row.object_key, cacheLookupPath])) {
                        throw bridgeError('MATERIAL_PARSE_CACHE_FAILED');
                    }
                    return cached;
                }
            }
            catch {
                // Cache metadata and object integrity failures are not cache misses. Keep private cache details hidden.
                throw bridgeError('MATERIAL_PARSE_CACHE_FAILED');
            }
        }
        request.material.authorized_local_path = authorizedPath;
        let response;
        const maxOutputBytes = dependencies.maxOutputBytes ?? envBytes('BB_PARSE_MAX_OUTPUT_BYTES', M1_PARSE_OUTPUT_BUDGET_BYTES);
        try {
            const raw = await (dependencies.parser ?? (parseRequest => runDocumentParser(parseRequest, { maxOutputBytes })))(request);
            if (containsPrivateReference(raw, [row.object_key, authorizedPath, directory])) {
                throw bridgeError('PARSER_RESULT_CONTAINS_PRIVATE_REFERENCE');
            }
            response = validateDocumentParseResponse(raw, request);
        }
        catch (error) {
            if (error instanceof Error && error.name === 'MaterialParserError')
                throw error;
            // The same document always produces the same output: over budget is terminal, not a retry.
            if (error instanceof Error && error.message === 'DOCUMENT_PARSER_OUTPUT_LIMIT')
                throw bridgeError('MATERIAL_PARSE_OUTPUT_LIMIT');
            if (error instanceof Error && error.message === 'DOCUMENT_PARSER_MEMORY_LIMIT')
                throw bridgeError('MATERIAL_PARSE_MEMORY_LIMIT');
            if (error instanceof Error && error.message === 'DOCUMENT_PARSER_TIMEOUT')
                throw bridgeError('MATERIAL_PARSE_TIMEOUT');
            throw bridgeError('MATERIAL_PARSE_FAILED');
        }
        if (containsPrivateReference(response, [row.object_key, authorizedPath, directory])) {
            throw bridgeError('PARSER_RESULT_CONTAINS_PRIVATE_REFERENCE');
        }
        if (cacheContext !== undefined && response.status !== 'failed') {
            try {
                await saveParseCache(dependencies.parseCache.dependencies, cacheContext, response);
            }
            catch {
                throw bridgeError('MATERIAL_PARSE_CACHE_FAILED');
            }
        }
        return response;
    }
    catch (error) {
        if (error instanceof Error && error.name === 'MaterialParserError')
            throw error;
        if (error instanceof Error && error.message.startsWith('PARSE_STAGING_'))
            throw bridgeError('MATERIAL_BYTES_UNAVAILABLE');
        throw bridgeError('MATERIAL_PARSE_FAILED');
    }
    finally {
        if (cleanup) {
            try {
                await cleanup();
            }
            catch {
                throw bridgeError('MATERIAL_TEMP_CLEANUP_FAILED');
            }
        }
    }
}
/** Lightweight inspections share owner/version/hash verified private staging,
 * but never invoke native extraction, OCR or a model. */
export async function inspectAuthorizedPdf(dependencies, input, inspect) {
    validateInput(input);
    const row = await lookupMaterial(dependencies, input);
    if (row.media_type !== 'application/pdf')
        throw bridgeError('UNSUPPORTED_MEDIA_TYPE');
    let directory, cleanup;
    try {
        const stagingRoot = dependencies.tempRoot ?? process.env.BB_PARSE_STAGING_DIR;
        if (stagingRoot)
            ({ directory, cleanup } = await createParseStaging(stagingRoot));
        else {
            directory = await mkdtemp(join(tmpdir(), 'bb-pdf-quality-'));
            cleanup = () => rm(directory, { recursive: true, force: true });
        }
        const path = join(directory, 'source');
        await stageMaterial(dependencies.blobs, row, path);
        return await inspect(path);
    }
    catch (error) {
        if (error instanceof Error && error.message === 'PARSE_STAGING_CAPACITY')
            throw bridgeError('MATERIAL_PARSE_CAPACITY_WAIT');
        throw error;
    }
    finally {
        await cleanup?.();
    }
}
