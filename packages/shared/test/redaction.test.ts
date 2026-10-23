import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger';
import { REDACTED, redactDeep } from '../src/redaction';

describe('redaction (rule 9)', () => {
  it('redacts sensitive keys at any depth and in any naming style', () => {
    const input = {
      booking: {
        guests: [{ name: 'A', passport_number: 'X1234567', dateOfBirth: '1990-01-01' }],
        meta: { deep: { 'Passport-Number': 'Y7654321' } },
      },
      clientSecret: 's3cr3t',
      ok: 1,
    };
    const out = redactDeep(input);
    expect(out.booking.guests[0]).toEqual({
      name: 'A',
      passport_number: REDACTED,
      dateOfBirth: REDACTED,
    });
    expect(out.booking.meta.deep['Passport-Number']).toBe(REDACTED);
    expect(out.clientSecret).toBe(REDACTED);
    expect(out.ok).toBe(1);
    expect(input.booking.guests[0]!.passport_number).toBe('X1234567'); // input untouched
  });

  it('keeps passport numbers and tokens out of log lines', () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const logger = createLogger('test', { level: 'info', destination });
    logger.info(
      {
        guest: { passportNumber: 'P99887766', dob: '1985-03-03' },
        req: { headers: { authorization: 'Bearer abc.def' } },
      },
      'confirming booking',
    );
    const output = lines.join('');
    expect(output).toContain('confirming booking');
    expect(output).not.toContain('P99887766');
    expect(output).not.toContain('1985-03-03');
    expect(output).not.toContain('abc.def');
  });
});
