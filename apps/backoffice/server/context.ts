import 'server-only';
import { getSession } from './session';
import type { Context } from './trpc';

export async function createContext(): Promise<Context> {
  return { session: await getSession() };
}
