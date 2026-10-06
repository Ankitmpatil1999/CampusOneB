/**
 * Access-token verification (ADR-0011): ES256 JWTs with `kid`, verified against public keys only.
 * Two key sets: the default set may carry every audience except `ops`; the back-office set may
 * carry only `ops`. A token signed with one set and claiming the other's audience is refused.
 */
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from 'jose';
import { z } from 'zod';
import { SURFACES, type Principal, type Surface } from './principal';

export interface TokenVerifier {
  verify(token: string): Promise<Principal>;
}

const claimsSchema = z.object({
  sub: z.string().min(1),
  aud: z.union([z.enum(SURFACES as [Surface, ...Surface[]]), z.array(z.string()).length(1)]),
  sid: z.string().min(1),
  ins: z.string().optional(),
  prf: z.string().optional(),
  st: z.array(z.string().regex(/^[a-z0-9-]+\.[a-z0-9-]+$/)).default([]),
});

export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidTokenError';
  }
}

export interface TokenVerifierOptions {
  readonly issuer: string;
  /** Public keys of the default set (member, console, portal, terminal, partner). */
  readonly jwks: JSONWebKeySet;
  /** Public keys of the back-office set (`ops` only). */
  readonly opsJwks?: JSONWebKeySet;
}

const kidsOf = (set?: JSONWebKeySet) =>
  new Set((set?.keys ?? []).map((k) => k.kid).filter(Boolean));

export function createTokenVerifier(opts: TokenVerifierOptions): TokenVerifier {
  const defaultKeys = createLocalJWKSet(opts.jwks);
  const opsKeys = opts.opsJwks ? createLocalJWKSet(opts.opsJwks) : undefined;
  const defaultKids = kidsOf(opts.jwks);
  const opsKids = kidsOf(opts.opsJwks);
  const defaultAudiences = SURFACES.filter((s) => s !== 'ops');

  return {
    async verify(token: string): Promise<Principal> {
      let kid: string | undefined;
      try {
        kid = decodeProtectedHeader(token).kid;
      } catch {
        throw new InvalidTokenError('malformed');
      }
      const isOps = kid !== undefined && opsKids.has(kid);
      if (!isOps && (kid === undefined || !defaultKids.has(kid))) {
        throw new InvalidTokenError('unknown_kid');
      }
      const keys = isOps ? opsKeys : defaultKeys;
      if (!keys) throw new InvalidTokenError('unknown_kid');
      let payload: unknown;
      try {
        ({ payload } = await jwtVerify(token, keys, {
          issuer: opts.issuer,
          algorithms: ['ES256'],
          audience: isOps ? ['ops'] : [...defaultAudiences],
          clockTolerance: 5,
          requiredClaims: ['sub', 'aud', 'exp', 'iat', 'sid'],
        }));
      } catch (e) {
        throw new InvalidTokenError(e instanceof Error ? e.name : 'verify_failed');
      }
      const claims = claimsSchema.safeParse(payload);
      if (!claims.success) throw new InvalidTokenError('claims_invalid');
      const c = claims.data;
      const surface = (Array.isArray(c.aud) ? c.aud[0] : c.aud) as Surface;
      if (!SURFACES.includes(surface)) throw new InvalidTokenError('audience_invalid');
      return {
        subject: c.sub,
        surface,
        sessionId: c.sid,
        ...(c.ins ? { institutionId: c.ins } : {}),
        ...(c.prf ? { profileId: c.prf } : {}),
        subTasks: c.st,
      };
    },
  };
}
