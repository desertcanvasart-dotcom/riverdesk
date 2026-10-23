import { pingDatabase } from '@vs/engine';
import { backofficeDb } from './db';
import { homeRouter } from './routers/home';
import { meRouter } from './routers/me';
import { publicProcedure, router } from './trpc';

export const appRouter = router({
  health: publicProcedure.query(async () => ({ database: await pingDatabase(backofficeDb()) })),
  me: meRouter,
  home: homeRouter,
});

export type AppRouter = typeof appRouter;
