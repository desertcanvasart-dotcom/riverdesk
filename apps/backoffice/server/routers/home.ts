import { getActionList } from '@vs/engine';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';

export const homeRouter = router({
  actionList: procedure('read').query(({ ctx }) => getActionList(backofficeDb(), ctx.engine)),
});
