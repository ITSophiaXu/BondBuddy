import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  runDocumentParser,
  runDocumentParserToFile,
  type DocumentParseRequest,
} from './document-parser.js';

const pythonExecutable = process.env.BB_PYTHON;
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

test(
  'real Python JSON and streaming bridges preserve Chinese paths and text under a non-UTF8 parent environment',
  {
    skip: pythonExecutable ? false : 'set BB_PYTHON to a configured Python interpreter',
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'bb-parser-中文-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const originalEncoding = process.env.PYTHONIOENCODING;
    process.env.PYTHONIOENCODING = 'cp1252';
    t.after(() => {
      if (originalEncoding === undefined) delete process.env.PYTHONIOENCODING;
      else process.env.PYTHONIOENCODING = originalEncoding;
    });
    const text = '合成材料：中文路径及财务附注，金额 123.45 元。';
    const bytes = Buffer.from(`${text}\n`, 'utf8');
    const path = join(root, '中文附注.txt');
    await writeFile(path, bytes);
    const request: DocumentParseRequest = {
      schema_version: 'document-parse-request-v1',
      request_id: 'synthetic-utf8',
      options: {},
      material: {
        material_id: 'synthetic-utf8',
        material_version: 1,
        media_type: 'text/plain',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        authorized_local_path: path,
      },
    };
    const options = { pythonExecutable, repoRoot };
    const parsed = await runDocumentParser(request, options);
    assert.equal(parsed.status, 'parsed');
    assert.equal(parsed.records[0]?.literal_quote, text);
    const recordsPath = join(root, 'records.ndjson');
    const stream = await runDocumentParserToFile(request, recordsPath, options);
    assert.equal(stream.response.status, 'parsed');
    assert.equal(stream.recordCount, 1);
    const record = JSON.parse((await readFile(recordsPath, 'utf8')).trim());
    assert.equal(record.literal_quote, text);
  },
);
