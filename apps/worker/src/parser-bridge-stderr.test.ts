import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  runDocumentParser,
  type DocumentParseRequest,
  type DocumentParserError,
} from './document-parser.js';
import {
  classifyParserStderr,
  redactParserStderr,
  type ParserStderrDiagnostic,
} from './parser-diagnostics.js';

// Synthetic only: a fake `bondbuddy_document_parser` module stands in for the real Python parser.
let root: string;
const python = process.env.BB_PYTHON ?? 'python3';

const request: DocumentParseRequest = {
  schema_version: 'document-parse-request-v1',
  request_id: 'parse-synthetic',
  material: {
    material_id: 'material-synthetic',
    material_version: 1,
    media_type: 'text/plain',
    sha256: 'a'.repeat(64),
    authorized_local_path: '/private/synthetic-stage/material.txt',
  },
  options: {},
};

const valid = {
  schema_version: 'document-parse-response-v1',
  request_id: 'parse-synthetic',
  parser_version: 'bondbuddy-document-parser-1.0.0',
  status: 'parsed',
  material: {
    material_id: 'material-synthetic',
    material_version: 1,
    media_type: 'text/plain',
    sha256: 'a'.repeat(64),
  },
  records: [
    {
      record_id: 'evidence-000001',
      material_id: 'material-synthetic',
      material_version: 1,
      content_hash: 'a'.repeat(64),
      locator_type: 'text_line',
      locator: { line: 1, stable_ref: 'text:l000001' },
      literal_quote: 'synthetic',
      context: '',
      extraction_method: 'native_text',
      extractor_version: 'bondbuddy-document-parser-1.0.0',
      confidence: null,
      uncertainty: [],
      formatting: {},
    },
  ],
  warnings: [],
  document: { page_count: null, encoding: 'utf-8' },
  error: null,
};

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'bb-fake-parser-'));
  await mkdir(join(root, 'python', 'bondbuddy_document_parser'), { recursive: true });
  await writeFile(join(root, 'python', 'bondbuddy_document_parser', '__init__.py'), '');
  await writeFile(
    join(root, 'python', 'bondbuddy_document_parser', '__main__.py'),
    `
import json, os, sys, time, warnings
req = json.load(sys.stdin)
mode = os.environ["BB_FAKE_MODE"]
valid = json.loads(os.environ["BB_FAKE_VALID"])
if mode == "warn":
    sys.stderr.write("Ignoring wrong pointing object 12 0 (offset 0)\\n")
    sys.stderr.write("incorrect startxref pointer(1)\\n")
    sys.stderr.write("reading " + req["material"]["authorized_local_path"] + " token=abc123SECRET\\n")
    warnings.warn("synthetic deprecation", DeprecationWarning)
    sys.stderr.write("totally unknown noise\\n")
    print(json.dumps(valid))
elif mode == "garbage":
    sys.stderr.write("Ignoring wrong pointing object 1 0\\n")
    print("this is not json")
elif mode == "partial":
    sys.stdout.write(json.dumps(valid)[:120])
elif mode == "huge":
    sys.stderr.write("Ignoring wrong pointing object 9 0\\n" * 60000)
    print(json.dumps(valid))
elif mode == "version":
    valid["schema_version"] = "document-parse-response-v2"
    print(json.dumps(valid))
elif mode == "evidence":
    sys.stderr.write("Ignoring wrong pointing object 3 0\\n")
    valid["records"][0]["locator"] = {"line": 1, "stable_ref": "text:l999999"}
    print(json.dumps(valid))
elif mode == "exit":
    sys.stderr.write("Traceback: synthetic crash at " + req["material"]["authorized_local_path"] + "\\n")
    print(json.dumps(valid))
    sys.exit(3)
elif mode == "oversize":
    print(json.dumps(valid) + " " * 4096)
elif mode == "sleep":
    sys.stderr.write("started\\n"); sys.stderr.flush()
    time.sleep(30)
`,
  );
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run(mode: string, extra: { timeoutMs?: number; maxOutputBytes?: number } = {}) {
  process.env.BB_FAKE_MODE = mode;
  process.env.BB_FAKE_VALID = JSON.stringify(valid);
  let diagnostic: ParserStderrDiagnostic | null | undefined;
  try {
    const response = await runDocumentParser(request, {
      pythonExecutable: python,
      repoRoot: root,
      onDiagnostic: (d) => {
        diagnostic = d;
      },
      ...extra,
    });
    return { response, diagnostic, error: undefined as DocumentParserError | undefined };
  } catch (error) {
    return { response: undefined, diagnostic, error: error as DocumentParserError };
  } finally {
    delete process.env.BB_FAKE_MODE;
    delete process.env.BB_FAKE_VALID;
  }
}

