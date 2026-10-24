import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { captureError, initErrorTracking, loadConfig } from '@vs/shared';
import { createContext } from '../../../../server/context';
import { appRouter } from '../../../../server/router';

export const dynamic = 'force-dynamic';

const handler = (request: Request) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req: request,
    router: appRouter,
    createContext,
    // Domain errors are expected answers; only unexpected failures are tracked.
    onError({ error, path }) {
      if (error.code !== 'INTERNAL_SERVER_ERROR') return;
      initErrorTracking(loadConfig(), 'backoffice');
      captureError(error.cause ?? error, { path });
    },
  });

export { handler as GET, handler as POST };
