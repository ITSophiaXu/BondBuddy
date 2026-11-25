import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { inspectMaterialUploadFileDetailed } from './original-material-upload.js';
import { UploadSafetyError } from './upload-safety.js';
import { pngSample } from './upload-safety.samples.js';

const PDF = 'application/pdf';

async function sample(kind: 'scan' | 'margin-scan' | 'ocr' | 'electronic' | 'logo' | 'chart' | 'mixed'): Promise<Buffer> {
  const document = await PDFDocument.create();
  const image = await document.embedPng(pngSample);
  const first = document.addPage([612, 792]);
  if (kind === 'scan' || kind === 'ocr') first.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  else if (kind === 'margin-scan' || kind === 'chart') first.drawImage(image, { x: 50, y: 80, width: 512, height: 632 });
  else if (kind === 'logo' || kind === 'mixed') first.drawImage(image, { x: 36, y: 700, width: 60, height: 60 });
  if (kind === 'ocr' || kind === 'electronic' || kind === 'logo' || kind === 'mixed' || kind === 'chart')
    first.drawText('Electronic document text with a substantial visible paragraph', { x: 40, y: 600, size: 12 });
  if (kind === 'mixed') {
    const second = document.addPage([612, 792]);
    second.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  }
  return Buffer.from(await document.save());
}

for (const kind of ['scan', 'margin-scan', 'ocr', 'electronic', 'logo', 'chart', 'mixed'] as const) {
  test(`project material PDF upload gate: ${kind}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bb-scanned-pdf-'));
    const path = join(directory, 'material.pdf');
    const bytes = await sample(kind);
    try {
      await writeFile(path, bytes);
      if (kind === 'scan' || kind === 'margin-scan' || kind === 'ocr' || kind === 'mixed') {
        await assert.rejects(inspectMaterialUploadFileDetailed(path, bytes.length, PDF), error =>
          error instanceof UploadSafetyError && error.reason === 'scanned_pdf' && error.status === 422);
      } else {
        const result = await inspectMaterialUploadFileDetailed(path, bytes.length, PDF);
        assert.equal(result.mediaType, PDF);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
