import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Config } from './config';

/**
 * Field-level encryption for passport numbers (rule 9): AES-256-GCM, a fresh 12-byte IV per
 * value, the key id as additional authenticated data. Layout: version(1) | iv(12) | tag(16) | ct.
 */
export interface FieldKey {
  id: string;
  key: Buffer;
}

export interface FieldKeyring {
  current: FieldKey;
  byId: Map<string, FieldKey>;
}

const VERSION = 1;

export function encryptField(plaintext: string, key: FieldKey): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.key, iv);
  cipher.setAAD(Buffer.from(key.id, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptField(blob: Buffer, keyId: string, keyring: FieldKeyring): string {
  const key = keyring.byId.get(keyId);
  if (!key) throw new Error(`Unknown field key ${keyId}`);
  if (blob[0] !== VERSION) throw new Error('Unknown ciphertext version');
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const decipher = createDecipheriv('aes-256-gcm', key.key, iv);
  decipher.setAAD(Buffer.from(key.id, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString('utf8');
}

/**
 * The current key (PASSPORT_KEY_ID / PASSPORT_KEY) plus earlier keys still needed to read old
 * values (PASSPORT_PREVIOUS_KEYS = "id:base64,id:base64").
 */
export function fieldKeyring(
  config: Pick<Config, 'PASSPORT_KEY_ID' | 'PASSPORT_KEY' | 'PASSPORT_PREVIOUS_KEYS'>,
): FieldKeyring {
  if (!config.PASSPORT_KEY_ID || !config.PASSPORT_KEY)
    throw new Error('Missing configuration: PASSPORT_KEY_ID, PASSPORT_KEY');
  const current = { id: config.PASSPORT_KEY_ID, key: Buffer.from(config.PASSPORT_KEY, 'base64') };
  const byId = new Map([[current.id, current]]);
  for (const entry of (config.PASSPORT_PREVIOUS_KEYS ?? '').split(',').filter(Boolean)) {
    const [id, value] = entry.split(':');
    if (id && value) byId.set(id, { id, key: Buffer.from(value, 'base64') });
  }
  return { current, byId };
}

/** Keyed fingerprint to compare two values without storing either (never persisted). */
export function fieldFingerprint(plaintext: string, key: FieldKey): string {
  return createHash('sha256').update(key.key).update(plaintext.normalize('NFKC')).digest('hex');
}
