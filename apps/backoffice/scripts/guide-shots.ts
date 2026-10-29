/**
 * Step screenshots for the website's how-to guides (apps/website/public/screens/<locale>/
 * guide-*.jpg): dialogs opened and filled with sample values, never saved, so the demo company
 * stays as it is. Demo company, local only.
 *   pnpm --filter @vs/backoffice guide-shots
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { BASE, signInAsDemoOwner } from './session';

const OUT = join(import.meta.dirname, '../../website/public/screens');
type Messages = Record<string, Record<string, string>>;

/** Guide name → how to reach the state worth showing. `m` holds the screen's own labels. */
const SHOTS: [string, (page: Page, m: Messages) => Promise<void>][] = [
  ['getting-started', async (page) => void (await page.goto(`${BASE}/`))],
  [
    'add-ship',
    async (page, m) => {
      await page.goto(`${BASE}/fleet`);
      await page.getByRole('button', { name: `+ ${m.fleet!.addShip}` }).click();
      const d = page.locator('dialog');
      await d.locator('input[name=name]').fill('MS Nile Pearl');
      await d.locator('input[name=code]').fill('PEARL');
      await d.locator('input[name=maxGuests]').fill('64');
    },
  ],
  [
    'add-category',
    async (page, m) => {
      await page.goto(`${BASE}/fleet`);
      await page.getByRole('button', { name: `+ ${m.fleet!.addCategory}` }).click();
      const d = page.locator('dialog');
      await d.locator('input[name=nameEn]').fill('Deluxe River View');
      await d.locator('input[name=nameAr]').fill('ديلوكس بإطلالة نيلية');
      await d.locator('input[name=code]').fill('DLX');
      await d
        .locator('label')
        .filter({ has: page.locator('input[name=deck]') })
        .locator('select')
        .selectOption('Upper');
      await d
        .locator('label')
        .filter({ has: page.locator('input[name=view]') })
        .locator('select')
        .selectOption('River view');
      await d
        .locator('label')
        .filter({ has: page.locator('input[name=bedConfig]') })
        .locator('select')
        .selectOption('Twin or double');
    },
  ],
  [
    'add-cabins',
    async (page, m) => {
      await page.goto(`${BASE}/fleet`);
      await page.getByRole('button', { name: `+ ${m.inventory!.addCabins}` }).click();
      const d = page.locator('dialog');
      await d.locator('input[placeholder="101-120, 201"]').fill('201-212');
      await d.locator('select').last().selectOption({ index: 1 });
    },
  ],
  [
    'route',
    async (page, m) => {
      await page.goto(`${BASE}/schedule`);
      await page.getByRole('button', { name: `+ ${m.routes!.addRoute}` }).click();
      const d = page.locator('dialog');
      await d.locator('input').first().fill('Luxor ⇄ Aswan weekly');
      const rows = d.locator('tbody tr');
      await rows.nth(0).locator('select').selectOption({ label: m.__ports!.LXR! });
      await d.getByRole('button', { name: `+ ${m.routes!.addStop}` }).click();
      await d.getByRole('button', { name: `+ ${m.routes!.addStop}` }).click();
      await rows.nth(1).locator('select').selectOption({ label: m.__ports!.EDF! });
      await rows.nth(1).locator('input[type=number]').fill('2');
      await rows.nth(2).locator('select').selectOption({ label: m.__ports!.ASW! });
      await rows.nth(2).locator('input[type=number]').fill('4');
      await rows.nth(2).locator('input[type=checkbox]').check();
    },
  ],
  [
    'itinerary',
    async (page, m) => {
      await page.goto(`${BASE}/schedule`);
      await page
        .getByRole('button', { name: `+ ${m.routes!.addItinerary}` })
        .first()
        .click();
    },
  ],
  ['schedule', async (page) => void (await page.goto(`${BASE}/schedule`))],
  [
    'seasons',
    async (page, m) => {
      await page.goto(`${BASE}/rates`);
      await page.locator(`h2:text-is("${m.policies!.seasons}")`).scrollIntoViewIfNeeded();
    },
  ],
  [
    'plan',
    async (page, m) => {
      await page.goto(`${BASE}/rates`);
      await page.getByRole('button', { name: `+ ${m.rates!.newPlan}` }).click();
      const d = page.locator('dialog');
      await d.locator('input').nth(0).fill('Gulf (SAR)');
      await d.locator('input').nth(1).fill('GCC');
    },
  ],
  ['prices', async (page) => void (await page.goto(`${BASE}/rates`))],
  [
    'book-filled',
    async (page, m) => {
      await page.goto(`${BASE}/book`);
      await page.locator('ul.grid li button:not([disabled])').first().click();
      await page.waitForSelector('text=US$');
      const first = page.locator(`label:has-text("${m.book!.firstName}") input`).first();
      await first.fill('Sara');
      await page.locator(`label:has-text("${m.book!.lastName}") input`).first().fill('Mansour');
    },
  ],
  ['requests', async (page) => void (await page.goto(`${BASE}/requests`))],
  [
    'request-offer',
    async (page, m) => {
      await page.goto(`${BASE}/requests`);
      await page.getByRole('button', { name: m.requests!.offer }).first().click();
    },
  ],
  ['booking', async (page) => void (await page.goto(`${BASE}/bookings/VS-26-00001`))],
  [
    'payment',
    async (page, m) => {
      await page.goto(`${BASE}/bookings/VS-26-00008`);
      await page.getByRole('button', { name: m.payments!.record }).first().click();
    },
  ],
  [
    'amend',
    async (page, m) => {
      await page.goto(`${BASE}/bookings/VS-26-00001`);
      await page.getByRole('button', { name: m.bookings!.amend }).click();
    },
  ],
  [
    'cancel',
    async (page, m) => {
      await page.goto(`${BASE}/bookings/VS-26-00001`);
      await page.getByRole('button', { name: m.bookings!.cancel }).click();
    },
  ],
  [
    'cabin-map',
    async (page) => {
      await page.goto(`${BASE}/guests`);
      await page.locator('ul button').first().click();
      await page.locator('[role=group] button').nth(1).click();
      await page.waitForSelector('ul.grid > li');
    },
  ],
  [
    'manifest',
    async (page) => {
      await page.goto(`${BASE}/guests`);
      await page.locator('ul button').first().click();
    },
  ],
  ['channels', async (page) => void (await page.goto(`${BASE}/channels`))],
  [
    'contract',
    async (page, m) => {
      await page.goto(`${BASE}/channels`);
      await page
        .getByRole('button', { name: `+ ${m.channels!.newContract}` })
        .first()
        .click();
    },
  ],
  [
    'schedule-change',
    async (page, m) => {
      await page.goto(`${BASE}/schedule`);
      await page.locator('ul li input[type=checkbox]:not([disabled])').first().check();
      await page.getByRole('button', { name: m.schedule!.cancel }).click();
      const d = page.locator('dialog');
      await d.locator('select').first().selectOption({ index: 1 });
      await d.getByRole('button', { name: m.schedule!.preview }).click();
      await page.waitForTimeout(1500);
    },
  ],
  [
    'emergency',
    async (page, m) => {
      await page.goto(`${BASE}/inventory`);
      await page.locator('input[type=checkbox]').first().check();
      await page.getByRole('button', { name: m.inventory!.emergency }).click();
    },
  ],
  ['vacancy', async (page) => void (await page.goto(`${BASE}/vacancy`))],
  [
    'markets',
    async (page, m) => {
      await page.goto(`${BASE}/settings`);
      await page.locator(`h2:text-is("${m.markets!.title}")`).scrollIntoViewIfNeeded();
    },
  ],
  [
    'analytics',
    async (page) => {
      await page.goto(`${BASE}/analytics`);
      await page.locator('section.rounded-xl').first().waitFor();
      await page.waitForTimeout(600);
    },
  ],
  [
    'analytics-occupancy',
    async (page, m) => {
      await page.goto(`${BASE}/analytics`);
      await page.getByRole('tab', { name: m.analytics!.tab_occupancy }).click();
      await page.locator('table').first().waitFor();
      await page.waitForTimeout(800);
    },
  ],
  [
    'analytics-channels',
    async (page, m) => {
      await page.goto(`${BASE}/analytics`);
      await page.getByRole('tab', { name: m.analytics!.tab_channels }).click();
      await page.locator('table').first().waitFor();
      await page.waitForTimeout(800);
    },
  ],
  [
    'analytics-cash',
    async (page, m) => {
      await page.goto(`${BASE}/analytics`);
      await page.getByRole('tab', { name: m.analytics!.tab_cash }).click();
      await page.locator('table').first().waitFor();
      await page.waitForTimeout(800);
    },
  ],
  [
    'checkin',
    async (page) => {
      await page.goto(`${BASE}/checkin`);
      await page.locator('section.rounded-xl').first().waitFor();
      await page.waitForTimeout(600);
    },
  ],
  [
    'branding',
    async (page, m) => {
      await page.goto(`${BASE}/settings`);
      const title = page.locator(`h2:text-is("${m.branding!.title}")`);
      // Below the sticky top bar.
      await title.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 72));
      // Wait for the preview frame to hold the rendered voucher.
      await page.waitForFunction(
        () => (document.querySelector('iframe') as HTMLIFrameElement | null)?.srcdoc.length,
      );
      await page.waitForTimeout(800);
    },
  ],
  // Invoicing (F1–F5): the demo company's sample invoices, receipts and credit note.
  [
    'invoices',
    async (page) => {
      await page.goto(`${BASE}/invoices`);
      await page.locator('table').first().waitFor();
    },
  ],
  [
    'invoice',
    async (page) => {
      await page.goto(`${BASE}/invoices`);
      await page
        .getByRole('row')
        .filter({ hasText: 'Cairo Travel' })
        .getByRole('link')
        .first()
        .click();
      await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/);
      await page.locator('section.rounded-xl').nth(2).waitFor();
    },
  ],
  [
    'record-receipt',
    async (page, m) => {
      await page.goto(`${BASE}/payments/receipts`);
      await page.getByRole('button', { name: m.receipts!.record, exact: true }).click();
      const d = page.locator('dialog');
      await d.locator('select').first().selectOption({ label: 'Cairo Travel (agent)' });
      await d.getByText(m.receipts!.allocateTo!).waitFor();
      await d.locator('input[inputmode=decimal]').first().fill('500');
      await d.locator('input[dir=ltr]').nth(1).fill('SWIFT 7790-CT');
      await page.waitForTimeout(400);
    },
  ],
  [
    'receipts',
    async (page) => {
      await page.goto(`${BASE}/payments/receipts`);
      await page.locator('table').first().waitFor();
    },
  ],
  [
    'receipt',
    async (page) => {
      await page.goto(`${BASE}/payments/receipts`);
      await page
        .getByRole('row')
        .filter({ hasText: 'Cairo Travel' })
        .getByRole('link')
        .first()
        .click();
      await page.waitForURL(/\/payments\/receipts\/[0-9a-f-]{36}$/);
      await page.locator('table').first().waitFor();
    },
  ],
  [
    'statement',
    async (page) => {
      await page.goto(`${BASE}/invoices/statements`);
      await page.locator('select').first().selectOption({ label: 'Cairo Travel (agent)' });
      await page.locator('table').first().waitFor();
    },
  ],
  [
    'aging',
    async (page) => {
      await page.goto(`${BASE}/invoices/receivables`);
      await page.locator('table').first().waitFor();
    },
  ],
  [
    'finance-reports',
    async (page) => {
      await page.goto(`${BASE}/invoices/reports`);
      await page.locator('table').first().waitFor();
    },
  ],
  [
    'account-codes',
    async (page, m) => {
      await page.goto(`${BASE}/invoices/settings`);
      const title = page.locator(`h2:text-is("${m.financeReports!.codesTitle}")`);
      await title.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 72));
    },
  ],
];

const only = process.argv[2];
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'ar'] as const) {
    mkdirSync(join(OUT, locale), { recursive: true });
    const m = JSON.parse(
      readFileSync(join(import.meta.dirname, `../messages/${locale}.json`), 'utf8'),
    ) as Messages;
    m.__ports =
      locale === 'ar'
        ? { LXR: 'الأقصر', EDF: 'إدفو', ASW: 'أسوان' }
        : { LXR: 'Luxor', EDF: 'Edfu', ASW: 'Aswan' };
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale });
    await context.addCookies([{ name: 'vs_locale', value: locale, url: BASE }]);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await signInAsDemoOwner(page);
    for (const [name, reach] of SHOTS) {
      if (only && name !== only) continue;
      try {
        await reach(page, m);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(600);
        await page.screenshot({
          path: join(OUT, locale, `guide-${name}.jpg`),
          type: 'jpeg',
          quality: 80,
        });
        console.log(`${locale} guide-${name}`);
      } catch (error) {
        console.log(`${locale} guide-${name} FAILED: ${(error as Error).message.split('\n')[0]}`);
      }
      await page.keyboard.press('Escape').catch(() => {});
    }
    await context.close();
  }
} finally {
  await browser.close();
}
