import { getActionList, getSetupChecklist } from '@vs/engine';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';

export const homeRouter = router({
  actionList: procedure('read').query(({ ctx }) => getActionList(backofficeDb(), ctx.engine)),
  /** What each ship still needs before the office can sell it (Batch 8, step 4). */
  setup: procedure('read').query(({ ctx }) => getSetupChecklist(backofficeDb(), ctx.engine)),
});
