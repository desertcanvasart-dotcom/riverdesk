// Local end-to-end check of the email flows and the platform area (needs Mailpit and the dev
// server): create password → confirm → two-step setup → /platform → add company → forgot
// password → sign in again. Usage: pnpm platform:add-admin --email E, then
//   pnpm --filter @vs/backoffice exec tsx scripts/auth-flows.ts E screenshot.png [quick]
import { chromium } from 'playwright';
import { TOTP } from 'otpauth';
const BASE = 'http://localhost:3100';
const MAIL = 'http://127.0.0.1:55324';
const email = process.argv[2]!;
const T = { timeout: 120000 };
async function latestLink(subject: RegExp) {
  for (let i = 0; i < 60; i += 1) {
    const list = (await (
      await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
    ).json()) as { messages: { ID: string; Subject: string }[] };
    const msg = list.messages.find((m) => subject.test(m.Subject));
    if (msg) {
      const body = (await (await fetch(`${MAIL}/api/v1/message/${msg.ID}`)).json()) as {
        HTML: string;
      };
      return /href="([^"]+)"/.exec(body.HTML)![1]!.replaceAll('&amp;', '&');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no email ${subject}`);
}
const settle = async (page: import('playwright').Page) => {
  await page.waitForLoadState('networkidle', T);
  await page.waitForTimeout(1500);
};
const browser = await chromium.launch();
const context = await browser.newContext();
const english = () => context.addCookies([{ name: 'vs_locale', value: 'en', url: BASE }]);
await english();
const page = await context.newPage();
page.setDefaultTimeout(60000);
await page.goto(`${BASE}/platform`, T);
console.log('0. /platform while signed out →', new URL(page.url()).pathname);
await page.goto(`${BASE}/signup`, T);
await settle(page);
await page.fill('input[name=email]', email);
await page.fill('input[name=password]', 'first-password-123');
await page.fill('input[name=confirm]', 'first-password-123');
await page.click('button[type=submit]');
await page.waitForSelector(`text=${email}`, T);
console.log('1. create-password form sent; confirmation email requested');
await page.goto(await latestLink(/confirm/i), T);
await page.waitForURL((u) => u.pathname === '/mfa', T);
await settle(page);
const key = (await page.locator('code').first().textContent())!.replace(/\s/g, '');
console.log('2. email link signed in → two-step setup page, setup key shown');
const code = () => new TOTP({ secret: key, digits: 6, period: 30 }).generate();
await page.fill('input[name=code]', code());
await page.click('button[type=submit]');
await page.waitForURL((u) => u.pathname === '/platform', T);
await settle(page);
console.log('3. code accepted → platform area:', await page.locator('h1').textContent());
const slug = `flow-${Date.now().toString(36)}`;
const fillCompany = async () => {
  const add = page.locator('form:has(input[name=slug])');
  await add.locator('input[name=name]').fill('Flow Cruises');
  await add.locator('input[name=slug]').fill(slug);
  await add.locator('input[name=prefix]').fill('flw');
  await add.locator('input[name=ownerName]').fill('Flow Owner');
  await add.locator('input[name=ownerEmail]').fill(`owner-${slug}@example.test`);
  await add.locator('button[type=submit]').click();
};
await fillCompany();
await page.waitForSelector('text=Flow Cruises is ready', T);
console.log('4. company added; listed:', (await page.locator(`text=${slug}`).count()) > 0);
await fillCompany();
await page.waitForSelector('text=already used', T).catch(() => {});
console.log(
  '5. duplicate short name refused:',
  (await page.locator('text=already used').count()) > 0,
  '| typed values kept:',
  (await page.locator('form:has(input[name=slug]) input[name=ownerName]').inputValue()) ===
    'Flow Owner',
);
await page.screenshot({ path: process.argv[3]! });
if (process.argv[4] === 'quick') process.exit(0);
await context.clearCookies();
await english();
await page.goto(`${BASE}/forgot-password`, T);
await settle(page);
await page.fill('input[name=email]', email);
await page.click('button[type=submit]');
await page.waitForSelector(`text=${email}`, T);
await page.goto(await latestLink(/reset/i), T);
await page.waitForURL((u) => u.pathname === '/mfa', T);
await settle(page);
console.log('6a. reset link signed in → asks for the two-step code first');
await page.waitForTimeout(31000 - (Date.now() % 30000)); // a fresh 30-second code
await page.fill('input[name=code]', code());
await page.click('button[type=submit]');
await page.waitForURL((u) => u.pathname === '/reset-password', T);
await settle(page);
await page.fill('input[name=password]', 'second-password-456');
await page.fill('input[name=confirm]', 'second-password-456');
await page.click('button[type=submit]');
await page.waitForURL((u) => u.pathname !== '/reset-password', T);
console.log(
  '6b. code → new-password form → new password saved → went to',
  new URL(page.url()).pathname,
);
await context.clearCookies();
await english();
await page.goto(`${BASE}/login`, T);
await settle(page);
await page.fill('input[name=email]', email);
await page.fill('input[name=password]', 'first-password-123');
await page.click('button[type=submit]');
await page.waitForTimeout(4000);
console.log('7. old password refused (still on login):', new URL(page.url()).pathname === '/login');
await page.fill('input[name=password]', 'second-password-456');
await page.click('button[type=submit]');
await page.waitForURL((u) => u.pathname === '/mfa', T);
await settle(page);
await page.waitForTimeout(31000 - (Date.now() % 30000)); // a fresh 30-second code
await page.fill('input[name=code]', code());
await page.click('button[type=submit]');
await page.waitForURL((u) => u.pathname === '/platform', T);
console.log('8. new password + code → platform area again');
await page.goto(`${BASE}/auth/callback?code=bogus`, T);
console.log('9. a bad or used link →', new URL(page.url()).pathname + new URL(page.url()).search);
await browser.close();
