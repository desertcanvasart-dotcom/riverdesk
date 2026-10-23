import { z } from 'zod';

/** Who performed an action. Every engine function takes one and writes it to audit_log. */
export const actorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('staff'), id: z.uuid(), label: z.string().optional() }),
  z.object({ type: z.literal('channel'), id: z.uuid(), label: z.string().optional() }),
  z.object({ type: z.literal('system'), label: z.string().min(1) }),
]);

export type Actor = z.infer<typeof actorSchema>;

export function systemActor(label: string): Actor {
  return { type: 'system', label };
}
