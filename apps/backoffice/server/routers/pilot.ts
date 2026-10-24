import { pilotDashboard } from '@vs/engine';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';

export const pilotRouter = router({
  dashboard: procedure('pilot.view').query(({ ctx }) => pilotDashboard(backofficeDb(), ctx.engine)),
});
