import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, chmod, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readPrivateJson} from './private-files.mjs';
import {readExpenseHistory} from './expense-history.mjs';
import {canonical, sha256} from './policy.mjs';

test('complete 96KiB history preserves default credential limit, hashes, permissions and bounded allocation', async () => {
  const dir = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), '.history-bound-'));
  const file = join(dir, 'history.json');
  try {
    const history = {ledger: {operations: [{original_payload: 'x'.repeat(96503)}]}};
    await writeFile(file, canonical(history), {mode: 0o600});
    const config = {external_expense_history: {file, sha256: sha256(canonical(history)),
      source_evidence_sha256: 'a'.repeat(64), source_ledger_sha256: 'b'.repeat(64), source_system_identifier: '123'}};
    await assert.rejects(readPrivateJson(file), /PRIVATE_FILE_PERMISSIONS/);
    assert.deepEqual(await readExpenseHistory(config), history);
    await assert.rejects(readExpenseHistory({external_expense_history: {...config.external_expense_history,
      sha256: 'c'.repeat(64)}}), /EXPENSE_HISTORY_HASH/);
    await chmod(file, 0o644);
    await assert.rejects(readExpenseHistory(config), /PRIVATE_FILE_PERMISSIONS/);
    await chmod(file, 0o600);
    await writeFile(file, canonical({original_payload: 'x'.repeat(262144)}));
    await assert.rejects(readExpenseHistory(config), /PRIVATE_FILE_PERMISSIONS/);
    await assert.rejects(readPrivateJson(file, {maxBytes: 262145}), /PRIVATE_FILE_BOUND/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
