/**
 * Short-lived signed tokens that carry a multi-step flow to its next step (sign-up after the code
 * is verified; password reset after recovery). HS256 with a per-purpose secret derived from the
 * field keys, audience = purpose, so a token of one flow is never accepted by another.
 */
import { jwtVerify, SignJWT } from 'jose';
import type { FieldCipher } from './fieldEncryption';

export type FlowPurpose =
  | 'signup'
  | 'password-reset'
  | 'social-state'
  | 'social-signup'
  | 'email-change'
  | 'staff-password-reset'
  | 'portal-signup'
  // A verified mobile without an account, before its account is made on the customer site.
  | 'portal-signup-new'
  | 'admission-resume'
  | 'admission-pay'
  | 'admission-otp';

export interface FlowTokens {
  issue(
    purpose: FlowPurpose,
    claims: Record<string, string | number>,
    ttlSeconds: number,
  ): Promise<{
    token: string;
    expiresAt: Date;
  }>;
  /** The claims, or undefined when the token is invalid, expired or of another purpose. */
  verify(purpose: FlowPurpose, token: string): Promise<Record<string, unknown> | undefined>;
}

export function createFlowTokens(
  cipher: FieldCipher,
  now: () => Date = () => new Date(),
): FlowTokens {
  const key = (p: FlowPurpose) => new Uint8Array(cipher.secret(`flow:${p}`));
  const audience = (p: FlowPurpose) => `ringpe:${p}`;
  return {
    async issue(purpose, claims, ttlSeconds) {
      const iat = Math.floor(now().getTime() / 1000);
      const exp = iat + ttlSeconds;
      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('ringpe')
        .setAudience(audience(purpose))
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        .sign(key(purpose));
      return { token, expiresAt: new Date(exp * 1000) };
    },
    async verify(purpose, token) {
      try {
        const { payload } = await jwtVerify(token, key(purpose), {
          issuer: 'ringpe',
          audience: audience(purpose),
          algorithms: ['HS256'],
          currentDate: now(),
        });
        return payload as Record<string, unknown>;
      } catch {
        return undefined;
      }
    },
  };
}
