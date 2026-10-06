/**
 * Typed errors (brief §7.1). `CustomAPIError` stays the base class as in the reference
 * (`CustomAPIError(statusCode, message, data)`); here the "message" is the message register key
 * returned as `code`, and the user-facing text comes from the register (docs/01 §4).
 */
import type { FieldError } from './validators';
import type { MessageKey } from '../config/registers';
import type { ProblemExtensions } from './apiResponse';

export interface ApiErrorOptions {
  /** Placeholder values for the message text. */
  readonly params?: Readonly<Record<string, string | number>>;
  /** Field errors (problem+json `errors[]`). */
  readonly errors?: readonly FieldError[];
  /** Extra response headers (e.g. Retry-After). */
  readonly headers?: Readonly<Record<string, string>>;
  /** RFC 9457 extension members (e.g. the payment engine's check and stage). */
  readonly extensions?: ProblemExtensions;
  readonly cause?: unknown;
}

export class CustomAPIError extends Error {
  readonly params: Readonly<Record<string, string | number>>;
  readonly errors: readonly FieldError[];
  readonly headers: Readonly<Record<string, string>>;
  readonly extensions: ProblemExtensions;

  constructor(
    readonly statusCode: number,
    readonly code: MessageKey,
    opts: ApiErrorOptions = {},
  ) {
    super(code, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    this.params = opts.params ?? {};
    this.errors = opts.errors ?? [];
    this.headers = opts.headers ?? {};
    this.extensions = opts.extensions ?? {};
  }
}

export class BadRequestError extends CustomAPIError {
  constructor(code: MessageKey = 'GEN.BAD_REQUEST', opts?: ApiErrorOptions) {
    super(400, code, opts);
  }
}

export class ValidationError extends CustomAPIError {
  constructor(errors: readonly FieldError[], opts: Omit<ApiErrorOptions, 'errors'> = {}) {
    super(422, 'VALIDATION.FAILED', { ...opts, errors });
  }
}

export class AuthenticationError extends CustomAPIError {
  constructor(opts?: ApiErrorOptions) {
    super(401, 'AUTH.UNAUTHENTICATED', opts);
  }
}

export class AuthorizationError extends CustomAPIError {
  constructor(code: MessageKey = 'AUTH.FORBIDDEN', opts?: ApiErrorOptions) {
    super(403, code, opts);
  }
}

/** Also used for another tenant's ids: they are reported as not found (golden rule). */
export class NotFoundError extends CustomAPIError {
  constructor(code: MessageKey = 'GEN.NOT_FOUND', opts?: ApiErrorOptions) {
    super(404, code, opts);
  }
}

export class ConflictError extends CustomAPIError {
  constructor(code: MessageKey, opts?: ApiErrorOptions) {
    super(409, code, opts);
  }
}

export class PreconditionFailedError extends CustomAPIError {
  constructor(opts?: ApiErrorOptions) {
    super(412, 'GEN.CONFLICT_VERSION', opts);
  }
}

export class PayloadTooLargeError extends CustomAPIError {
  constructor(code: MessageKey = 'GEN.PAYLOAD_TOO_LARGE', opts?: ApiErrorOptions) {
    super(413, code, opts);
  }
}

export class UnsupportedMediaTypeError extends CustomAPIError {
  constructor(opts?: ApiErrorOptions) {
    super(415, 'GEN.UNSUPPORTED_MEDIA_TYPE', opts);
  }
}

export class RateLimitError extends CustomAPIError {
  constructor(retryAfterSeconds: number) {
    super(429, 'GEN.RATE_LIMITED', { headers: { 'Retry-After': String(retryAfterSeconds) } });
  }
}

export class ServiceUnavailableError extends CustomAPIError {
  constructor(retryAfterSeconds = 30) {
    super(503, 'GEN.UNAVAILABLE', { headers: { 'Retry-After': String(retryAfterSeconds) } });
  }
}

export class InternalError extends CustomAPIError {
  constructor(cause?: unknown) {
    super(500, 'GEN.INTERNAL', { cause });
  }
}
