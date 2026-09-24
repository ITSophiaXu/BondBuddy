import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BlobServiceClient } from '@azure/storage-blob';
import { Pool } from 'pg';
import { azureBlobs, digest, verifiedMedia } from './data.js';
import { createServer } from './server.js';
import {
  activeDocxSample, activeSvgDocxSample, compressedBombSample, csvFormulaSample, csvSample, DOCX, docxSample,
  encryptedOfficeSample, encryptedZipSample, entryCountBombSample, expandedSizeBombSample, JPEG, jpegSample, CSV,
  macroDefaultDocxSample, macroDocxSample, nestedGzipDocxSample, PDF, pdfSample, PNG, pngSample, PPTX, pptxSample, TEXT, textSample,
  XLSX, xlsxSample
} from './upload-safety.samples.js';

const connection = process.env.BB_TEST_DATABASE_URL;
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const origin = 'http://bondbuddy.test';

async function expectInspectionFailure(bytes: Buffer, mediaType: string, status: number, code: string): Promise<void> {
  await assert.rejects(verifiedMedia(bytes, mediaType), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { status: number }).status, status);
    assert.equal((error as Error & { code: string }).code, code);
    return true;
  });
}

test('bounded upload inspection accepts valid synthetic samples for the seven shared MIME types', async () => {
  const valid = [
    { name: 'synthetic.pdf', mediaType: PDF, bytes: pdfSample() },
    { name: 'synthetic.docx', mediaType: DOCX, bytes: await docxSample() },
    { name: 'synthetic.xlsx', mediaType: XLSX, bytes: await xlsxSample() },
    { name: 'synthetic.txt', mediaType: TEXT, bytes: textSample },
    { name: 'synthetic.csv', mediaType: CSV, bytes: csvSample },
    { name: 'synthetic-bom-quoted.csv', mediaType: CSV, bytes: Buffer.from('\uFEFF"label",amount\r\n"Synthetic", -100 \r\n') },
    { name: 'synthetic.png', mediaType: PNG, bytes: pngSample },
    { name: 'synthetic.jpg', mediaType: JPEG, bytes: jpegSample }
  ];
  for (const item of valid) assert.equal(await verifiedMedia(item.bytes, item.mediaType), item.mediaType, item.name);
});

