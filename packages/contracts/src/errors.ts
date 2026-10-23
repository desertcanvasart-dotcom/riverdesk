/**
 * The error code catalogue. Codes are stable: clients (back office, channels) branch on them,
 * so a code is never renamed or reused. Add new codes at the end of a group.
 */
export const ERROR_CATALOGUE = {
  // Inventory and booking
  NOT_AVAILABLE: { status: 409, retryable: false, message: 'Not enough free cabins' },
  HOLD_EXPIRED: { status: 409, retryable: false, message: 'The hold has expired' },
  HOLD_NOT_ACTIVE: { status: 409, retryable: false, message: 'The hold is not active' },
  REVISION_CHANGED: { status: 409, retryable: false, message: 'The booking revision has changed' },
  STOP_SALE: { status: 409, retryable: false, message: 'Sales are stopped' },
  SAILING_CLOSED: { status: 409, retryable: false, message: 'The sailing is closed' },
  INVALID_STATE: { status: 409, retryable: false, message: 'Not allowed in the current state' },
  CAPACITY_CONFLICT: {
    status: 409,
    retryable: false,
    message: 'The change would go below existing commitments',
  },
  SCHEDULE_CONFLICT: {
    status: 409,
    retryable: false,
    message: 'The schedule change conflicts with other legs',
  },
  // Pricing and contracts
  INVALID_OCCUPANCY: { status: 422, retryable: false, message: 'Occupancy not allowed' },
  NO_RATE_FOR_SEASON: { status: 422, retryable: false, message: 'No rate for this season' },
  CONTRACT_FORBIDS: { status: 403, retryable: false, message: 'The channel contract forbids this' },
  QUOTE_EXPIRED: { status: 409, retryable: false, message: 'The quote has expired' },
  // Concurrency and idempotency
  RETRY_LATER: { status: 409, retryable: true, message: 'Busy; retry later' },
  IN_PROGRESS: { status: 409, retryable: true, message: 'A request with this key is in progress' },
  IDEMPOTENCY_KEY_REUSED: {
    status: 422,
    retryable: false,
    message: 'Idempotency key reused with a different body',
  },
  // Access and input
  UNAUTHENTICATED: { status: 401, retryable: false, message: 'Not authenticated' },
  FORBIDDEN: { status: 403, retryable: false, message: 'Not allowed' },
  NOT_FOUND: { status: 404, retryable: false, message: 'Not found' },
  VALIDATION_FAILED: { status: 400, retryable: false, message: 'Invalid input' },
  RATE_LIMITED: { status: 429, retryable: true, message: 'Too many requests' },
  // System
  INVARIANT_VIOLATION: { status: 500, retryable: false, message: 'Inventory invariant violated' },
  SERVICE_UNAVAILABLE: { status: 503, retryable: true, message: 'Service unavailable' },
  INTERNAL: { status: 500, retryable: false, message: 'Internal error' },
} as const satisfies Record<string, { status: number; retryable: boolean; message: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOGUE;

export const ERROR_CODES = Object.keys(ERROR_CATALOGUE) as ErrorCode[];

/** Base type for every expected failure. Anything else that is thrown is a bug (INTERNAL). */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    options: { message?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(options.message ?? ERROR_CATALOGUE[code].message, { cause: options.cause });
    this.name = 'DomainError';
    this.code = code;
    this.details = options.details;
  }

  get status(): number {
    return ERROR_CATALOGUE[this.code].status;
  }

  get retryable(): boolean {
    return ERROR_CATALOGUE[this.code].retryable;
  }

  /** The shape returned to clients. Never includes the cause or a stack. */
  toJSON(): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}

export function isDomainError(error: unknown, code?: ErrorCode): error is DomainError {
  return error instanceof DomainError && (code === undefined || error.code === code);
}
