import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

// Codex uses the Responses wire protocol. DeepSeek serves Chat Completions.
// This loopback-only adapter translates the text-only worker subset, including SSE.
export function toMessages(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });
  for (const item of typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input || []) {
    if (item.type === 'function_call' || item.type === 'function_call_output') throw new Error('本 worker 不允许工具执行。');
    if (item.role) {
      const content = typeof item.content === 'string' ? item.content : (item.content || []).filter(c => ['input_text', 'output_text', 'text'].includes(c.type)).map(c => c.text).join('\n');
      if (content) messages.push({ role: ['system', 'developer'].includes(item.role) ? 'system' : item.role, content });
    }
  }
  const schema = body.text?.format?.schema;
  if (schema) messages.push({ role: 'system', content: `Return only a valid JSON object matching this JSON Schema. Do not wrap it in markdown.\n${JSON.stringify(schema)}` });
  return messages;
}

export async function startBridge({ apiKey, baseUrl = 'https://api.deepseek.com', model = 'deepseek-chat', fetcher = fetch }) {
  const token = randomUUID();
  const server = createServer(async (req, res) => {
    const provided = Buffer.from(String(req.headers.authorization || ''));
    const expected = Buffer.from(`Bearer ${token}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) { res.writeHead(401); return res.end(); }
    if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(req.url)) { res.writeHead(404); return res.end(); }
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const timeout = setTimeout(() => controller.abort(), 240000);
    try {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 4_000_000) throw new Error('模型请求过大。'); }
      const body = JSON.parse(raw);
      const payload = { model, messages: toMessages(body), stream: false, max_tokens: 8192 };
      if (body.text?.format?.schema) payload.response_format = { type: 'json_object' };
      // Codex advertises built-ins even with shell disabled. This text-only
      // adapter deliberately forwards no tool definitions and never produces
      // function_call output. Actual tool items in input fail in toMessages.
      const response = await fetcher(baseUrl.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
      if (!response.ok) {
        const message = response.status === 401 ? 'DeepSeek API Key 无效。' : response.status === 402 ? 'DeepSeek 账户余额不足。' : response.status === 429 ? 'DeepSeek 请求限流，请稍后重试。' : `DeepSeek 请求失败（${response.status}）。`;
        res.writeHead(response.status, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message, type: 'upstream_error', code: String(response.status) } }));
      }
      const data = await response.json();
      const choice = data.choices?.[0];
      if (choice?.finish_reason !== 'stop' || !choice.message?.content) throw new Error('DeepSeek 返回被截断或为空，本段未完成。');
      const id = 'resp_' + randomUUID().replaceAll('-', '');
      const message = { id: 'msg_' + randomUUID().replaceAll('-', ''), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: choice.message.content, annotations: [] }] };
      const result = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model, output: [message], usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0, total_tokens: data.usage?.total_tokens || 0, input_tokens_details: { cached_tokens: data.usage?.prompt_cache_hit_tokens || 0 } } };
      if (!body.stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(result)); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      let sequence = 0;
      const event = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`);
      event('response.created', { response: { ...result, status: 'in_progress', output: [], usage: null } });
      event('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
      event('response.content_part.added', { item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      event('response.output_text.delta', { item_id: message.id, output_index: 0, content_index: 0, delta: choice.message.content });
      event('response.output_text.done', { item_id: message.id, output_index: 0, content_index: 0, text: choice.message.content });
      event('response.content_part.done', { item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] });
      event('response.output_item.done', { output_index: 0, item: message });
      event('response.completed', { response: result }); res.end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.name === 'AbortError' ? '模型请求已取消或超时。' : error.message, type: 'adapter_error' } }));
    } finally { clearTimeout(timeout); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { token, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => { server.closeAllConnections(); server.close(); } };
}
