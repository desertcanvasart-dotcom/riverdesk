import { chromium, type Browser } from 'playwright';

/** One headless Chromium for the worker's lifetime; each document gets its own page. */
let browser: Promise<Browser> | undefined;

function getBrowser(): Promise<Browser> {
  browser ??= chromium.launch({ headless: true }).catch((error: unknown) => {
    browser = undefined;
    throw error;
  });
  return browser;
}

async function withPage<T>(
  html: string,
  fn: (page: import('playwright').Page) => Promise<T>,
): Promise<T> {
  const context = await (await getBrowser()).newContext({ javaScriptEnabled: false });
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
