/**
 * Usability check (spec: a phone booking in under 60 seconds). Plays a staff member taking a
 * booking on the phone at 375 px in Arabic, at human pace: ~1 s before each tap, typing at ~8
 * characters a second. Creates a real booking for the local demo company.
 *   pnpm --filter @vs/backoffice usability
 */
import { chromium } from 'playwright';
import { BASE, signInAsDemoOwner } from './session';

const THINK_MS = 1_000;
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await context.addCookies([{ name: 'vs_locale', value: 'ar', url: BASE }]);
  const page = await context.newPage();
  await signInAsDemoOwner(page);
  let taps = 0;
  const tap = async (selector: string) => {
    await page.waitForTimeout(THINK_MS);
    await page.locator(selector).first().click();
    taps += 1;
  };
  const type = async (selector: string, text: string) => {
    await tap(selector);
    await page.keyboard.type(text, { delay: 125 });
  };

  const started = Date.now();
  await page.goto(`${BASE}/book`);
  await page.waitForSelector('text=LXR-4');
  await tap('button:has-text("LXR-4")'); // itinerary chip
  await tap('ul.grid li button:not([disabled])'); // first sailing with room
  await page.waitForSelector('text=US$', { timeout: 15_000 }); // the live price
  await type('#book-summary input >> nth=0', 'Nour');
  await type('#book-summary input >> nth=1', 'Ibrahim');
  await type('#book-summary input >> nth=2', 'EG');
  await tap('#book-summary button[type=submit]');
  await page.waitForURL(/\/bookings\/[A-Z]+-\d{2}-\d{5}$/, { timeout: 15_000 });
  const seconds = (Date.now() - started) / 1000;
  const ref = page.url().split('/').at(-1);
  console.log(`Booked ${ref} in ${seconds.toFixed(1)} s (${taps} taps, 17 characters typed)`);
  if (seconds >= 60) process.exitCode = 1;
} finally {
  await browser.close();
}
