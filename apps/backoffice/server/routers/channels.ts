import { z } from 'zod';
import {
  addApiClientSecret,
  addApiClientSecretInput,
  createAllotment,
  createAllotmentInput,
  createApiClient,
  createApiClientInput,
  createChannel,
  createChannelInput,
  createContract,
  createContractInput,
  createWebhookEndpoint,
  createWebhookEndpointInput,
  listChannelsDetail,
  listWebhookDeliveries,
  reduceAllotment,
  reduceAllotmentInput,
  releaseAllotmentLeg,
  releaseAllotmentLegInput,
  replayWebhookDelivery,
  replayWebhookDeliveryInput,
  revokeApiClientSecret,
  revokeApiClientSecretInput,
  updateContract,
  updateContractInput,
} from '@vs/engine';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';

export const channelsRouter = router({
  list: procedure('read').query(({ ctx }) => listChannelsDetail(backofficeDb(), ctx.engine)),
  create: procedure('channels.write')
    .input(createChannelInput)
    .mutation(({ ctx, input }) => createChannel(backofficeDb(), ctx.engine, input)),
  createContract: procedure('channels.write')
    .input(createContractInput)
    .mutation(({ ctx, input }) => createContract(backofficeDb(), ctx.engine, input)),
  updateContract: procedure('channels.write')
    .input(updateContractInput)
    .mutation(({ ctx, input }) => updateContract(backofficeDb(), ctx.engine, input)),
  createAllotment: procedure('inventory.write')
    .input(createAllotmentInput)
    .mutation(({ ctx, input }) => createAllotment(backofficeDb(), ctx.engine, input)),
  reduceAllotment: procedure('inventory.write')
    .input(reduceAllotmentInput)
    .mutation(({ ctx, input }) => reduceAllotment(backofficeDb(), ctx.engine, input)),
  releaseAllotment: procedure('inventory.write')
    .input(releaseAllotmentLegInput)
    .mutation(({ ctx, input }) => releaseAllotmentLeg(backofficeDb(), ctx.engine, input)),
  /** Returns the client secret once; it is never shown again. */
  createClient: procedure('channels.write')
    .input(createApiClientInput)
    .mutation(({ ctx, input }) => createApiClient(backofficeDb(), ctx.engine, input)),
  addSecret: procedure('channels.write')
    .input(addApiClientSecretInput)
    .mutation(({ ctx, input }) => addApiClientSecret(backofficeDb(), ctx.engine, input)),
  revokeSecret: procedure('channels.write')
    .input(revokeApiClientSecretInput)
    .mutation(({ ctx, input }) => revokeApiClientSecret(backofficeDb(), ctx.engine, input)),
  /** Returns the signing secret once. */
  createEndpoint: procedure('channels.write')
    .input(createWebhookEndpointInput)
    .mutation(({ ctx, input }) => createWebhookEndpoint(backofficeDb(), ctx.engine, input)),
  deliveries: procedure('read')
    .input(
      z.object({
        endpointId: z.uuid(),
        status: z.enum(['pending', 'delivered', 'dead']).optional(),
      }),
    )
    .query(({ ctx, input }) => listWebhookDeliveries(backofficeDb(), ctx.engine, input)),
  replay: procedure('channels.write')
    .input(replayWebhookDeliveryInput)
    .mutation(({ ctx, input }) => replayWebhookDelivery(backofficeDb(), ctx.engine, input)),
});
