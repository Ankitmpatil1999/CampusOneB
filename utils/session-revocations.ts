/**
 * Ended sessions whose access tokens are still inside their 15 minutes (ADR-0011): deactivation,
 * suspension, password change, sign-out elsewhere and refresh-token reuse take effect at once.
 * Redis when configured (several instances); an in-memory map otherwise (one instance only).
 */
import type { Redis } from 'ioredis';

export interface SessionRevocations {
  /** Marks a session id as ended until `untilEpochSeconds` (the latest access-token expiry). */
  revoke(sessionId: string, untilEpochSeconds: number): Promise<void>;
  isRevoked(sessionId: string): Promise<boolean>;
}

export function memoryRevocations(now: () => number = () => Date.now()): SessionRevocations {
  const ended = new Map<string, number>();
  return {
    async revoke(sessionId, until) {
      ended.set(sessionId, until);
      // Drop expired entries opportunistically so the map stays small.
      const t = now() / 1000;
      for (const [k, v] of ended) if (v < t) ended.delete(k);
    },
    async isRevoked(sessionId) {
      const until = ended.get(sessionId);
      return until !== undefined && until >= now() / 1000;
    },
  };
}

export function redisRevocations(redis: Redis): SessionRevocations {
  const key = (sid: string) => `rp:revoked:${sid}`;
  return {
    async revoke(sessionId, until) {
      const ttl = Math.max(1, Math.ceil(until - Date.now() / 1000));
      await redis.set(key(sessionId), '1', 'EX', ttl);
    },
    async isRevoked(sessionId) {
      return (await redis.exists(key(sessionId))) === 1;
    },
  };
}
