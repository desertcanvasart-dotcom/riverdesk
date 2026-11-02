import { chromium, type Browser } from 'playwright';
import { createLogger } from '@vs/shared';

const logger = createLogger('renderer');

/**
 * One headless Chromium shared by the worker; each document gets its own page. If it dies (out of
 * memory, a crash) it is forgotten and the next document launches a new one.
 */
let browser: Promise<Browser> | undefined;

function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  const launching: Promise<Browser> = launchChromium().then(
    (launched) => {
      launched.on('disconnected', () => {
        if (browser === launching) browser = undefined;
      });
      return launched;
    },
    (error: unknown) => {
      if (browser === launching) browser = undefined;
      throw error;
    },
  );
  browser = launching;
  return launching;
}

/**
 * Chromium's own sandbox on (the worker runs as a non-root user). Where the host does not allow
 * it (no user namespaces in the container), it starts without and says so; JavaScript and the
 * network stay off for every document either way.
 */
let sandboxRefused = false;
async function launchChromium(): Promise<Browser> {
  if (!sandboxRefused) {
    try {
      return await chromium.launch({ headless: true, chromiumSandbox: true });
    } catch (error) {
      sandboxRefused = true;
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      logger.warn({ reason }, 'Chromium sandbox unavailable on this host; rendering without it');
    }
  }
  return chromium.launch({ headless: true });
}

/** Test hook: the browser the next document would use. */
export function currentBrowser(): Promise<Browser> {
  return getBrowser();
}

async function withPage<T>(
  html: string,
  fn: (page: import('playwright').Page) => Promise<T>,
): Promise<T> {
  let context: import('playwright').BrowserContext;
  try {
    context = await (await getBrowser()).newContext({ javaScriptEnabled: false });
  } catch {
    // The browser died between documents: start a new one, once.
    browser = undefined;
    context = await (await getBrowser()).newContext({ javaScriptEnabled: false });
  }
  try {
    const page = await context.newPage();
    // Documents are self-contained (fonts embedded): nothing may be fetched while rendering.
    await page.route('**/*', (route) =>
      route.request().url().startsWith('data:') ? route.continue() : route.abort(),
    );
    await page.setContent(html, { waitUntil: 'load' });
    // Runs in the page (browser globals), not in Node.
    await page.evaluate('document.fonts.ready.then(() => true)');
    return await fn(page);
  } finally {
    await context.close();
  }
}

export function htmlToPdf(html: string): Promise<Buffer> {
  return withPage(html, (page) => page.pdf({ preferCSSPageSize: true, printBackground: true }));
}

export function htmlToPng(html: string): Promise<Buffer> {
  return withPage(html, async (page) => {
    await page.setViewportSize({ width: 1240, height: 800 });
    return page.locator('.sheet').screenshot({ type: 'png' });
  });
}

export async function closeRenderer(): Promise<void> {
  const current = browser;
  browser = undefined;
  if (current) await (await current.catch(() => null))?.close();
}
