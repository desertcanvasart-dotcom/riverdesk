import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { isDomainError, type ErrorCode } from '@vs/contracts';
import type { EngineContext, StaffContext } from '@vs/engine';
import { can, type Permission } from './permissions';
import type { Session } from './session';

export interface Context {
  session: Session | null;
}

const STATUS: Partial<Record<ErrorCode, TRPCError['code']>> = {
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'BAD_REQUEST',
  UNAUTHENTICATED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  CONTRACT_FORBIDS: 'FORBIDDEN',
  RATE_LIMITED: 'TOO_MANY_REQUESTS',
};

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    const cause = error.cause;
    return {
      ...shape,
      data: {
        ...shape.data,
        domainCode: isDomainError(cause) ? cause.code : undefined,
        domainDetails: isDomainError(cause) ? cause.details : undefined,
      },
    };
  },
});

/** Domain errors keep their stable code for the UI; anything else is an internal error. */
const domainErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && isDomainError(result.error.cause)) {
    const cause = result.error.cause;
    throw new TRPCError({ code: STATUS[cause.code] ?? 'CONFLICT', message: cause.message, cause });
  }
  return result;
});

export const router = t.router;
export const publicProcedure = t.procedure.use(domainErrors);

export interface StaffCtx {
  staff: StaffContext;
  engine: EngineContext;
}

/** A linked staff member who has passed MFA where the role requires it. */
export const staffProcedure = publicProcedure.use(({ ctx, next }) => {
  const staff = ctx.session?.staff;
  if (!staff) throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (ctx.session!.needsMfa) throw new TRPCError({ code: 'FORBIDDEN', message: 'MFA_REQUIRED' });
  const engine: EngineContext = {
    operatorId: staff.operatorId,
    actor: { type: 'staff', id: staff.staffUserId },
  };
  return next({ ctx: { staff, engine } });
});

/** Every procedure names the permission it needs; checked on the server. */
export function procedure(permission: Permission) {
  return staffProcedure.use(({ ctx, next }) => {
    if (!can(ctx.staff.role, permission))
      throw new TRPCError({ code: 'FORBIDDEN', message: `Needs ${permission}` });
    return next();
  });
}
