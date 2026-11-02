import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger';
import { REDACTED, redactDeep, scrubErrorText } from '../src/redaction';

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

  it('catches check-in fields by the words in their names, not an exact list', () => {
    const out = redactDeep({
      visa_number: 'V1',
      visaType: 'e-visa',
      medical_notes: 'asthma',
      medical_ciphertext: 'xx',
      passport_country: 'EG',
      allergies: 'nuts',
      headers: { 'x-api-key': 'k', 'content-type': 'json' },
      dob: '1990-01-01',
      double: 2,
    });
    expect(out).toEqual({
      visa_number: REDACTED,
      visaType: REDACTED,
      medical_notes: REDACTED,
      medical_ciphertext: REDACTED,
      passport_country: REDACTED,
      allergies: REDACTED,
      headers: { 'x-api-key': REDACTED, 'content-type': 'json' },
      dob: REDACTED,
      double: 2,
    });
  });

  it('logs a database error without the values it quotes', () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const error = Object.assign(new Error('invalid input syntax for type uuid: "A24681357"'), {
      code: '22P02',
      detail: 'Key (email)=(hana@example.com) already exists.',
      where: 'PL/pgSQL function with "A24681357"',
    });
    createLogger('test', { level: 'info', destination }).error({ err: error }, 'failed');
    const line = lines.join('');
    expect(line).not.toMatch(/A24681357|hana@example\.com/);
    expect(line).toContain('22P02');
    expect(line).toContain('invalid input syntax for type uuid');
    expect(scrubErrorText('mail to hana@example.com failed')).toBe('mail to [email] failed');
  });
});
