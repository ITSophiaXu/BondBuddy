import test from 'node:test';
import assert from 'node:assert/strict';
import { Value } from '@sinclair/typebox/value';
import { ProjectFileCheckResultSchema } from '@bondbuddy/contracts';
import {
  completedFileCheck,
  verifiedFileCheck,
  verifiedFileLinks,
} from './project-file-evidence.js';
import type { ProjectFileText } from '@bondbuddy/contracts';
const snapshot = (
  texts: string[],
  coverage: 'complete' | 'partial' = 'complete',
): ProjectFileText => ({
  version: 'project-file-text-v1',
  sha256: 'a'.repeat(64),
  format: 'docx',
  spans: texts.map((text, i) => ({
    id: 'p' + i,
    text,
    location: 'row ' + i,
    sha256: 'b'.repeat(64),
  })),
  warnings: [],
  coverage,
});
test('fabricated source anchors are manual, never automatic edits', () => {
  const result = verifiedFileCheck('v1', snapshot(['2025 100']), snapshot(['2025 90']), {
    checked_span_ids: ['p0'],
    findings: [
      {
        kind: 'conflict',
        target_span_id: 'p0',
        original: '90',
        replacement: '100',
        source_span_id: 'p0',
        source_quote: 'invented',
        reason: 'amount',
      },
    ],
    links: [],
  });
  assert.equal(result.status, 'manual');
  assert.equal(result.findings[0].replacement, null);
});
test('incomplete coverage or missing evidence cannot report a clean file', () => {
  for (const p of [
    { findings: [], links: [], checked_span_ids: [] },
    { findings: [], links: [], checked_span_ids: ['p0'] },
  ]) {
    const result = verifiedFileCheck('v', snapshot(['100']), snapshot(['100']), p);
    assert.equal(result.status, 'manual');
    assert.ok(
      Value.Check(ProjectFileCheckResultSchema, {
        version: 'project-file-check-v1',
        files: [result],
      }),
    );
  }
});
test('links preserve row, period, unit and exact version, repeated text requires an unambiguous span', () => {
  const source = snapshot(['2024 100亿元', '2025 100万元']),
    target = snapshot(['2025 100万元']);
  const p = {
    source_span_id: 'p1',
    source_quote: '100万元',
    target_span_id: 'p0',
    target_quote: '100万元',
    field: '资产',
    period: '2025',
    unit: '万元',
  };
  const links = verifiedFileLinks(source, target, [p, { ...p, source_span_id: 'p0' }]);
  assert.equal(links.length, 1);
  assert.equal(links[0].source_location, 'row 1');
  assert.equal(links[0].period, '2025');
  assert.equal(
    verifiedFileLinks(snapshot(['100 100']), target, [
      { ...p, source_span_id: 'p0', source_quote: '100' },
    ]).length,
    0,
  );
  const checked = verifiedFileCheck('v', source, target, {
    checked_span_ids: ['p0'],
    findings: [],
    links: [p],
  });
  assert.equal(checked.status, 'consistent');
});

test('overlapping replacements remain manual instead of an order-dependent bulk edit', () => {
  const result = verifiedFileCheck(
    'v',
    snapshot(['发行规模120万元']),
    snapshot(['发行规模100万元']),
    {
      checked_span_ids: ['p0'],
      links: [],
      findings: ['发行规模100万元', '100万元'].map((original) => ({
        kind: 'conflict',
        target_span_id: 'p0',
        original,
        replacement: '120万元',
        source_span_id: 'p0',
        source_quote: '120万元',
        reason: '发行规模变化',
      })),
    },
  );
  assert.equal(result.status, 'manual');
  assert.ok(result.findings.every((f) => f.kind === 'manual' && f.replacement === null));
});

test('paid completion rejects unread placeholders, missing coverage, partial extraction and truncated findings', () => {
  const source = snapshot(['发行人100万元']),
    target = snapshot(['发行人100万元', '其他披露']);
  const valid = {
    checked_span_ids: ['p0', 'p1'],
    findings: [],
    links: [
      {
        source_span_id: 'p0',
        source_quote: '发行人',
        target_span_id: 'p0',
        target_quote: '发行人',
      },
    ],
  };
  for (const proposal of [
    {},
    { ...valid, checked_span_ids: ['p0'] },
    { ...valid, links: [] },
    { ...valid, checked_span_ids: ['p0', 'p1', 'invented'] },
    { ...valid, findings: Array(1801).fill({}) },
  ]) {
    assert.throws(() => completedFileCheck('v', source, target, proposal), /FILE_CHECK_INCOMPLETE/);
  }
  assert.throws(
    () => completedFileCheck('v', { ...source, coverage: 'partial' }, target, valid),
    /FILE_CHECK_INCOMPLETE/,
  );
  assert.throws(
    () => completedFileCheck('v', source, { ...target, coverage: 'partial' }, valid),
    /FILE_CHECK_INCOMPLETE/,
  );
  assert.equal(completedFileCheck('v', source, target, valid).status, 'consistent');
});

test('complete manual findings need anchored target content and header conflicts remain manual', () => {
  const source = snapshot(['100万元']),
    target = snapshot(['90万元']);
  target.spans[0].id = 'header1-p0';
  const p = {
    checked_span_ids: ['header1-p0'],
    findings: [
      {
        kind: 'conflict',
        target_span_id: 'header1-p0',
        original: '90万元',
        replacement: '100万元',
        source_span_id: 'p0',
        source_quote: '100万元',
        reason: '期间数据变化',
      },
    ],
  };
  const checked = completedFileCheck('v', source, target, p);
  assert.equal(checked.status, 'manual');
  assert.equal(checked.findings[0].replacement, null);
  assert.throws(
    () =>
      completedFileCheck('v', source, target, {
        ...p,
        findings: [{ kind: 'manual', reason: '未检查' }],
      }),
    /FILE_CHECK_INCOMPLETE/,
  );
  assert.throws(
    () =>
      completedFileCheck('v', source, target, {
        ...p,
        findings: [
          {
            kind: 'manual',
            target_span_id: 'header1-p0',
            original: '90万元',
            reason: '该段尚未检查',
          },
        ],
      }),
    /FILE_CHECK_INCOMPLETE/,
  );
  assert.equal(
    completedFileCheck('v', source, target, {
      ...p,
      findings: [
        {
          kind: 'manual',
          target_span_id: 'header1-p0',
          original: '90万元',
          reason: '缺少原始凭据，需要人工确认',
        },
      ],
    }).status,
    'manual',
  );
});
