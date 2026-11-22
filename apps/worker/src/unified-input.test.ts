import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { emptyUpdateDetails, reportingWindow } from '@bondbuddy/contracts';
import { digest } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { unifiedInputGate, type UnifiedManifest } from './unified-input.js';
import type { RunRow, InputRevisionRow } from './run-pipeline.js';

test('optional absent and partial source context does not gate an uploaded-source-only run; ownership/hash checks remain', async () => {
  for (const role of ['historical', 'reference'])
    for (const partial of [false, true]) {
      const pin = {
        material_id: 'source',
        material_version: 1,
        role,
        sha256: digest('synthetic source'),
      };
      const m: UnifiedManifest = {
        issuer_name: '合成目标',
        market: 'sse',
        offering: 'private',
        materials: [pin],
        update_details: {
          ...emptyUpdateDetails(),
          authoring_mode: 'unified_v1',
          target_reporting_periods: reportingWindow('sse', 'private', '2025-06-30'),
        },
        authoring: {
          version: 'unified_v1',
          source_prospectuses: partial
            ? [
                {
                  ...pin,
                  issuer_name: null,
                  relation: null,
                  market: null,
                  offering: null,
                  reporting_periods: [],
                  status: 'user_asserted',
                },
              ]
            : [],
          requirements: [],
          knowledge: [{ path: 'synthetic.md', markdown: '合成知识', sha256: digest('合成知识') }],
          knowledge_status: 'authoring_reference_not_compliance_approval',
        },
      };
      const hash = inputManifestHash(m),
        input = {
          manifest: m,
          input_hash: hash,
          draft_revision: 1,
          material_versions: [pin],
          rule_pack_version: null,
          template_version: null,
        } as InputRevisionRow;
      const run = { input_hash: hash, owner_user_id: 'owner', project_id: 'project' } as RunRow;
      const pool = {
        query: async (_sql: string, values: unknown[]) => {
          assert.deepEqual(values, ['owner', 'project', 'source', 1]);
          return { rows: [pin] };
        },
      } as unknown as Pool;
      assert.equal(await unifiedInputGate(pool, run, input), null);
      assert.deepEqual(
        await unifiedInputGate(
          { query: async () => ({ rows: [] }) } as unknown as Pool,
          run,
          input,
        ),
        { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' },
      );
      assert.deepEqual(
        await unifiedInputGate(pool, run, { ...input, input_hash: '0'.repeat(64) }),
        { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' },
      );
    }
});
