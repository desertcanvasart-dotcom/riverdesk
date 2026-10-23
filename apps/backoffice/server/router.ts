import { pingDatabase } from '@vs/engine';
import { backofficeDb } from './db';
import { bookRouter } from './routers/book';
import { bookingsRouter } from './routers/bookings';
import { homeRouter } from './routers/home';
import { inventoryRouter } from './routers/inventory';
import { meRouter } from './routers/me';
import { ratesRouter } from './routers/rates';
import { requestsRouter } from './routers/requests';
import { scheduleRouter } from './routers/schedule';
import { publicProcedure, router } from './trpc';

export const appRouter = router({
  health: publicProcedure.query(async () => ({ database: await pingDatabase(backofficeDb()) })),
  me: meRouter,
  home: homeRouter,
  book: bookRouter,
  bookings: bookingsRouter,
  requests: requestsRouter,
  inventory: inventoryRouter,
  schedule: scheduleRouter,
  rates: ratesRouter,
});

export type AppRouter = typeof appRouter;
