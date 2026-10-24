import { z } from 'zod';
import {
  addMarket,
  addMarketInput,
  deleteMarket,
  listMarkets,
  updateMarket,
  updateMarketInput,
  getOperatorSettings,
  inviteStaff,
  inviteStaffInput,
  listStaff,
  revokeInvitation,
  revokeInvitationInput,
  updateOperatorSettings,
  updateOperatorSettingsInput,
  updateStaff,
  updateStaffInput,
} from '@vs/engine';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';

export const settingsRouter = router({
  /** The company's markets: every screen that names a market reads them (markets, 2026-10-24). */
  markets: procedure('read').query(({ ctx }) => listMarkets(backofficeDb(), ctx.engine)),
  addMarket: procedure('settings.write')
    .input(addMarketInput)
    .mutation(({ ctx, input }) => addMarket(backofficeDb(), ctx.engine, input)),
  updateMarket: procedure('settings.write')
    .input(updateMarketInput)
    .mutation(({ ctx, input }) => updateMarket(backofficeDb(), ctx.engine, input)),
  deleteMarket: procedure('settings.write')
    .input(z.object({ marketId: z.uuid() }))
    .mutation(({ ctx, input }) => deleteMarket(backofficeDb(), ctx.engine, input.marketId)),
  staff: procedure('read').query(({ ctx }) => listStaff(backofficeDb(), ctx.engine)),
  invite: procedure('settings.write')
    .input(inviteStaffInput)
    .mutation(({ ctx, input }) => inviteStaff(backofficeDb(), ctx.engine, input)),
  revokeInvitation: procedure('settings.write')
    .input(revokeInvitationInput)
    .mutation(({ ctx, input }) => revokeInvitation(backofficeDb(), ctx.engine, input)),
  updateStaff: procedure('settings.write')
    .input(updateStaffInput)
    .mutation(({ ctx, input }) => updateStaff(backofficeDb(), ctx.engine, input)),
  operator: procedure('read').query(({ ctx }) => getOperatorSettings(backofficeDb(), ctx.engine)),
  updateOperator: procedure('settings.write')
    .input(updateOperatorSettingsInput)
    .mutation(({ ctx, input }) => updateOperatorSettings(backofficeDb(), ctx.engine, input)),
});
