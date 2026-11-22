import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { emptyUpdateDetails } from '@bondbuddy/contracts';
import { digest } from '@bondbuddy/api/data';
import { fileAuthoringStage } from './file-authoring-stage.js';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import type { UnifiedInput } from './unified-input.js';
import type { StageContext } from './run-pipeline.js';

// Exercises the real worker workspace preparation; no provider or database call.
test('PPN worker receives every pinned method, clause, table and point comment unchanged', async () => {
  const path = 'knowledge/nafmii/drafts/ppn/writing-20261013/writing-framework.md';
  const markdown = await readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');
  const input: UnifiedInput = {
    materials: [],
    requirements: [],
    manifest: {
      issuer_name: '合成PPN发行人',
      market: 'nafmii',
      offering: 'ppn',
      materials: [],
      update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1' },
      authoring: {
        version: 'unified_v1',
        source_prospectuses: [],
        requirements: [],
        knowledge: [{ path, sha256: digest(markdown), markdown }],
        knowledge_status: 'authoring_reference_not_compliance_approval',
      },
    },
  };
  const ctx = {
    run: {
      id: 'synthetic-ppn-run',
      owner_user_id: 'synthetic-owner',
      project_id: 'synthetic-project',
      input_hash: 'a'.repeat(64),
    },
    lease: { checkpoint: {} },
    signal: new AbortController().signal,
  } as unknown as StageContext;
  for (const scenario of ['current', 'tampered', 'legacy']) {
    const directory = await mkdtemp(join(tmpdir(), 'bb-ppn-writing-'));
    try {
      const locked = structuredClone(input);
      const expected =
        scenario === 'legacy'
          ? {
              path: 'knowledge/nafmii/drafts/ppn/README.md',
              markdown: '# Synthetic prior PPN knowledge',
            }
          : { path, markdown };
      locked.manifest.authoring.knowledge = [{ ...expected, sha256: digest(expected.markdown) }];
      if (scenario === 'tampered') locked.manifest.authoring.knowledge[0]!.markdown += '\nchanged';
      const stage = fileAuthoringStage({
        load: async () => locked,
        config: loadCodexAdapterConfig({}),
        model: (options) => ({
          name: options.name,
          run: async () => {
            await options.fileWorkspace!.prepare(directory);
            const manifest = JSON.parse(await readFile(join(directory, 'input.json'), 'utf8'));
            const pinned = manifest.knowledge[0];
            const received = await readFile(join(directory, pinned.local_path), 'utf8');
            assert.equal(manifest.knowledge.length, 1);
            assert.equal(pinned.path, expected.path);
            assert.equal(pinned.sha256, digest(received));
            assert.equal(received, expected.markdown);
            if (scenario === 'current') {
              assert.match(received, /### C107 .*P05610/);
              assert.match(received, /### T090/);
            } else assert.doesNotMatch(received, /ppn-writing-2026\.10\.13-v1/);
            assert.equal(manifest.target.offering, 'ppn');
            assert.equal(manifest.baseline_kind, 'none');
            const task = await readFile(join(directory, 'task.md'), 'utf8');
            assert.match(task, /ppn-writing-2026\.10\.13-v1/);
            assert.match(task, /旧任务快照未含该版本时继续按其原锁定知识执行/);
            return { kind: 'done', value: { synthetic: true } };
          },
        }),
      });
      if (scenario === 'tampered') await assert.rejects(stage.run(ctx), /INPUT_REVISION_CONFLICT/);
      else assert.equal((await stage.run(ctx)).kind, 'done');
    } finally {
      assert.ok(!relative(resolve(tmpdir()), resolve(directory)).startsWith('..'));
      await rm(directory, { recursive: true, force: true });
    }
  }
});
