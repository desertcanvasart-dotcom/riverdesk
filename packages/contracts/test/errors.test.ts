import { describe, expect, it } from 'vitest';
import { DomainError, ERROR_CATALOGUE, ERROR_CODES, isDomainError } from '../src/index';

describe('error catalogue', () => {
  it('contains the codes the spec and prompt name', () => {
    for (const code of [
      'NOT_AVAILABLE',
      'HOLD_EXPIRED',
      'REVISION_CHANGED',
      'RETRY_LATER',
      'CONTRACT_FORBIDS',
      'INVALID_OCCUPANCY',
      'NO_RATE_FOR_SEASON',
      'SAILING_CLOSED',
      'IN_PROGRESS',
    ]) {
      expect(ERROR_CODES).toContain(code);
    }
  });

  it('gives every code an HTTP status in the 4xx or 5xx range', () => {
    for (const entry of Object.values(ERROR_CATALOGUE)) {
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.status).toBeLessThan(600);
    }
  });

  it('serialises without the cause', () => {
    const error = new DomainError('RETRY_LATER', {
      cause: new Error('deadlock'),
      details: { n: 1 },
    });
    expect(error.toJSON()).toEqual({
      code: 'RETRY_LATER',
      message: 'Busy; retry later',
      details: { n: 1 },
    });
    expect(error.status).toBe(409);
    expect(error.retryable).toBe(true);
    expect(isDomainError(error, 'RETRY_LATER')).toBe(true);
    expect(isDomainError(error, 'NOT_FOUND')).toBe(false);
  });
});
