import 'server-only';
import { redirect } from 'next/navigation';
import { getSession, type Session } from '../../server/session';

/** The platform area: a platform admin who passed the two-step check in this session. */
export async function requirePlatformAdmin(): Promise<Session & { email: string }> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.platformAdmin || !session.email) redirect('/');
  if (session.aal !== 'aal2') redirect('/mfa');
  return session as Session & { email: string };
}
