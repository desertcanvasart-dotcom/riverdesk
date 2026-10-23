import {
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
