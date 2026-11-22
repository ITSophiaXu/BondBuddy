#!/usr/bin/env node
// Synthetic Codex process. Models an exact production punctuation error, never calls a provider.
import assert from 'node:assert/strict';
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const mode=process.argv.find(a=>a.startsWith('--fake-scenario='))?.split('=')[1];
const lines=prompt.split('\n'),at=lines.findIndex(l=>/^<<BB-DATA-[a-f0-9]+ ref=/.test(l));
assert.ok(at>=0);const capture=lines[at].split(' ref=')[1],material=JSON.parse(lines[at+1]);
const reask=prompt.includes('[bb-reask]');
if(reask)assert.match(prompt,/QUOTE_NOT_VERBATIM findings indexes 0/);
const exact=material.text,quote=mode==='quote_retry'&&reask?exact:exact.replace('》、《','、《');
const value={summary:'Synthetic public record',findings:[{capture_id:capture,quote,explanation:'Synthetic record only',title:'Synthetic public information',nature:'information',subject_match:'company_name'}]};
for(const event of [{type:'thread.started',thread_id:'synthetic-integrity-quote'},{type:'item.completed',item:{id:'reply',type:'agent_message',text:JSON.stringify(value)}},{type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:0,output_tokens:30,reasoning_output_tokens:0}}])process.stdout.write(JSON.stringify(event)+'\n');
