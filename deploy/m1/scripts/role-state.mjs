import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));
export const optionalJSON = path => existsSync(path) ? readJSON(path) : null;
export function atomicText(path, value) {
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, value); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, path);
    const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}
export const atomicJSON = (path, value) => atomicText(path, JSON.stringify(value));
