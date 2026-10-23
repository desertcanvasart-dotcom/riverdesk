import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import ScalarApiReference from '@scalar/fastify-api-reference';
import { DomainError, isDomainError } from '@vs/contracts';
import { openApiDocument, openApiText } from '@vs/contracts/openapi';
import { authenticateClient, pingDatabase, type VsDatabase } from '@vs/engine';
import { createLogger, type Logger } from '@vs/shared';
import { issueToken, TOKEN_TTL_SECONDS } from './auth';
import { v1Routes, type V1Options } from './routes/v1';

export interface AppOptions {
  db: VsDatabase;
  logger?: Logger;
  /** API_TOKEN_SECRET, decoded. */
  tokenSecret: Uint8Array;
  afterCommit?: V1Options['afterCommit'];
}

/** SQLSTATE classes and socket errors that mean the database is unreachable: answer 503. */
function isOutage(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return (
    typeof code === 'string' &&
    (code.startsWith('08') ||
      code === '57P01' ||
      code === '57P03' ||
      ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(code))
  );
}

/** Channel API v1 server (packages/contracts/openapi.yaml). */
export function buildApp(options: AppOptions) {
  const app = Fastify({
    loggerInstance: options.logger ?? createLogger('api'),
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 256 * 1024,
  });

  // One place maps errors to HTTP. Unknown errors are INTERNAL and never leak their message.
  app.setErrorHandler((error, request, reply) => {
    if (isDomainError(error)) {
      if (error.code === 'RETRY_LATER' || error.code === 'IN_PROGRESS')
        void reply.header('Retry-After', '1');
      return reply.status(error.status).send({ error: error.toJSON() });
    }
    if (isOutage(error)) {
      request.log.error({ err: error }, 'database unavailable');
      return reply
        .status(503)
        .header('Retry-After', '30')
        .send({ error: new DomainError('SERVICE_UNAVAILABLE').toJSON() });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply
        .status(400)
        .send({
          error: new DomainError('VALIDATION_FAILED', {
            message: (error as Error).message,
          }).toJSON(),
        });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: new DomainError('INTERNAL').toJSON() });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: new DomainError('NOT_FOUND').toJSON() }),
  );

  void app.register(formbody);

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

  // OAuth 2.0 client credentials (RFC 6749 §4.4): Basic auth or form fields; OAuth error format.
  app.post('/oauth/token', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    let clientId = body.client_id;
    let secret = body.client_secret;
    const basic = request.headers.authorization;
    if (basic?.startsWith('Basic ')) {
      const decoded = Buffer.from(basic.slice(6), 'base64').toString();
      const colon = decoded.indexOf(':');
      if (colon > 0) {
        clientId = decodeURIComponent(decoded.slice(0, colon));
        secret = decodeURIComponent(decoded.slice(colon + 1));
      }
    }
    if (body.grant_type !== 'client_credentials')
      return reply.status(400).send({ error: 'unsupported_grant_type' });
    if (!clientId || !secret) return reply.status(400).send({ error: 'invalid_request' });
    const client = await authenticateClient(options.db, clientId, secret);
    if (!client) return reply.status(401).send({ error: 'invalid_client' });
    const token = await issueToken(options.tokenSecret, client);
    return reply
      .header('Cache-Control', 'no-store')
      .send({ access_token: token, token_type: 'Bearer', expires_in: TOKEN_TTL_SECONDS });
  });

  void app.register(v1Routes, {
    prefix: '/v1',
    db: options.db,
    tokenSecret: options.tokenSecret,
    afterCommit: options.afterCommit,
  });
  return app;
}
