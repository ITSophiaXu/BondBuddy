import { Ajv } from 'ajv';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dataLifecycleSchemas } from './index.js';

type Example = { name: string; schema: keyof typeof dataLifecycleSchemas; valid: boolean; value: unknown };
const data = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/data-lifecycle.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Example[] };
assert.equal(data.synthetic, true);
const ajv = new Ajv({ allErrors: true, strict: true });
for (const example of data.cases) {
  const validate = ajv.compile(dataLifecycleSchemas[example.schema]);
  assert.equal(validate(example.value), example.valid, `${example.name}: ${ajv.errorsText(validate.errors)}`);
}
process.stdout.write(`Validated ${data.cases.length} synthetic data-lifecycle examples\n`);
