import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPdfQuality, PDF_QUALITY_VERSION, auditPdfQualityState, auditPdfQualityMessage, isAuditPdf, pdfQualitySamplePages, isPdfQualityJobVersion } from './pdf-quality.js';
const quality = { version: 'pdf-raster-quality-1', status: 'partial', page_count: 100, checked_pages: 7, low_resolution_pages: [{ page: 7, dpi: 144 }] };
test('quality validates measured page coverage and rejects unknown/private fields', () => {
    assert.deepEqual(readPdfQuality(quality), quality);
    for (const delta of [{ status: 'complete' }, { checked_pages: 101 }, { low_resolution_pages: [{ page: 8, dpi: 144 }] }, { low_resolution_pages: [{ page: 7, dpi: 144 }, { page: 7, dpi: 144 }] }, { low_resolution_pages: [{ page: 7, dpi: 300 }] }, { path: '/private/customer.pdf' }, { page_count: null }])
        assert.equal(readPdfQuality({ ...quality, ...delta }), undefined);
    assert.equal(readPdfQuality(undefined), undefined);
});
test('all DPI-only legacy receipts require reinspection, never silently reject or pass', () => {
    for (const version of ['pdf-raster-quality-1', 'pdf-raster-quality-2', 'pdf-raster-quality-3']) {
        const old = { version, status: 'complete', page_count: 1, checked_pages: 1, low_resolution_pages: [{ page: 1, dpi: 144 }], ...(version.endsWith('-3') ? { sampled_pages: [1] } : {}) };
        assert.ok(readPdfQuality(old));
        assert.equal(auditPdfQualityState(old), 'pending');
        assert.equal(auditPdfQualityState({ ...old, low_resolution_pages: [] }), 'pending');
    }
    assert.equal(isAuditPdf({ role: 'audit', media_type: 'application/pdf' }), true);
    assert.equal(isAuditPdf({ role: 'financial', media_type: 'application/pdf' }), false);
});
test('sample completion validates exact visited pages, early low and incomplete prefixes', () => {
    const full = { version: PDF_QUALITY_VERSION, status: 'complete', page_count: 100, checked_pages: 8, sampled_pages: pdfQualitySamplePages(100), blocking_pages: [], low_resolution_pages: [] };
    assert.equal(auditPdfQualityState(full), 'ready');
    const low = { ...full, checked_pages: 2, sampled_pages: [5, 8], blocking_pages: [8], low_resolution_pages: [{ page: 8, dpi: 144 }] };
    assert.equal(auditPdfQualityState(low), 'low');
    assert.equal(auditPdfQualityState({ ...low, status: 'partial' }), 'low');
    assert.equal(auditPdfQualityState({ ...low, status: 'partial', blocking_pages: [], low_resolution_pages: [] }), 'incomplete');
    for (const delta of [{ sampled_pages: undefined }, { sampled_pages: [5] }, { checked_pages: 1, sampled_pages: [5] }, { sampled_pages: [1, 5, 8, 12, 25, 50, 75, 100] }, { low_resolution_pages: [{ page: 2, dpi: 144 }] }, { sampled_pages: [5, 8, 12, 1, 25, 50, 75, 75] }])
        assert.equal(readPdfQuality({ ...full, ...delta }), undefined);
    assert.equal(readPdfQuality({ ...low, checked_pages: 3, sampled_pages: [5, 8, 12] }), undefined, 'no continuing past the first low page');
    assert.equal(readPdfQuality({ ...full, version: 'pdf-raster-quality-2' }), undefined, 'legacy full cannot claim sample coverage');
    assert.equal(isPdfQualityJobVersion('pdf-raster-quality-2:retry:old'), true);
    assert.equal(isPdfQualityJobVersion(PDF_QUALITY_VERSION + ':retry:new'), true);
    assert.equal(isPdfQualityJobVersion('pdf-raster-quality-1'), false);
});
test('sample count is bounded and page indices may exceed old full-scan cap', () => {
    for (const count of [1, 8, 9, 12, 100, 1501, 100000]) {
        const sampled_pages = pdfQualitySamplePages(count);
        assert.ok(sampled_pages.length <= 8);
        assert.equal(new Set(sampled_pages).size, sampled_pages.length);
        assert.ok(readPdfQuality({ version: PDF_QUALITY_VERSION, status: 'complete', page_count: count, checked_pages: sampled_pages.length, sampled_pages, blocking_pages: [], low_resolution_pages: [] }));
    }
    assert.deepEqual(pdfQualitySamplePages(100), [5, 8, 12, 1, 25, 50, 75, 100]);
});
test('DPI advisories may precede page one in sample order; only corroborated severe detail blocks', () => {
    const full = { version: PDF_QUALITY_VERSION, status: 'complete', page_count: 100, checked_pages: 8, sampled_pages: pdfQualitySamplePages(100), blocking_pages: [], low_resolution_pages: [{ page: 5, dpi: 150 }, { page: 1, dpi: 150 }] };
    assert.equal(auditPdfQualityState(full), 'ready');
    assert.equal(auditPdfQualityMessage(full), '');
    for (const delta of [{ blocking_pages: undefined }, { blocking_pages: [5] }, { blocking_pages: [100] }, { low_resolution_pages: [{ page: 1, dpi: 150 }, { page: 5, dpi: 150 }] }, { low_resolution_pages: [{ page: 5, dpi: 150 }, { page: 5, dpi: 150 }] }, { checked_pages: 2, sampled_pages: [5, 8], low_resolution_pages: [{ page: 5, dpi: 150 }] }])
        assert.equal(readPdfQuality({ ...full, ...delta }), undefined);
});
