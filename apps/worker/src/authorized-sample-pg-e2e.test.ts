import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Pool } from 'pg';
import { enqueueMaterialParse, documentParserVersion } from '@bondbuddy/api/material-jobs';
import { createUpdateDifficultySnapshot, loadLockedUpdateDifficultyInput } from '@bondbuddy/api/update-difficulty-repository';
import { parseHistoricalNativeExtractorVersion } from '@bondbuddy/domain/historical-native-extractor-version';
import type { Market, Offering, ReportingPeriod } from '@bondbuddy/contracts';
import { runDocumentParser } from './document-parser.js';
import { runMaterialParseOnce } from './material-parse-job.js';
import { getLatestHistoricalProfile } from './historical-profile-repository.js';
import { isolatedTestDatabase } from './test-database.js';

type ManifestFile = {
  path: string;
  upload_role: string;
  media_type: string;
  sha256: string;
  bytes: number;
};
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
    files: ManifestFile[];
  }>;
};

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const localPython = join(sourceRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const sampleParserPython = process.env.BB_PYTHON?.trim() || (existsSync(localPython)
  ? localPython
  : process.platform === 'win32' ? 'python' : 'python3');
const optedIn = process.env.BB_RUN_AUTHORIZED_SAMPLE_PG_E2E === '1';
const testDatabaseUrl = optedIn ? await isolatedTestDatabase('AUTHORIZED_SAMPLE_PG_TEST_DATABASE_URL') : undefined;

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const FINANCIAL_ROLES = new Set(['financial', 'interimFinancial', 'notes', 'audit']);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function parsePeriod(value: string): ReportingPeriod {
  const annual = /^(20\d{2})$/.exec(value);
  if (annual) return {
    start: `${annual[1]}-01-01`, end: `${annual[1]}-12-31`, period_kind: 'annual', scope: 'consolidated',
    raw_value: `${annual[1]} 年度`, provenance: {} as ReportingPeriod['provenance'], uncertainty: [], status: 'recognized',
  };
  const interim = /^(20\d{2})-(\d{2})\/(20\d{2})-(\d{2})$/.exec(value);
  assert.ok(interim, `unsupported manifest reporting period: ${value}`);
  const endDay = new Date(Date.UTC(Number(interim[3]), Number(interim[4]), 0)).getUTCDate();
  return {
    start: `${interim[1]}-${interim[2]}-01`, end: `${interim[3]}-${interim[4]}-${String(endDay).padStart(2, '0')}`,
    period_kind: 'interim', scope: 'consolidated', raw_value: value,
    provenance: {} as ReportingPeriod['provenance'], uncertainty: [], status: 'recognized',
  };
}

function asTargetPeriod(value: string) {
  const period = parsePeriod(value);
  return {
    start: period.start, end: period.end, period_kind: period.period_kind, scope: 'consolidated' as const,
    status: 'user_asserted' as const, evidence_refs: [] as string[],
  };
}

test('persists authorized historical DOCX recognition and difficulty through the PostgreSQL worker/API repositories', {
  skip: !optedIn
    ? 'set BB_RUN_AUTHORIZED_SAMPLE_PG_E2E=1 to run the authorized-material PostgreSQL integration'
    : !testDatabaseUrl
      ? 'set AUTHORIZED_SAMPLE_PG_TEST_DATABASE_URL or BB_TEST_DATABASE_URL to a disposable migrated PostgreSQL 16 template'
      : false,
}, async () => {
  assert.ok(testDatabaseUrl);
  const manifestRoot = join(sourceRoot, 'tests/samples/2026-09-25');
  const manifestPath = join(manifestRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AuthorizedManifest;
  const cases = manifest.cases;
  assert.equal(cases.length, 4, 'only the four manifest-registered sample cases are in scope');

  const pool = new Pool({ connectionString: testDatabaseUrl });
  const blobBytes = new Map<string, Buffer>();
  const parser = (request: Parameters<typeof runDocumentParser>[0]) => runDocumentParser(request, {
    pythonExecutable: sampleParserPython,
    repoRoot: sourceRoot,
  });

  try {
    for (const sample of cases) {
      assert.equal(sample.target_confirmation.status, 'confirmed', `${sample.case_id}: recorded target confirmation is required`);
      assert.ok(sample.target_confirmation.confirmed_by, `${sample.case_id}: target confirmation must identify its confirmer`);
      assert.ok(sample.target_confirmation.confirmed_on, `${sample.case_id}: target confirmation must be dated`);
      assert.ok(sample.target_confirmation.record_path.includes('TARGET-CONFIRMATIONS.md'),
        `${sample.case_id}: target confirmation record must be linked`);
      const historicalFiles = sample.files.filter(file => file.upload_role === 'historical');
      assert.equal(historicalFiles.length, 1, `${sample.case_id}: exactly one registered historical file is expected`);
      const historicalFile = historicalFiles[0]!;
      assert.equal(historicalFile.media_type, DOCX, `${sample.case_id}: this opt-in suite covers authorized native DOCX only`);
      const historicalBytes = await readFile(join(manifestRoot, historicalFile.path));
      assert.equal(historicalBytes.byteLength, historicalFile.bytes, `${sample.case_id}: historical byte count must match manifest`);
      assert.equal(sha256(historicalBytes), historicalFile.sha256, `${sample.case_id}: historical SHA-256 must match manifest`);

      const financialFile = sample.files.find(file => FINANCIAL_ROLES.has(file.upload_role));
      assert.ok(financialFile, `${sample.case_id}: a manifest-registered financial material is needed for the locked input`);
      const financialBytes = await readFile(join(manifestRoot, financialFile.path));
      assert.equal(financialBytes.byteLength, financialFile.bytes, `${sample.case_id}: financial byte count must match manifest`);
      assert.equal(sha256(financialBytes), financialFile.sha256, `${sample.case_id}: financial SHA-256 must match manifest`);

      const suffix = randomUUID();
      const owner = `authorized-owner-${suffix}`;
      const project = `authorized-project-${suffix}`;
      const historicalMaterial = `authorized-historical-${suffix}`;
      const historicalUpload = `authorized-upload-${suffix}`;
      const financialMaterial = `authorized-financial-${suffix}`;
      const financialUpload = `authorized-fin-upload-${suffix}`;
      const historicalKey = `authorized-samples/${sample.case_id}/${suffix}/historical`;
      const financialKey = `authorized-samples/${sample.case_id}/${suffix}/financial`;
      blobBytes.set(historicalKey, historicalBytes);
      blobBytes.set(financialKey, financialBytes);

      const targetPeriods = (sample.target_confirmation.reporting_periods ?? []).map(asTargetPeriod);
      assert.ok(targetPeriods.length > 0, `${sample.case_id}: complete confirmed target periods are required`);
      assert.equal(targetPeriods.at(-1)!.end, sample.target_confirmation.latest_cutoff,
        `${sample.case_id}: target period set cutoff must match the confirmation record`);
      const confirmedAt = `${sample.target_confirmation.confirmed_on}T00:00:00.000Z`;
      const targetConfirmation = {
        status: 'confirmed' as const, market: sample.target_confirmation.market, offering: sample.target_confirmation.offering,
        document_purpose: null, as_of: null, target_reporting_periods: targetPeriods,
        confirmed_by: sample.target_confirmation.confirmed_by!, confirmed_at: confirmedAt,
      };
      const materialRefs = [
        { material_id: historicalMaterial, material_version: 1 },
        { material_id: financialMaterial, material_version: 1 },
      ];
      const materials = [
        { ...materialRefs[0], role: 'historical', sha256: historicalFile.sha256 },
        { ...materialRefs[1], role: financialFile.upload_role, sha256: financialFile.sha256 },
      ];
      const manifestBody = {
        draft_revision: 1, name: `Authorized sample ${sample.case_id}`, kind: 'update',
        issuer_name: null, market: sample.target_confirmation.market, offering: sample.target_confirmation.offering,
        update_details: { target_reporting_periods: targetPeriods }, target_confirmation: targetConfirmation, materials,
      };
      const manifestHash = sha256(Buffer.from(JSON.stringify(manifestBody)));

      const client = await pool.connect();
      let jobId = '';
      try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,market,offering)
          VALUES($1,$2,$3,'update',$4,$5)`, [project, owner, `Authorized sample ${sample.case_id}`, sample.target_confirmation.market, sample.target_confirmation.offering]);
        await client.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state,received_sha256,received_bytes)
          VALUES($1,$2,$3,$4,$5,$6,$7,'historical',$8,now()+interval '1 day','completed',$7,$6)`,
        [historicalUpload, owner, project, basename(historicalFile.path), historicalFile.media_type, historicalFile.bytes, historicalFile.sha256, `${historicalKey}/upload`]);
        await client.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
          VALUES($1,1,$2,$3,$4,'historical',$5,$6,$7,$8,$9,'persisted')`,
        [historicalMaterial, owner, project, historicalUpload, basename(historicalFile.path), historicalFile.media_type,
          historicalFile.bytes, historicalFile.sha256, historicalKey]);
        await client.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state,received_sha256,received_bytes)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 day','completed',$7,$6)`,
        [financialUpload, owner, project, basename(financialFile.path), financialFile.media_type, financialFile.bytes, financialFile.sha256,
          financialFile.upload_role, `${financialKey}/upload`]);
        await client.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
          VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'persisted')`,
        [financialMaterial, owner, project, financialUpload, financialFile.upload_role, basename(financialFile.path), financialFile.media_type,
          financialFile.bytes, financialFile.sha256, financialKey]);

        const queued = await enqueueMaterialParse(client, {
          owner, projectId: project, materialId: historicalMaterial, materialVersion: 1,
          sha256: historicalFile.sha256, traceId: `authorized-trace-${suffix}`, parserVersion: documentParserVersion(),
        });
        assert.equal(queued.created, true);
        jobId = queued.jobId;

        await client.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
          VALUES($1,1,$2,1,$3,$4::jsonb,$5::jsonb,'[]'::jsonb)`,
        [project, owner, manifestHash, JSON.stringify(manifestBody), JSON.stringify(materialRefs)]);
        await client.query(`INSERT INTO bb_input_revision_target_confirmations(owner_user_id,project_id,input_revision,market,offering,document_purpose,as_of,target_reporting_periods,confirmed_by,confirmed_at)
          VALUES($1,$2,1,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
        [owner, project, sample.target_confirmation.market, sample.target_confirmation.offering, null, null,
          JSON.stringify(targetPeriods), sample.target_confirmation.confirmed_by, confirmedAt]);
        await client.query('UPDATE bb_projects SET latest_input_revision=1 WHERE owner_user_id=$1 AND id=$2', [owner, project]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      const outcome = await runMaterialParseOnce({
        pool,
        leaseSeconds: 300,
        material: {
          pool,
          blobs: { getPrivate: async key => blobBytes.get(key) ?? null },
          parser,
        },
      });
      assert.equal(outcome, 'succeeded', `${sample.case_id}: parse job ${jobId} should succeed`);

      const job = await pool.query('SELECT state,parser_version,checkpoint FROM bb_jobs WHERE id=$1 AND owner_user_id=$2', [jobId, owner]);
      assert.equal(job.rows.length, 1);
      assert.equal(job.rows[0]!.state, 'succeeded');
      assert.equal(job.rows[0]!.parser_version, documentParserVersion());
      assert.ok(job.rows[0]!.checkpoint.stages.parse_evidence.snapshot_id);
      assert.ok(job.rows[0]!.checkpoint.stages.historical_profile.profile_version >= 1);

      const profile = await getLatestHistoricalProfile({ pool }, {
        ownerUserId: owner, projectId: project, materialId: historicalMaterial, materialVersion: 1,
      });
      assert.ok(profile, `${sample.case_id}: HistoricalProspectusProfile must persist through the worker repository`);
      const recognition = profile.recognition;
      assert.equal(recognition.source_market.value, sample.market, `${sample.case_id}: source market should be identified from parsed text`);
      assert.ok(recognition.source_market.provenance.evidence_refs.length >= 2);
      assert.equal(recognition.source_offering.value, sample.offering, `${sample.case_id}: source offering should be identified from parsed text`);
      assert.ok(recognition.source_offering.provenance.evidence_refs.length >= 2);
      assert.equal(recognition.material_id, historicalMaterial);
      assert.equal(recognition.material_version, 1);
      assert.ok(recognition.reporting_periods.length > 0);
      const parserIdentity = parseHistoricalNativeExtractorVersion(recognition.source_market.provenance.extractor_version);
      assert.ok(parserIdentity, `${sample.case_id}: profile must carry a versioned Python parser identity`);
      assert.equal(parserIdentity.parserVersion, job.rows[0]!.parser_version);
      const recognizedPeriods = new Set(recognition.reporting_periods
        .filter(period => period.start && period.end)
        .map(period => `${period.start}/${period.end}`));
      for (const expected of sample.source_reporting_periods.map(value => parsePeriod(value))) {
        assert.ok(recognizedPeriods.has(`${expected.start}/${expected.end}`),
          `${sample.case_id}: recognized source periods should contain ${expected.start}/${expected.end}`);
      }
      assert.ok(recognition.reporting_periods.some(period => period.end === recognition.latest_reporting_cutoff.value),
        `${sample.case_id}: latest cutoff must derive from a recognized reporting period`);

      const locked = await loadLockedUpdateDifficultyInput({ pool }, {
        ownerUserId: owner, projectId: project, inputRevision: 1, inputHash: manifestHash, requestId: `difficulty-load-${suffix}`,
      });
      assert.deepEqual(locked.source, { materialId: historicalMaterial, materialVersion: 1, profileVersion: profile.profileVersion });
      assert.equal(locked.source.materialId, historicalMaterial);
      assert.deepEqual(locked.financialMaterialVersions, [{ materialId: financialMaterial, materialVersion: 1 }]);
      assert.deepEqual(locked.targetReportingPeriods, (sample.target_confirmation.reporting_periods ?? []).map(asTargetPeriod));
      assert.ok(locked.targetReportingPeriods.every(period => period.status === 'user_asserted' && !('provenance' in period)),
        `${sample.case_id}: user-confirmed target periods stay user asserted and do not become source evidence`);

      const saved = await createUpdateDifficultySnapshot({ pool }, locked);
      assert.equal(saved.sourceMaterialId, historicalMaterial);
      assert.equal(saved.sourceProfileVersion, profile.profileVersion);
      assert.equal(saved.targetMarket, sample.target_confirmation.market);
      assert.equal(saved.targetOffering, sample.target_confirmation.offering);
      assert.equal(saved.estimate.status, 'needs_confirmation');
      assert.equal(saved.estimate.estimatedN, null);
      const snapshotRow = await pool.query('SELECT estimate,comparison_input,financial_material_versions FROM bb_update_difficulty_snapshots WHERE id=$1', [saved.id]);
      assert.equal(snapshotRow.rows.length, 1, `${sample.case_id}: UpdateDifficultyInput snapshot should be durable`);
      assert.equal((snapshotRow.rows[0]!.estimate as { estimatedN: number | null }).estimatedN, null);
      assert.deepEqual(snapshotRow.rows[0]!.comparison_input.targetReportingPeriods, locked.targetReportingPeriods);
      assert.deepEqual(snapshotRow.rows[0]!.financial_material_versions, [{ materialId: financialMaterial, materialVersion: 1 }]);
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM bb_outbox
        WHERE aggregate_type='project' AND aggregate_id=$1 AND event_type='project.update_difficulty_snapshotted'
          AND payload->>'snapshot_id'=$2`, [project, saved.id])).rows[0]!.count, 1,
      `${sample.case_id}: snapshot and outbox event should persist together through the API repository`);

      const costs = await pool.query(`SELECT payload FROM bb_outbox
        WHERE aggregate_type='material_parse_job' AND aggregate_id=$1 AND event_type='platform.processing_cost'`, [jobId]);
      assert.equal(costs.rows.length, 1, `${sample.case_id}: the native DOCX parse should have one durable cost event`);
      const cost = costs.rows[0]!.payload as Record<string, unknown>;
      assert.equal(cost.stage, 'parse');
      assert.equal(cost.attempt, 1);
      assert.equal(cost.quantity, 1);
      assert.equal(cost.billable, false);
      assert.equal(cost.cost_payer, 'platform');
      assert.equal(cost.pricing_status, 'unknown');
      assert.equal(cost.unit_price_ref, null);
      assert.equal(cost.outcome, 'succeeded');
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM bb_outbox
        WHERE aggregate_type='material_parse_job' AND aggregate_id=$1 AND event_type='platform.processing_cost'
          AND payload->>'stage'='ocr'`, [jobId])).rows[0]!.count, 0,
      'these registered historical inputs are DOCX; the scan/OCR event path is not exercised by this regression');

      blobBytes.delete(historicalKey);
      blobBytes.delete(financialKey);
    }
  } finally {
    await pool.end();
  }
});
