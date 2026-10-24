import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { Providers } from '../lib/trpc';
import './globals.css';

export const metadata = { title: 'Reservations · vessel-system' };
export const viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} dir={locale.startsWith('ar') ? 'rtl' : 'ltr'}>
      <body className="min-h-dvh antialiased">
        <NextIntlClientProvider messages={await getMessages()}>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
