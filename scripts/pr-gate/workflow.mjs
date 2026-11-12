// Read the deliberately small, static subset used by pr-gate.yml. Refuse syntax
// changes rather than silently running a stale copy of the matrix/environment.
export function readWorkflow(source) {
  const envText = source.match(/^env:\r?\n([\s\S]*?)^jobs:/m)?.[1];
  if (!envText) throw new Error('Missing workflow env');
  const scalar = value => {
    value = value.trim();
    if (/^'[^']*'$/.test(value) || /^"[^"\\]*"$/.test(value)) value = value.slice(1, -1);
    if (!value || /[\r\n$`{}]/.test(value)) throw new Error(`Unsupported workflow scalar: ${value}`);
    return value;
  };
  const env = {};
  for (const line of envText.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'))) {
    const match = /^  ([A-Z][A-Z0-9_]*): (.+)$/.exec(line);
    if (!match || Object.hasOwn(env, match[1])) throw new Error(`Unsupported workflow env line: ${line}`);
    env[match[1]] = scalar(match[2]);
  }
  const matrixText = source.match(/^        include:\r?\n([\s\S]*?)^    services:/m)?.[1];
  if (!matrixText) throw new Error('Missing workflow matrix');
  const matrix = matrixText.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).map(line => {
    const body = /^          - \{ (.*) \}$/.exec(line)?.[1];
    if (!body) throw new Error(`Unsupported workflow matrix line: ${line}`);
    const row = {};
    for (const field of body.match(/(?:'[^']*'|"[^"]*"|[^,])+/g) ?? []) {
      const match = /^\s*(\w+):\s*(.+?)\s*$/.exec(field);
      if (!match || !['name', 'groups', 'shard', 'chromium', 'render'].includes(match[1]) || Object.hasOwn(row, match[1])) throw new Error(`Unsupported matrix field: ${field}`);
      row[match[1]] = scalar(match[2]);
    }
    if (!/^[a-z0-9-]+$/.test(row.name ?? '') || !/^[a-z,-]+$/.test(row.groups ?? '') || !/^\d+\/\d+$/.test(row.shard ?? '') || ['chromium', 'render'].some(key => row[key] && !['true', 'false'].includes(row[key]))) throw new Error('Invalid matrix row');
    return row;
  });
  if (matrix.length !== 8 || new Set(matrix.map(row => row.name)).size !== 8) throw new Error('Expected the eight unique pr-gate matrix rows');
  const postgres = source.match(/^        image: (postgres:16\.\d+)\r?$/m)?.[1];
  const azurite = source.match(/\b(mcr\.microsoft\.com\/azure-storage\/azurite:\d+\.\d+\.\d+)\b/)?.[1];
  const credentials = Object.fromEntries([...source.matchAll(/^          (POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB): (\S+)\r?$/gm)].map(([, key, value]) => [key, value]));
  if (!postgres || !azurite || Object.keys(credentials).length !== 3) throw new Error('Missing pinned test service configuration');
  const expectedUrl = `postgresql://${credentials.POSTGRES_USER}:${credentials.POSTGRES_PASSWORD}@127.0.0.1:5432/${credentials.POSTGRES_DB}`;
  if (env.BB_TEST_DATABASE_URL !== expectedUrl || env.BB_TEST_AZURITE_CONNECTION_STRING !== 'UseDevelopmentStorage=true' || ['BB_TEST_LIVE_AUTHORING', 'BB_PLATFORM_PROBE_ENABLED', 'BB_REVIEW_WEB_SEARCH_ENABLED'].some(key => env[key] !== '0')) throw new Error('Workflow must use disposable loopback services and disable live models/probes/search');
  return { env, matrix, postgres, azurite, credentials };
}
