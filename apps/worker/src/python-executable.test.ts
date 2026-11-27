import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolvePythonExecutable } from './python-executable.js';

test('prefers explicit interpreter, then host overrides, then platform default', t => {
  const keys = ['BONDBUDDY_WORD_PYTHON', 'BONDBUDDY_TEST_PYTHON', 'BB_PYTHON', 'BB_PYTHON_BIN'] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  for (const key of keys) delete process.env[key];
  assert.equal(resolvePythonExecutable('/opt/venv/bin/python'), '/opt/venv/bin/python');
  process.env.BB_PYTHON = 'C:/Python/python.exe';
  assert.equal(resolvePythonExecutable(), 'C:/Python/python.exe');
  process.env.BONDBUDDY_TEST_PYTHON = '/tmp/test-python';
  assert.equal(resolvePythonExecutable(), '/tmp/test-python');
  for (const key of keys) delete process.env[key];
  assert.equal(resolvePythonExecutable(), process.platform === 'win32' ? 'python' : 'python3');
});
