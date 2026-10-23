import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { createContext } from '../../../../server/context';
import { appRouter } from '../../../../server/router';

export const dynamic = 'force-dynamic';

const handler = (request: Request) =>
  fetchRequestHandler({ endpoint: '/api/trpc', req: request, router: appRouter, createContext });

export { handler as GET, handler as POST };
