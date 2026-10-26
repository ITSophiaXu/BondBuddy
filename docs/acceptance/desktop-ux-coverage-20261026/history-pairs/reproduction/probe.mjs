import { writeFileSync } from 'node:fs';
import { Client } from 'pg';
for (const key of Object.keys(process.env)) if (/^PG/i.test(key)) delete process.env[key];
const started = new Date().toISOString();
const client = new Client({ connectionString: 'postgresql://bb_history_test@127.0.0.1:15529/postgres', connectionTimeoutMillis: 10000 });
let result;
try { await client.connect(); result = { started, finished: new Date().toISOString(), rows: (await client.query('SELECT current_user,current_setting(\'data_directory\'),pg_postmaster_start_time()')).rows }; }
catch (error) { result = { started, finished: new Date().toISOString(), error: String(error) }; }
finally { await client.end(); }
writeFileSync(new URL(`./probe-${Date.now()}.json`, import.meta.url), JSON.stringify(result,null,2)+'\n', { flag: 'wx' });
console.log(JSON.stringify(result));
