import type { ReactNode } from 'react';
import { Tajawal } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { Providers } from '../lib/trpc';
import './globals.css';

const tajawal = Tajawal({
  subsets: ['arabic', 'latin'],
  weight: ['400', '500', '700', '800'],
  variable: '--font-tajawal',
  display: 'swap',
});

export const metadata = { title: 'Riverdesk' };
export const viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} dir={locale.startsWith('ar') ? 'rtl' : 'ltr'} className={tajawal.variable}>
      <body className="min-h-dvh antialiased">
        <NextIntlClientProvider messages={await getMessages()}>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
