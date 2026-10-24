import { z } from 'zod';
import {
  addItinerary,
  addPort,
  addRoute,
  addUsualPorts,
  createPortInput,
  createSailingPatternInput,
  createScheduleTemplateInput,
  deleteItinerary,
  deleteRoute,
  getRoutes,
  replaceRouteStops,
  replaceRouteStopsInput,
  updateItinerary,
  updateItineraryInput,
  updatePort,
  updatePortInput,
  updateRoute,
  updateRouteInput,
} from '@vs/engine';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';

/** Ports, routes and itineraries (Batch 8, step 2). Departures are generated on Schedule. */
export const routesRouter = router({
  list: procedure('read')
    .input(z.object({ vesselId: z.uuid() }))
    .query(({ ctx, input }) => getRoutes(backofficeDb(), ctx.engine, input.vesselId)),
  addPort: procedure('schedule.write')
    .input(createPortInput)
    .mutation(({ ctx, input }) => addPort(backofficeDb(), ctx.engine, input)),
  addUsualPorts: procedure('schedule.write').mutation(({ ctx }) =>
    addUsualPorts(backofficeDb(), ctx.engine),
  ),
  updatePort: procedure('schedule.write')
    .input(updatePortInput)
    .mutation(({ ctx, input }) => updatePort(backofficeDb(), ctx.engine, input)),
  addRoute: procedure('schedule.write')
    .input(createScheduleTemplateInput)
    .mutation(({ ctx, input }) => addRoute(backofficeDb(), ctx.engine, input)),
  updateRoute: procedure('schedule.write')
    .input(updateRouteInput)
    .mutation(({ ctx, input }) => updateRoute(backofficeDb(), ctx.engine, input)),
  replaceStops: procedure('schedule.write')
    .input(replaceRouteStopsInput)
    .mutation(({ ctx, input }) => replaceRouteStops(backofficeDb(), ctx.engine, input)),
  deleteRoute: procedure('schedule.write')
    .input(z.object({ routeId: z.uuid() }))
    .mutation(({ ctx, input }) => deleteRoute(backofficeDb(), ctx.engine, input.routeId)),
  addItinerary: procedure('schedule.write')
    .input(createSailingPatternInput)
    .mutation(({ ctx, input }) => addItinerary(backofficeDb(), ctx.engine, input)),
  updateItinerary: procedure('schedule.write')
    .input(updateItineraryInput)
    .mutation(({ ctx, input }) => updateItinerary(backofficeDb(), ctx.engine, input)),
  deleteItinerary: procedure('schedule.write')
    .input(z.object({ itineraryId: z.uuid() }))
    .mutation(({ ctx, input }) => deleteItinerary(backofficeDb(), ctx.engine, input.itineraryId)),
});
