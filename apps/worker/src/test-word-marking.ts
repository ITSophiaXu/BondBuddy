import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isTestUncoveredItems, type TestUncoveredItem } from '@bondbuddy/contracts';

const run = promisify(execFile);
const repositoryRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');

/** The marker is applied before Word inspection, Blob promotion and final hash calculation. */
export async function markTestWord(bytes:Buffer, uncovered:TestUncoveredItem[]):Promise<Buffer> {
  if (!isTestUncoveredItems(uncovered)) throw new Error('TEST_UNCOVERED_ITEMS_INVALID');
  const directory=await mkdtemp(join(process.env.BB_PARSE_STAGING_DIR ?? tmpdir(),'bb-test-word-'));
  try {
    const source=join(directory,'source.docx'),manifest=join(directory,'uncovered.json'),target=join(directory,'marked.docx');
    await writeFile(source,bytes,{mode:0o600});
    await writeFile(manifest,JSON.stringify(uncovered),{mode:0o600});
    await run(process.env.BB_PYTHON_BIN ?? 'python3',[
      '-m','bondbuddy_word_delivery.test_marking',source,manifest,target
    ],{cwd:repositoryRoot,timeout:120_000,maxBuffer:64*1024,env:{...process.env,PYTHONPATH:join(repositoryRoot,'python')}});
    return await readFile(target);
  } finally { await rm(directory,{recursive:true,force:true}); }
}
