import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  getDocumentStatus,
  listDocuments,
  vacancyData,
  requestDocument,
  requestDocumentInput,
} from '@vs/engine';
import { backofficeDb } from '../db';
import { can } from '../permissions';
import { procedure, router } from '../trpc';

/** Requests return at once; the worker renders, the screen polls status, then downloads. */
export const documentsRouter = router({
  request: procedure('documents.create')
    .input(requestDocumentInput)
    .mutation(({ ctx, input }) => {
      if (input.kind === 'manifest' && !can(ctx.staff.role, 'manifests'))
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Needs manifests' });
      return requestDocument(backofficeDb(), ctx.engine, input);
    }),
  status: procedure('read')
    .input(z.object({ documentId: z.uuid() }))
    .query(({ ctx, input }) => getDocumentStatus(backofficeDb(), ctx.engine, input.documentId)),
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
