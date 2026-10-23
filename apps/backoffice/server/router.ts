import { pingDatabase } from '@vs/engine';
import { backofficeDb } from './db';
import { publicProcedure, router, staffProcedure } from './trpc';

export const appRouter = router({
  health: publicProcedure.query(async () => ({ database: await pingDatabase(backofficeDb()) })),
  me: staffProcedure.query(({ ctx }) => ctx.staff),
});

export type AppRouter = typeof appRouter;
