import type { ReactNode } from 'react';

export const metadata = { title: 'vessel-system back office' };

// Arabic first (RTL); full i18n with next-intl arrives in Batch 6.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: 16 }}>
        {children}
      </body>
    </html>
  );
}
