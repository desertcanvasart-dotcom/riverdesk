import { v7, validate } from 'uuid';

/** UUID v7: time-ordered, so new rows land at the end of B-tree indexes. */
export function uuidv7(): string {
  return v7();
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && validate(value);
}
