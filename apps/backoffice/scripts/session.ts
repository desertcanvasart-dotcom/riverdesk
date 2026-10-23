import { TOTP } from 'otpauth';
import type { Page } from 'playwright';
import { loadConfig } from '@vs/shared';

export const BASE = process.env.BASE_URL ?? 'http://localhost:3100';

/** Signs in as the local demo owner (password and TOTP from the seed). Local only. */
export async function signInAsDemoOwner(page: Page) {
  const config = loadConfig();
  if (config.VS_ENV === 'hosted') throw new Error('Local demo company only');
  const secret = config.SEED_TOTP_SECRET;
  if (!secret) throw new Error('SEED_TOTP_SECRET is not set');
  await page.goto(`${BASE}/login`);
  await page.fill('input[name=email]', 'owner@demo.local');
  await page.fill('input[name=password]', 'demo-password-123');
  await page.click('button[type=submit]');
  await page.waitForURL(/\/mfa$/);
  await page.fill(
    'input[inputmode=numeric]',
    new TOTP({ secret, digits: 6, period: 30 }).generate(),
  );
  await page.click('button[type=submit]');
  await page.waitForURL((url) => !url.pathname.startsWith('/mfa'));
}
