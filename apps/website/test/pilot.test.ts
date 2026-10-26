import { describe, expect, it } from 'vitest';
import { normaliseWhatsApp, parsePilot, validatePilot } from '../lib/pilot';

describe('pilot form', () => {
  it.each([
    ['01001234567', '+201001234567'],
    ['٠١٠٠ ١٢٣ ٤٥٦٧', '+201001234567'],
    ['00201001234567', '+201001234567'],
    ['201001234567', '+201001234567'],
    ['+44 7700 900123', '+447700900123'],
    ['(+49) 151-2345-6789', '+4915123456789'],
  ])('normalises %s to %s', (raw, e164) => {
    expect(normaliseWhatsApp(raw)).toBe(e164);
  });

  it.each(['', '1234', '0100123', 'not a number', '+0123456789'])('rejects %s', (raw) => {
    expect(normaliseWhatsApp(raw)).toBeNull();
  });

  it('requires name, company, vessels, WhatsApp and consent; the rest is optional', () => {
    expect(Object.keys(validatePilot(parsePilot({})))).toEqual([
      'fullName',
      'company',
      'vessels',
      'whatsapp',
      'consent',
    ]);
    const ok = parsePilot({
      fullName: 'Amr Said',
      company: 'Nile Co',
      vessels: 'MS Amira',
      whatsapp: '01001234567',
      consent: true,
    });
    expect(validatePilot(ok)).toEqual({});
    expect(validatePilot({ ...ok, email: 'nope' })).toEqual({ email: 'email' });
    expect(validatePilot({ ...ok, homePort: 'paris' })).toEqual({ homePort: 'required' });
  });
});
