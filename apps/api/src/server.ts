import Fastify from 'fastify';
import { openApiDocument, schemas } from '@bondbuddy/contracts';

export function createServer() {
  const app = Fastify({ logger: true });
  app.get('/health', { schema: { response: { 200: schemas.HealthResponse } } }, async () => ({ status: 'ok' as const, service: 'bondbuddy-m1-api-skeleton' as const, implementation: 'health-and-contract-only' as const }));
  app.get('/openapi.json', async () => openApiDocument());
  return app;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const app = createServer();
  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  app.listen({ host: process.env.HOST ?? '127.0.0.1', port }).catch(error => { app.log.error(error); process.exitCode = 1; });
}
