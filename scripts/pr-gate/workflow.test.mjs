import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readWorkflow } from './workflow.mjs';

const source = readFileSync(new URL('../../.github/workflows/pr-gate.yml', import.meta.url), 'utf8');
test('workflow provides all eight rows, quoted group commas and synthetic service credentials', () => {
  const config = readWorkflow(source);
  assert.equal(config.matrix.length, 8);
  assert.equal(config.matrix.find(row => row.name === 'misc').groups, 'packages,web-unit,scripts,python');
  assert.equal(config.matrix.find(row => row.name === 'misc').render, 'true');
  assert.equal(config.env.BB_TEST_LIVE_AUTHORING, '0');
  assert.equal(config.postgres, 'postgres:16.10');
  assert.equal(config.azurite, 'mcr.microsoft.com/azure-storage/azurite:3.35.0');
});
test('workflow drift cannot silently omit rows, environment or disable synthetic boundaries', () => {
  for (const invalid of [source.replace('name: api-2', 'name: api-1'), source.replace('BB_TEST_LIVE_AUTHORING: \'0\'', 'BB_TEST_LIVE_AUTHORING: \'1\''),
    source.replace('synthetic-ci-only@127.0.0.1', 'synthetic-ci-only@production'), source.replace('UseDevelopmentStorage=true', 'AccountName=real'),
    source.replace('groups: api', 'groups: $' + '{{ inputs.group }}'), source.replace(/          - \{ name: browser-3[^\r\n]+\r?\n/, '')]) {
    assert.throws(() => readWorkflow(invalid));
  }
});
