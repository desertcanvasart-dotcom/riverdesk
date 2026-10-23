import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Alert } from '../../components/ui';
import { Shell } from '../../components/shell';
import { serverCaller } from '../../server/caller';
import { getSession } from '../../server/session';
import { signOut } from '../actions';

export const dynamic = 'force-dynamic';

/** Every staff screen: signed in, linked to a company, MFA passed where the role requires it. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.needsMfa) redirect('/mfa');
  if (!session.staff) {
    const t = await getTranslations('login');
    return (
      <main className="mx-auto max-w-sm px-4 py-16">
        <Alert tone="warn">{t('notLinked')}</Alert>
        <form action={signOut} className="mt-4">
          <button className="text-sm text-brand">↩</button>
        </form>
      </main>
    );
  }
  const profile = await (await serverCaller()).me.profile();
  const t = await getTranslations('roles');
  return (
    <Shell operator={profile.operatorName} user={profile.displayName} role={t(profile.role)}>
      {children}
    </Shell>
  );
}
