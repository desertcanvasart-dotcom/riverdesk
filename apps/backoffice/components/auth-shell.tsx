import type { ReactNode } from 'react';
import { LocaleSwitch } from './locale-switch';

/** The narrow centred layout of the sign-in, password and MFA pages. */
export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <LocaleSwitch />
      </div>
      {children}
    </main>
  );
}
