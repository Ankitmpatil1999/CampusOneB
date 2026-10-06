import type { Principal } from '../utils/principal';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by the correlation-id middleware for every request. */
    correlationId: string;
    /** Set by `authenticate` when a valid access token is presented. */
    principal?: Principal;
    /** How the access token arrived: web cookie (CSRF checked on writes) or Bearer header. */
    authVia?: 'cookie' | 'bearer';
    /** Raw body bytes, kept only for signed partner webhooks (HMAC verification). */
    rawBody?: Buffer;
  }
}

export {};
