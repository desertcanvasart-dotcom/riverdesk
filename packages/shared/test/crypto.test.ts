import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptField, encryptField, fieldKeyring } from '../src/crypto';

describe('passport field encryption', () => {
  const k1 = randomBytes(32).toString('base64');
  const k2 = randomBytes(32).toString('base64');

  it('round-trips, with a fresh IV each time', () => {
    const ring = fieldKeyring({ PASSPORT_KEY_ID: 'k1', PASSPORT_KEY: k1 });
    const a = encryptField('A12345678', ring.current);
    const b = encryptField('A12345678', ring.current);
    expect(a.equals(b)).toBe(false);
    expect(a.toString('latin1')).not.toContain('A12345678');
    expect(decryptField(a, 'k1', ring)).toBe('A12345678');
  });

  it('reads values written under a previous key after rotation', () => {
    const old = fieldKeyring({ PASSPORT_KEY_ID: 'k1', PASSPORT_KEY: k1 });
    const blob = encryptField('B7654321', old.current);
    const rotated = fieldKeyring({
      PASSPORT_KEY_ID: 'k2',
      PASSPORT_KEY: k2,
      PASSPORT_PREVIOUS_KEYS: `k1:${k1}`,
    });
    expect(decryptField(blob, 'k1', rotated)).toBe('B7654321');
  });

  it('rejects tampering and a wrong key id', () => {
    const ring = fieldKeyring({ PASSPORT_KEY_ID: 'k1', PASSPORT_KEY: k1 });
    const blob = encryptField('C1', ring.current);
    blob.writeUInt8(blob.readUInt8(blob.length - 1) ^ 1, blob.length - 1);
    expect(() => decryptField(blob, 'k1', ring)).toThrow();
    expect(() => decryptField(encryptField('C1', ring.current), 'nope', ring)).toThrow(
      'Unknown field key',
    );
  });
});
