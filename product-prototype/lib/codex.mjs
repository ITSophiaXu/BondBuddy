import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { startBridge } from './bridge.mjs';

export const string = { type: 'string' };
export const array = items => ({ type: 'array', items });
export const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const evidenceSchema = object({ documentId: string, locator: string, quote: string });
export const REVIEW_SCHEMA = object({ summary: string, findings: array(object({ status: { type: 'string', enum: ['明确错误','来源冲突','待补证','待人工判断','未覆盖'] }, priority: { type: 'string', enum: ['P1','P2','P3'] }, category: string, title: string, locator: string, quote: string, issue: string, evidence: array(evidenceSchema), suggestion: string, rule_ids: array(string), calculation: string })), checks: array(object({ rule_id: string, status: { type: 'string', enum: ['通过','明确错误','来源冲突','待补证','待人工判断','不适用','未覆盖'] }, reason: string })), limitations: array(string) });
export const UPDATE_SCHEMA = object({ summary: string, edits: array(object({ locator: string, quote: string, replacement: string, reason: string, evidence: array(evidenceSchema) })), gaps: array(string) });
export const CHAT_SCHEMA = object({ billingOutcome:{type:'string',enum:['delivered','needs_input','refused']}, title: string, answer: string, document: string, sources: array(string), limitations: array(string) });

export function validate(value, schema) {
  if (schema.type === 'string') return typeof value === 'string' && (!schema.enum || schema.enum.includes(value));
  if (schema.type === 'array') return Array.isArray(value) && value.every(v => validate(v, schema.items));
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(schema.properties).every(k => validate(value[k], schema.properties[k])) && Object.keys(value).every(k => k in schema.properties);
}
export function executable() {
  if (process.env.BOND_BUDDY_CODEX) return process.env.BOND_BUDDY_CODEX;
  if (process.platform === 'win32') {
    const root = join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
    try { return readdirSync(root).map(n => join(root, n, 'codex.exe')).filter(existsSync).sort((a,b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] || 'codex'; } catch {}
  }
  return 'codex';
}
export function launch(args, { cwd, input = '', signal, env = {}, timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable(), args, { cwd, windowsHide: true, shell: false, signal, env: { ...process.env, ...env } });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', d => { stdout = (stdout + d).slice(-3000000); });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-12000); });
    child.stdin.on('error', () => {});
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.end(input);
  });
}
export async function askCodex({ prompt, schema, folder, key, signal, settings, runner = launch, bridgeFactory = startBridge }) {
  if (!settings.apiKey) throw new Error('请先在设置中配置 DeepSeek API Key。材料与任务已保存。');
  const bridge = await bridgeFactory(settings);
  try {
    const schemaPath = join(folder, `${key}.schema.json`), resultPath = join(folder, `${key}.response.json`);
    const codexHome = join(folder, 'codex-home'); await mkdir(codexHome, { recursive: true });
    await writeFile(schemaPath, JSON.stringify(schema));
    const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--json',
      '-c', 'approval_policy="never"', '-c', 'features.shell_tool=false', '-c', 'features.apply_patch_freeform=false', '-c', 'web_search="disabled"',
      '-c', 'model_provider="bondbuddy"', '-m', settings.model, '-c', 'model_providers.bondbuddy.name="BondBuddy DeepSeek"',
      '-c', `model_providers.bondbuddy.base_url=${JSON.stringify(bridge.url)}`, '-c', 'model_providers.bondbuddy.env_key="BOND_BUDDY_BRIDGE_TOKEN"',
      '-c', 'model_providers.bondbuddy.wire_api="responses"', '-c', 'model_providers.bondbuddy.requires_openai_auth=false',
      '--output-schema', schemaPath, '--output-last-message', resultPath, '-'];
    const result = await runner(args, { cwd: folder, input: prompt, signal, env: { CODEX_HOME: codexHome, BOND_BUDDY_BRIDGE_TOKEN: bridge.token, DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '' } });
    if (signal?.aborted) throw new Error('任务已停止。');
    if (result.timedOut) throw new Error('当前片段处理超时，可从已保存的进度继续。');
    const events = result.stdout.split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
    if (result.code !== 0 || events.some(e=>e.type==='turn.failed')) {
      const details = result.stdout + result.stderr;
      if (/401|API Key 无效/.test(details)) throw new Error('DeepSeek API Key 无效，请在设置中更新后重试。');
      if (/402|余额不足/.test(details)) throw new Error('DeepSeek 账户余额不足。');
      if (/429|限流/.test(details)) throw new Error('DeepSeek 请求限流，请稍后继续。');
      throw new Error('Codex 未完成本段任务，请检查模型连接和 Codex 版本后继续。');
    }
    const raw = await readFile(resultPath, 'utf8');
    const value = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!validate(value, schema)) throw new Error('模型输出格式不完整，本段未计为完成，请重试。');
    const usage = events.filter(e => e.type === 'turn.completed').reduce((a,e) => ({ inputTokens: a.inputTokens + (e.usage?.input_tokens || 0), outputTokens: a.outputTokens + (e.usage?.output_tokens || 0), cachedInputTokens: a.cachedInputTokens + (e.usage?.cached_input_tokens || 0) }), { inputTokens:0, outputTokens:0, cachedInputTokens:0 });
    // The gateway is the billing authority; CLI usage is only a display fallback.
    // Failed/retried model responses are platform costs, not additional customer charges.
    const metering=bridge.usageEvents?.at(-1);
    return { value, usage:metering?.verified?metering.usage:usage, metering:metering||{id:key,type:'model',usage,verified:false} };
  } finally { bridge.close(); }
}
