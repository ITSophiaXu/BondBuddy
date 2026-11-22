import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { Market, Offering, ReportingPeriod } from '@bondbuddy/contracts';
import { estimateUpdateDifficulty } from '@bondbuddy/domain/update-difficulty';
import { runDocumentParser } from './document-parser.js';
import { parseAuthorizedMaterial } from './material-parser.js';
import { recognizeHistoricalNativeText } from './historical-native-recognition.js';

type AuthorizedManifest = {
  cases: Array<{
    case_id: string;
    market: Market;
    offering: Offering;
    source_reporting_periods: string[];
    target_confirmation: {
      status: 'confirmed' | 'pending';
      confirmed_by: string | null;
      confirmed_on: string | null;
      market: Market | null;
      offering: Offering | null;
      reporting_periods: string[] | null;
      latest_cutoff: string | null;
      record_path: string;
    };
    files: Array<{
      path: string;
      upload_role: string;
      media_type: string;
      sha256: string;
      bytes: number;
    }>;
  }>;
};

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const localPython = join(
  sourceRoot,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const sampleParserPython =
  process.env.BB_PYTHON?.trim() ||
  (existsSync(localPython) ? localPython : process.platform === 'win32' ? 'python' : 'python3');

function parsePeriod(value: string): {
  start: string;
  end: string;
  period_kind: 'annual' | 'interim';
} {
  const annual = /^(20\d{2})$/.exec(value);
  if (annual)
    return { start: `${annual[1]}-01-01`, end: `${annual[1]}-12-31`, period_kind: 'annual' };

  const interim = /^(20\d{2})-(\d{2})\/(20\d{2})-(\d{2})$/.exec(value);
  assert.ok(interim, `manifest period must use a supported year or month-range form: ${value}`);
  const year = Number(interim[3]);
  const month = Number(interim[4]);
  const endDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: `${interim[1]}-${interim[2]}-01`,
    end: `${interim[3]}-${interim[4]}-${String(endDay).padStart(2, '0')}`,
    period_kind: 'interim',
  };
}

function periodKey(period: Pick<ReportingPeriod, 'start' | 'end'>): string {
  return `${period.start}/${period.end}`;
}

