import { z } from 'zod';
import { getStaffProfile, setStaffLocale } from '@vs/engine';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';
import { can, PERMISSIONS, type Permission } from '../permissions';

export const meRouter = router({
  profile: procedure('self').query(async ({ ctx }) => {
    const profile = await getStaffProfile(backofficeDb(), ctx.engine, ctx.staff.staffUserId);
    const permissions = (Object.keys(PERMISSIONS) as Permission[]).filter((p) =>
      can(ctx.staff.role, p),
    );
    return { ...profile, permissions };
  }),
  setLocale: procedure('self')
    .input(z.object({ locale: z.enum(['ar', 'en']) }))
    .mutation(async ({ ctx, input }) => {
      await setStaffLocale(backofficeDb(), ctx.engine, ctx.staff.staffUserId, input.locale);
      return { locale: input.locale };
    }),
});
