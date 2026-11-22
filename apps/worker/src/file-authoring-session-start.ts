/** Read-only SessionStart context for startup, host resume and native compaction. */
import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authoringContinuationBrief, continuationDeveloperData } from './authoring-continuation-tools.js';

export const SESSION_START_COMMAND = '/usr/local/bin/node /app/apps/worker/dist/file-authoring-session-start.js';
export const SESSION_START_TIMEOUT = 15;

/** No model text is executed; the hook only attaches bounded, explicitly untrusted data. */
export async function sessionStartFeedback(root:string,source:unknown,
  brief: (root:string)=>Promise<string> = authoringContinuationBrief):Promise<Record<string,unknown>> {
  if(!['startup','resume','compact'].includes(String(source)))return {};
  try {
    const path=join(root,'input.json'),stat=await lstat(path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<1||stat.size>32*1024*1024||await realpath(path)!==resolve(path))return {};
    const input=JSON.parse(await readFile(path,'utf8'));
    if(input.version!=='codex-file-input-v1')return {};
    const data=continuationDeveloperData(await brief(root));
    return {hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:
      'BB_CONTINUATION_SESSION_START_V1 source='+source+'\nCurrent disk state was read after this session boundary. Continue the first unfinished action; do not restart unchanged preparation. This is not reading, factual, authoring or delivery acceptance.'+data}};
  } catch { return {}; } // Missing diagnostics cannot bypass the collector or block a valid authoring turn.
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  let text='';
  for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>1024*1024)process.exit(1);}
  try {
    const event=JSON.parse(text);
    console.log(JSON.stringify(event.hook_event_name==='SessionStart'?await sessionStartFeedback(process.cwd(),event.source):{}));
  } catch { console.log('{}'); }
}