// Opt in with BB_RUN_AUTHORIZED_SAMPLE_TESTS=1. BB_PYTHON may point to the
// repository .venv Python when running from a separate worktree.
test(
  'bridges authorized historical DOCX source evidence into conservative update difficulty',
  {
    skip:
      process.env.BB_RUN_AUTHORIZED_SAMPLE_TESTS === '1'
        ? false
        : 'set BB_RUN_AUTHORIZED_SAMPLE_TESTS=1 to run the authorized-material bridge check',
  },
  async () => {
    const manifestPath = join(sourceRoot, 'tests/samples/2026-09-25/manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuthorizedManifest;
    const historical = manifest.cases.flatMap((sample) =>
      sample.files
        .filter((file) => file.upload_role === 'historical')
        .map((file) => ({ sample, file })),
    );
    assert.equal(historical.length, 4);

    for (const [index, { sample, file }] of historical.entries()) {
      const bytes = await readFile(join(sourceRoot, 'tests/samples/2026-09-25', file.path));
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      assert.equal(bytes.byteLength, file.bytes, `${sample.case_id}: manifest byte size mismatch`);
      assert.equal(actualHash, file.sha256, `${sample.case_id}: manifest hash mismatch`);

      const materialId = `authorized-difficulty-${index + 1}`;
      const ownerUserId = 'authorized-difficulty-owner';
      const projectId = `authorized-difficulty-${sample.case_id}`;
      const row = {
        owner_user_id: ownerUserId,
        project_id: projectId,
        id: materialId,
        version: 1,
        media_type: file.media_type,
        byte_size: bytes.byteLength,
        sha256: actualHash,
        object_key: `authorized-sample/${sample.case_id}/${materialId}`,
        role: 'historical',
      };
      const parsed = await parseAuthorizedMaterial(
        {
          pool: { query: async () => ({ rows: [row] }) },
          blobs: { getPrivate: async () => bytes },
          parser: (request) =>
            runDocumentParser(request, {
              pythonExecutable: sampleParserPython,
              repoRoot: sourceRoot,
            }),
        },
        {
          ownerUserId,
          projectId,
          materialId,
          version: 1,
          requestId: `authorized-difficulty-parse-${index + 1}`,
          requiredRole: 'historical',
        },
      );
      assert.notEqual(parsed.status, 'failed', `${sample.case_id}: parser failed`);

      const recognition = recognizeHistoricalNativeText(parsed, { profileVersion: 1 });
      const parserRecords = new Map(parsed.records.map((record) => [record.record_id, record]));
      const assertAnchoredEvidence = (label: string, refs: readonly string[]) => {
        assert.ok(
          refs.length >= 2,
          `${sample.case_id}: ${label} needs independent source evidence`,
        );
        assert.equal(
          new Set(refs).size,
          refs.length,
          `${sample.case_id}: ${label} evidence refs must be unique`,
        );
        for (const ref of refs) {
          const record = parserRecords.get(ref);
          assert.ok(
            record,
            `${sample.case_id}: ${label} evidence ref ${ref} must resolve to this parse result`,
          );
          assert.equal(
            record.material_id,
            materialId,
            `${sample.case_id}: ${label} evidence must bind the historical material`,
          );
          assert.equal(
            record.material_version,
            1,
            `${sample.case_id}: ${label} evidence must bind its version`,
          );
          assert.equal(
            record.content_hash,
            actualHash,
            `${sample.case_id}: ${label} evidence must bind its content hash`,
          );
          assert.ok(
            record.literal_quote.trim().length > 0,
            `${sample.case_id}: ${label} evidence must preserve a quote`,
          );
        }
      };

      assert.equal(
        recognition.source_market.value,
        sample.market,
        `${sample.case_id}: source market mismatch`,
      );
      assert.equal(
        recognition.source_market.status,
        parsed.status === 'needs_confirmation' ? 'needs_confirmation' : 'recognized',
        `${sample.case_id}: parser uncertainty must propagate to source-market status`,
      );
      assertAnchoredEvidence('source market', recognition.source_market.provenance.evidence_refs);
      assert.equal(
        recognition.source_offering.value,
        sample.offering,
        `${sample.case_id}: source offering mismatch`,
      );
      assert.equal(
        recognition.source_offering.status,
        parsed.status === 'needs_confirmation' ? 'needs_confirmation' : 'recognized',
        `${sample.case_id}: parser uncertainty must propagate to source-offering status`,
      );
      assertAnchoredEvidence(
        'source offering',
        recognition.source_offering.provenance.evidence_refs,
      );

      const expectedSourcePeriods = sample.source_reporting_periods
        .map(parsePeriod)
        .map((period) => `${period.start}/${period.end}`)
        .sort();
      const actualPeriods = recognition.reporting_periods.filter(
        (period) => period.start !== null && period.end !== null,
      );
      const actualSourcePeriods = [...new Set(actualPeriods.map(periodKey))].sort();
      for (const expected of expectedSourcePeriods) {
        assert.ok(
          actualSourcePeriods.includes(expected),
          `${sample.case_id}: missing source period ${expected}`,
        );
      }
      for (const period of actualPeriods) {
        assert.ok(
          period.provenance.evidence_refs.length > 0,
          `${sample.case_id}: source period ${periodKey(period)} lacks evidence refs`,
        );
        for (const ref of period.provenance.evidence_refs) {
          const record = parserRecords.get(ref);
          assert.ok(
            record,
            `${sample.case_id}: source period evidence ref ${ref} must resolve to this parse result`,
          );
          assert.equal(
            record.material_id,
            materialId,
            `${sample.case_id}: source period evidence must bind the historical material`,
          );
          assert.equal(
            record.material_version,
            1,
            `${sample.case_id}: source period evidence must bind its version`,
          );
          assert.equal(
            record.content_hash,
            actualHash,
            `${sample.case_id}: source period evidence must bind its content hash`,
          );
          assert.ok(
            record.literal_quote.trim().length > 0,
            `${sample.case_id}: source period evidence must preserve a quote`,
          );
        }
      }
      const unsupportedPeriods = actualPeriods.filter(
        (period) => !expectedSourcePeriods.includes(periodKey(period)),
      );
      assert.ok(
        unsupportedPeriods.every((period) => period.status !== 'recognized'),
        `${sample.case_id}: extra source periods require confirmation rather than being accepted as confirmed facts`,
      );

      const confirmation = sample.target_confirmation;
      assert.equal(
        confirmation.status,
        'confirmed',
        `${sample.case_id}: target confirmation record must be complete`,
      );
      assert.ok(
        confirmation.confirmed_by,
        `${sample.case_id}: target confirmation must identify its confirmer`,
      );
      assert.ok(confirmation.confirmed_on, `${sample.case_id}: target confirmation must be dated`);
      assert.ok(
        confirmation.record_path.includes('TARGET-CONFIRMATIONS.md'),
        `${sample.case_id}: target confirmation record path is required`,
      );
      assert.ok(
        confirmation.reporting_periods,
        `${sample.case_id}: confirmed target period set is required`,
      );
      assert.equal(
        confirmation.market,
        sample.market,
        `${sample.case_id}: confirmed target market mismatch`,
      );
      assert.equal(
        confirmation.offering,
        sample.offering,
        `${sample.case_id}: confirmed target offering mismatch`,
      );
      const targetPeriods = confirmation.reporting_periods!.map((value) => {
        const period = parsePeriod(value);
        return {
          ...period,
          scope: null,
          status: 'user_asserted' as const,
          evidence_refs: [] as const,
        };
      });
      const expectedTargetPeriods = confirmation
        .reporting_periods!.map(parsePeriod)
        .map((period) => `${period.start}/${period.end}`)
        .sort();
      assert.deepEqual(
        targetPeriods.map(periodKey).sort(),
        expectedTargetPeriods,
        `${sample.case_id}: confirmed target period set must be preserved exactly`,
      );
      assert.equal(
        [...targetPeriods].sort((a, b) => a.end.localeCompare(b.end)).at(-1)?.end,
        confirmation.latest_cutoff,
        `${sample.case_id}: confirmed target cutoff must match the confirmed target period set`,
      );
      assert.ok(
        targetPeriods.every(
          (period) => period.status === 'user_asserted' && period.evidence_refs.length === 0,
        ),
        `${sample.case_id}: target-period assertions cannot be promoted to source evidence`,
      );

      // The manifest and confirmation record are comparison inputs only. Source
      // recognition above receives only the hash/version-bound parser response.
      const estimate = estimateUpdateDifficulty({
        profileVersion: recognition.profile_version,
        targetRevision: 1,
        source: {
          market: recognition.source_market.value,
          offering: recognition.source_offering.value,
          reportingPeriods: recognition.reporting_periods,
        },
        target: {
          market: confirmation.market,
          offering: confirmation.offering,
          reportingPeriods: targetPeriods,
        },
        replacements: [],
        restatements: [],
      });
      assert.equal(
        estimate.status,
        'needs_confirmation',
        `${sample.case_id}: user-asserted target periods require confirmation`,
      );
      assert.equal(
        estimate.estimatedN,
        null,
        `${sample.case_id}: do not estimate N from user-asserted target periods`,
      );
      assert.deepEqual(
        estimate.sourceReportingPeriods,
        recognition.reporting_periods,
        `${sample.case_id}: estimator must receive the recognized source-period set unchanged`,
      );
      assert.deepEqual(
        estimate.targetReportingPeriods,
        targetPeriods,
        `${sample.case_id}: estimator must preserve the target assertion set unchanged`,
      );
      for (const target of targetPeriods) {
        assert.ok(
          estimate.confirmationReasons.includes(`target_period_needs_confirmation:${target.end}`),
          `${sample.case_id}: expected target confirmation reason for ${target.end}`,
        );
      }
    }
  },
);