test('warnings on stderr plus a valid result succeed and keep a classified, redacted diagnostic', async () => {
  const { response, diagnostic, error } = await run('warn');
  assert.equal(error, undefined);
  assert.equal(response?.status, 'parsed');
  assert.ok(diagnostic);
  assert.deepEqual(diagnostic.classes, [
    'PDF_WRONG_POINTING_OBJECT',
    'PDF_XREF_REPAIRED',
    'PYTHON_WARNING',
    'UNCLASSIFIED',
  ]);
  assert.ok(diagnostic.unclassified_lines >= 2); // "reading [path] ..." and "totally unknown noise"
  assert.ok(!diagnostic.excerpt.includes('/private/synthetic-stage'));
  assert.ok(!diagnostic.excerpt.includes('abc123SECRET'));
  assert.ok(!diagnostic.excerpt.includes(root));
  assert.equal(diagnostic.truncated, false);
});

test('a clean run reports a null diagnostic', async () => {
  const plain = await run('oversize', { maxOutputBytes: 1024 * 1024 });
  assert.equal(plain.error, undefined);
  assert.equal(plain.diagnostic, null);
});

test('garbage stdout fails closed even when stderr only carries known warnings', async () => {
  const { error, diagnostic } = await run('garbage');
  assert.equal(error?.message, 'INVALID_PARSE_RESPONSE');
  assert.deepEqual(error?.diagnostic?.classes, ['PDF_WRONG_POINTING_OBJECT']);
  assert.deepEqual(diagnostic, error?.diagnostic);
});

test('partial JSON fails closed', async () => {
  const { error } = await run('partial');
  assert.equal(error?.message, 'INVALID_PARSE_RESPONSE');
  assert.equal(error?.diagnostic, null);
});

test('schema/version mismatch fails closed', async () => {
  const { error } = await run('version');
  assert.equal(error?.message, 'INVALID_PARSE_RESPONSE');
});

test('malformed #13 evidence still fails closed despite harmless warnings', async () => {
  const { error } = await run('evidence');
  assert.equal(error?.message, 'INVALID_PARSE_RESPONSE');
  assert.deepEqual(error?.diagnostic?.classes, ['PDF_WRONG_POINTING_OBJECT']);
});

test('huge stderr is bounded and does not fail a valid result', async () => {
  const { response, diagnostic, error } = await run('huge');
  assert.equal(error, undefined);
  assert.equal(response?.status, 'parsed');
  assert.ok(diagnostic);
  assert.ok(diagnostic.bytes > 2_000_000);
  assert.equal(diagnostic.truncated, true);
  assert.ok(diagnostic.excerpt.length <= 4096);
  assert.ok(diagnostic.classes.includes('PDF_WRONG_POINTING_OBJECT'));
  assert.ok(diagnostic.unclassified_lines <= 1); // at most the line cut by the capture limit
});

test('non-zero exit fails closed and keeps the redacted stderr', async () => {
  const { error } = await run('exit');
  assert.equal(error?.message, 'DOCUMENT_PARSER_PROCESS_FAILED');
  assert.ok(error?.diagnostic?.excerpt.includes('Traceback'));
  assert.ok(!error?.diagnostic?.excerpt.includes('/private/synthetic-stage'));
  assert.equal((error as unknown as { stderr?: unknown }).stderr, undefined);
});

test('oversized stdout fails closed', async () => {
  const { error } = await run('oversize', { maxOutputBytes: 1024 });
  assert.equal(error?.message, 'DOCUMENT_PARSER_OUTPUT_LIMIT');
});

test('timeout fails closed and keeps what stderr said before the kill', async () => {
  const started = Date.now();
  const { error } = await run('sleep', { timeoutMs: 1500 });
  assert.equal(error?.message, 'DOCUMENT_PARSER_TIMEOUT');
  assert.ok(Date.now() - started < 10_000);
  assert.ok(error?.diagnostic?.excerpt.includes('started'));
});

test('redaction strips paths, urls, emails, credentials and long opaque values', () => {
  const text = redactParserStderr(
    'at /srv/x/y.py url=https://h.example/a?sig=zz a@b.example password: hunter2 Bearer abc.def ' +
      'f'.repeat(40) +
      ' ' +
      'Q'.repeat(50),
    ['/srv/x'],
  );
  for (const leaked of [
    '/srv/x',
    'h.example',
    'a@b.example',
    'hunter2',
    'abc.def',
    'f'.repeat(40),
    'Q'.repeat(50),
  ])
    assert.ok(!text.includes(leaked), leaked);
  assert.equal(classifyParserStderr(Buffer.alloc(0), 0), null);
});
