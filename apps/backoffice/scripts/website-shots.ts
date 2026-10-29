/**
 * Screenshots for the public website (apps/website/public/screens/<locale>/): each back-office
 * screen at desktop width, plus Today on a phone. Demo company, local only.
 *   pnpm --filter @vs/backoffice website-shots [name…]   (names: only those screens, no phone)
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { BASE, signInAsDemoOwner } from './session';

const OUT = join(import.meta.dirname, '../../website/public/screens');

/** Website name → back-office path (and an optional step to show the interesting state). */
const SCREENS: [string, string, ((page: Page) => Promise<void>)?][] = [
  ['today', '/'],
  [
    'book',
    '/book',
    async (page) => {
      await page.locator('ul.grid li button:not([disabled])').first().click();
      await page.waitForSelector('text=US$');
    },
  ],
  ['booking', '/bookings/VS-26-00001'],
  ['requests', '/requests'],
  ['inventory', '/inventory'],
  ['fleet', '/fleet'],
  ['schedule', '/schedule'],
  ['rates', '/rates'],
  ['channels', '/channels'],
  ['payments', '/payments'],
  [
    'guests',
    '/guests',
    async (page) => {
      await page.locator('ul button').first().click();
      await page.waitForLoadState('networkidle');
      // The cabin map view: deck by deck, who is in each cabin.
      await page.locator('[role=group] button').nth(1).click();
      await page.waitForSelector('ul.grid > li');
      await page.waitForTimeout(500);
    },
  ],
  ['vacancy', '/vacancy'],
  ['settings', '/settings'],
  ['invoices', '/invoices'],
  ['statements', '/invoices/receivables'],
  [
    'analytics',
    '/analytics',
    async (page) => {
      // Revenue: by month and channel, with commission, invoiced and extras below.
      await page.getByRole('tab').nth(5).click();
      await page.locator('table').first().waitFor();
      await page.waitForTimeout(800);
    },
  ],
  [
    'checkin',
    '/checkin',
    async (page) => void (await page.locator('section.rounded-xl').first().waitFor()),
  ],
  [
    'folios',
    '/checkin',
    async (page) => {
      // The Folios tab, with the folio of a cabin that still has charges open.
      await page.locator('[role=tablist] button').nth(1).click();
      await page.locator('button.min-h-20').nth(1).click();
      await page.locator('dialog[open] li').first().waitFor();
      await page.waitForTimeout(400);
    },
  ],
  [
    'documents',
    '/bookings/VS-26-00001',
    async (page) => {
      // The booking's documents, in Arabic, English or both.
      const docs = page.locator('h2').filter({ hasText: /^(Documents|المستندات)$/ });
      await docs.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 140));
      await page.waitForTimeout(400);
    },
  ],
];
const only = process.argv.slice(2);

const browser = await chromium.launch();
try {
  for (const locale of ['ar', 'en'] as const) {
    mkdirSync(join(OUT, locale), { recursive: true });
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale });
    await desktop.addCookies([{ name: 'vs_locale', value: locale, url: BASE }]);
    const page = await desktop.newPage();
    await signInAsDemoOwner(page);
    for (const [name, path, prepare] of SCREENS) {
      if (only.length && !only.includes(name)) continue;
      await page.goto(`${BASE}${path}`);
      await page.waitForLoadState('networkidle');
      if (prepare) await prepare(page);
      await page.screenshot({
        path: join(OUT, locale, `desktop-${name}.jpg`),
        type: 'jpeg',
        quality: 78,
      });
      console.log(`${locale} desktop-${name}`);
    }
    if (only.length) {
      await desktop.close();
      continue;
    }
    const phone = await browser.newContext({
      viewport: { width: 390, height: 780 },
      deviceScaleFactor: 2,
      locale,
    });
    await phone.addCookies([
      { name: 'vs_locale', value: locale, url: BASE },
      ...(await desktop.cookies()),
    ]);
    const p = await phone.newPage();
    await p.goto(`${BASE}/`);
    await p.waitForLoadState('networkidle');
    await p.screenshot({ path: join(OUT, locale, 'phone-today.jpg'), type: 'jpeg', quality: 78 });
    await desktop.close();
    await phone.close();
  }
} finally {
  await browser.close();
}
