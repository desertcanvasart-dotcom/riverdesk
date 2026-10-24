import { describe, expect, it } from 'vitest';
import type { ErrorEvent } from '@sentry/node';
import { scrubEvent } from '../src/tracking';

describe('error tracking scrubs personal data', () => {
  it('drops user, bodies, cookies and auth headers, and redacts passports in extra data', () => {
    const event = scrubEvent({
      type: undefined,
      user: { email: 'guest@example.test' },
      request: {
        data: '{"passport_number":"P123"}',
        cookies: { sb: 'x' },
        headers: { authorization: 'Bearer abc', 'user-agent': 'ua' },
        query_string: 'secret=1',
      },
      extra: { guest: { passport_number: 'P12345678', first_name: 'Mona' } },
    } as ErrorEvent);
    expect(event.user).toBeUndefined();
    expect(event.request).toEqual({ headers: { 'user-agent': 'ua' } });
    expect(JSON.stringify(event)).not.toContain('P12345678');
  });
});
