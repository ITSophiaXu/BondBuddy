// Run inside the Node image on the internal network with NODE_USE_ENV_PROXY=1.
const start = performance.now();
try {
  const response = await fetch('https://query.sse.com.cn/commonSoaQuery.do', { signal: AbortSignal.timeout(7000) });
  process.stdout.write(`${JSON.stringify({ result: 'unexpected_response', status: response.status })}\n`);
  process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ result: 'failed_closed', name: error.name,
    cause_code: error.cause?.code ?? null, elapsed_ms: Math.round(performance.now() - start) })}\n`);
}