test('upload inspection rejects encryption, corrupt structures, active content, and bounded archive abuse', async () => {
  const encryptedPdf = pdfSample({ encrypted: true });
  const scriptPdf = pdfSample({ javascript: true });
  const corruptPdf = pdfSample({ corrupt: true });
  const corruptDocx = (await docxSample()).subarray(0, -10);
  const corruptXlsx = (await xlsxSample()).subarray(0, -10);
  const activeXlsx = await xlsxSample(Buffer.from('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1"><f>WEBSERVICE("https://example.invalid")</f></c></row></sheetData></worksheet>'));
  const imageFormulaXlsx = await xlsxSample(Buffer.from('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1"><f>IMAGE("https://example.invalid/image.png")</f></c></row></sheetData></worksheet>'));
  const nestedDocx = await docxSample([{ name: 'word/embeddings/inner.zip', contents: Buffer.from([0x50, 0x4b, 0x03, 0x04]) }]);
  const unicodeWhitespaceFormulaCsv = Buffer.from(`name,value\nrow,"${'\u00a0'.repeat(600)}=HYPERLINK(""https://example.invalid"")"\n`);
  const bomFormulaCsv = Buffer.from('\uFEFF"=HYPERLINK(""https://example.invalid"")"\n');
  const badPng = pngSample.subarray(0, -8);
  const badJpeg = jpegSample.subarray(0, -8);

  await expectInspectionFailure(encryptedPdf, PDF, 422, 'MATERIAL_ENCRYPTED');
  await expectInspectionFailure(encryptedOfficeSample(), DOCX, 422, 'MATERIAL_ENCRYPTED');
  await expectInspectionFailure(await encryptedZipSample(), DOCX, 422, 'MATERIAL_ENCRYPTED');
  await expectInspectionFailure(corruptPdf, PDF, 422, 'MATERIAL_UNREADABLE');
  await expectInspectionFailure(corruptDocx, DOCX, 422, 'MATERIAL_UNREADABLE');
  await expectInspectionFailure(corruptXlsx, XLSX, 422, 'MATERIAL_UNREADABLE');
  await expectInspectionFailure(Buffer.from('ordinary text'), PDF, 422, 'MATERIAL_CONTENT_MISMATCH');
  await expectInspectionFailure(scriptPdf, PDF, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await pptxSample(), PPTX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await pptxSample(), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await activeDocxSample(), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await activeSvgDocxSample(), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await macroDocxSample(), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await macroDefaultDocxSample(), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(activeXlsx, XLSX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(imageFormulaXlsx, XLSX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(nestedDocx, DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await nestedGzipDocxSample(), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await compressedBombSample(), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await expandedSizeBombSample(), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(await entryCountBombSample(), DOCX, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(csvFormulaSample, CSV, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(unicodeWhitespaceFormulaCsv, CSV, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(bomFormulaCsv, CSV, 415, 'MATERIAL_FORMAT_UNSUPPORTED');
  await expectInspectionFailure(Buffer.from('column,value\nrow,"unterminated', 'utf8'), CSV, 422, 'MATERIAL_UNREADABLE');
  await expectInspectionFailure(badPng, PNG, 422, 'MATERIAL_UNREADABLE');
  await expectInspectionFailure(badJpeg, JPEG, 422, 'MATERIAL_UNREADABLE');
  await expectInspectionFailure(Buffer.from([0xc3, 0x28]), TEXT, 422, 'MATERIAL_CONTENT_MISMATCH');
});

test('upload inspection limits concurrent parser workers and releases capacity after use', async () => {
  const first = verifiedMedia(textSample, TEXT);
  const second = verifiedMedia(textSample, TEXT);
  const rejected = verifiedMedia(textSample, TEXT);
  await assert.rejects(rejected, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { status: number }).status, 503);
    assert.equal((error as Error & { code: string }).code, 'DATA_UNAVAILABLE');
    return true;
  });
  assert.deepEqual(await Promise.all([first, second]), [TEXT, TEXT]);
  assert.equal(await verifiedMedia(textSample, TEXT), TEXT);
});

test('PostgreSQL/Azurite upload scan runs before Blob receipt and preserves owner 404 and retry idempotency', { skip: !connection || !blobConnection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const originalOwnerId = `upload-${randomUUID()}`;
  let ownerId = originalOwnerId;
  const containerName = `bb-upload-${randomUUID().replaceAll('-', '')}`;
  const blobs = azureBlobs(blobConnection!, containerName);
  const app = createServer({
    pool,
    blobs,
    principal: async () => ({ userId: ownerId, csrfVerified: true }),
    allowedOrigin: origin
  });
  const send = (method: string, url: string, payload?: unknown, contentType = 'application/json') => app.inject({
    method: method as any,
    url,
    headers: { origin, 'content-type': contentType },
    payload: payload as any
  });
  let projectId = '';
  try {
    await pool.query('SELECT 1');
    const project = await send('POST', '/api/v1/projects', { name: 'Synthetic Upload Safety', kind: 'update', issuer_name: null, market: null, offering: null });
    assert.equal(project.statusCode, 201, project.body);
    projectId = project.json().project_id;
    const pdf = pdfSample();
    const start = await send('POST', `/api/v1/projects/${projectId}/materials/uploads`, {
      filename: 'synthetic.pdf', media_type: PDF, byte_size: pdf.length, sha256: digest(pdf), role: 'audit'
    });
    assert.equal(start.statusCode, 201, start.body);
    const uploadUrl = start.json().upload_url;
    const uploadId = start.json().upload_id;
    const firstPut = await send('PUT', uploadUrl, pdf, 'application/octet-stream');
    assert.equal(firstPut.statusCode, 204, firstPut.body);
    assert.equal((await send('PUT', uploadUrl, pdf, 'application/octet-stream')).statusCode, 204, 'retrying received bytes stays idempotent');
    const completeUrl = `/api/v1/projects/${projectId}/materials/uploads/${uploadId}/complete`;
    const complete = await send('POST', completeUrl, { byte_size: pdf.length, sha256: digest(pdf) });
    assert.equal(complete.statusCode, 200, complete.body);
    const replay = await send('POST', completeUrl, { byte_size: pdf.length, sha256: digest(pdf) });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().material_id, complete.json().material_id);

    const bad = await docxSample();
    bad.writeUInt32LE(0, bad.length - 22); // Corrupt the end-of-central-directory signature while keeping the request structurally plausible.
    const rejectedStart = await send('POST', `/api/v1/projects/${projectId}/materials/uploads`, {
      filename: 'corrupt.docx', media_type: DOCX,
      byte_size: bad.length, sha256: digest(bad), role: 'audit'
    });
    assert.equal(rejectedStart.statusCode, 201, rejectedStart.body);
    const rejectedPut = await send('PUT', rejectedStart.json().upload_url, bad, 'application/octet-stream');
    assert.equal(rejectedPut.statusCode, 422, rejectedPut.body);
    assert.equal(rejectedPut.json().code, 'MATERIAL_UNREADABLE');
    const blobKey = `users/${ownerId}/projects/${projectId}/uploads/${rejectedStart.json().upload_id}`;
    assert.equal(await blobs.getIfExists(blobKey), null, 'rejected bytes never reach private Blob storage');

    ownerId = `upload-other-${randomUUID()}`;
    assert.equal((await send('GET', `/api/v1/projects/${projectId}/materials/${complete.json().material_id}`)).statusCode, 404);
    assert.equal((await send('GET', `/api/v1/projects/${projectId}/materials/${complete.json().material_id}/download`)).statusCode, 404);
  } finally {
    if (projectId) {
      await pool.query('DELETE FROM bb_outbox WHERE owner_user_id=$1', [originalOwnerId]);
      await pool.query('DELETE FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2', [originalOwnerId, projectId]);
      await pool.query('DELETE FROM bb_uploads WHERE owner_user_id=$1 AND project_id=$2', [originalOwnerId, projectId]);
      await pool.query('DELETE FROM bb_projects WHERE owner_user_id=$1 AND id=$2', [originalOwnerId, projectId]);
    }
    await app.close();
    await pool.end();
    await BlobServiceClient.fromConnectionString(blobConnection!).getContainerClient(containerName).deleteIfExists();
  }
});
