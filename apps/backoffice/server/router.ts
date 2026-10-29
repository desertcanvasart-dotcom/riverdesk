import { pingDatabase } from '@vs/engine';
import { backofficeDb } from './db';
import { analyticsRouter } from './routers/analytics';
import { bookRouter } from './routers/book';
import { bookingsRouter } from './routers/bookings';
import { channelsRouter } from './routers/channels';
import { checkinRouter } from './routers/checkin';
import { documentsRouter } from './routers/documents';
import { financeRouter, invoicesRouter } from './routers/finance';
import { fleetRouter } from './routers/fleet';
import { foliosRouter } from './routers/folios';
import { guestsRouter } from './routers/guests';
import { homeRouter } from './routers/home';
import { inventoryRouter } from './routers/inventory';
import { meRouter } from './routers/me';
import { paymentsRouter } from './routers/payments';
import { pilotRouter } from './routers/pilot';
import { receiptsRouter } from './routers/receipts';
import { receivablesRouter } from './routers/receivables';
import { financeReportsRouter } from './routers/finance-reports';
import { ratesRouter } from './routers/rates';
import { requestsRouter } from './routers/requests';
import { routesRouter } from './routers/routes';
import { scheduleRouter } from './routers/schedule';
import { settingsRouter } from './routers/settings';
import { publicProcedure, router } from './trpc';

export const appRouter = router({
  health: publicProcedure.query(async () => ({ database: await pingDatabase(backofficeDb()) })),
  me: meRouter,
  home: homeRouter,
  book: bookRouter,
  bookings: bookingsRouter,
  requests: requestsRouter,
  inventory: inventoryRouter,
  fleet: fleetRouter,
  schedule: scheduleRouter,
  routes: routesRouter,
  rates: ratesRouter,
  finance: financeRouter,
  invoices: invoicesRouter,
  channels: channelsRouter,
  payments: paymentsRouter,
  receipts: receiptsRouter,
  receivables: receivablesRouter,
  financeReports: financeReportsRouter,
  settings: settingsRouter,
  documents: documentsRouter,
  guests: guestsRouter,
  checkin: checkinRouter,
  folios: foliosRouter,
  analytics: analyticsRouter,
  pilot: pilotRouter,
});

export type AppRouter = typeof appRouter;
