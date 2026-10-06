/**
 * Issues access tokens (ADR-0011): ES256 JWTs, 15 minutes, audience = surface, `sid` = session.
 * The back office signs with its own keys; nothing else accepts an `ops` token.
 */
import { SignJWT } from 'jose';
import { v7 as uuidv7 } from 'uuid';
import type { SigningKeySet } from './signing-keys';
import type { Surface } from './principal';

export interface AccessTokenClaims {
  /** Account public id. */
  readonly subject: string;
  readonly surface: Surface;
  /** Session public id. */
  readonly sessionId: string;
  readonly institutionId?: string;
  readonly profileId?: string;
  readonly subTasks: readonly string[];
}

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface TokenSigner {
  /** `ttlSeconds` overrides the default lifetime (platform setting). */
  sign(claims: AccessTokenClaims, ttlSeconds?: number): Promise<IssuedAccessToken>;
}

export interface TokenSignerOptions {
  readonly issuer: string;
  readonly keys: SigningKeySet;
  readonly opsKeys: SigningKeySet;
  readonly ttlSeconds: number;
  readonly now?: () => Date;
}

export function createTokenSigner(opts: TokenSignerOptions): TokenSigner {
  const now = opts.now ?? (() => new Date());
  return {
    async sign(c, ttlSeconds) {
      const keys = c.surface === 'ops' ? opts.opsKeys : opts.keys;
      const issuedAt = Math.floor(now().getTime() / 1000);
      const exp = issuedAt + (ttlSeconds ?? opts.ttlSeconds);
      const payload: Record<string, unknown> = { sid: c.sessionId, st: [...c.subTasks] };
      if (c.institutionId) payload['ins'] = c.institutionId;
      if (c.profileId) payload['prf'] = c.profileId;
      const token = await new SignJWT(payload)
        .setProtectedHeader({ alg: 'ES256', kid: keys.activeKid, typ: 'at+jwt' })
        .setIssuer(opts.issuer)
        .setSubject(c.subject)
        .setAudience(c.surface)
        .setIssuedAt(issuedAt)
        .setExpirationTime(exp)
        .setJti(uuidv7())
        .sign(keys.privateKey);
      return { token, expiresAt: new Date(exp * 1000) };
    },
  };
}
