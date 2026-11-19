import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildFileAuthoringInstructions, FILE_AUTHORING_INSTRUCTIONS_MAX_BYTES, FILE_AUTHORING_IMAGE_EDIT_GUIDANCE, FileAuthoringInstructionsError } from './file-authoring-instructions.js';

const errorCode = (code: FileAuthoringInstructionsError['code']) => (error: unknown) =>
  error instanceof FileAuthoringInstructionsError && error.code === code;

test('the actual trusted instructions fit in one bounded prompt with every byte preserved', async () => {
  const taskInstructions = await readFile(new URL('../../../python/bondbuddy_file_authoring/task.md', import.meta.url), 'utf8');
  const fixedEditInstructions = await readFile(new URL('../../../python/bondbuddy_file_authoring/fixed-edit.md', import.meta.url), 'utf8');
  const prompt = buildFileAuthoringInstructions({ taskInstructions, fixedEditInstructions, controlled: true,
    trustedPreamble: 'Synthetic trusted progress and input-lock preamble.', continuationInstructions: 'Synthetic authorized recovery instruction.' });
  for (const text of [taskInstructions, fixedEditInstructions]) {
    assert.ok(prompt.includes(text), 'the complete document is included without an excerpt or summary');
    assert.equal(prompt.indexOf(text), prompt.lastIndexOf(text), 'each complete document is supplied once');
  }
  assert.ok(Buffer.byteLength(prompt) <= FILE_AUTHORING_INSTRUCTIONS_MAX_BYTES);
});

test('direct-file authoring receives the complete task instructions without the unrelated controlled interface', () => {
  const taskInstructions = 'Complete direct-file task requirements.';
  const fixedEditInstructions = 'Controlled editing instructions that must not enter this prompt.';
  const prompt = buildFileAuthoringInstructions({ taskInstructions, fixedEditInstructions, controlled: false });
  assert.ok(prompt.includes(taskInstructions));
  assert.equal(prompt.includes(fixedEditInstructions), false);
  assert.equal(prompt.includes('BEGIN TRUSTED fixed-edit.md'), false);
});

test('whitespace, CRLF and non-ASCII instructions are preserved and optional trusted text is included in order', () => {
  const taskInstructions = '\r\n 完整要求\r\n\r\n';
  const fixedEditInstructions = '  完整接口\r\n';
  const trustedPreamble = '前置约束\r\n';
  const continuationInstructions = '\r\n已授权续跑约束  ';
  const prompt = buildFileAuthoringInstructions({ taskInstructions, fixedEditInstructions, controlled: true,
    trustedPreamble, continuationInstructions });
  assert.ok(prompt.startsWith(trustedPreamble));
  assert.ok(prompt.endsWith(continuationInstructions));
  assert.ok(prompt.includes(taskInstructions));
  assert.ok(prompt.includes(fixedEditInstructions));
  assert.ok(prompt.indexOf(taskInstructions) < prompt.indexOf(fixedEditInstructions));
});

test('missing trusted requirements fail before execution instead of silently omitting an interface', () => {
  assert.throws(() => buildFileAuthoringInstructions({ taskInstructions: ' ', controlled: false }), errorCode('AUTHORING_INSTRUCTIONS_INVALID'));
  assert.throws(() => buildFileAuthoringInstructions({ taskInstructions: 'task', controlled: true }), errorCode('AUTHORING_INSTRUCTIONS_INVALID'));
  assert.throws(() => buildFileAuthoringInstructions({ taskInstructions: 'task', fixedEditInstructions: '\r\n', controlled: true }), errorCode('AUTHORING_INSTRUCTIONS_INVALID'));
});

test('the exact UTF-8 byte boundary is accepted and one additional byte is rejected without truncation', () => {
  const base = buildFileAuthoringInstructions({ taskInstructions: 'x', controlled: false });
  const taskBytes = FILE_AUTHORING_INSTRUCTIONS_MAX_BYTES - Buffer.byteLength(base) + 1;
  const taskInstructions = '中'.repeat(Math.floor(taskBytes / 3)) + 'x'.repeat(taskBytes % 3);
  const prompt = buildFileAuthoringInstructions({ taskInstructions, controlled: false });
  assert.equal(Buffer.byteLength(prompt), FILE_AUTHORING_INSTRUCTIONS_MAX_BYTES);
  assert.ok(prompt.includes(taskInstructions));
  assert.throws(() => buildFileAuthoringInstructions({ taskInstructions: taskInstructions + 'x', controlled: false }), error =>
    errorCode('AUTHORING_INSTRUCTIONS_TOO_LARGE')(error) && (error as FileAuthoringInstructionsError).byteLength === FILE_AUTHORING_INSTRUCTIONS_MAX_BYTES + 1);
});

test('the byte budget includes preamble, continuation and the complete controlled instructions', () => {
  for (const extra of [
    { trustedPreamble: 'x'.repeat(FILE_AUTHORING_INSTRUCTIONS_MAX_BYTES) },
    { continuationInstructions: 'x'.repeat(FILE_AUTHORING_INSTRUCTIONS_MAX_BYTES) },
    { controlled: true, fixedEditInstructions: 'x'.repeat(FILE_AUTHORING_INSTRUCTIONS_MAX_BYTES) },
  ]) {
    assert.throws(() => buildFileAuthoringInstructions({ taskInstructions: 'task', controlled: false, ...extra }), errorCode('AUTHORING_INSTRUCTIONS_TOO_LARGE'));
  }
});


test('source-bound image removal guidance is exposed only to the controlled editor without changing fixed instruction bytes', () => {
  const taskInstructions='Unchanged complete task.', fixedEditInstructions='Unchanged fixed interface.';
  const controlled=buildFileAuthoringInstructions({taskInstructions,fixedEditInstructions,controlled:true});
  const direct=buildFileAuthoringInstructions({taskInstructions,controlled:false});
  assert.ok(controlled.includes(FILE_AUTHORING_IMAGE_EDIT_GUIDANCE));
  assert.ok(controlled.includes(fixedEditInstructions));
  assert.ok(controlled.includes('relationship_id')&&controlled.includes('image_sha256'));
  assert.equal(direct.includes(FILE_AUTHORING_IMAGE_EDIT_GUIDANCE),false);
});
