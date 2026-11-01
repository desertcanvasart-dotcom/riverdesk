import { describe, expect, it } from 'vitest';
import { localPath } from '../lib/local-path';

describe('next after sign-in', () => {
  it('keeps a path on this site with its query and hash', () => {
    expect(localPath('/reset-password')).toBe('/reset-password');
    expect(localPath('/bookings?status=held#top')).toBe('/bookings?status=held#top');
  });

  it('refuses anything a browser would take to another site', () => {
    for (const next of [
      '//evil.com',
      '/\\evil.com',
      '/\\/evil.com',
      '/\t/evil.com',
      '/\n/evil.com',
      'https://evil.com',
      'javascript:alert(1)',
      'evil.com',
      '',
      null,
      undefined,
    ])
      expect(localPath(next), JSON.stringify(next)).toBeNull();
  });
});
