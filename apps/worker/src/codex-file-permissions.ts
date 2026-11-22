import { execFile } from 'node:child_process';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CodexAdapterConfig } from './codex-adapter.js';

/** Native commands read this immutable job and write only its scratch/output directories. */
export function filePermissionArgs(cwd: string, readOnly = false): string[] {
  const filesystem = {
    ':minimal': 'read',
    [cwd]: 'read',
    ...(!readOnly ? { [join(cwd, 'scratch')]: 'write', [join(cwd, 'output')]: 'write' } : {}),
    '/opt/venv': 'read',
    '/opt/codex': 'read',
    '/app/python': 'read',
    '/proc': 'deny',
    '/run/bondbuddy/enrollment': 'deny',
    '/run/bondbuddy/service': 'deny',
    '/etc/bondbuddy': 'deny',
  };
  const entries = Object.entries(filesystem)
    .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
    .join(',');
  return [
    '-c',
    'default_permissions="bb_file"',
    '-c',
    `permissions={bb_file={filesystem={${entries}},network={enabled=false}}}`,
  ];
}

/** Test the actual boundary before any provider intent; never fall back to full access. */
export async function verifyFilePermissions(
  c: CodexAdapterConfig,
  cwd: string,
  home: string,
  readOnly = false,
): Promise<void> {
  const outside = join(home, 'permission-canary'),
    probe = join(cwd, 'permission-probe.py');
  await writeFile(outside, 'private', { mode: 0o600 });
  await writeFile(
    probe,
    `import pathlib,socket,sys\nr=pathlib.Path.cwd()\n${readOnly ? 'assert pathlib.Path(__file__).read_text()\n' : "(r/'scratch/permission-result').write_text('ok')\n"}for p,m in [(sys.argv[1],'r'),('/run/secrets/bb-copilot-oauth','r'),('/run/bondbuddy/enrollment/context.json','r'),('/run/bondbuddy/enrollment/authoring.json','r'),('/run/bondbuddy/enrollment/review.json','r'),('/run/bondbuddy/service/credentials.json','r'),('/run/bondbuddy/service/authoring.env','r'),('/run/bondbuddy/service/review.env','r'),('/run/bondbuddy/service/compose.env','r'),('/etc/bondbuddy/enrollment.json','r'),('/proc/1/environ','r'),(str(r/'input.json'),'w')${readOnly ? ",(str(r/'scratch/permission-result'),'w')" : ''}]:\n try: open(p,m)\n except OSError: pass\n else: raise RuntimeError('file_boundary_failed')\ntry: socket.socket().connect(('127.0.0.1',3000))\nexcept PermissionError: pass\nelse: raise RuntimeError('network_boundary_failed')\nprint('BB_FILE_PERMISSIONS_OK')\n`,
    { mode: 0o400 },
  );
  try {
    const result = await promisify(execFile)(
      c.command[0]!,
      [
        ...c.command.slice(1),
        ...filePermissionArgs(cwd, readOnly),
        'sandbox',
        '--',
        '/opt/venv/bin/python',
        '-B',
        probe,
        outside,
      ],
      {
        cwd,
        env: {
          PATH: c.path_env,
          HOME: home,
          CODEX_HOME: home,
          TMPDIR: join(cwd, 'scratch'),
          LANG: 'C.UTF-8',
        },
        timeout: 30000,
        maxBuffer: 8192,
      },
    );
    if (
      result.stdout.trim() !== 'BB_FILE_PERMISSIONS_OK' ||
      (!readOnly && (await readFile(join(cwd, 'scratch/permission-result'), 'utf8')) !== 'ok')
    )
      throw Error();
  } catch {
    throw new Error('AUTHORING_FILE_SANDBOX_UNAVAILABLE');
  } finally {
    await rm(probe, { force: true });
    await rm(outside, { force: true });
    await rm(join(cwd, 'scratch/permission-result'), { force: true });
  }
}
