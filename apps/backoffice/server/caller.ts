import 'server-only';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { createContext } from './context';
import { appRouter } from './router';

/**
 * Server components call procedures through the same permission checks as the browser.
 * A page renders alongside its layout, so it sends people to sign-in or the two-step check
 * itself instead of calling a procedure that refuses them (and logs an error) first.
 */
export const serverCaller = cache(async () => {
  const context = await createContext();
  if (!context.session) redirect('/login');
  if (context.session.needsMfa) redirect('/mfa');
  if (!context.session.staff && context.session.platformAdmin) redirect('/platform');
  return appRouter.createCaller(context);
});
