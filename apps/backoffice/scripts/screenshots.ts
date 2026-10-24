/**
 * Screenshots of every back-office screen in Arabic and English at phone width (375 px), signed
 * in as the demo owner (TOTP from SEED_TOTP_SECRET, local only). Also fails on any page that
 * scrolls sideways. Output: docs/screenshots/batch-6/<locale>/<screen>.png (not committed).
 *   pnpm --filter @vs/backoffice screenshots
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { BASE, signInAsDemoOwner } from './session';
const OUT = join(import.meta.dirname, '../../../docs/screenshots/batch-6');

const screens: [string, string][] = [
  ['01-today', '/'],
  ['02-new-booking', '/book'],
  ['03-bookings', '/bookings'],
  ['04-booking', '/bookings/VS-26-00001'],
  ['05-requests', '/requests'],
  ['06-inventory', '/inventory'],
  ['07-schedule', '/schedule'],
  ['08-rates', '/rates'],
  ['09-channels', '/channels'],
  ['10-payments', '/payments'],
  ['11-guests', '/guests'],
  ['12-vacancy', '/vacancy'],
  ['13-settings', '/settings'],
  ['14-pilot', '/pilot'],
];

const browser = await chromium.launch();
const problems: string[] = [];
try {
  for (const locale of ['ar', 'en'] as const) {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, locale });
    await context.addCookies([{ name: 'vs_locale', value: locale, url: BASE }]);
    const page = await context.newPage();
    mkdirSync(join(OUT, locale), { recursive: true });
    await page.goto(`${BASE}/login`);
    await page.screenshot({ path: join(OUT, locale, '00-login.png'), fullPage: true });
    await signInAsDemoOwner(page);
    for (const [name, path] of screens) {
      await page.goto(`${BASE}${path}`);
      await page.waitForLoadState('networkidle');
      if (name === '11-guests') {
        // Open the first departure that has guests, so the screen shows a manifest.
        const first = page.locator('ul button').first();
        if (await first.count()) {
          await first.click();
          await page.waitForLoadState('networkidle');
        }
      }
      const { scroll, client, dir } = (await page.evaluate(
        '({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, dir: document.documentElement.dir })',
      )) as { scroll: number; client: number; dir: string };
      if (scroll > client)
        problems.push(`${locale} ${path}: page is ${scroll}px wide in a ${client}px viewport`);
      if (dir !== (locale === 'ar' ? 'rtl' : 'ltr')) problems.push(`${locale} ${path}: dir=${dir}`);
      await page.screenshot({ path: join(OUT, locale, `${name}.png`), fullPage: true });
      console.log(`${locale} ${name}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`All screens fit 375 px in both languages. Screenshots in ${OUT}`);
