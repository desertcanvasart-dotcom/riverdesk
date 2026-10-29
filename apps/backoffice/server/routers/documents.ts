import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  ONBOARD_DOCUMENTS,
  PASSPORT_DOCUMENTS,
  getDocumentStatus,
  listDocuments,
  vacancyData,
  requestDocument,
  requestDocumentInput,
  type RequestDocumentInput,
} from '@vs/engine';
import { backofficeDb } from '../db';
import { can } from '../permissions';
import { procedure, router } from '../trpc';

/** Requests return at once; the worker renders, the screen polls status, then downloads. */
export const documentsRouter = router({
  request: procedure('documents.create')
    .input(requestDocumentInput)
    .mutation(({ ctx, input }) => {
      if (PASSPORT_DOCUMENTS.includes(input.kind) && !can(ctx.staff.role, 'manifests'))
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Needs manifests' });
      if (ctx.staff.role !== 'onboard') return requestDocument(backofficeDb(), ctx.engine, input);
      // On board: only this vessel's departure and programme documents, and the sheet without
      // balances.
      if (!ONBOARD_DOCUMENTS.includes(input.kind))
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Needs read' });
      return requestDocument(
        backofficeDb(),
        ctx.engine,
        ('variant' in input ? { ...input, variant: 'agent' } : input) as RequestDocumentInput,
        { vesselId: ctx.staff.vesselId },
      );
    }),
  status: procedure('self')
    .input(z.object({ documentId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const status = await getDocumentStatus(backofficeDb(), ctx.engine, input.documentId);
      // An on-board login follows only the documents it asked for.
      if (ctx.staff.role === 'onboard' && status.requestedBy !== ctx.staff.staffUserId)
        throw new TRPCError({ code: 'NOT_FOUND' });
      if (ctx.staff.role !== 'onboard' && !can(ctx.staff.role, 'read'))
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Needs read' });
      return status;
    }),
  vacancy: procedure('read')
    .input(
      z.object({
        vesselId: z.uuid(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        weeks: z.number().int().min(1).max(8),
      }),
    )
    .query(({ ctx, input }) => vacancyData(backofficeDb(), ctx.engine, input)),
  list: procedure('read')
    .input(z.object({ entity: z.enum(['booking', 'leg', 'vessel']), entityId: z.uuid() }))
    .query(({ ctx, input }) => listDocuments(backofficeDb(), ctx.engine, input)),
});
