import { initTRPC, TRPCError } from '@trpc/server';
import { isDomainError } from '@vs/contracts';
import type { StaffContext, StaffRole } from '@vs/engine';

export interface Context {
  /** Null when there is no verified Supabase session or the user is not linked to an operator. */
  staff: StaffContext | null;
}

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    const cause = error.cause;
    return {
      ...shape,
      data: { ...shape.data, domainCode: isDomainError(cause) ? cause.code : undefined },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

/** Requires a linked staff user; role checks run on the server (prompt § Batch 6). */
export const staffProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.staff) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { staff: ctx.staff } });
});

export function requireRole(...roles: StaffRole[]) {
  return staffProcedure.use(({ ctx, next }) => {
    if (!roles.includes(ctx.staff.role)) throw new TRPCError({ code: 'FORBIDDEN' });
    return next();
  });
}
