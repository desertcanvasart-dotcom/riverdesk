import { pingDatabase } from '@vs/engine';
import { backofficeDb } from './db';
import { bookRouter } from './routers/book';
import { bookingsRouter } from './routers/bookings';
import { homeRouter } from './routers/home';
import { meRouter } from './routers/me';
import { requestsRouter } from './routers/requests';
import { publicProcedure, router } from './trpc';

export const appRouter = router({
  health: publicProcedure.query(async () => ({ database: await pingDatabase(backofficeDb()) })),
  me: meRouter,
  home: homeRouter,
  book: bookRouter,
  bookings: bookingsRouter,
  requests: requestsRouter,
});

export type AppRouter = typeof appRouter;
