import 'server-only';
import { cache } from 'react';
import { createContext } from './context';
import { appRouter } from './router';

/** Server components call procedures through the same permission checks as the browser. */
export const serverCaller = cache(async () => appRouter.createCaller(await createContext()));
