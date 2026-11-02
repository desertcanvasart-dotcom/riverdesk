import { afterAll, describe, expect, it } from 'vitest';
import { closeRenderer, currentBrowser, htmlToPdf } from '../src/documents/render';

describe('document renderer', () => {
  afterAll(async () => {
    await closeRenderer();
  });

  it('starts a new Chromium when the old one dies, instead of failing every document', async () => {
    const first = await htmlToPdf('<html><body><div class="sheet">one</div></body></html>');
    expect(first.subarray(0, 5).toString()).toBe('%PDF-');
    // What an out-of-memory kill looks like to the worker: the browser just goes away.
    const dying = await currentBrowser();
    await dying.close();
    const second = await htmlToPdf('<html><body><div class="sheet">two</div></body></html>');
    expect(second.subarray(0, 5).toString()).toBe('%PDF-');
    expect(await currentBrowser()).not.toBe(dying);
  }, 60_000);
});
