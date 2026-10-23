import Fastify from 'fastify';
import ScalarApiReference from '@scalar/fastify-api-reference';
import { DomainError, isDomainError, openApiDocument, openApiText } from '@vs/contracts';
import { pingDatabase, type VsDatabase } from '@vs/engine';
import { createLogger, type Logger } from '@vs/shared';

/**
 * Channel API v1 server. Batch 0 has only /health and the error mapping; the OpenAPI contract
 * and /v1 handlers arrive in Batch 5.
 */
export function buildApp(options: { db: VsDatabase; logger?: Logger }) {
  const app = Fastify({
    loggerInstance: options.logger ?? createLogger('api'),
    genReqId: () => crypto.randomUUID(),
  });

  // One place maps domain errors to HTTP (prompt § Batch 5). Unknown errors are INTERNAL and
  // never leak their message.
  app.setErrorHandler((error, request, reply) => {
    if (isDomainError(error)) {
      if (error.code === 'RETRY_LATER' || error.code === 'RATE_LIMITED')
        reply.header('Retry-After', '1');
      return reply.status(error.status).send({ error: error.toJSON() });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: new DomainError('INTERNAL').toJSON() });
  });

  // The contract, and interactive docs rendered from it.
  app.get('/openapi.yaml', async (_request, reply) =>
    reply.type('application/yaml').send(openApiText()),
  );
  void app.register(ScalarApiReference, {
    routePrefix: '/docs',
    configuration: { title: 'vessel-system Channel API', content: openApiDocument() },
  });

  app.get('/health', async (_request, reply) => {
    const database = await pingDatabase(options.db).catch(() => false);
    return reply
      .status(database ? 200 : 503)
      .send({ status: database ? 'ok' : 'unavailable', database });
  });

  return app;
}
